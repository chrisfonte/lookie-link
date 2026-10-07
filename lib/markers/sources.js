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
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');

const { expandHome, safeResolve } = require('../path-utils');
const { select, selectFirst, toSamples } = require('./selectors');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_INDEX_MAX = 200000;
const DEFAULT_REFRESH_SECONDS = 60;
const MAX_GLOBS = 16;
const MAX_INDEXES = 16;
const MAX_KEYS_PER_FILE = 64;
const MAX_CONFIRMED = 64;
const DIR_CONCURRENCY = 16;
const SLICE_MS = 8;
const MAX_ENTRIES = 50000;
const DEFAULT_DOCUMENT_BYTES = 65536;
const DETAIL_TEXT_CHARS = 2000;
const DETAIL_LIST_ITEMS = 200;
const DETAIL_ITEM_CHARS = 500;
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

/**
 * The `locate.glob` grammar: one glob or a list of up to 16. Each glob is a
 * relative path whose segments (directories and the file name) may carry `*`
 * (any characters inside one segment, never a leading dot). No `**`, no `?`,
 * no other glob characters.
 */
function parseGlobs(input) {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0 || list.length > MAX_GLOBS) return { error: 'unsupported glob' };
  const globs = [];
  for (const text of list) {
    const rel = normalizeRelative(text);
    if (!rel) return { error: 'unsafe path' };
    const segments = [];
    for (const part of rel.split('/')) {
      if (/[?[\]{}]/.test(part) || part.includes('**')) return { error: 'unsupported glob' };
      segments.push(part.includes('*')
        ? { text: part, re: new RegExp(`^${part.split('*').map(escapeRegExp).join('[^/]*')}$`) }
        : { text: part, re: null });
    }
    globs.push({ text: rel, segments, literal: segments.every((segment) => !segment.re) });
  }
  return { globs };
}

// The final key of a match pointer, as a literal every matching file must contain.
function pointerKeyName(pointer) {
  const last = String(pointer).split('/').pop();
  const open = last.indexOf('[');
  const key = (open === -1 ? last : last.slice(0, open)).replace(/~1/g, '/').replace(/~0/g, '~');
  return key.length > 0 ? key : null;
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

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

function isScalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// A compact, human-readable rendering: scalars as text, containers as YAML.
function compactYaml(value) {
  try {
    return yaml.dump(value, { lineWidth: 120, noRefs: true, skipInvalid: true, schema: yaml.CORE_SCHEMA }).trimEnd();
  } catch {
    return null;
  }
}

function detailText(value) {
  if (isScalar(value)) return String(value);
  return compactYaml(value);
}

/** One detail's value for its kind, or undefined when the pointer yields nothing usable. */
function detailValue(doc, pointer, kind) {
  const hits = select(doc, pointer).map((hit) => hit.value).filter((value) => value !== undefined && value !== null);
  if (hits.length === 0) return undefined;
  if (kind === 'number') {
    const raw = hits[0];
    const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
  }
  if (kind === 'list') {
    const items = hits.length === 1 && Array.isArray(hits[0]) ? hits[0] : hits;
    const texts = items.map(detailText).filter((text) => typeof text === 'string');
    return texts.slice(0, DETAIL_LIST_ITEMS).map((text) => clip(text, DETAIL_ITEM_CHARS));
  }
  const text = kind === 'yaml' ? compactYaml(hits[0]) : detailText(hits[0]);
  return typeof text === 'string' ? clip(text, DETAIL_TEXT_CHARS) : undefined;
}

function labelText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : undefined;
}

/**
 * @param {object} options
 * @param {Record<string, string|{path: string}>} options.roots alias -> directory (the `markers.roots` map)
 * @param {number} [options.maxFileBytes] read bound, default 8 MiB
 * @param {number} [options.locateRefreshSeconds] longest age of a locate index before it is rebuilt, default 60
 * @param {number} [options.locateIndexMax] most candidate files one locator may cover, default 200000
 * @param {() => number} [options.now] clock in milliseconds (tests)
 */
