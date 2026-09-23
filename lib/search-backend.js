'use strict';

// Search backends (API roadmap R8, 2026-09-23).
//
// The walking backend (lib/managed-repo-search.js) reads files itself under
// fair-shared budgets: complete when scoped to one repo, sampled across a
// fleet. This module adds a ripgrep backend that searches every served root
// in one process and is complete in well under a second on the live fleet
// (18 roots, ~0.15 s warm, ~3 s cold on 2026-09-23). It is used when a
// ripgrep binary is configured or found on PATH; otherwise the walk remains.
//
// Config (lib/config.js getSearchConfig):
//   search:
//     ripgrep: auto          # auto | false | /absolute/path/to/rg
//     maxResults: 100        # hard cap on results (default MAX_RESULT_LIMIT)
//
// Result shape is identical to the walking backend, plus `backend: 'ripgrep'`.
// Query semantics (all terms, quoted phrases) live in lib/search-query.js: one
// JSON match run for the most selective term supplies line + snippet, and one
// --files-with-matches run per further term narrows the set (each run cached).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildHref, buildAssetHref } = require('./path-utils');
const { SKIP_DIRECTORIES } = require('./repo-reader');
const { parseSearchQuery, matchesAllTerms, snippetFor } = require('./search-query');

const SEARCHABLE_GLOBS = ['*.md', '*.markdown', '*.txt', '*.yaml', '*.yml', '*.json', '*.csv', '*.html', '*.htm'];
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 100;
const RG_TIMEOUT_MS = 15000;
// Twenty parallel unscoped searches spawned forty ripgrep processes over the
// same 18 roots and took 11 s each (2026-09-23). Two measures: a small
// concurrency gate so rg runs do not thrash the CPU, and short caches keyed by
// query + roots (NOT by caller: filtering happens per caller afterwards), so
// identical or overlapping searches coalesce instead of repeating the scan.
const MAX_CONCURRENT_RG = 3;
const CONTENT_CACHE_MS = 30000;
const FILES_CACHE_MS = 20000;
let running = 0;
const waiters = [];
const contentCache = new Map(); // key -> { at, promise }
const filesCache = new Map();   // key -> { at, promise }

function acquire() {
  if (running < MAX_CONCURRENT_RG) { running += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve)).then(() => { running += 1; });
}
function release() {
  running -= 1;
  const next = waiters.shift();
  if (next) next();
}
function cached(map, key, ttl, make) {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.promise;
  const promise = make().catch((error) => { map.delete(key); throw error; });
  map.set(key, { at: now, promise });
  if (map.size > 200) for (const [k, v] of map) { if (now - v.at >= ttl) map.delete(k); }
  return promise;
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch (_) { return false; }
}

// Resolves the ripgrep binary once. `auto` looks on PATH (the service's PATH,
// not an interactive shell's: a shell function named rg does not count).
function resolveRipgrep(setting) {
  if (setting === false || setting === 'false' || setting === 'off') return null;
  if (typeof setting === 'string' && setting !== 'auto' && setting.trim()) {
    const candidate = path.resolve(setting.trim());
    return isExecutable(candidate) ? candidate : null;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(number)));
}

function normalizeScopeFilter(scope) {
  const values = Array.isArray(scope) ? scope : scope == null ? [] : [scope];
  return new Set(values.flatMap((value) => String(value || '').split(',')).map((value) => value.trim()).filter(Boolean));
}

async function runRipgrep(binary, args, timeoutMs) {
  await acquire();
  try { return await runRipgrepNow(binary, args, timeoutMs); } finally { release(); }
}

