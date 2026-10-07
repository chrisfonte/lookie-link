'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const { canonicalize } = require('../forms/canonical');
const {
  BUNDLED_IDS,
  isMarkerTemplateId,
  validateMarkerTemplate,
} = require('./template-schema');

const DEFAULT_BUNDLED_DIR = path.join(__dirname, 'bundled');
const PROTECTED_KEYS = new Set(['templateId', 'revision', 'contractVersion', 'resourceKind']);

function codedError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function validationError(details) {
  return codedError('EVALIDATION', 'Template validation failed.', details);
}

function entryFor(doc, source, writable = source === 'stored') {
  return { ...structuredClone(doc), source, writable };
}

async function syncDirectory(directoryPath) {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Temp file (wx, 0600) + fsync + rename + directory fsync. Copied from the
// forms template registry so a crash never leaves a torn template.
async function durableReplace(targetPath, bytes) {
  const directoryPath = path.dirname(targetPath);
  const createdDirectory = await fs.mkdir(directoryPath, { recursive: true });
  if (createdDirectory) await syncDirectory(path.dirname(createdDirectory));
  const tempPath = path.join(directoryPath, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
    await syncDirectory(directoryPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

// Same durability as durableReplace, but the target must not exist: the temp file
// is hard-linked into place, which fails with EEXIST instead of overwriting.
async function durableCreateExclusive(targetPath, bytes) {
  const directoryPath = path.dirname(targetPath);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directoryPath, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(tempPath, targetPath);
    await syncDirectory(directoryPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

/**
 * Bundled (read-only), stored (`<writableDir>/<templateId>.json`) and file
 * (read-only extra directories) marker templates. Entries are the template
 * document plus `source` ('bundled' | 'stored' | 'file') and `writable`.
 *
 * `templatesPath` (string) or `templatesPaths` (array): the first directory is
 * the writable store, the rest are read-only sources. Revision history lives in
 * `<writableDir>/.history/<templateId>/r<N>.json`.
 *
 * Ids are unique across all entries (bundled, writable, then each read-only
 * directory in order): the first holder wins and later ones are logged and
 * ignored. A read-only template's current revision is copied into the history
 * the first time it is read; if that revision already exists there with
 * different canonical bytes the template is refused (not listed, not served), so
 * a file edited without a revision bump cannot change what pinned records mean.
 * `remove` is a tombstone: `<id>.json` moves to `.history/<id>/tombstone.json`
 * and every history file stays, so records pinned to any revision still render.
 */
class MarkerTemplateStore {
  constructor({
    templatesPath, templatesPaths, bundledDir = DEFAULT_BUNDLED_DIR, logger = console, clock = () => new Date(),
  } = {}) {
    const directories = Array.isArray(templatesPaths) ? templatesPaths : [templatesPath];
    if (directories.length === 0 || directories.some((entry) => typeof entry !== 'string' || entry === '')) {
      throw new Error('templatesPath (string) or templatesPaths (non-empty array of strings) is required.');
    }
    this.templatesPath = directories[0];
    this.readOnlyPaths = directories.slice(1);
    this.logger = logger;
    this.clock = clock;
    this.mutationLocks = new Map();
    this.warned = new Set();
    this.bundled = this.loadBundled(bundledDir);
  }

  loadBundled(bundledDir) {
    const bundled = new Map();
    for (const name of fsSync.readdirSync(bundledDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const doc = JSON.parse(fsSync.readFileSync(path.join(bundledDir, name), 'utf8'));
      const validation = validateMarkerTemplate(doc);
      if (!validation.valid || `${doc.templateId}.json` !== name) {
        throw new Error(`Bundled marker template ${name} is invalid: ${JSON.stringify(validation.errors)}`);
      }
      bundled.set(doc.templateId, doc);
    }
    return bundled;
  }

  warn(message, details) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(message, details);
  }

  // Warns once per distinct condition, so repeated reads do not flood the log.
  warnOnce(key, message, details) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message, details);
  }

  templateFile(templateId) {
    return path.join(this.templatesPath, `${templateId}.json`);
  }

  historyFile(templateId, revision) {
    return path.join(this.templatesPath, '.history', templateId, `r${revision}.json`);
  }

  tombstoneFile(templateId) {
    return path.join(this.templatesPath, '.history', templateId, 'tombstone.json');
  }

  async readStored(templateId, fileName = `${templateId}.json`, directory = this.templatesPath) {
    const filePath = path.join(directory, fileName);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (!stat.isFile()) {
      this.warn('Skipping marker template that is not a regular file.', { file: fileName });
      return null;
    }
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      this.warn('Skipping unreadable marker template.', { file: fileName, error: error.message });
      return null;
    }
    const validation = validateMarkerTemplate(doc);
    if (!validation.valid) {
      this.warn('Skipping invalid marker template.', { file: fileName, errors: validation.errors.slice(0, 5) });
      return null;
    }
    if (doc.templateId !== templateId) {
      this.warn('Skipping marker template whose templateId does not match its file name.', { file: fileName });
      return null;
    }
    return doc;
  }

  async scanDirectory(directory) {
    let names = [];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const found = [];
    for (const name of names.sort()) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      const templateId = name.slice(0, -'.json'.length);
      if (!isMarkerTemplateId(templateId)) {
        this.warn('Skipping marker template with an invalid file name.', { file: name });
        continue;
      }
      found.push({ templateId, name });
    }
    return found;
  }

  async list() {
    const entries = new Map();
    for (const [templateId, doc] of this.bundled) entries.set(templateId, entryFor(doc, 'bundled'));
    for (const { templateId, name } of await this.scanDirectory(this.templatesPath)) {
      if (entries.has(templateId)) {
        this.warn('Ignoring stored marker template that reuses a bundled id.', { file: name });
        continue;
      }
      const doc = await this.readStored(templateId, name);
      if (doc) entries.set(templateId, entryFor(doc, 'stored'));
    }
    const claimed = new Set();
    for (const directory of this.readOnlyPaths) {
      for (const { templateId, name } of await this.scanDirectory(directory)) {
        if (entries.has(templateId) || claimed.has(templateId)) {
          this.warn('Ignoring read-only marker template whose id is already provided.', {
            file: name, provided: entries.has(templateId) ? entries.get(templateId).source : 'file',
          });
          continue;
        }
        const doc = await this.readStored(templateId, name, directory);
        if (!doc) continue;
        claimed.add(templateId);
        if (await this.ensureReadOnlyHistory(doc, directory)) entries.set(templateId, entryFor(doc, 'file', false));
      }
    }
    return [...entries.values()].sort((left, right) => (left.templateId < right.templateId ? -1 : left.templateId > right.templateId ? 1 : 0));
  }

  /**
   * Startup pass: lists every template, which imports the history of read-only
   * templates and logs refusals and id collisions once.
   */
  async load() {
    return this.list();
  }

  // First read-only directory holding a valid template with this id, or null.
  // Does not touch history; use readReadOnly for a template that will be served.
  async findReadOnly(templateId) {
    for (const directory of this.readOnlyPaths) {
      const doc = await this.readStored(templateId, `${templateId}.json`, directory);
      if (doc) return { doc, directory };
    }
    return null;
  }

  // The read-only template to serve, or null when absent or refused because its
  // revision's history holds different bytes. The first holder of an id decides.
  async readReadOnly(templateId) {
    const found = await this.findReadOnly(templateId);
    if (!found) return null;
    return await this.ensureReadOnlyHistory(found.doc, found.directory) ? found.doc : null;
  }

  async ensureReadOnlyHistory(doc, directory) {
    const bytes = canonicalize(doc);
    if (await this.writeHistoryIfAbsent(doc.templateId, doc.revision, bytes) !== 'different') return true;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    this.warnOnce(`refused:${directory}:${doc.templateId}:${digest}`,
      'Refusing read-only marker template: its revision already has different history bytes. Bump the revision.',
      { templateId: doc.templateId, revision: doc.revision, directory });
    return false;
  }

  async get(templateId) {
    if (!isMarkerTemplateId(templateId)) return null;
    if (this.bundled.has(templateId)) return entryFor(this.bundled.get(templateId), 'bundled');
    const doc = await this.readStored(templateId);
    if (doc) {
      if (this.readOnlyPaths.length > 0 && await this.findReadOnly(templateId)) {
        this.warn('Stored marker template shadows a read-only template with the same id.', { templateId });
      }
      return entryFor(doc, 'stored');
    }
    const readOnly = await this.readReadOnly(templateId);
    return readOnly ? entryFor(readOnly, 'file', false) : null;
  }

  /**
   * A specific revision: the current document when `revision` is current,
   * otherwise the copy kept in the writable store's history. Null when unknown.
   */
  async getRevision(templateId, revision) {
    if (!isMarkerTemplateId(templateId) || !Number.isSafeInteger(revision) || revision < 1) return null;
    const current = await this.get(templateId);
    if (current && current.revision === revision) return current;
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(this.historyFile(templateId, revision), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) throw error;
      return null;
    }
    if (!validateMarkerTemplate(doc).valid || doc.templateId !== templateId || doc.revision !== revision) {
      this.warn('Ignoring invalid marker template history file.', { templateId, revision });
      return null;
    }
    return entryFor(doc, current ? current.source : 'stored', false);
  }

  async withMutationLock(templateId, operation) {
    const predecessor = this.mutationLocks.get(templateId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.mutationLocks.set(templateId, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(templateId) === current) this.mutationLocks.delete(templateId);
    }
  }

  validate(doc) {
    const validation = validateMarkerTemplate(doc);
    if (!validation.valid) throw validationError(validation.errors);
  }

  // The writable template at the expected revision. A template that exists only
  // in a read-only source is EREADONLY, an unknown one ENOTFOUND.
  async currentForMutation(templateId, expectedRevision) {
    const current = await this.readStored(templateId);
    if (!current) {
      if (await this.findReadOnly(templateId)) throw codedError('EREADONLY', 'Template comes from a read-only source.');
      throw codedError('ENOTFOUND', 'Template not found.');
    }
    if (current.revision !== expectedRevision) {
      const error = codedError('ESTALE', 'Template revision is stale.');
      error.currentRevision = current.revision;
      throw error;
    }
    return current;
  }

  // Creates the history file for a revision when absent. Returns 'created',
  // 'same' (already there with identical bytes) or 'different'.
  async writeHistoryIfAbsent(templateId, revision, bytes) {
    const target = this.historyFile(templateId, revision);
    try {
      await durableCreateExclusive(target, bytes);
      return 'created';
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return await fs.readFile(target, 'utf8') === bytes ? 'same' : 'different';
  }

  // Immutable copy of the revision about to be replaced or removed. An existing
  // file with the same bytes (a retry after a crash) is fine; different bytes are not.
  async recordHistory(current) {
    if (await this.writeHistoryIfAbsent(current.templateId, current.revision, canonicalize(current)) === 'different') {
      throw codedError('ECONFLICT', 'A different history entry already exists for this revision.');
    }
  }

  // The tombstone of a removed template: { present, doc } where doc is null when
  // the file is unreadable or invalid (still present, so the id stays reserved).
  async readTombstone(templateId) {
    let text;
    try {
      text = await fs.readFile(this.tombstoneFile(templateId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { present: false, doc: null };
      throw error;
    }
    try {
      const doc = JSON.parse(text);
      if (validateMarkerTemplate(doc).valid && doc.templateId === templateId) return { present: true, doc };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { present: true, doc: null };
  }

  /**
   * @param {object} input
   * @param {{restore?: boolean}} [options] `restore: true` revives a removed id
   *   with `input` as its content at the tombstone's revision + 1; otherwise a
   *   removed id is ECONFLICT.
   */
  async create(input, { restore = false } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw validationError([{ path: '', message: 'template must be an object' }]);
    }
    const doc = structuredClone(input);
    const givenRevision = doc.revision;
    if (doc.contractVersion === undefined) doc.contractVersion = 1;
    if (doc.resourceKind === undefined) doc.resourceKind = 'marker-template';
    if (doc.revision === undefined) doc.revision = 1;
    this.validate(doc);
    const { templateId } = doc;
    if (BUNDLED_IDS.includes(templateId) || this.bundled.has(templateId)) {
      throw codedError('ECONFLICT', 'Template id is reserved by a bundled template.');
    }
    return this.withMutationLock(templateId, async () => {
      const exists = await fs.lstat(this.templateFile(templateId)).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (exists || await this.findReadOnly(templateId)) throw codedError('ECONFLICT', 'Template already exists.');
      const tombstone = await this.readTombstone(templateId);
      if (tombstone.present) {
        if (!restore || !tombstone.doc) throw codedError('ECONFLICT', 'Template id belongs to a removed template.');
        const next = tombstone.doc.revision + 1;
        if (givenRevision !== undefined && givenRevision !== next) {
          throw validationError([{ path: 'revision', message: `must be ${next} when restoring a removed template` }]);
        }
        doc.revision = next;
      } else if (doc.revision !== 1) {
        throw validationError([{ path: 'revision', message: 'must be 1 for a new template' }]);
      }
      await durableReplace(this.templateFile(templateId), canonicalize(doc));
      if (tombstone.present) {
        await fs.rm(this.tombstoneFile(templateId), { force: true });
        await syncDirectory(path.dirname(this.tombstoneFile(templateId)));
      }
      return entryFor(doc, 'stored');
    });
  }

  async update(templateId, expectedRevision, changes) {
    if (!isMarkerTemplateId(templateId)) throw codedError('ENOTFOUND', 'Template not found.');
    if (this.bundled.has(templateId)) throw codedError('EREADONLY', 'Bundled templates are read-only.');
    return this.withMutationLock(templateId, async () => {
      const current = await this.currentForMutation(templateId, expectedRevision);
      const next = structuredClone(current);
      for (const [key, value] of Object.entries(changes || {})) {
        if (PROTECTED_KEYS.has(key)) continue;
        if (value === null) delete next[key];
        else next[key] = structuredClone(value);
      }
      next.revision = current.revision + 1;
      this.validate(next);
      await this.recordHistory(current);
      await durableReplace(this.templateFile(templateId), canonicalize(next));
      return entryFor(next, 'stored');
    });
  }

  async remove(templateId, expectedRevision) {
    if (!isMarkerTemplateId(templateId)) throw codedError('ENOTFOUND', 'Template not found.');
    if (this.bundled.has(templateId)) throw codedError('EREADONLY', 'Bundled templates are read-only.');
    return this.withMutationLock(templateId, async () => {
      const current = await this.currentForMutation(templateId, expectedRevision);
      await this.recordHistory(current);
      await fs.rename(this.templateFile(templateId), this.tombstoneFile(templateId));
      await syncDirectory(path.dirname(this.tombstoneFile(templateId)));
      await syncDirectory(this.templatesPath);
      return true;
    });
  }
}

module.exports = { MarkerTemplateStore, durableReplace };