function createSourceResolver({
  roots,
  maxFileBytes = MAX_FILE_BYTES,
  locateRefreshSeconds = DEFAULT_REFRESH_SECONDS,
  locateIndexMax = DEFAULT_INDEX_MAX,
  now = Date.now,
} = {}) {
  const rootMap = normalizeRoots(roots);
  const refreshMs = Math.max(0, Number(locateRefreshSeconds)) * 1000;
  const indexMax = Math.max(1, Math.floor(Number(locateIndexMax)));

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

  // A bounded read of a text file under a root. The file is cut at `maxBytes`
  // (`truncated`) rather than refused; a binary file is refused.
  async function readTextFile(alias, relInput, maxBytes) {
    const rel = normalizeRelative(relInput);
    const rootPath = rootMap.get(alias);
    if (!rel) return { ok: false, reason: 'unsafe path' };
    if (!rootPath) return { ok: false, reason: 'unknown root' };
    try {
      const abs = await safeResolve(rootPath, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { ok: false, reason: 'missing' };
      const handle = await fs.open(abs, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.includes(0)) return { ok: false, reason: 'not text' };
        const truncated = stat.size > maxBytes;
        let text = bytes.toString('utf8');
        if (truncated) text = text.replace(/\uFFFD+$/, '');
        return { ok: true, relPath: rel, text, truncated };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && error.code === 'EACCES') return { ok: false, reason: 'outside root' };
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }
  }

  const REASON_TEXT = {
    'unsafe path': 'a path in the data is not a relative path inside the root (not followed)',
    'outside root': 'a path in the data leaves the root (not followed)',
    'unknown root': 'the source names a root that is not configured',
    missing: 'file not found',
    'too large': 'file is too large to read',
    unparseable: 'file could not be parsed',
    unreadable: 'file could not be read',
    'too many candidates': 'too many candidates match the locator glob; narrow it',
    'index failed': 'the locator index could not be built',
    'not text': 'file is not a text file',
  };

  // ---- Locator: glob grammar, bounded walk, per-root locate index ----

  const indexes = new Map();

  function tooManyError() {
    const error = new Error('too many candidates');
    error.tooMany = true;
    return error;
  }

  function insideRoot(realRoot, real) {
    return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`);
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const at = next;
        next += 1;
        results[at] = await fn(items[at], at);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // One wildcard level: the matching, non-dot names inside `entry`. `last`
  // levels return files, the others directories. A symlink is followed only
  // when it stays inside the root.
  async function listLevel(realRoot, entry, segment, last, dirs) {
    let names;
    try {
      if (!entry.checked && !insideRoot(realRoot, await fs.realpath(entry.abs))) return [];
      names = await fs.readdir(entry.abs, { withFileTypes: true });
      dirs.set(entry.abs, (await fs.stat(entry.abs)).mtimeMs);
    } catch {
      return [];
    }
    const found = [];
    for (const dirent of names) {
      if (dirent.name.startsWith('.') || !segment.re.test(dirent.name)) continue;
      const abs = path.join(entry.abs, dirent.name);
      let isDirectory = dirent.isDirectory();
      let isFile = dirent.isFile();
      if (dirent.isSymbolicLink()) {
        try {
          const real = await fs.realpath(abs);
          if (!insideRoot(realRoot, real)) continue;
          const stat = await fs.stat(real);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (last ? isFile : isDirectory) found.push({ rel: entry.rel ? `${entry.rel}/${dirent.name}` : dirent.name, abs, checked: true });
    }
    return found.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  }

  // Candidate files for every glob (relative path -> absolute path) and the
  // directories listed on the way (absolute path -> mtime). Throws `tooMany`
  // as soon as any level or the union exceeds `cap`; never returns a partial set.
  async function walkCandidates(realRoot, globs, cap, dirs) {
    const candidates = new Map();
    for (const glob of globs) {
      let level = [{ rel: '', abs: realRoot, checked: true }];
      for (let i = 0; i < glob.segments.length; i += 1) {
        const segment = glob.segments[i];
        const last = i === glob.segments.length - 1;
        if (!segment.re) {
          level = level.map((entry) => ({ rel: entry.rel ? `${entry.rel}/${segment.text}` : segment.text, abs: path.join(entry.abs, segment.text), checked: false }));
          continue;
        }
        const listed = await mapLimit(level, DIR_CONCURRENCY, (entry) => listLevel(realRoot, entry, segment, last, dirs));
        level = [];
        for (const group of listed) {
          for (const entry of group) level.push(entry);
          if (level.length > cap) throw tooManyError();
        }
      }
      for (const entry of level) candidates.set(entry.rel, entry.abs);
      if (candidates.size > cap) throw tooManyError();
    }
    return candidates;
  }

  function matchValueKeys(doc, pointer) {
    const keys = new Set();
    for (const hit of select(doc, pointer)) {
      if (hit.value === null || hit.value === undefined || typeof hit.value === 'object') continue;
      keys.add(String(hit.value).toLowerCase());
      if (keys.size >= MAX_KEYS_PER_FILE) break;
    }
    return [...keys];
  }

  const UNREADABLE = Object.freeze({ mtimeMs: 0, size: 0, unreadable: true, keys: [] });

  // One candidate's index entry, or null when it is missing, not a regular
  // file or resolves outside the root. An unchanged `previous` entry is reused.
  // Synchronous on purpose: tens of thousands of tiny files are several times
  // faster without a thread-pool round trip each; `rebuildIndex` yields to the
  // event loop between short slices.
  function indexFile(index, realRoot, abs, previous) {
    if (previous && !previous.unreadable) {
      try {
        const stat = fsSync.statSync(abs);
        if (stat.mtimeMs === previous.mtimeMs && stat.size === previous.size) return previous;
      } catch {
        return null;
      }
    }
    let real;
    try {
      real = fsSync.realpathSync.native(abs);
    } catch (error) {
      return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? null : UNREADABLE;
    }
    if (!insideRoot(realRoot, real)) return null;
    let fd;
    try {
      fd = fsSync.openSync(real, 'r');
    } catch {
      return UNREADABLE;
    }
    try {
      const stat = fsSync.fstatSync(fd);
      if (!stat.isFile()) return null;
      const entry = { mtimeMs: stat.mtimeMs, size: stat.size, unreadable: false, keys: [] };
      if (stat.size > maxFileBytes) return { ...entry, unreadable: true };
      const buffer = Buffer.allocUnsafe(stat.size);
      const bytesRead = fsSync.readSync(fd, buffer, 0, stat.size, 0);
      const text = buffer.toString('utf8', 0, bytesRead);
      // Cheap pre-filter: a file that never mentions the key cannot hold the value.
      if (index.keyName && !text.includes(index.keyName)) return entry;
      try {
        entry.keys = matchValueKeys(parseDocument(text, index.kind), index.pointer);
      } catch {
        entry.unreadable = true;
      }
      return entry;
    } catch {
      return UNREADABLE;
    } finally {
      fsSync.closeSync(fd);
    }
  }

  async function rebuildIndex(index) {
    const rootPath = rootMap.get(index.alias);
    const dirs = new Map();
    const files = new Map();
    let error = null;
    let realRoot = null;
    try {
      realRoot = await fs.realpath(rootPath);
    } catch {
      realRoot = null;
    }
    if (realRoot) {
      try {
        const candidates = await walkCandidates(realRoot, index.globs, indexMax, dirs);
        let sliceStart = performance.now();
        for (const [rel, abs] of candidates) {
          const entry = indexFile(index, realRoot, abs, index.files.get(rel));
          if (entry) files.set(rel, entry);
          if (performance.now() - sliceStart > SLICE_MS) {
            await new Promise((resolve) => { setImmediate(resolve); });
            sliceStart = performance.now();
          }
        }
      } catch (caught) {
        if (!caught || !caught.tooMany) throw caught;
        error = 'too many candidates';
        files.clear();
      }
    }
    const byValue = new Map();
    let unreadable = 0;
    for (const [rel, entry] of files) {
      if (entry.unreadable) unreadable += 1;
      for (const key of entry.keys) {
        const list = byValue.get(key);
        if (list) list.push(rel);
        else byValue.set(key, [rel]);
      }
    }
    Object.assign(index, { dirs, files, byValue, unreadable, error, builtAt: now() });
  }

  async function directoriesChanged(index) {
    const changed = await mapLimit([...index.dirs], DIR_CONCURRENCY, async ([abs, mtimeMs]) => {
      try {
        return (await fs.stat(abs)).mtimeMs !== mtimeMs;
      } catch {
        return true;
      }
    });
    return changed.some(Boolean);
  }

  // Rebuild when never built, older than the refresh interval, or when any
  // walked directory's mtime moved. Concurrent callers share one refresh.
  function ensureFresh(index) {
    if (!index.pending) {
      index.pending = (async () => {
        const stale = index.builtAt === null || now() - index.builtAt >= refreshMs || await directoriesChanged(index);
        if (stale) await rebuildIndex(index);
      })().finally(() => { index.pending = null; });
    }
    return index.pending;
  }

  function indexFor(alias, globs, kind, pointer) {
    const key = JSON.stringify([alias, globs.map((glob) => glob.text).sort(), kind || 'yaml', pointer]);
    let index = indexes.get(key);
    if (index) {
      indexes.delete(key);
    } else {
      index = {
        alias, globs, kind, pointer, keyName: pointerKeyName(pointer), builtAt: null, pending: null,
        dirs: new Map(), files: new Map(), byValue: new Map(), unreadable: 0, error: null,
      };
    }
    indexes.set(key, index);
    while (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value);
    return index;
  }

  // Candidate relative paths whose indexed values include `expected`, plus how
  // many candidate files could not be read. Literal-only globs skip the index.
  async function lookupCandidates(source, parsed, expected) {
    if (!rootMap.has(source.root)) return { error: 'unknown root' };
    if (parsed.every((glob) => glob.literal)) return { rels: [...new Set(parsed.map((glob) => glob.text))], unreadable: 0 };
    const index = indexFor(source.root, parsed, source.kind, source.locate.match.pointer);
    try {
      await ensureFresh(index);
    } catch {
      return { error: 'index failed' };
    }
    if (index.error) return { error: index.error };
    return { rels: [...(index.byValue.get(expected.toLowerCase()) || [])].sort(), unreadable: index.unreadable };
  }

  async function locate(state, source) {
    const { locate: locator } = source;
    const expected = substitute(locator.match.equals, state.audio);
    if (expected === null) return { ok: false, message: 'the audio identity needed to find the target is unavailable' };
    const parsed = parseGlobs(locator.glob);
    if (parsed.error) return { ok: false, message: REASON_TEXT[parsed.error] || 'the locator glob is not supported' };
    const found = await lookupCandidates(source, parsed.globs, expected);
    if (found.error) return { ok: false, message: REASON_TEXT[found.error] || 'the locator glob is not supported' };
    const foldCase = String(locator.match.equals).includes('$audio.sha256');
    const surviving = dropReceiptCopies(found.rels.map((relPath) => ({ relPath })), state.template);
    if (surviving.length > MAX_CONFIRMED) throw ambiguousError();
    const targets = [];
    let unreadable = found.unreadable;
    for (const { relPath } of surviving) {
      const file = await readDataFile(source.root, relPath, source.kind);
      if (!file.ok) {
        continue;
      }
      const confirmed = select(file.doc, locator.match.pointer).some((hit) => {
        if (hit.value === null || typeof hit.value === 'object') return false;
        const actual = String(hit.value);
        return foldCase ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
      });
      if (confirmed) targets.push(file);
    }
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

  async function resolveDetails(state) {
    const out = [];
    for (const detail of Array.isArray(state.template.details) ? state.template.details : []) {
      const kind = detail.kind || 'text';
      const source = state.byId.get(detail.source);
      const file = source ? await loadSource(state, source) : null;
      let value = null;
      if (file && file.ok) {
        const found = detailValue(file.doc, detail.pointer, kind);
        if (found === undefined) state.problems.push({ sourceId: detail.source, detailId: detail.id, message: `no value found for "${detail.label}"` });
        else value = found;
      }
      out.push({ id: detail.id, label: detail.label, kind, value });
    }
    return out;
  }

  async function resolveDocuments(state) {
    const out = [];
    for (const document of Array.isArray(state.template.documents) ? state.template.documents : []) {
      const problem = (message) => { state.problems.push({ sourceId: document.source, documentId: document.id, message }); };
      const declared = state.byId.get(document.source);
      const holderId = typeof document.pathFrom === 'string' ? document.source : document.pathFrom.source;
      const pointer = typeof document.pathFrom === 'string' ? document.pathFrom : document.pathFrom.pointer;
      const holder = await loadDependency(state, holderId);
      if (!holder) continue;
      const linked = selectFirst(holder.doc, pointer);
      if (typeof linked !== 'string' || linked === '') {
        problem(`no document path found for "${document.label}"`);
        continue;
      }
      const maxBytes = Math.min(document.maxBytes || DEFAULT_DOCUMENT_BYTES, maxFileBytes);
      const file = await readTextFile((declared && declared.root) || holder.root, linked, maxBytes);
      if (!file.ok) {
        problem(`${document.label}: ${REASON_TEXT[file.reason]}`);
        continue;
      }
      out.push({ id: document.id, label: document.label, text: file.text, truncated: file.truncated, path: file.relPath });
    }
    return out;
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
   *   details: Array<{id: string, label: string, kind: 'text'|'number'|'list'|'yaml', value: string|number|string[]|null}>,
   *   documents: Array<{id: string, label: string, text: string, truncated: boolean, path: string}>,
   *   projections: Array<{id: string, kind: string, label: string, acceptable: boolean}>,
   *   problems: Array<{sourceId: string, markerId?: string, detailId?: string, documentId?: string, message: string}>
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
    const details = target ? await resolveDetails(state) : [];
    const documents = target ? await resolveDocuments(state) : [];
    const projections = (Array.isArray(state.template.projections) ? state.template.projections : [])
      .map((projection) => ({
        id: projection.id,
        kind: projection.kind,
        label: projection.label || projection.id,
        acceptable: Boolean(projection.status && typeof projection.status.onAccept === 'string' && projection.status.onAccept),
      }));
    return {
      target,
      targetSha256: target ? target.sha256 : null,
      sources: overlays,
      reads,
      targetValues: { ...reads },
      image,
      details,
      documents,
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
