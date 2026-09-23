'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { renderDocumentPage, renderCacheStats, renderCacheClear } = require('../lib/renderer');
const { createApp } = require('../server');

const SOURCE = '# Title\n\n' + Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\nSome **bold** text with a [link](other.md) and \`code\` ${i}.\n`).join('\n');

test('rendered body is cached by key and invalidated when the source changes', () => {
  renderCacheClear();
  const base = { repo: 'r', repoRoot: '/tmp', relativePath: 'doc.md', parentHref: '/', mtime: 'm', size: 's', customThemeCss: '', renderCacheKey: 'u|1' };
  const first = renderDocumentPage({ ...base, source: SOURCE });
  assert.equal(renderCacheStats().entries, 1);
  const t0 = process.hrtime.bigint();
  const second = renderDocumentPage({ ...base, source: SOURCE });
  const hitMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(second, first, 'identical page from the cache');
  assert.equal(renderCacheStats().entries, 1);
  const changed = renderDocumentPage({ ...base, source: SOURCE + '\nnew line\n' });
  assert.notEqual(changed, first);
  assert.equal(renderCacheStats().entries, 2, 'a changed source is a new entry');
  const uncached = renderDocumentPage({ ...base, renderCacheKey: null, source: SOURCE });
  assert.equal(uncached, first, 'uncached render produces the same page');
  assert.equal(renderCacheStats().entries, 2, 'no key, no entry');
  assert.ok(hitMs < 50, `cache hit should be fast, was ${hitMs.toFixed(1)} ms`);
});

test('cache is keyed by annotations flag and query token, and is bounded', () => {
  renderCacheClear();
  const base = { repo: 'r', repoRoot: '/tmp', relativePath: 'doc.md', source: SOURCE, parentHref: '/', mtime: 'm', size: 's', customThemeCss: '', renderCacheKey: 'u|1' };
  renderDocumentPage({ ...base, annotationsEnabled: false });
  renderDocumentPage({ ...base, annotationsEnabled: true });
  renderDocumentPage({ ...base, queryToken: 'tok' });
  assert.equal(renderCacheStats().entries, 3);
  for (let i = 0; i < 320; i++) renderDocumentPage({ ...base, relativePath: `doc-${i}.md` });
  assert.ok(renderCacheStats().entries <= 300, 'entry cap holds');
});

test('the view route serves an unscoped caller from the cache and a scoped caller without it', async () => {
  renderCacheClear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-render-cache-'));
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes', 'a.md'), SOURCE);
  const app = createApp({ mappings: { docs: root }, accessConfig: { humanDefault: 'restricted', tokens: { reader: { secret: 'scoped-placeholder', subject: { companyId: 'x', agentId: 'r' }, repos: { docs: { paths: ['notes/'] } }, permissions: { view: true } }, full: { secret: 'full-placeholder', subject: { companyId: 'x', agentId: 'f' }, repos: { docs: { paths: [''] } }, permissions: { view: true } } } }, apiKeyStore: null, grantStore: null, managedRepoStore: null, publishStore: null, editingEnabled: false, annotationsEnabled: false, rawHtmlEnabled: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const get = (headers) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/view/docs/notes/a.md', headers }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }).on('error', reject));
  try {
    const scoped = await get({ authorization: 'Bearer scoped-placeholder' });
    assert.equal(scoped.status, 200);
    assert.equal(renderCacheStats().entries, 0, 'scoped caller never populates the cache');
    const full = await get({ authorization: 'Bearer full-placeholder' });
    assert.equal(full.status, 200);
    assert.equal(renderCacheStats().entries, 0, 'a token-scoped caller (even with a whole-repo scope) is not "unrestricted"');
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  const open = createApp({ mappings: { docs: root }, accessConfig: {}, apiKeyStore: null, grantStore: null, managedRepoStore: null, publishStore: null, editingEnabled: false, annotationsEnabled: false, rawHtmlEnabled: false });
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true }); fs.writeFileSync(path.join(root, 'notes', 'a.md'), SOURCE);
  const server2 = open.listen(0, '127.0.0.1');
  await new Promise((r) => server2.once('listening', r));
  const get2 = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server2.address().port, path: '/view/docs/notes/a.md' }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }).on('error', reject));
  try {
    const one = await get2(); const two = await get2();
    assert.equal(one.status, 200);
    assert.equal(renderCacheStats().entries, 1, 'unrestricted caller populates one entry');
    assert.equal(one.body.length, two.body.length);
  } finally { server2.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
