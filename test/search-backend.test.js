'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { resolveRipgrep, searchWithRipgrep } = require('../lib/search-backend');
const { createApp } = require('../server');

const RG = resolveRipgrep('auto');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-rg-'));
  const a = path.join(root, 'alpha'); const b = path.join(root, 'beta');
  fs.mkdirSync(path.join(a, 'notes'), { recursive: true }); fs.mkdirSync(path.join(a, '.git'), { recursive: true }); fs.mkdirSync(path.join(a, 'private'), { recursive: true });
  fs.mkdirSync(path.join(b, 'deep', 'deeper'), { recursive: true }); fs.mkdirSync(path.join(b, '.stversions'), { recursive: true });
  fs.writeFileSync(path.join(a, 'README.md'), '# Alpha\nnothing here\n');
  fs.writeFileSync(path.join(a, 'notes', 'needle-in-name.md'), 'plain body\n');
  fs.writeFileSync(path.join(a, 'notes', 'body.md'), 'line one\nthe NEEDLE is on line two\n');
  fs.writeFileSync(path.join(a, 'private', 'secret.md'), 'needle hidden\n');
  fs.writeFileSync(path.join(a, '.git', 'HEAD'), 'needle in git\n');
  fs.writeFileSync(path.join(a, 'notes', 'binary.png'), 'needle png');
  fs.writeFileSync(path.join(b, 'deep', 'deeper', 'far.yaml'), 'key: needle\n');
  fs.writeFileSync(path.join(b, '.stversions', 'old.md'), 'needle old\n');
  return { root, repos: [{ id: 'alpha', rootPath: a, managed: false }, { id: 'beta', rootPath: b, managed: false }, { id: 'ghost', rootPath: path.join(root, 'nope'), managed: false }] };
}

