'use strict';

// `yaml-pointers` projection (design §4.1): write marker values into a YAML
// target through the guarded ops-yaml CLI.
//
// run() MUST be called inside the record store's save lock for
// (audio.sha256, templateId): the target is read once, a candidate is built by
// byte-splicing, proven, validated and applied, and the caller then writes the
// record. The transaction never runs `ops-yaml edit` (it reflows documents).
//
// Invariants:
//  - preview writes nothing durable; transient candidate files live under
//    `<root>/.lookie-tmp/` and are removed before run() returns;
//  - live writes the snapshot and the receipt only after the candidate is
//    proven, deletes them on every failure BEFORE `--live` is spawned, and
//    never deletes them afterwards;
//  - after `--live` is spawned a receipt (status applied | uncertain) is
//    returned for every outcome except a refusal (CLI exit 2, 3, 4, 5);
//  - no CLI stdout and no absolute path is ever returned or stored.

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

const { ProjectionError } = require('./errors');
const {
  SpliceError, parsePointer, formatPointer, deepEqual, getAt, setAt, appendAt, declaredPointers,
  collapseToListUnit, applyOps, dq, renderScalar, proveCandidate,
} = require('./yaml-splice');

const KIND = 'yaml-pointers';
const MAX_TARGET_BYTES = 8 * 1024 * 1024;
const TMP_DIR = '.lookie-tmp';
const HEX64 = /^[0-9a-f]{64}$/;
const UNITS = ['samples', 'ms', 'seconds'];
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_LIVE_TIMEOUT_MS = 0; // no kill timeout on --live: a kill would leave the target uncertain

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validationError(message, details) {
  return new ProjectionError(422, 'validation_error', message, details);
}

function spliceFailure(error, step) {
  if (error instanceof SpliceError) {
    return validationError(error.message, { step, reason: error.code, ...(error.details || {}) });
  }
  return error;
}

// ---- time and substitution -----------------------------------------------------

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function stampOf(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** ISO 8601 date-time with a numeric offset, in `timezone` (IANA name) or the server zone. */
function dateWithOffset(date, timezone) {
  let parts;
  if (timezone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
      const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
      const offsetMinutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${formatOffset(offsetMinutes)}`;
    } catch {
      // unknown zone name: fall through to the server zone
    }
  }
  const offsetMinutes = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${formatOffset(offsetMinutes)}`;
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function oneLine(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, ' ').trim();
}

/** Replace `{name}` tokens; an unknown token is a template error. */
function substituteBraces(template, vars, where) {
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9.]*)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw validationError(`unknown substitution ${match} in ${where}`, { step: 'substitution', where });
    }
    return String(vars[name]);
  });
}

function substituteDollars(text, dollars) {
  return text.replace(/\$(snapshot\.path|snapshot\.sha256|receipt\.path|receipt\.sha256|audio\.sha256|audio\.basename)/g,
    (match, name) => (Object.prototype.hasOwnProperty.call(dollars, name) ? String(dollars[name]) : match));
}

function pathSafe(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function conversionOf(sample, unit, sampleRate) {
  if (unit === 'samples') return sample;
  if (unit === 'ms') return Math.round((sample / sampleRate) * 1000);
  return Number((sample / sampleRate).toFixed(6));
}

function toSamples(value, unit, sampleRate) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (unit === 'samples') return Math.round(value);
  if (unit === 'ms') return Math.round((value * sampleRate) / 1000);
  return Math.round(value * sampleRate);
}