function runRipgrepNow(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // rg exits 1 for "no matches", 2 for errors (some of which are benign,
      // e.g. a vanished file); the JSON stream is still usable.
      resolve({ code, killed, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}

// Maps an absolute matched path back to { repo, relativePath } using the
// real roots, longest root first so nested roots resolve to the deepest.
function makePathMapper(repos) {
  const roots = repos.map((repo) => {
    let real = repo.rootPath;
    try { real = fs.realpathSync(repo.rootPath); } catch (_) {}
    return { id: repo.id, real, raw: repo.rootPath };
  }).sort((a, b) => b.real.length - a.real.length);
  return (absolute) => {
    for (const root of roots) {
      for (const base of [root.real, root.raw]) {
        if (absolute === base || absolute.startsWith(base + path.sep)) {
          const rel = absolute.slice(base.length + 1).split(path.sep).join('/');
          if (rel.split('/').some((part) => SKIP_DIRECTORIES.has(part))) return null;
          return { repo: root.id, relativePath: rel };
        }
      }
    }
    return null;
  };
}

async function searchWithRipgrep(options) {
  const parsed = parseSearchQuery(options.query);
  const query = parsed.raw;
  if (!parsed.terms.length) throw new Error('q is required.');
  const terms = parsed.terms;
  const limit = boundedInteger(options.limit, DEFAULT_RESULT_LIMIT, options.maxResults || MAX_RESULT_LIMIT);
  const scopeFilter = normalizeScopeFilter(options.scope);
  const repos = options.repos
    .filter((repo) => scopeFilter.size === 0 || scopeFilter.has(repo.id))
    .filter((repo) => options.canView(repo.id, '', 'directory'))
    .filter((repo) => { try { return fs.statSync(repo.rootPath).isDirectory(); } catch (_) { return false; } });
  if (!repos.length) {
    return { results: [], count: 0, totalMatches: 0, truncated: false, reposSearched: 0, backend: 'ripgrep', terms: terms.map((t) => t.text), limits: { results: limit, fileBytes: MAX_FILE_BYTES } };
  }
  const mapPath = makePathMapper(repos);
  const globArgs = SEARCHABLE_GLOBS.flatMap((g) => ['-g', g]).concat([...SKIP_DIRECTORIES].flatMap((d) => ['-g', `!${d}`]));
  const roots = repos.map((repo) => repo.rootPath);
  const baseArgs = ['--no-messages', '--no-config', '--max-filesize', String(MAX_FILE_BYTES), '-i', '-F', ...globArgs];
  const timeoutMs = options.timeoutMs || RG_TIMEOUT_MS;
  const rootsKey = JSON.stringify(roots);

  // Parsed (not raw) results are cached per term + roots. Caller filtering
  // runs per request on top of the cached, unfiltered arrays.
  const [primary, ...rest] = terms;
  const content = await cached(contentCache, JSON.stringify(['match', primary.lower, roots]), CONTENT_CACHE_MS, async () => {
    const run = await runRipgrep(options.binary, ['--json', '--max-count', '1', ...baseArgs, '--', primary.text, ...roots], timeoutMs);
    const matches = [];
    for (const line of run.stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) { continue; }
      const absolute = record.data && record.data.path && record.data.path.text;
      if (!absolute) continue;
      const mapped = mapPath(absolute);
      if (!mapped) continue;
      matches.push({ ...mapped, line: record.data.line_number || null, lineText: record.data.lines && record.data.lines.text ? record.data.lines.text : '' });
    }
    return { matches, killed: run.killed };
  });
  const narrowing = await Promise.all(rest.map((term) => cached(contentCache, JSON.stringify(['files-with', term.lower, roots]), CONTENT_CACHE_MS, async () => {
    const run = await runRipgrep(options.binary, ['--files-with-matches', ...baseArgs, '--', term.text, ...roots], timeoutMs);
    const set = new Set();
    for (const absolute of run.stdout.split('\n')) {
      if (!absolute) continue;
      const mapped = mapPath(absolute);
      if (mapped) set.add(`${mapped.repo}/${mapped.relativePath}`);
    }
    return { set, killed: run.killed };
  })));
  const files = await cached(filesCache, rootsKey, FILES_CACHE_MS, async () => {
    const run = await runRipgrep(options.binary, ['--files', ...baseArgs.filter((a) => a !== '-i' && a !== '-F'), '--', ...roots], timeoutMs);
    const entries = [];
    for (const absolute of run.stdout.split('\n')) {
      if (!absolute) continue;
      const mapped = mapPath(absolute);
      if (mapped) entries.push({ repo: mapped.repo, relativePath: mapped.relativePath, lower: mapped.relativePath.toLowerCase() });
    }
    return { entries, killed: run.killed };
  });
  const found = new Map(); // key repo/path -> result
  for (const m of content.matches) {
    const key = `${m.repo}/${m.relativePath}`;
    if (narrowing.some((n) => !n.set.has(key))) continue;
    if (!options.canView(m.repo, m.relativePath, 'file')) continue;
    found.set(key, { repo: m.repo, relativePath: m.relativePath, bodyMatches: true, line: m.line, lineText: m.lineText });
  }
  for (const e of files.entries) {
    if (!matchesAllTerms(e.lower, terms)) continue;
    if (!options.canView(e.repo, e.relativePath, 'file')) continue;
    const key = `${e.repo}/${e.relativePath}`;
    const existing = found.get(key);
    if (existing) existing.pathMatches = true;
    else found.set(key, { repo: e.repo, relativePath: e.relativePath, pathMatches: true, bodyMatches: false, line: null, lineText: '' });
  }
  const anyKilled = content.killed || files.killed || narrowing.some((n) => n.killed);

  const results = [];
  for (const item of found.values()) {
    let mtimeMs = 0;
    try { mtimeMs = Math.trunc(fs.statSync(path.join(repos.find((r) => r.id === item.repo).rootPath, ...item.relativePath.split('/'))).mtimeMs); } catch (_) {}
    results.push({
      repo: item.repo,
      path: item.relativePath,
      score: item.pathMatches && item.bodyMatches ? 2 : 1,
      snippet: snippetFor(item.lineText || '', terms),
      line: item.line,
      lastModified: mtimeMs,
      viewUrl: buildHref(item.repo, item.relativePath),
      rawUrl: buildAssetHref(item.repo, item.relativePath),
    });
  }
  results.sort((left, right) => right.score - left.score || right.lastModified - left.lastModified || left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  const truncated = results.length > limit || anyKilled;
  return {
    results: results.slice(0, limit),
    count: Math.min(results.length, limit),
    totalMatches: results.length,
    truncated,
    reposSearched: repos.length,
    backend: 'ripgrep',
    terms: terms.map((t) => t.text),
    limits: { results: limit, fileBytes: MAX_FILE_BYTES },
  };
}

module.exports = { resolveRipgrep, searchWithRipgrep, SEARCHABLE_GLOBS, MAX_RESULT_LIMIT };
