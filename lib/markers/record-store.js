'use strict';

// Immutable marker records (design §1.3). One pretty-JSON file per save,
// `<storageRoot>/<uuidv4>.json`, mode 0600, published with link-then-unlink so an
// id is never overwritten (pattern copied from lib/forms/submission-store.js
// durableCreate). The latest record for (audio.sha256, templateId) is found by
// scanning the destination's files under a per-(sha256, templateId) save lock;
// there is no in-memory index. One Lookie process per destination (v1).

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { isMarkerTemplateId } = require('./template-schema');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESOURCE_KIND = 'marker-record';
const MAX_MARKERS = 5000;
const MAX_TEXT = 4000;
const MAX_REASON = 2000;
const MAX_ACTOR_NAME = 80;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]');
const NAME_SOURCES = new Set(['self-asserted', 'config', 'token']);

const RECORD_KEYS = new Set([
  'contractVersion', 'resourceKind', 'recordId', 'receiptAt', 'actor', 'reason', 'audio', 'templateId',
  'templateRevision', 'markers', 'tags', 'touched', 'overrides', 'supersedesRecord', 'projection',
]);
const ACTOR_KEYS = new Set(['id', 'type', 'name', 'nameSource']);
const AUDIO_KEYS = new Set(['repo', 'path', 'sha256', 'sampleRate', 'channels', 'frames']);
const POINT_KEYS = new Set(['id', 'type', 'kind', 'sample', 'label', 'note']);
const REGION_KEYS = new Set(['id', 'type', 'kind', 'startSample', 'endSample', 'label', 'note']);

