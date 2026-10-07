'use strict';

// Source resolver for marker templates (design §3.1, §3.2, §6).
//
// A template's `sources` name read-only overlays pulled from a "target" file
// (found by a glob plus an identity match) and from artifacts the target links
// to (`pathFrom`). Everything is resolved under the configured `markers.roots`;
// every data-derived path must be relative, free of `..`, and contained by the
// root after symlink resolution. Nothing here ever returns an absolute path
// except through the two non-enumerable `target` properties documented on
// `locateTarget`.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

const { expandHome, safeResolve } = require('../path-utils');
const { select, selectFirst, toSamples } = require('./selectors');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 500;
const MAX_ENTRIES = 50000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const RESERVED_DIRS = new Set(['.history', '.lookie-tmp']);
const WILDCARD_MARK = '\u0001';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Receipts directories of the template's yaml-pointers projections, as
 * matchers for root-relative paths under the receipts directory that belongs
 * to the target at `targetRel`. `{target.dir}` becomes the target's directory;
 * every other `{...}` (`{audio.basename}`, `{stamp}`, `{recordId}`,
 * `{templateId}`, anything else) matches any single path segment.
 */
function receiptsMatchers(template, targetRel) {
  const targetDir = path.posix.dirname(targetRel);
  const matchers = [];
  for (const projection of Array.isArray(template && template.projections) ? template.projections : []) {
    const dir = projection && projection.kind === 'yaml-pointers' && projection.receipts && projection.receipts.dir;
    if (typeof dir !== 'string' || dir === '') continue;
    const filled = dir.replace(/\{([^{}]*)\}/g, (_, name) => (name === 'target.dir' ? (targetDir === '.' ? '' : targetDir) : WILDCARD_MARK));
    const normalized = path.posix.normalize(filled.replace(/^\/+/, ''));
    if (normalized === '..' || normalized.startsWith('../')) continue;
    const base = normalized === '.' ? '' : normalized.replace(/\/+$/, '');
    const pattern = base.split(WILDCARD_MARK).map(escapeRegExp).join('[^/]+');
    matchers.push(new RegExp(base === '' ? '^' : `^${pattern}/`));
  }
  return matchers;
}

/**
 * A projection's snapshot is a verbatim copy of its target, so it carries the
 * same match value. Drop matches inside a `.history` / `.lookie-tmp` directory
 * and matches under another match's receipts directory (design review 2, N4).
 */
function dropReceiptCopies(matches, template) {
  const real = matches.filter((file) => !path.posix.dirname(file.relPath).split('/').some((part) => RESERVED_DIRS.has(part)));
  return real.filter((file) => !real.some((other) => other !== file
    && receiptsMatchers(template, other.relPath).some((matcher) => matcher.test(file.relPath))));
}

function ambiguousError() {
  const error = new Error('More than one file matches the target locator.');
  error.status = 409;
  error.code = 'ambiguous_target';
  return error;
}

/**
 * A data-derived path is acceptable only when it is relative, has no `..`
 * segment and no backslash, NUL or drive prefix. Returns the normalized
 * posix path or null.
 */
function normalizeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return null;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

function normalizeRoots(roots) {
  const map = new Map();
  for (const [alias, entry] of Object.entries(roots || {})) {
    const rootPath = typeof entry === 'string' ? entry : entry && entry.path;
    if (typeof rootPath === 'string' && rootPath) map.set(alias, expandHome(rootPath));
  }
  return map;
}

function parseDocument(text, kind) {
  if (kind === 'json') return JSON.parse(text);
  return yaml.load(text, { schema: yaml.CORE_SCHEMA });
}