test('ripgrep backend: complete across repos, skips internals, honours scope and caller filtering', { skip: RG ? false : 'ripgrep not on PATH' }, async () => {
  const f = fixture();
  try {
    const all = await searchWithRipgrep({ binary: RG, repos: f.repos, query: 'needle', canView: () => true });
    assert.equal(all.backend, 'ripgrep');
    assert.equal(all.reposSearched, 2, 'absent root skipped');
    assert.deepEqual(all.results.map((r) => `${r.repo}/${r.path}`).sort(), ['alpha/notes/body.md', 'alpha/notes/needle-in-name.md', 'alpha/private/secret.md', 'beta/deep/deeper/far.yaml']);
    const body = all.results.find((r) => r.path === 'notes/body.md');
    assert.equal(body.line, 2);
    assert.match(body.snippet, /NEEDLE is on line two/);
    assert.equal(body.score, 1);
    assert.equal(all.results.find((r) => r.path === 'notes/needle-in-name.md').score, 1, 'path-only match');
    const scoped = await searchWithRipgrep({ binary: RG, repos: f.repos, query: 'needle', scope: 'beta', canView: () => true });
    assert.deepEqual(scoped.results.map((r) => r.repo), ['beta']);
    const filtered = await searchWithRipgrep({ binary: RG, repos: f.repos, query: 'needle', canView: (repo, rel) => !rel.startsWith('private') });
    assert.equal(filtered.results.some((r) => r.path.startsWith('private')), false, 'caller filter applied per file');
    const capped = await searchWithRipgrep({ binary: RG, repos: f.repos, query: 'needle', limit: 2, canView: () => true });
    assert.equal(capped.count, 2); assert.equal(capped.truncated, true); assert.equal(capped.totalMatches, 4);
    const none = await searchWithRipgrep({ binary: RG, repos: f.repos, query: 'zzz-no-such-term', canView: () => true });
    assert.equal(none.count, 0); assert.equal(none.truncated, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('resolveRipgrep: explicit path must be executable; false disables', () => {
  assert.equal(resolveRipgrep(false), null);
  assert.equal(resolveRipgrep('/definitely/not/here/rg'), null);
  if (RG) assert.equal(resolveRipgrep(RG), RG);
});

test('the search route names its backend and falls back to the walk when ripgrep is off', async () => {
  const f = fixture();
  const boot = (searchConfig) => new Promise((resolve) => {
    const app = createApp({ mappings: { alpha: f.repos[0].rootPath, beta: f.repos[1].rootPath }, accessConfig: {}, apiKeyStore: null, grantStore: null, managedRepoStore: null, publishStore: null, editingEnabled: false, annotationsEnabled: false, rawHtmlEnabled: false, searchConfig });
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
  const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject));
  const walk = await boot({ ripgrep: false });
  try {
    const r = await get(walk.base + '/api/search?q=needle');
    assert.equal(r.backend, 'walk');
    assert.ok(r.count >= 3);
  } finally { walk.server.close(); }
  if (RG) {
    const rg = await boot({ ripgrep: 'auto' });
    try {
      const r = await get(rg.base + '/api/search?q=needle');
      assert.equal(r.backend, 'ripgrep');
      assert.deepEqual(r.results.map((x) => `${x.repo}/${x.path}`).sort(), ['alpha/notes/body.md', 'alpha/notes/needle-in-name.md', 'alpha/private/secret.md', 'beta/deep/deeper/far.yaml']);
    } finally { rg.server.close(); }
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('query semantics: every term must match in any order, quotes make a phrase, path-only terms', { skip: RG ? false : 'ripgrep not on PATH' }, async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repos[0].rootPath, 'notes', 'multi.md'), 'first line has alpha-term\nlast line has BETA-term\n');
  fs.writeFileSync(path.join(f.repos[1].rootPath, 'deep', 'only-alpha-term.md'), 'alpha-term alone\n');
  const run = (query) => searchWithRipgrep({ binary: RG, repos: f.repos, query, canView: () => true });
  try {
    const both = await run('beta-term alpha-term');
    assert.deepEqual(both.results.map((r) => r.path), ['notes/multi.md'], 'order-independent AND across lines');
    assert.deepEqual(both.terms, ['alpha-term', 'beta-term'], 'terms echoed, most selective first');
    assert.match(both.results[0].snippet, /alpha-term/i, 'snippet from the primary term line');
    const phrase = await run('"line has beta"');
    assert.deepEqual(phrase.results.map((r) => r.path), ['notes/multi.md']);
    const phraseMiss = await run('"beta line has"');
    assert.equal(phraseMiss.count, 0, 'a phrase is literal and ordered');
    const pathOnly = await run('deep only-alpha');
    assert.deepEqual(pathOnly.results.map((r) => `${r.repo}/${r.path}`), ['beta/deep/only-alpha-term.md'], 'all terms in the path');
    const none = await run('alpha-term zzz-absent');
    assert.equal(none.count, 0); assert.equal(none.totalMatches, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('walk backend shares the query semantics; the route rejects limit < 1', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repos[0].rootPath, 'notes', 'multi.md'), 'first line has alpha-term\nlast line has BETA-term\n');
  const app = createApp({ mappings: { alpha: f.repos[0].rootPath, beta: f.repos[1].rootPath }, accessConfig: {}, apiKeyStore: null, grantStore: null, managedRepoStore: null, publishStore: null, editingEnabled: false, annotationsEnabled: false, rawHtmlEnabled: false, searchConfig: { ripgrep: false } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (qs) => new Promise((resolve, reject) => http.get(base + '/api/search?' + qs, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); }).on('error', reject));
  try {
    const both = await get('q=beta-term+alpha-term');
    assert.equal(both.body.backend, 'walk');
    assert.deepEqual(both.body.results.map((r) => r.path), ['notes/multi.md']);
    assert.deepEqual(both.body.terms, ['alpha-term', 'beta-term']);
    assert.equal(both.body.totalMatches, 1);
    const zero = await get('q=alpha&limit=0');
    assert.equal(zero.status, 400); assert.equal(zero.body.error.details[0].path, 'limit');
    const bad = await get('q=alpha&scope=nope');
    assert.equal(bad.status, 400); assert.match(bad.body.error.message, /nope/);
  } finally { server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('parsed search caches stay small: distinct queries evict oldest-first', { skip: RG ? false : 'ripgrep not on PATH' }, async () => {
  const f = fixture();
  try {
    const { contentCacheSize } = require('../lib/search-backend');
    for (let i = 0; i < 40; i++) await searchWithRipgrep({ binary: RG, repos: f.repos, query: `needle-${i} needle`, canView: () => true });
    assert.ok(contentCacheSize() <= 8, `content cache bounded, was ${contentCacheSize()}`);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