/** Insert `-<first 8 of recordId>` before the extension of a file name. */
function suffixName(name, recordId) {
  const suffix = `-${String(recordId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
  const ext = path.posix.extname(name);
  return ext && ext !== name ? `${name.slice(0, -ext.length)}${suffix}${ext}` : `${name}${suffix}`;
}

function cleanRelative(rel, where) {
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..') || rel.includes('\\')) {
    throw validationError(`${where} must resolve to a relative path inside the root`, { step: 'receipts', where });
  }
  return normalized;
}

// ---- filesystem helpers ----------------------------------------------------------

async function realpathInside(rootReal, candidate) {
  const real = await fs.realpath(candidate);
  const withSep = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return real === rootReal || real.startsWith(withSep);
}

/** Deepest existing ancestor of `target` must resolve inside the root (guards symlink components). */
async function assertAncestorInside(rootReal, target) {
  let current = target;
  for (;;) {
    try {
      await fs.lstat(current);
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!(await realpathInside(rootReal, current))) {
    throw validationError('a receipts path component resolves outside the root', { step: 'receipts' });
  }
}

/** mkdir -p that reports which directories it created (so a failure can remove them). */
async function mkdirTracked(dir, created) {
  const missing = [];
  let current = dir;
  for (;;) {
    try {
      await fs.stat(current);
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const entry of missing.reverse()) {
    await fs.mkdir(entry);
    created.push(entry);
  }
}

async function writeExclusive(file, buffer, mode) {
  const handle = await fs.open(file, 'wx', mode);
  try {
    await handle.writeFile(buffer);
  } finally {
    await handle.close();
  }
}

// ---- the factory -------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {Record<string, {path: string, allowProjections?: boolean, requireValidator?: boolean}>} deps.roots
 *   `markers.roots` (alias -> flags); a projection may name only a root with allowProjections.
 * @param {string} [deps.yamlToolPath] absolute path of the ops-yaml launcher; absent -> 409 feature_disabled
 * @param {Record<string, string[]>} [deps.validators] `markers.validators` (id -> argv with {candidate} {root})
 * @param {Function} [deps.locateTarget] lane E's `resolver.locateTarget(template, sourceId, audio)` ->
 *   `{ target: {root, relPath, sha256}|null, problem }` (a bare target object is accepted too). Optional
 *   when run() is given `target`.
 * @param {Function} [deps.loadRecord] `async (recordId) => record|null`, used to load the predecessor when
 *   run() is not given one and the record supersedes another
 * @param {Function} [deps.execFile] child_process.execFile-compatible (default: the real one)
 * @param {() => Date} [deps.clock]
 * @param {string} [deps.timezone] IANA zone for {date} (default: the server zone)
 * @param {number} [deps.timeoutMs] validator and dry-run timeout (default 60 s)
 * @param {number} [deps.liveTimeoutMs] `--live` kill timeout (default 0 = none; a kill would yield status uncertain)
 * @param {{warn?: Function}} [deps.logger]
 */
function createYamlPointersProjection(deps = {}) {
  const roots = deps.roots || {};
  const validators = deps.validators || {};
  const execFileImpl = deps.execFile || childProcess.execFile;
  const clock = deps.clock || (() => new Date());
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const liveTimeoutMs = deps.liveTimeoutMs === undefined ? DEFAULT_LIVE_TIMEOUT_MS : deps.liveTimeoutMs;
  const logger = deps.logger || {};

  function warn(message, details) {
    if (typeof logger.warn === 'function') logger.warn(message, details);
  }

  function exec(file, args, timeout) {
    return new Promise((resolve) => {
      try {
        execFileImpl(file, args, { env: { ...process.env }, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          const exit = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          resolve({ exit, stderr: String(stderr || ''), killed: Boolean(error && (error.killed || error.signal)) });
        });
      } catch (error) {
        resolve({ exit: null, stderr: String(error && error.message), killed: false });
      }
    });
  }

  // ---- step 0/1: preconditions, target ------------------------------------------

  function resolveProjection(args) {
    const { template } = args;
    let projection = args.projection;
    if (!projection && template && Array.isArray(template.projections)) {
      projection = template.projections.find((entry) => entry.id === args.projectionId);
    }
    if (!projection) throw new ProjectionError(404, 'not_found', 'The template does not declare that projection.');
    if (projection.kind !== KIND) throw validationError(`projection kind must be ${KIND}`);
    return projection;
  }

  function assertAuthority(projection) {
    if (!deps.yamlToolPath) {
      throw new ProjectionError(409, 'feature_disabled', 'The yaml-pointers projection is not configured on this instance.');
    }
    const root = roots[projection.root];
    if (!root || typeof root.path !== 'string') {
      throw validationError('The projection root is not configured on this instance.', { step: 'authority' });
    }
    if (root.allowProjections !== true) {
      throw new ProjectionError(403, 'projection_not_allowed', 'This root does not accept projections.');
    }
    if (root.requireValidator !== false && !projection.validator) {
      throw validationError('This root requires the projection to name a validator.', { step: 'authority' });
    }
    if (projection.validator && !Array.isArray(validators[projection.validator])) {
      throw new ProjectionError(409, 'feature_disabled', 'The projection names a validator that is not configured on this instance.');
    }
    return root;
  }

  async function locate(args, projection, audio) {
    let target = args.target;
    if (!target) {
      if (typeof deps.locateTarget !== 'function') {
        throw new ProjectionError(409, 'feature_disabled', 'No target locator is configured on this instance.');
      }
      const located = await deps.locateTarget(args.template, projection.target, { sha256: audio.sha256, basename: audio.basename });
      target = located && Object.prototype.hasOwnProperty.call(located, 'target') ? located.target : located;
      if (!target) {
        throw new ProjectionError(404, 'not_found', 'The projection target was not found.',
          located && located.problem ? { problem: String(located.problem) } : undefined);
      }
    }
    if (typeof target.relPath !== 'string' || !target.relPath || (target.root && target.root !== projection.root)) {
      throw validationError('The located target does not belong to the projection root.', { step: 'target' });
    }
    return target;
  }

  async function readTarget(rootReal, relPath) {
    const clean = cleanRelative(relPath, 'target path');
    const abs = path.join(rootReal, clean);
    await assertAncestorInside(rootReal, abs);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat) throw new ProjectionError(404, 'not_found', 'The projection target was not found.');
    if (stat.isSymbolicLink() || !stat.isFile()) throw validationError('The projection target must be a regular file.', { step: 'target' });
    if (!(await realpathInside(rootReal, abs))) throw validationError('The projection target resolves outside the root.', { step: 'target' });
    if (stat.size > MAX_TARGET_BYTES) throw validationError('The projection target is too large.', { step: 'target' });
    const bytes = await fs.readFile(abs);
    return { abs, rel: clean, bytes, mode: stat.mode & 0o777 };
  }

  // ---- step 2: effective write set --------------------------------------------------

  function markerValueKey(marker) {
    return JSON.stringify([marker.type, marker.kind, marker.sample, marker.startSample, marker.endSample]);
  }

  function planOps({ template, projection, record, predecessor, touched, live, sampleRate, accept, vars }) {
    const templateMarkers = new Map((template.markers || []).map((marker) => [marker.id, marker]));
    const markers = Array.isArray(record.markers) ? record.markers : [];
    const predecessorById = predecessor && Array.isArray(predecessor.markers)
      ? new Map(predecessor.markers.map((marker) => [marker.id, marker])) : null;
    const touchedIds = new Set(Array.isArray(touched) ? touched : []);

    const candidates = [];
    for (const [index, entry] of (projection.write || []).entries()) {
      const where = `write[${index}]`;
      const definition = templateMarkers.get(entry.marker);
      if (!definition) throw validationError(`${where}.marker is not a declared marker`, { step: 'write', where });
      if (definition.multiple === true) {
        throw validationError(`${where}: marker "${entry.marker}" allows several instances; a projection writes a single marker`, { step: 'write', where });
      }
      const instances = markers.filter((marker) => marker.type === entry.marker);
      if (instances.length === 0) continue; // absent markers are skipped, never written as null
      if (instances.length > 1) throw validationError(`${where}: marker "${entry.marker}" has several instances`, { step: 'write', where });
      const marker = instances[0];
      const kind = marker.kind || definition.kind;
      let sample;
      if (kind === 'region') {
        if (entry.edge !== 'start' && entry.edge !== 'end') {
          throw validationError(`${where}: a region marker needs edge "start" or "end"`, { step: 'write', where });
        }
        sample = entry.edge === 'start' ? marker.startSample : marker.endSample;
      } else {
        if (entry.edge !== undefined) throw validationError(`${where}: edge applies only to region markers`, { step: 'write', where });
        sample = marker.sample;
      }
      // Unit precedence: the entry's own unit, then the template's unit, then samples.
      const unit = entry.unit !== undefined ? entry.unit : (template.unit !== undefined ? template.unit : 'samples');
      if (!UNITS.includes(unit)) throw validationError(`${where}.unit must be one of ${UNITS.join(', ')}`, { step: 'write', where });
      if (!Number.isInteger(sample) || sample < 0) throw validationError(`${where}: marker "${entry.marker}" has no integer sample position`, { step: 'write', where });
      if (unit !== 'samples' && !(Number(sampleRate) > 0)) throw validationError('The audio sample rate is needed to convert units.', { step: 'write', where });
      const value = conversionOf(sample, unit, sampleRate);
      const current = getAt(live, entry.pointer);
      candidates.push({
        entry, marker, sample, unit, value, where, found: current.found, current: current.found ? current.value : undefined,
        differsFromTarget: !current.found || !deepEqual(current.value, value),
      });
    }

    // Effective set (S17): changed against the predecessor record (or, with none, against the
    // target's current values), plus the ids the operator touched.
    const effectiveIds = new Set();
    for (const candidate of candidates) {
      const { marker } = candidate;
      let changed;
      if (predecessorById) {
        const before = predecessorById.get(marker.id);
        changed = !before || markerValueKey(before) !== markerValueKey(marker);
      } else {
        changed = candidates.some((other) => other.marker.id === marker.id && other.differsFromTarget);
      }
      if (changed || touchedIds.has(marker.id)) effectiveIds.add(marker.id);
    }
    const writes = candidates.filter((candidate) => effectiveIds.has(candidate.marker.id));
    for (const write of writes) {
      if (!write.found) {
        throw validationError('pointer does not exist in target', { step: 'write', pointer: write.entry.pointer, where: write.where });
      }
    }

    const ops = writes.map((write) => ({
      pointer: write.entry.pointer, value: write.value, token: renderScalar(write.value), type: 'marker', write,
    }));
    if (writes.length > 0 || accept) {
      for (const [index, entry] of (projection.text || []).entries()) {
        const value = substituteBraces(entry.template, vars.text, `text[${index}]`);
        ops.push({ pointer: entry.pointer, value, token: dq(value), type: 'text' });
      }
    }
    if (accept) {
      if (!projection.status) throw validationError('The projection has no status.onAccept to apply.', { step: 'status' });
      ops.push({ pointer: projection.status.pointer, value: projection.status.onAccept, token: dq(projection.status.onAccept), type: 'status' });
    }
    return { ops, writes };
  }

  // ---- steps 3-5: snapshot/receipt text, appends, candidate --------------------------

  function nextN(live, projection) {
    for (const section of [projection.evidence, projection.history]) {
      if (!section || !isPlainObject(section.append)) continue;
      const key = Object.keys(section.append).find((name) => typeof section.append[name] === 'string' && section.append[name].includes('{n}'));
      if (!key) continue;
      const pattern = new RegExp(`^${section.append[key].split(/(\{n\}|\{[A-Za-z][A-Za-z0-9.]*\})/)
        .map((part) => (part === '{n}' ? '(\\d+)' : /^\{.+\}$/.test(part) ? '.*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('')}$`);
      const list = getAt(live, section.pointer);
      let highest = 0;
      if (list.found && Array.isArray(list.value)) {
        for (const item of list.value) {
          const candidate = isPlainObject(item) ? item[key] : item;
          const match = typeof candidate === 'string' ? pattern.exec(candidate) : null;
          if (match) highest = Math.max(highest, Number(match[1]));
        }
      }
      return highest + 1;
    }
    return 1;
  }

  function receiptMarkdown({ actorLabel, actor, when, reason, record, template, projection, targetPath, before, snapshotPath, writes, ops, sampleRate }) {
    const lines = [
      '# Marker edit receipt',
      '',
      `- Actor: ${actorLabel}${actor.nameSource ? ` (${actor.nameSource})` : ''}`,
      `- Time: ${when}`,
      `- Record: ${record.recordId}`,
      `- Template: ${template.templateId}${template.revision !== undefined ? ` r${template.revision}` : ''}`,
      `- Projection: ${projection.id}`,
      `- Target: ${targetPath}`,
      `- Pre-edit sha256: ${before}`,
      `- Snapshot: ${snapshotPath}`,
      '',
      '## Reason',
      '',
      ...(reason ? reason.split(/\r?\n/).map((line) => `> ${line}`) : ['> (none given)']),
      '',
      '## Markers written',
      '',
    ];
    if (writes.length === 0) lines.push('- (no marker positions changed)');
    for (const write of writes) {
      const oldSamples = toSamples(write.current, write.unit, sampleRate);
      const seconds = Number(sampleRate) > 0 ? (write.sample / sampleRate).toFixed(6) : 'n/a';
      const oldSeconds = oldSamples !== null && Number(sampleRate) > 0 ? (oldSamples / sampleRate).toFixed(6) : 'n/a';
      lines.push(`- ${write.marker.id} (${write.entry.marker}${write.entry.edge ? ` ${write.entry.edge}` : ''}) at ${write.entry.pointer}: `
        + `${write.current === null ? 'null' : String(write.current)} -> ${write.value} ${write.unit}; `
        + `samples ${oldSamples === null ? 'n/a' : oldSamples} -> ${write.sample}; seconds ${oldSeconds} -> ${seconds}`);
    }
    const others = ops.filter((op) => op.type !== 'marker');
    if (others.length > 0) {
      lines.push('', '## Other fields set', '');
      for (const op of others) lines.push(`- ${op.pointer}: ${JSON.stringify(op.value)}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ---- CLI and validator -----------------------------------------------------------

  function applyArgs(liveAbs, candidateAbs, before, pointers, live) {
    const args = ['apply', liveAbs, candidateAbs, '--expected-sha256', before];
    for (const pointer of pointers) args.push('--allow-change', pointer);
    if (live) args.push('--live');
    return args;
  }

  async function runValidator(projection, candidateAbs, rootReal) {
    if (!projection.validator) return null;
    const argv = validators[projection.validator].map((part) => part.split('{candidate}').join(candidateAbs).split('{root}').join(rootReal));
    const result = await exec(argv[0], argv.slice(1), timeoutMs);
    return result.exit;
  }

  function sanitize(text, rootReal, tmpAbs) {
    let out = String(text || '').trim().slice(0, 500);
    for (const secret of [tmpAbs, rootReal]) if (secret) out = out.split(secret).join('<root>');
    return out;
  }

  function refusalFor(exit, phase, stderr, ctx) {
    if (exit === 4) {
      return new ProjectionError(409, 'target_conflict', 'The target changed since it was read; reload and retry.', { step: phase }, { currentTargetSha256: ctx.currentSha() });
    }
    if (exit === 5) {
      return new ProjectionError(500, 'projection_bug', 'The guarded writer rejected the declared change set.',
        { step: phase, declared: ctx.pointers, cliMessage: sanitize(stderr, ctx.rootReal, ctx.tmpAbs) });
    }
    if (exit === 3) return validationError('The guarded writer rejected the candidate.', { step: phase, exit });
    return new ProjectionError(500, 'projection_unavailable', 'The guarded writer is unavailable.', { step: phase, exit });
  }

  // ---- run ---------------------------------------------------------------------------

  /**
   * @param {object} args
   * @param {object} args.template marker template
   * @param {object} [args.projection] the projection config (else found by `projectionId` in the template)
   * @param {string} [args.projectionId]
   * @param {object} args.record `{ recordId, markers, reason, actor, receiptAt, templateId, templateRevision, audio?, supersedesRecord? }`
   * @param {object} [args.predecessor] the superseded record (else loaded with deps.loadRecord)
   * @param {string[]} [args.touched] marker ids the operator touched
   * @param {{sha256: string, path?: string, basename?: string, sampleRate: number}} args.audio
   * @param {{root?: string, relPath: string}} [args.target] bypasses deps.locateTarget
   * @param {'preview'|'live'} args.mode
   * @param {boolean} [args.accept]
   * @param {string} [args.expectedTargetSha256] required in live mode
   * @returns {Promise<object>} a preview result, a live receipt, or `{kind, mode, status: 'skipped'}`
   * @throws {ProjectionError}
   */
  async function run(args) {
    const mode = args.mode;
    if (mode !== 'preview' && mode !== 'live') throw new ProjectionError(400, 'invalid_request', 'mode must be preview or live.');
    const projection = resolveProjection(args);
    const rootConfig = assertAuthority(projection);
    const { template } = args;
    const record = args.record || {};
    const audio = { ...(record.audio || {}), ...(args.audio || {}) };
    audio.basename = audio.basename || (audio.path ? path.posix.basename(String(audio.path)) : '');
    const accept = args.accept === true;
    const expected = typeof args.expectedTargetSha256 === 'string' ? args.expectedTargetSha256.toLowerCase() : null;
    if (mode === 'live' && !expected) {
      throw new ProjectionError(400, 'invalid_request', 'expectedTargetSha256 is required for a live projection.');
    }
    if (mode === 'live' && !record.recordId) throw new ProjectionError(400, 'invalid_request', 'A live projection needs the pre-allocated recordId.');
    if (!HEX64.test(String(audio.sha256 || ''))) throw validationError('The audio sha256 is required.', { step: 'audio' });

    let rootReal;
    try {
      rootReal = await fs.realpath(rootConfig.path);
    } catch {
      throw new ProjectionError(409, 'feature_disabled', 'The projection root is not available on this instance.');
    }

    // Step 1: resolve the target, read the bytes once.
    const target = await locate(args, projection, audio);
    const source = await readTarget(rootReal, target.relPath);
    const before = sha256(source.bytes);
    const sourceText = source.bytes.toString('utf8');
    let live;
    try {
      live = yaml.load(sourceText);
    } catch (error) {
      throw validationError('The target is not valid YAML.', { step: 'parse', reason: error && error.name });
    }
    if (!isPlainObject(live)) throw validationError('The target must be a YAML mapping.', { step: 'parse' });

    // Step 2: effective write set.
    const now = (record.receiptAt && !Number.isNaN(new Date(record.receiptAt).getTime())) ? new Date(record.receiptAt) : clock();
    const actor = isPlainObject(record.actor) ? record.actor : {};
    const actorLabel = oneLine(actor.name || actor.id || 'unknown');
    const reasonLine = oneLine(record.reason);
    const recordId = record.recordId || 'preview';
    const n = nextN(live, projection);
    const when = dateWithOffset(now, deps.timezone);
    const textVars = {
      actor: actorLabel, date: when, stamp: stampOf(now), reason: reasonLine, n,
      'audio.basename': audio.basename, 'audio.sha256': audio.sha256, recordId, templateId: template.templateId,
    };
    const sampleRate = Number(audio.sampleRate);
    let predecessor = args.predecessor;
    if (predecessor === undefined && record.supersedesRecord && record.supersedesRecord.id && typeof deps.loadRecord === 'function') {
      predecessor = await deps.loadRecord(record.supersedesRecord.id);
    }
    const plan = planOps({
      template, projection, record, predecessor: predecessor || null, touched: args.touched || record.touched, live, sampleRate, accept,
      vars: { text: textVars },
    });
    if (plan.ops.length === 0) {
      return { kind: KIND, projectionId: projection.id, mode, status: 'skipped', targetSha256After: before };
    }
    if (expected && expected !== before) {
      throw new ProjectionError(409, 'target_conflict', 'The target changed since it was read; reload and retry.', undefined, { currentTargetSha256: before });
    }

    // A1: markers + text + status.
    const a1 = structuredClone(live);
    try {
      for (const op of plan.ops) setAt(a1, op.pointer, op.value);
    } catch (error) {
      throw spliceFailure(error, 'write');
    }

    // Step 3: snapshot and receipt, in memory; paths from receipts.dir.
    const targetDir = path.posix.dirname(source.rel);
    const pathVars = {
      'target.dir': targetDir, 'audio.basename': pathSafe(audio.basename), stamp: textVars.stamp,
      recordId: pathSafe(recordId), templateId: pathSafe(template.templateId),
    };
    const receipts = projection.receipts || {};
    const dirRel = cleanRelative(substituteBraces(receipts.dir || '', pathVars, 'receipts.dir'), 'receipts.dir');
    const snapshotName = suffixName(path.posix.basename(substituteBraces(receipts.snapshot || '', pathVars, 'receipts.snapshot')), recordId);
    const receiptName = suffixName(path.posix.basename(substituteBraces(receipts.receipt || '', pathVars, 'receipts.receipt')), recordId);
    const snapshotRel = cleanRelative(path.posix.join(dirRel, snapshotName), 'receipts.snapshot');
    const receiptRel = cleanRelative(path.posix.join(dirRel, receiptName), 'receipts.receipt');
    const snapshotBytes = source.bytes;
    const snapshotSha = before;
    const receiptText = receiptMarkdown({
      actorLabel, actor, when, reason: String(record.reason || ''), record: { recordId }, template, projection, targetPath: source.rel,
      before, snapshotPath: snapshotRel, writes: plan.writes, ops: plan.ops, sampleRate,
    });
    const receiptBytes = Buffer.from(receiptText, 'utf8');
    const receiptSha = sha256(receiptBytes);

    const dollars = {
      'snapshot.path': snapshotRel, 'snapshot.sha256': snapshotSha, 'receipt.path': receiptRel, 'receipt.sha256': receiptSha,
      'audio.sha256': audio.sha256, 'audio.basename': audio.basename,
    };
    const appendValues = (append, where) => Object.fromEntries(Object.entries(append).map(([key, value]) => [
      key, substituteDollars(substituteBraces(value, textVars, `${where}.${key}`), dollars),
    ]));
    const appends = [];
    if (projection.history) appends.push({ pointer: projection.history.pointer, item: appendValues(projection.history.append, 'history.append') });
    if (projection.evidence) {
      const item = appendValues(projection.evidence.append, 'evidence.append');
      appends.push({ pointer: projection.evidence.pointer, item });
      if (projection.evidence.referenceIn) {
        if (typeof item.id !== 'string') throw validationError('evidence.append needs an id for referenceIn.', { step: 'evidence' });
        appends.push({ pointer: projection.evidence.referenceIn, item: item.id });
      }
    }
    const a2 = structuredClone(a1);
    try {
      for (const entry of appends) appendAt(a2, entry.pointer, entry.item);
    } catch (error) {
      throw spliceFailure(error, 'append');
    }

    // Step 4: declared pointers by the CLI's rule, self-checked.
    const pointers = declaredPointers(live, a2);
    const expectedUnits = new Set();
    for (const op of plan.ops) {
      const current = getAt(live, op.pointer);
      if (!current.found || !deepEqual(current.value, op.value)) expectedUnits.add(collapseToListUnit(live, op.pointer));
    }
    for (const entry of appends) expectedUnits.add(collapseToListUnit(live, entry.pointer));
    const expectedList = [...expectedUnits].sort();
    if (JSON.stringify(expectedList) !== JSON.stringify(pointers)) {
      throw new ProjectionError(500, 'projection_bug', 'The declared change set does not match the template.', { step: 'pointers', derived: pointers, expected: expectedList });
    }
    if (pointers.length === 0) {
      return { kind: KIND, projectionId: projection.id, mode, status: 'skipped', targetSha256After: before };
    }

    // Step 5: byte-splice the candidate and prove it.
    const setOps = plan.ops.map((op) => ({ op: 'set', pointer: op.pointer, token: op.token }));
    const appendOps = appends.map((entry) => ({ op: 'append', pointer: entry.pointer, item: entry.item }));
    let full;
    let markersOnly;
    try {
      full = applyOps(sourceText, [...setOps, ...appendOps]);
      markersOnly = applyOps(sourceText, setOps);
    } catch (error) {
      throw spliceFailure(error, 'splice');
    }
    const proofFull = proveCandidate(sourceText, full.text, a2, { edits: full.edits });
    const proofMarkers = proveCandidate(sourceText, markersOnly.text, a1, { edits: markersOnly.edits });
    if (!proofFull.equal || !proofFull.bounded || !proofMarkers.equal || !proofMarkers.bounded) {
      throw new ProjectionError(500, 'projection_bug', 'The candidate failed its proof.', {
        step: 'proof', equal: proofFull.equal && proofMarkers.equal, bounded: proofFull.bounded && proofMarkers.bounded,
      });
    }
    const candidateSha = sha256(Buffer.from(full.text, 'utf8'));
    const written = [...new Set(plan.writes.map((write) => write.marker.id))];

    // Steps 6-7 share transient candidate files under <root>/.lookie-tmp/.
    const tmpBase = path.join(rootReal, TMP_DIR);
    let tmpAbs = null;
    const ctx = {
      pointers, rootReal, get tmpAbs() { return tmpAbs; }, currentSha: () => before,
    };
    const created = [];
    const createdDirs = [];
    const cleanupFiles = async () => {
      for (const file of created.reverse()) await fs.rm(file, { force: true }).catch((error) => warn('Cleanup of a projection file failed.', { error: error.message }));
      for (const dir of createdDirs.reverse()) await fs.rmdir(dir).catch(() => {});
    };
    try {
      await assertAncestorInside(rootReal, tmpBase);
      await fs.mkdir(tmpBase, { recursive: true, mode: 0o700 });
      tmpAbs = await fs.mkdtemp(path.join(tmpBase, 'run-'));
      const fullPath = path.join(tmpAbs, 'full', path.basename(source.rel));
      const markersPath = path.join(tmpAbs, 'markers', path.basename(source.rel));
      await fs.mkdir(path.dirname(fullPath), { mode: 0o700 });
      await fs.mkdir(path.dirname(markersPath), { mode: 0o700 });
      await fs.writeFile(fullPath, full.text, { mode: 0o600 });

      if (mode === 'preview') {
        await fs.writeFile(markersPath, markersOnly.text, { mode: 0o600 });
        const validatorExit = await runValidator(projection, markersPath, rootReal); // advisory in preview
        const dry = await exec(deps.yamlToolPath, applyArgs(source.abs, fullPath, before, pointers, false), timeoutMs);
        if (dry.exit !== 0) {
          if (dry.exit === 4) {
            const current = await fs.readFile(source.abs).then(sha256).catch(() => null);
            ctx.currentSha = () => current;
          }
          throw refusalFor(dry.exit, 'dry_run', dry.stderr, ctx);
        }
        return {
          kind: KIND,
          projectionId: projection.id,
          mode: 'preview',
          status: 'preview',
          targetPath: source.rel,
          before,
          candidateSha256: candidateSha,
          pointers,
          diff: proofFull.hunks,
          validator: { exit: validatorExit, scope: 'markers-only', advisory: true },
          appends: 'validated on save',
          cli: { dryRunExit: dry.exit },
          written,
        };
      }

      // Step 7 (live): snapshot and receipt first, exclusive create.
      const dirAbs = path.join(rootReal, dirRel);
      await assertAncestorInside(rootReal, dirAbs);
      await mkdirTracked(dirAbs, createdDirs);
      if (!(await realpathInside(rootReal, dirAbs))) throw validationError('The receipts directory resolves outside the root.', { step: 'receipts' });
      const snapshotAbs = path.join(rootReal, snapshotRel);
      const receiptAbs = path.join(rootReal, receiptRel);
      for (const [file, bytes] of [[snapshotAbs, snapshotBytes], [receiptAbs, receiptBytes]]) {
        try {
          await writeExclusive(file, bytes, source.mode || 0o644);
          created.push(file);
        } catch (error) {
          if (error && error.code === 'EEXIST') {
            throw new ProjectionError(500, 'projection_bug', 'A snapshot or receipt file already exists.', { step: 'snapshot' });
          }
          throw error;
        }
      }
      if (sha256(await fs.readFile(snapshotAbs)) !== snapshotSha || sha256(await fs.readFile(receiptAbs)) !== receiptSha) {
        throw new ProjectionError(500, 'projection_bug', 'A snapshot or receipt file did not read back as written.', { step: 'snapshot' });
      }

      const candidateExit = await runValidator(projection, fullPath, rootReal);
      if (projection.validator && candidateExit !== 0) {
        throw candidateExit === null
          ? new ProjectionError(500, 'projection_unavailable', 'The validator could not be run.', { step: 'validator' })
          : validationError('The validator refused the candidate.', { step: 'validator', exit: candidateExit, scope: 'full' });
      }
      const dry = await exec(deps.yamlToolPath, applyArgs(source.abs, fullPath, before, pointers, false), timeoutMs);
      if (dry.exit !== 0) {
        if (dry.exit === 4) {
          const current = await fs.readFile(source.abs).then(sha256).catch(() => null);
          ctx.currentSha = () => current;
        }
        throw refusalFor(dry.exit, 'dry_run', dry.stderr, ctx);
      }
      // From here nothing is deleted.
      created.length = 0;
      createdDirs.length = 0;

      const liveRun = await exec(deps.yamlToolPath, applyArgs(source.abs, fullPath, before, pointers, true), liveTimeoutMs);
      if ([2, 3, 4, 5].includes(liveRun.exit)) {
        if (liveRun.exit === 4) {
          const current = await fs.readFile(source.abs).then(sha256).catch(() => null);
          ctx.currentSha = () => current;
        }
        throw refusalFor(liveRun.exit, 'apply', liveRun.stderr, ctx);
      }

      let readback = null;
      try {
        readback = sha256(await fs.readFile(source.abs));
      } catch (error) {
        warn('Readback after apply failed.', { error: error.message });
      }
      let postExit = null;
      if (liveRun.exit === 0 && readback === candidateSha && projection.validator) {
        postExit = await runValidator(projection, source.abs, rootReal).catch(() => null);
      }
      const applied = liveRun.exit === 0 && readback === candidateSha && (!projection.validator || postExit === 0);
      return {
        kind: KIND,
        projectionId: projection.id,
        mode: 'live',
        status: applied ? 'applied' : 'uncertain',
        ...(applied ? {} : { note: liveRun.exit === 9 ? 'destination changed after replace; nothing restored' : 'the outcome of the write could not be confirmed; nothing restored' }),
        targetPath: source.rel,
        before,
        after: candidateSha,
        pointers,
        snapshot: { path: snapshotRel, sha256: snapshotSha },
        receipt: { path: receiptRel, sha256: receiptSha },
        validator: { exit: projection.validator ? (postExit === null ? candidateExit : postExit) : null, scope: 'full', candidateExit },
        cli: { dryRunExit: dry.exit, liveExit: liveRun.exit },
        written,
        targetSha256After: readback,
      };
    } catch (error) {
      await cleanupFiles(); // empty after --live was spawned
      throw error;
    } finally {
      if (tmpAbs) await fs.rm(tmpAbs, { recursive: true, force: true }).catch(() => {});
      await fs.rmdir(tmpBase).catch(() => {});
    }
  }

  return { kind: KIND, run };
}

module.exports = { createYamlPointersProjection, ProjectionError, formatPointer, parsePointer };
