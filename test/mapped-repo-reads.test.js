'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { createApp } = require('../server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-mapped-reads-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(path.join(docs, 'notes', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'private'), { recursive: true });
  fs.mkdirSync(path.join(docs, '.git'), { recursive: true });
  fs.mkdirSync(path.join(docs, '.stversions'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'README.md'), '# Docs\nwallpaper roadmap\n');
  fs.writeFileSync(path.join(docs, 'notes', 'a.md'), 'alpha note about wallpapers\n');
  fs.writeFileSync(path.join(docs, 'notes', 'deep', 'b.yaml'), 'key: wallpaper\n');
  fs.writeFileSync(path.join(docs, 'private', 'secret.md'), 'do not list\n');
  fs.writeFileSync(path.join(docs, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(docs, '.stversions', 'old.md'), 'old wallpaper\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside the repo\n');
  fs.symlinkSync(root, path.join(docs, 'escape'));
  const old = Date.now() - 86400000;
  fs.utimesSync(path.join(docs, 'README.md'), old / 1000, old / 1000);
  return { root, docs };
}

function start(options) {
  const app = createApp({ apiKeyStore: null, grantStore: null, managedRepoStore: null, publishStore: null, editingEnabled: false, annotationsEnabled: false, rawHtmlEnabled: false, ...options });
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port })));
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    }).on('error', reject);
  });
}

test('tree, changes, file read and search work on a plainly mapped repo', async () => {
  const f = fixture();
  const s = await start({ mappings: { docs: f.docs, ghost: path.join(f.root, 'not-synced-here') }, accessConfig: {} });
  try {
    const tree = await get(s.base + '/api/repos/docs/tree?maxDepth=3');
    assert.equal(tree.status, 200, tree.text);
    assert.equal(tree.json.managed, false);
    const paths = tree.json.entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['README.md', 'notes', 'notes/a.md', 'notes/deep', 'notes/deep/b.yaml', 'private', 'private/secret.md']);
    assert.equal(paths.some((p) => p.startsWith('.git') || p.startsWith('.stversions') || p === 'escape'), false, 'VCS, Syncthing and symlinks never listed');
    const sub = await get(s.base + '/api/repos/docs/tree?path=notes&maxDepth=0');
    assert.deepEqual(sub.json.entries.map((e) => e.path), ['a.md', 'deep'].map((p) => 'notes/' + p));
    const since = Date.now() - 3600000;
    const changes = await get(s.base + '/api/repos/docs/changes?since=' + since);
    assert.equal(changes.status, 200);
    assert.equal(changes.json.entries.some((e) => e.path === 'README.md'), false, 'a file older than since is excluded');
    assert.deepEqual(changes.json.entries.map((e) => e.path).sort(), ['notes/a.md', 'notes/deep/b.yaml', 'private/secret.md']);
    assert.match(changes.json.entries[0].viewUrl, /^\/view\/docs\//);
    const bad = await get(s.base + '/api/repos/docs/changes?since=yesterday');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_request');
    const file = await get(s.base + '/api/repos/docs/files/notes/a.md');
    assert.equal(file.status, 200);
    assert.equal(file.json.content, 'alpha note about wallpapers\n');
    assert.equal(typeof file.json.mtimeMs, 'number');
    const search = await get(s.base + '/api/search?q=wallpaper');
    assert.equal(search.status, 200, search.text);
    assert.deepEqual(search.json.results.map((r) => r.path).sort(), ['README.md', 'notes/a.md', 'notes/deep/b.yaml']);
    assert.equal(search.json.results.every((r) => r.repo === 'docs'), true, 'an absent mapped root does not fail the search');
    assert.equal((await get(s.base + '/api/repos/ghost/tree')).status, 404, 'absent root answers 404 per request');
    const suggest = await get(s.base + '/api/search/suggest?q=notes/de');
    assert.equal(suggest.status, 200);
    assert.ok(suggest.json.suggestions.some((x) => x.path === 'notes/deep'));
  } finally { s.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('mapped reads refuse traversal, internal folders and unknown repos', async () => {
  const f = fixture();
  const s = await start({ mappings: { docs: f.docs }, accessConfig: {} });
  try {
    for (const url of ['/api/repos/docs/files/../../etc/passwd', '/api/repos/docs/tree?path=..', '/api/repos/docs/files/.git/HEAD', '/api/repos/docs/tree?path=.stversions', '/api/repos/docs/files/escape/outside.txt', '/api/repos/nope/tree']) {
      const r = await get(s.base + url);
      assert.ok(r.status === 404 || r.status === 403, `${url} -> ${r.status}`);
      assert.equal(typeof r.json.error, 'object', url);
    }
  } finally { s.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a token scoped to one folder sees only that folder in tree, changes and search', async () => {
  const f = fixture();
  const s = await start({
    mappings: { docs: f.docs },
    accessConfig: { humanDefault: 'restricted', tokens: { reader: { secret: 'scoped-reader-placeholder', subject: { companyId: 'example', agentId: 'reader' }, repos: { docs: { paths: ['notes/'] } }, permissions: { view: true } } } },
  });
  const auth = { authorization: 'Bearer scoped-reader-placeholder' };
  try {
    assert.equal((await get(s.base + '/api/repos/docs/tree')).status, 401, 'no credential');
    const tree = await get(s.base + '/api/repos/docs/tree?maxDepth=3', auth);
    assert.equal(tree.status, 200, tree.text);
    assert.deepEqual(tree.json.entries.map((e) => e.path).sort(), ['notes', 'notes/a.md', 'notes/deep', 'notes/deep/b.yaml']);
    const changes = await get(s.base + '/api/repos/docs/changes', auth);
    assert.equal(changes.json.entries.some((e) => e.path.startsWith('private')), false);
    const search = await get(s.base + '/api/search?q=wallpaper', auth);
    assert.deepEqual(search.json.results.map((r) => r.path).sort(), ['notes/a.md', 'notes/deep/b.yaml']);
    assert.equal((await get(s.base + '/api/repos/docs/files/private/secret.md', auth)).status, 404);
    const whoami = await get(s.base + '/api/whoami', auth);
    assert.equal(whoami.json.capabilities.repoRead, true);
    assert.equal(whoami.json.capabilities.search, true);
    assert.equal(whoami.json.endpoints.repoTree, '/api/repos/:repo/tree');
  } finally { s.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