function codedError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedClone(value[key]);
    return out;
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(sortedClone(value), null, 2)}\n`;
}

function newRecordId() {
  return crypto.randomUUID();
}

// ---- validation -----------------------------------------------------------

function rejectUnknown(value, allowed, base, details) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) details.push({ path: base ? `${base}.${key}` : key, message: 'is not allowed' });
  }
}

function optionalText(value, path, max, details) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    details.push({ path, message: `must be a string of at most ${max} characters or null` });
    return null;
  }
  return value;
}

function newMarkerId(used) {
  for (;;) {
    const id = `m-${crypto.randomBytes(2).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Validates and normalizes record markers; generates missing ids ('m-' + 4 hex).
 * Position range checks belong to evaluateConstraints; this checks shape only.
 * @returns {object[]} normalized markers
 * @throws {Error} EVALIDATION with `details`
 */
function normalizeMarkers(markers) {
  const details = [];
  if (!Array.isArray(markers)) throw codedError('EVALIDATION', 'markers must be an array.', [{ path: 'markers', message: 'must be an array' }]);
  if (markers.length > MAX_MARKERS) {
    throw codedError('EVALIDATION', 'Too many markers.', [{ path: 'markers', message: `at most ${MAX_MARKERS} markers` }]);
  }
  const used = new Set();
  for (const marker of markers) {
    if (isPlainObject(marker) && typeof marker.id === 'string' && marker.id) used.add(marker.id);
  }
  const seen = new Set();
  const out = markers.map((marker, index) => {
    const base = `markers[${index}]`;
    if (!isPlainObject(marker)) {
      details.push({ path: base, message: 'must be an object' });
      return null;
    }
    const kind = marker.kind;
    if (kind !== 'point' && kind !== 'region') {
      details.push({ path: `${base}.kind`, message: 'must be point or region' });
      return null;
    }
    rejectUnknown(marker, kind === 'point' ? POINT_KEYS : REGION_KEYS, base, details);
    let id = marker.id;
    if (id === undefined || id === null || id === '') {
      id = newMarkerId(used);
      used.add(id);
    } else if (typeof id !== 'string' || !MARKER_ID.test(id)) {
      details.push({ path: `${base}.id`, message: 'must be 1-64 letters, digits, - or _' });
    } else if (seen.has(id)) {
      details.push({ path: `${base}.id`, message: 'must be unique within the record' });
    }
    seen.add(id);
    if (typeof marker.type !== 'string' || !marker.type) details.push({ path: `${base}.type`, message: 'is required' });
    const normalized = { id, type: marker.type, kind };
    if (kind === 'point') {
      normalized.sample = marker.sample;
    } else {
      normalized.startSample = marker.startSample;
      normalized.endSample = marker.endSample;
    }
    normalized.label = optionalText(marker.label, `${base}.label`, MAX_TEXT, details);
    normalized.note = optionalText(marker.note, `${base}.note`, MAX_TEXT, details);
    return normalized;
  });
  if (details.length > 0) throw codedError('EVALIDATION', 'Marker validation failed.', details);
  return out;
}

function validActorName(name) {
  return typeof name === 'string' && Boolean(name.trim()) && name.length <= MAX_ACTOR_NAME && !CONTROL_CHARS.test(name);
}

function normalizeActor(actor, details) {
  if (!isPlainObject(actor)) {
    details.push({ path: 'actor', message: 'must be an object' });
    return null;
  }
  rejectUnknown(actor, ACTOR_KEYS, 'actor', details);
  if (typeof actor.id !== 'string' || !actor.id) details.push({ path: 'actor.id', message: 'is required' });
  if (typeof actor.type !== 'string' || !actor.type) details.push({ path: 'actor.type', message: 'is required' });
  const out = { id: actor.id, type: actor.type };
  if (actor.name !== undefined) {
    if (!validActorName(actor.name)) {
      details.push({ path: 'actor.name', message: `must be 1-${MAX_ACTOR_NAME} printable characters` });
    } else {
      out.name = actor.name.trim();
    }
    if (!NAME_SOURCES.has(actor.nameSource)) details.push({ path: 'actor.nameSource', message: 'must be self-asserted, config or token' });
    else out.nameSource = actor.nameSource;
  } else if (actor.nameSource !== undefined) {
    details.push({ path: 'actor.nameSource', message: 'requires actor.name' });
  }
  return out;
}

function normalizeAudio(audio, details) {
  if (!isPlainObject(audio)) {
    details.push({ path: 'audio', message: 'must be an object' });
    return null;
  }
  rejectUnknown(audio, AUDIO_KEYS, 'audio', details);
  for (const key of ['repo', 'path']) {
    if (typeof audio[key] !== 'string' || !audio[key] || audio[key].length > 4096) details.push({ path: `audio.${key}`, message: 'is required' });
  }
  if (typeof audio.sha256 !== 'string' || !SHA256.test(audio.sha256)) details.push({ path: 'audio.sha256', message: 'must be 64 lowercase hex characters' });
  for (const key of ['sampleRate', 'channels']) {
    if (!Number.isSafeInteger(audio[key]) || audio[key] < 1) details.push({ path: `audio.${key}`, message: 'must be a positive integer' });
  }
  if (!Number.isSafeInteger(audio.frames) || audio.frames < 0) details.push({ path: 'audio.frames', message: 'must be a non-negative integer' });
  return {
    repo: audio.repo, path: audio.path, sha256: audio.sha256, sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames,
  };
}

function normalizeSupersedes(reference, details) {
  if (reference === undefined || reference === null) return null;
  if (!isPlainObject(reference) || (reference.resourceKind !== undefined && reference.resourceKind !== RESOURCE_KIND)
      || typeof reference.id !== 'string' || !UUID.test(reference.id)) {
    details.push({ path: 'supersedesRecord', message: 'must be { resourceKind: "marker-record", id: <uuid> }' });
    return null;
  }
  return { resourceKind: RESOURCE_KIND, id: reference.id };
}

function normalizeTags(tags, details) {
  if (tags === undefined || tags === null) return {};
  if (!isPlainObject(tags)) {
    details.push({ path: 'tags', message: 'must be an object' });
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value !== 'string' || value.length > MAX_TEXT) details.push({ path: `tags.${key}`, message: 'must be a string' });
    else out[key] = value;
  }
  return out;
}

/**
 * Validates caller input (or a full record) and returns a normalized record.
 * @throws {Error} EVALIDATION with `details`
 */