function substitute(template, audio) {
  const values = { '$audio.sha256': audio && audio.sha256, '$audio.basename': audio && audio.basename };
  let missing = false;
  const result = String(template).replace(/\$audio\.(sha256|basename)/g, (token) => {
    const value = values[token];
    if (typeof value !== 'string' || value === '') {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : result;
}

function itemField(item, key) {
  if (typeof key !== 'string') return undefined;
  if (key.startsWith('/')) return selectFirst(item, key);
  if (item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.prototype.hasOwnProperty.call(item, key)) return item[key];
  return undefined;
}

function labelText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : undefined;
}

/**
 * @param {object} options
 * @param {Record<string, string|{path: string}>} options.roots alias -> directory (the `markers.roots` map)
 * @param {number} [options.maxFileBytes] read bound, default 8 MiB
 */
function createSourceResolver({ roots, maxFileBytes = MAX_FILE_BYTES } = {}) {
  const rootMap = normalizeRoots(roots);

  async function readDataFile(alias, relInput, kind) {
    const rel = normalizeRelative(relInput);
    const rootPath = rootMap.get(alias);
    if (!rel) return { ok: false, reason: 'unsafe path' };
    if (!rootPath) return { ok: false, reason: 'unknown root' };
    let abs;
    let stat;
    try {
      abs = await safeResolve(rootPath, rel);
      stat = await fs.stat(abs);
    } catch (error) {
      if (error && error.code === 'EACCES') return { ok: false, reason: 'outside root' };
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }
    if (!stat.isFile()) return { ok: false, reason: 'missing' };
    if (stat.size > maxFileBytes) return { ok: false, reason: 'too large' };
    let bytes;
    try {
      const handle = await fs.open(abs, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, maxFileBytes) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (bytes.length > maxFileBytes) return { ok: false, reason: 'too large' };
    let doc;
    try {
      doc = parseDocument(bytes.toString('utf8'), kind);
    } catch {
      return { ok: false, reason: 'unparseable' };
    }
    return {
      ok: true,
      root: alias,
      relPath: rel,
      abs,
      doc,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mtimeMs: stat.mtimeMs,
    };
  }

  const REASON_TEXT = {
    'unsafe path': 'a path in the data is not a relative path inside the root (not followed)',
    'outside root': 'a path in the data leaves the root (not followed)',
    'unknown root': 'the source names a root that is not configured',
    missing: 'file not found',
    'too large': 'file is too large to read',
    unparseable: 'file could not be parsed',
    unreadable: 'file could not be read',
  };

  // Candidate relative paths for a glob with at most one `*` directory segment.
  async function globCandidates(alias, glob) {
    const rel = normalizeRelative(glob);
    if (!rel) return { error: 'unsafe path' };
    const segments = rel.split('/');
    const wild = segments.map((segment, index) => (segment.includes('*') ? index : -1)).filter((index) => index >= 0);
    if (wild.length === 0) return { candidates: [rel] };
    if (wild.length > 1 || segments[wild[0]] !== '*' || wild[0] === segments.length - 1) return { error: 'unsupported glob' };
    const rootPath = rootMap.get(alias);
    if (!rootPath) return { error: 'unknown root' };
    const prefix = segments.slice(0, wild[0]).join('/');
    const suffix = segments.slice(wild[0] + 1).join('/');
    let names;
    try {
      const dir = await safeResolve(rootPath, prefix);
      names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return { candidates: [] };
    }
    return { candidates: names.slice(0, MAX_CANDIDATES).map((name) => [prefix, name, suffix].filter(Boolean).join('/')) };
  }

  async function locate(state, source) {
    const { locate: locator } = source;
    const expected = substitute(locator.match.equals, state.audio);
    if (expected === null) return { ok: false, message: 'the audio identity needed to find the target is unavailable' };
    const globbed = await globCandidates(source.root, locator.glob);
    if (globbed.error) return { ok: false, message: REASON_TEXT[globbed.error] || 'the locator glob is not supported' };
    const foldCase = String(locator.match.equals).includes('$audio.sha256');
    const matches = [];
    let unreadable = 0;
    for (const candidate of globbed.candidates) {
      const file = await readDataFile(source.root, candidate, source.kind);
      if (!file.ok) {
        if (file.reason === 'unparseable' || file.reason === 'unreadable' || file.reason === 'too large') unreadable += 1;
        continue;
      }
      const found = select(file.doc, locator.match.pointer).some((hit) => {
        if (hit.value === null || typeof hit.value === 'object') return false;
        const actual = String(hit.value);
        return foldCase ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
      });
      if (found) matches.push(file);
    }
    const targets = dropReceiptCopies(matches, state.template);
    if (targets.length > 1) throw ambiguousError();
    if (targets.length === 0) {
      const suffix = unreadable > 0 ? ` (${unreadable} candidate file${unreadable === 1 ? '' : 's'} could not be read)` : '';
      return { ok: false, message: `no target found${suffix}` };
    }
    return targets[0];
  }

  function newState(template, audio) {
    const sources = Array.isArray(template && template.sources) ? template.sources : [];
    return {
      template: template || {},
      audio: audio || {},
      sources,
      byId: new Map(sources.map((source) => [source.id, source])),
      files: new Map(),
      visiting: new Set(),
      problems: [],
    };
  }

  function loadSource(state, source) {
    if (!state.files.has(source.id)) state.files.set(source.id, loadUncached(state, source));
    return state.files.get(source.id);
  }

  async function loadDependency(state, id) {
    const dependency = state.byId.get(id);
    if (!dependency || state.visiting.has(id)) return null;
    const file = await loadSource(state, dependency);
    return file.ok ? file : null;
  }

  async function loadUncached(state, source) {
    const fail = (message) => {
      state.problems.push({ sourceId: source.id, message });
      return { ok: false };
    };
    state.visiting.add(source.id);
    try {
      if (typeof source.from === 'string') {
        const file = await loadDependency(state, source.from);
        return file ? { ...file } : { ok: false };
      }
      if (source.locate) {
        if (typeof source.root !== 'string') return fail('the source names no root');
        const found = await locate(state, source);
        return found.ok === false ? fail(found.message) : found;
      }
      if (source.pathFrom !== undefined) {
        const origin = typeof source.pathFrom === 'string' ? source.from : source.pathFrom.source;
        const pointer = typeof source.pathFrom === 'string' ? source.pathFrom : source.pathFrom.pointer;
        const holder = typeof origin === 'string' ? await loadDependency(state, origin) : null;
        if (!holder) return typeof origin === 'string' ? { ok: false } : fail('pathFrom names no source');
        const linked = selectFirst(holder.doc, pointer);
        if (linked === undefined || linked === null) return fail('no linked file path found in the source file');
        const file = await readDataFile(source.root || holder.root, linked, source.kind);
        return file.ok ? file : fail(REASON_TEXT[file.reason]);
      }
      return fail('the source has no way to find a file');
    } finally {
      state.visiting.delete(source.id);
    }
  }

  function overlayFor(state, source, file) {
    const selector = source.select;
    const as = source.as || {};
    const kind = as.kind || (selector.start && selector.end ? 'region' : 'point');
    const unit = selector.unit || 'samples';
    const out = {
      id: source.id,
      as: { kind, ...(as.label ? { label: as.label } : {}), ...(as.color ? { color: as.color } : {}), ...(as.style ? { style: as.style } : {}) },
      points: [],
      regions: [],
    };
    const problem = (message) => { state.problems.push({ sourceId: source.id, message }); };
    const hits = select(file.doc, selector.pointer);
    if (hits.length === 0) {
      problem('no values found in the source file');
      return out;
    }
    if (unit !== 'samples' && !(state.audio.sampleRate > 0)) {
      problem('the sample rate needed to convert this source is unavailable');
      return out;
    }
    let skipped = 0;
    for (const { value: item } of hits.slice(0, MAX_ENTRIES)) {
      const label = labelText(itemField(item, selector.label));
      const extra = label === undefined ? {} : { label };
      if (kind === 'region') {
        const pair = Array.isArray(item) ? item : [itemField(item, selector.start), itemField(item, selector.end)];
        const start = toSamples(pair[0], unit, state.audio.sampleRate);
        const end = toSamples(pair[1], unit, state.audio.sampleRate);
        if (start === null || end === null || end < start) skipped += 1;
        else out.regions.push({ startSample: start, endSample: end, ...extra });
      } else {
        const raw = selector.start ? itemField(item, selector.start) : item;
        const sample = toSamples(raw, unit, state.audio.sampleRate);
        if (sample === null) skipped += 1;
        else out.points.push({ sample, ...extra });
      }
    }
    if (hits.length > MAX_ENTRIES) problem(`only the first ${MAX_ENTRIES} entries are shown`);
    if (skipped > 0) problem(`${skipped} entr${skipped === 1 ? 'y' : 'ies'} could not be converted to a position`);
    out.points.sort((a, b) => a.sample - b.sample);
    out.regions.sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample);
    return out;
  }

  // One marker `read` -> sample | {startSample,endSample} | undefined (problem recorded).
  function readValue(state, marker, source, file) {
    const unit = (source.select && source.select.unit) || 'samples';
    const rate = state.audio.sampleRate;
    const hit = select(file.doc, marker.read.pointer)[0];
    const problem = (message) => { state.problems.push({ sourceId: source.id, markerId: marker.id, message }); };
    if (!hit) return problem(`no value found for marker "${marker.id}"`);
    const raw = hit.value;
    let pair = null;
    if (Array.isArray(raw) && raw.length === 2) pair = raw;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const start = raw.startSample !== undefined ? raw.startSample : raw.start;
      const end = raw.endSample !== undefined ? raw.endSample : raw.end;
      if (start !== undefined && end !== undefined) pair = [start, end];
    }
    if (pair) {
      const start = toSamples(pair[0], unit, rate);
      const end = toSamples(pair[1], unit, rate);
      if (start === null || end === null || end < start) return problem(`value for marker "${marker.id}" could not be converted`);
      if (marker.kind !== 'region') return problem(`value for marker "${marker.id}" is a region but the marker is a point`);
      return { startSample: start, endSample: end };
    }
    const sample = toSamples(raw, unit, rate);
    if (sample === null) return problem(`value for marker "${marker.id}" could not be converted`);
    if (marker.kind === 'region') return problem(`value for marker "${marker.id}" is a position but the marker is a region`);
    return sample;
  }

  async function resolveImage(state) {
    const image = state.template.image;
    if (!image) return null;
    const declared = state.byId.get(image.source);
    const holder = declared ? await loadDependency(state, declared.id) : null;
    if (!holder) return null;
    const problem = (message) => { state.problems.push({ sourceId: 'image', message }); return null; };
    const linked = selectFirst(holder.doc, image.pathFrom);
    if (linked === undefined || linked === null) return problem('no image path found in the source file');
    const rel = normalizeRelative(linked);
    if (!rel) return problem(REASON_TEXT['unsafe path']);
    if (!IMAGE_EXTENSIONS.has(path.posix.extname(rel).toLowerCase())) return problem('the image path is not an image file');
    try {
      const abs = await safeResolve(rootMap.get(holder.root), rel);
      if (!(await fs.stat(abs)).isFile()) return problem(REASON_TEXT.missing);
    } catch (error) {
      return problem(error && error.code === 'EACCES' ? REASON_TEXT['outside root'] : REASON_TEXT.missing);
    }
    const plot = image.plot
      ? { left: image.plot.left, right: image.plot.right, top: image.plot.top, bottom: image.plot.bottom }
      : null;
    return { root: holder.root, relPath: rel, plot };
  }

  function publicTarget(file) {
    const target = { root: file.root, relPath: file.relPath, sha256: file.sha256, size: file.size, mtimeMs: file.mtimeMs };
    // Server-internal: never serialized (non-enumerable), never to a client.
    Object.defineProperty(target, 'absPath', { value: file.abs, enumerable: false });
    Object.defineProperty(target, 'doc', { value: file.doc, enumerable: false });
    return target;
  }

  /**
   * Resolve everything a template's sources describe for one audio file.
   * Throws `{status: 409, code: 'ambiguous_target'}` when a locator matches
   * more than one file; every other failure becomes a neutral entry in `problems`.
   *
   * @param {{template: object, audio: {sha256?: string, basename?: string, sampleRate?: number, frames?: number}}} input
   * @returns {Promise<{
   *   target: {root: string, relPath: string, sha256: string, size: number, mtimeMs: number}|null,
   *   targetSha256: string|null,
   *   sources: Array<{id: string, as: object, points: Array<{sample: number, label?: string}>, regions: Array<{startSample: number, endSample: number, label?: string}>}>,
   *   reads: Record<string, number|{startSample: number, endSample: number}>,
   *   targetValues: Record<string, number|{startSample: number, endSample: number}>,
   *   image: {root: string, relPath: string, plot: {left: number, right: number, top: number, bottom: number}|null}|null,
   *   projections: Array<{id: string, kind: string, label: string}>,
   *   problems: Array<{sourceId: string, markerId?: string, message: string}>
   * }>}
   */
  async function resolveContext({ template, audio } = {}) {
    const state = newState(template, audio);
    const overlays = [];
    for (const source of state.sources) {
      const file = await loadSource(state, source);
      if (file.ok && source.select) overlays.push(overlayFor(state, source, file));
    }
    const reads = {};
    for (const marker of Array.isArray(state.template.markers) ? state.template.markers : []) {
      if (!marker.read) continue;
      const source = state.byId.get(marker.read.source);
      const file = source ? await loadSource(state, source) : null;
      if (!file || !file.ok) continue;
      const value = readValue(state, marker, source, file);
      if (value !== undefined) reads[marker.id] = value;
    }
    const image = await resolveImage(state);
    const targetSource = state.byId.get('target') || state.sources.find((source) => source.locate);
    const targetFile = targetSource ? await loadSource(state, targetSource) : null;
    const target = targetFile && targetFile.ok ? publicTarget(targetFile) : null;
    const projections = (Array.isArray(state.template.projections) ? state.template.projections : [])
      .map((projection) => ({ id: projection.id, kind: projection.kind, label: projection.label || projection.id }));
    return {
      target,
      targetSha256: target ? target.sha256 : null,
      sources: overlays,
      reads,
      targetValues: { ...reads },
      image,
      projections,
      problems: state.problems,
    };
  }

  /**
   * Locate one source's file (typically a projection's `target` source).
   * Throws `{status: 409, code: 'ambiguous_target'}` on more than one match.
   *
   * @param {object} template marker template
   * @param {string|object} source a declared source id, or a source object
   * @param {{sha256?: string, basename?: string}} audio
   * @returns {Promise<{target: null|{root: string, relPath: string, sha256: string, size: number, mtimeMs: number}, problem: string|null}>}
   *   `target.sha256` is the hash of the bytes read now (the expected-sha for a write).
   *   `target.absPath` and `target.doc` (parsed content) are NON-ENUMERABLE: usable
   *   server-side, absent from JSON.stringify and object spread.
   */
  async function locateTarget(template, source, audio) {
    const state = newState(template, audio);
    const declared = typeof source === 'string' ? state.byId.get(source) : source;
    if (!declared || typeof declared.id !== 'string') return { target: null, problem: 'unknown source' };
    if (!state.byId.has(declared.id)) state.byId.set(declared.id, declared);
    const file = await loadSource(state, declared);
    if (file.ok) return { target: publicTarget(file), problem: null };
    const own = state.problems.find((entry) => entry.sourceId === declared.id) || state.problems[0];
    return { target: null, problem: own ? own.message : 'source could not be resolved' };
  }

  return { resolveContext, locateTarget };
}

module.exports = { createSourceResolver, normalizeRelative, MAX_FILE_BYTES };
