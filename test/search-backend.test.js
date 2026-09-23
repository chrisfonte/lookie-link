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