function normalizeRecord(input, { clock, markersNormalized = false } = {}) {
  const details = [];
  if (!isPlainObject(input)) throw codedError('EVALIDATION', 'Record must be an object.', [{ path: '', message: 'must be an object' }]);
  rejectUnknown(input, RECORD_KEYS, '', details);
  if (input.contractVersion !== undefined && input.contractVersion !== 1) details.push({ path: 'contractVersion', message: 'must be 1' });
  if (input.resourceKind !== undefined && input.resourceKind !== RESOURCE_KIND) details.push({ path: 'resourceKind', message: `must be ${RESOURCE_KIND}` });
  let recordId = input.recordId;
  if (recordId === undefined) recordId = newRecordId();
  else if (typeof recordId !== 'string' || !UUID.test(recordId)) details.push({ path: 'recordId', message: 'must be a lowercase UUIDv4' });
  let receiptAt = input.receiptAt;
  if (receiptAt === undefined) {
    const now = clock();
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) throw codedError('ECLOCK', 'The server clock returned an invalid time.');
    receiptAt = date.toISOString();
  } else if (typeof receiptAt !== 'string' || Number.isNaN(Date.parse(receiptAt))) {
    details.push({ path: 'receiptAt', message: 'must be an ISO 8601 time' });
  }
  const actor = normalizeActor(input.actor, details);
  const audio = normalizeAudio(input.audio, details);
  const reason = optionalText(input.reason, 'reason', MAX_REASON, details);
  if (!isMarkerTemplateId(input.templateId)) details.push({ path: 'templateId', message: 'must be a marker template id' });
  if (!Number.isSafeInteger(input.templateRevision) || input.templateRevision < 1) details.push({ path: 'templateRevision', message: 'must be a positive integer' });
  let markers = [];
  try {
    markers = markersNormalized ? input.markers : normalizeMarkers(input.markers);
  } catch (error) {
    if (error.code !== 'EVALIDATION') throw error;
    details.push(...error.details);
  }
  const tags = normalizeTags(input.tags, details);
  let touched;
  if (input.touched !== undefined) {
    if (!Array.isArray(input.touched) || input.touched.length > MAX_MARKERS
        || input.touched.some((id) => typeof id !== 'string' || !MARKER_ID.test(id))) {
      details.push({ path: 'touched', message: 'must be an array of marker ids' });
    } else {
      touched = [...new Set(input.touched)];
    }
  }
  let overrides;
  if (input.overrides !== undefined) {
    if (!Array.isArray(input.overrides) || input.overrides.length > MAX_MARKERS
        || input.overrides.some((entry) => !isPlainObject(entry) || Object.keys(entry).some((key) => key !== 'markerId' && key !== 'reason')
          || typeof entry.markerId !== 'string' || !MARKER_ID.test(entry.markerId)
          || typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > MAX_REASON)) {
      details.push({ path: 'overrides', message: 'must be an array of { markerId, reason } with a non-empty reason' });
    } else {
      overrides = input.overrides.map((entry) => ({ markerId: entry.markerId, reason: entry.reason.trim() }));
    }
  }
  const supersedesRecord = normalizeSupersedes(input.supersedesRecord, details);
  let projection = null;
  if (input.projection !== undefined && input.projection !== null) {
    if (isPlainObject(input.projection)) projection = input.projection;
    else details.push({ path: 'projection', message: 'must be an object or null' });
  }
  if (details.length > 0) throw codedError('EVALIDATION', 'Record validation failed.', details);
  return {
    contractVersion: 1,
    resourceKind: RESOURCE_KIND,
    recordId,
    receiptAt,
    actor,
    reason,
    audio,
    templateId: input.templateId,
    templateRevision: input.templateRevision,
    markers,
    tags,
    ...(touched ? { touched } : {}),
    ...(overrides ? { overrides } : {}),
    supersedesRecord,
    projection,
  };
}

/** Listing-safe summary of a record (no markers). */
function summarizeRecord(record) {
  return {
    recordId: record.recordId,
    receiptAt: record.receiptAt,
    actor: record.actor,
    reason: record.reason,
    audio: record.audio,
    templateId: record.templateId,
    templateRevision: record.templateRevision,
    markerCount: Array.isArray(record.markers) ? record.markers.length : 0,
    supersedesRecord: record.supersedesRecord || null,
    projectionStatus: record.projection && typeof record.projection.status === 'string' ? record.projection.status : null,
  };
}

// ---- store ----------------------------------------------------------------

// Module-level so two store instances over one directory still serialize.
const saveLocks = new Map();

function newestFirst(left, right) {
  if (left.receiptAt !== right.receiptAt) return left.receiptAt < right.receiptAt ? 1 : -1;
  return left.recordId < right.recordId ? 1 : -1;
}

class MarkerRecordStore {
  /**
   * @param {object} options
   * @param {string} options.storageRoot destination directory
   * @param {() => (Date|number)} [options.clock]
   * @param {{warn?: Function}} [options.logger]
   */
  constructor({ storageRoot, clock = () => new Date(), logger } = {}) {
    if (typeof storageRoot !== 'string' || !storageRoot) throw new TypeError('storageRoot is required.');
    this.storageRoot = path.resolve(storageRoot);
    this.clock = clock;
    this.logger = logger;
  }

  newRecordId() {
    return newRecordId();
  }

  recordPath(recordId) {
    if (typeof recordId !== 'string' || !UUID.test(recordId)) {
      throw codedError('EVALIDATION', 'recordId must be a lowercase UUIDv4.', [{ path: 'recordId', message: 'must be a lowercase UUIDv4' }]);
    }
    return path.join(this.storageRoot, `${recordId}.json`);
  }

  async ensureStorageRoot() {
    await fs.mkdir(this.storageRoot, { recursive: true });
    const stat = await fs.lstat(this.storageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw codedError('EACCES', 'storageRoot must be a directory and not a symbolic link.');
    }
  }

  /**
   * Serializes saves for one (sha256, templateId): the router runs the whole
   * save (checks, projection, write) inside `fn`. Not re-entrant; pass
   * `{ lockHeld: true }` to createRecord/persistRecord from inside `fn`.
   */
  async withSaveLock(sha256, templateId, fn) {
    const key = `${this.storageRoot}\0${sha256}\0${templateId}`;
    const predecessor = saveLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    saveLocks.set(key, current);
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      if (saveLocks.get(key) === current) saveLocks.delete(key);
    }
  }

  async recordFiles() {
    try {
      const entries = await fs.readdir(this.storageRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && UUID.test(entry.name.slice(0, -5)))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async readRecordFile(fileName) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.storageRoot, fileName), 'utf8'));
      return isPlainObject(record) && record.resourceKind === RESOURCE_KIND && record.recordId === fileName.slice(0, -5) ? record : null;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('Skipping unreadable marker record.', { file: fileName, error: error.message });
      }
      return null;
    }
  }

  async allRecords() {
    const records = [];
    for (const fileName of await this.recordFiles()) {
      const record = await this.readRecordFile(fileName);
      if (record) records.push(record);
    }
    return records;
  }

  async getRecord(recordId) {
    if (typeof recordId !== 'string' || !UUID.test(recordId)) return null;
    return this.readRecordFile(`${recordId}.json`);
  }

  static headsOf(records) {
    const superseded = new Set(records.filter((record) => record.supersedesRecord).map((record) => record.supersedesRecord.id));
    return records.filter((record) => !superseded.has(record.recordId)).sort(newestFirst);
  }

  /** Latest record for the bytes + template, by scanning the destination. Call under the save lock when deciding a write. */
  async latestFor(sha256, templateId) {
    const records = (await this.allRecords()).filter((record) => record.audio && record.audio.sha256 === sha256 && record.templateId === templateId);
    return MarkerRecordStore.headsOf(records)[0] || null;
  }

  /**
   * The one-code rule for supersession.
   * ENOTFOUND: the named predecessor is missing or belongs to another template.
   * ESTALE_AUDIO: the predecessor is for the same template but different audio bytes.
   * ESTALE_LATEST (currentRecordId, currentRecord): a newer record exists, or none was named while one exists.
   */
  async assertCanWrite({ sha256, templateId, supersedesId = null }) {
    const matching = (await this.allRecords()).filter((record) => record.audio && record.audio.sha256 === sha256 && record.templateId === templateId);
    const latest = MarkerRecordStore.headsOf(matching)[0] || null;
    if (supersedesId && !matching.some((record) => record.recordId === supersedesId)) {
      const predecessor = await this.getRecord(supersedesId);
      if (predecessor && predecessor.templateId === templateId && predecessor.audio && predecessor.audio.sha256 !== sha256) {
        const error = codedError('ESTALE_AUDIO', 'the audio bytes changed since that record');
        if (latest) {
          error.currentRecordId = latest.recordId;
          error.currentRecord = summarizeRecord(latest);
        }
        throw error;
      }
      throw codedError('ENOTFOUND', 'Predecessor record not found.');
    }
    if (latest && latest.recordId !== supersedesId) {
      const error = codedError('ESTALE_LATEST', supersedesId ? 'The predecessor has already been superseded.' : 'A record already exists for this audio and template; supersede it.');
      error.currentRecordId = latest.recordId;
      error.currentRecord = summarizeRecord(latest);
      throw error;
    }
    return latest;
  }

  /** Validates input and returns the complete record without writing it. */
  buildRecord(input) {
    return normalizeRecord(input, { clock: this.clock });
  }

  async durableCreate(record) {
    await this.ensureStorageRoot();
    const finalPath = this.recordPath(record.recordId);
    const tempPath = path.join(this.storageRoot, `.${record.recordId}.${crypto.randomUUID()}.tmp`);
    let handle;
    let published = false;
    try {
      handle = await fs.open(tempPath, 'wx', 0o600);
      await handle.writeFile(stableJson(record), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        // link(2) publishes atomically and never replaces an existing record.
        await fs.link(tempPath, finalPath);
        published = true;
      } catch (error) {
        if (error && error.code === 'EEXIST') throw codedError('EEXIST', `Record ${record.recordId} already exists.`);
        throw error;
      }
      // The record is durable from here: post-publish cleanup failures are warnings, never a rollback.
      try {
        await fs.unlink(tempPath);
        const directory = await fs.open(this.storageRoot, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (cleanupError) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`marker record ${record.recordId} published; post-publish cleanup failed: ${cleanupError && cleanupError.code ? cleanupError.code : cleanupError}`);
        }
      }
      return record;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!published) await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Writes a record built by buildRecord (re-validated). Takes the save lock
   * unless `lockHeld`. `skipChecks` skips the supersession rule (used after a
   * live projection, when the record must be written whatever happens).
   */
  async persistRecord(record, { lockHeld = false, skipChecks = false } = {}) {
    const normalized = normalizeRecord(record, { clock: this.clock });
    const run = async () => {
      if (!skipChecks) {
        await this.assertCanWrite({
          sha256: normalized.audio.sha256,
          templateId: normalized.templateId,
          supersedesId: normalized.supersedesRecord ? normalized.supersedesRecord.id : null,
        });
      }
      return this.durableCreate(normalized);
    };
    if (lockHeld) return run();
    return this.withSaveLock(normalized.audio.sha256, normalized.templateId, run);
  }

  async createRecord(input, options = {}) {
    return this.persistRecord(this.buildRecord(input), options);
  }

  async resolveLatest(recordId) {
    const start = await this.getRecord(recordId);
    if (!start) return null;
    const records = (await this.allRecords()).filter((record) => record.audio.sha256 === start.audio.sha256 && record.templateId === start.templateId);
    const successors = new Map();
    for (const record of records) {
      if (!record.supersedesRecord) continue;
      if (successors.has(record.supersedesRecord.id)) throw codedError('EINTEGRITY', 'The supersession chain has multiple successors.');
      successors.set(record.supersedesRecord.id, record);
    }
    const visited = new Set();
    let current = start;
    while (current) {
      if (visited.has(current.recordId)) throw codedError('EINTEGRITY', 'The supersession chain contains a cycle.');
      visited.add(current.recordId);
      const next = successors.get(current.recordId);
      if (!next) return current;
      current = next;
    }
    return null;
  }

  /** @returns {Promise<{latest: object, predecessors: object[]}|null>} predecessors newest first */
  async getHistory(recordId) {
    const latest = await this.resolveLatest(recordId);
    if (!latest) return null;
    const predecessors = [];
    const visited = new Set([latest.recordId]);
    let current = latest;
    while (current.supersedesRecord) {
      const predecessor = await this.getRecord(current.supersedesRecord.id);
      if (!predecessor || visited.has(predecessor.recordId)) throw codedError('EINTEGRITY', 'The supersession chain is incomplete or cyclic.');
      predecessors.push(predecessor);
      visited.add(predecessor.recordId);
      current = predecessor;
    }
    return { latest, predecessors };
  }

  /**
   * Latest record per (audio.sha256, templateId), newest first. With `all`, every record.
   * `repo`/`path` filter on the recorded display fields.
   */
  async listLatest({ sha256, repo, path: audioPath, templateId, all = false } = {}) {
    let records = await this.allRecords();
    const superseded = new Set(records.filter((record) => record.supersedesRecord).map((record) => record.supersedesRecord.id));
    records = records.filter((record) => (sha256 === undefined || record.audio.sha256 === sha256)
      && (repo === undefined || record.audio.repo === repo)
      && (audioPath === undefined || record.audio.path === audioPath)
      && (templateId === undefined || record.templateId === templateId)
      && (all || !superseded.has(record.recordId)));
    return records.sort(newestFirst);
  }
}

module.exports = {
  MarkerRecordStore,
  normalizeMarkers,
  normalizeRecord,
  validActorName,
  summarizeRecord,
  newRecordId,
  RESOURCE_KIND,
};
