'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

const { createApp } = require('../server');
const { loadKits } = require('../lib/kits');

const ADMIN = 'kits-admin-placeholder';
const BUNDLED_CSS = fs.readFileSync(path.join(__dirname, '..', 'kits', 'ops', 'kit.css'), 'utf8');

function request(base, route, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text, buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = (body, token = ADMIN) => ({
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function startServer(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-kits-admin-'));
  const managedFolder = path.join(root, 'managed');
  const app = createApp({
    mappings: {},
    accessConfig: {
      appearance: { adminTokens: { ops: { secret: ADMIN } } },
      ...(extra.accessConfig || {}),
    },
    apiKeyStore: null,
    grantStore: null,
    managedRepoStore: null,
    publishStore: null,
    editingEnabled: false,
    annotationsEnabled: false,
    rawHtmlEnabled: false,
    kitsConfig: {
      enabled: true,
      default: 'ops',
      folders: [],
      managedFolder,
      ...(extra.kitsConfig || {}),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    root,
    managedFolder,
    app,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
      loadKits({ enabled: true });
    },
  };
}

test('kit admin routes refuse missing bearer with the standard access error', async () => {
  const s = await startServer();
  try {
    const res = await request(s.base, '/api/kits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'unauthenticated');
  } finally {
    await s.close();
  }
});

test('POST /api/kits creates a managed kit; conflict / validation / upload / delete', async () => {
  const s = await startServer();
  try {
    const created = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'demo',
        label: 'Demo',
        version: '0.1.0',
        description: 'Managed demo',
        stylesheet: ':root{--demo:1}\n',
        templates: { 'hello.html': '<html>hi</html>\n' },
      }),
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.kit.name, 'demo');
    assert.equal(created.json.kit.source, 'org');
    assert.equal(created.json.kit.scope, 'org');
    assert.equal(created.json.kit.org, 'default');
    assert.equal(created.json.kit.currentVersion, 1);
    assert.equal(created.json.kit.writable, true);
    assert.equal(created.json.kit.stylesheetUrl, '/kit/demo/kit.css');
    assert.equal(created.json.kit.effectiveVersion, '0.1.0@1');
    assert.equal(created.json.kit.pinnedStylesheetUrl, '/kit/demo/v/0.1.0%401/kit.css');
    assert.deepEqual(created.json.kit.caching, {
      stylesheetUrl: 'no-cache',
      pinnedStylesheetUrl: 'immutable',
    });

    const listed = await request(s.base, '/api/kits');
    assert.ok(listed.json.kits.some((kit) => kit.name === 'demo' && kit.source === 'org' && kit.scope === 'org'));

    const css = await request(s.base, '/kit/demo/kit.css');
    assert.equal(css.status, 200);
    assert.equal(css.text, ':root{--demo:1}\n');

    const conflict = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'ops',
        label: 'Clash',
        version: '1',
        stylesheet: 'x{}',
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'conflict');

    const badName = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({ name: 'Bad_Name', label: 'X', version: '1', stylesheet: 'x{}' }),
    });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.error.code, 'invalid_request');
    assert.ok(badName.json.error.details.some((d) => d.path === 'name'));

    const badFile = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'okname',
        label: 'X',
        version: '1',
        stylesheet: 'x{}',
        templates: { '../evil.html': '<p/>' },
      }),
    });
    assert.equal(badFile.status, 400);
    assert.ok(badFile.json.error.details.some((d) => /file|templates/i.test(d.path) || /file names/i.test(d.message)));

    const oversize = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'bigone',
        label: 'X',
        version: '1',
        stylesheet: 'x'.repeat(1024 * 1024 + 1),
      }),
    });
    assert.equal(oversize.status, 400);
    assert.ok(oversize.json.error.details.some((d) => d.path === 'stylesheet'));

    const uploadBundled = await request(s.base, '/api/kits/ops/files/extra.html', {
      method: 'PUT',
      ...json({ content: '<p>nope</p>' }),
    });
    assert.equal(uploadBundled.status, 403);
    assert.equal(uploadBundled.json.error.code, 'read_only');

    const upload = await request(s.base, '/api/kits/demo/files/more.html', {
      method: 'PUT',
      ...json({ content: '<p>more</p>\n' }),
    });
    assert.equal(upload.status, 200, upload.text);
    assert.equal(upload.json.kit.currentVersion, 2);
    assert.equal(upload.json.kit.effectiveVersion, '0.1.0@2');
    assert.ok(upload.json.kit.files.some((f) => f.file === 'more.html'));

    const deleted = await request(s.base, '/api/kits/demo', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(deleted.status, 200);
    const gone = await request(s.base, '/api/kits/demo');
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.code, 'gone');

    const deleteBundled = await request(s.base, '/api/kits/ops', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(deleteBundled.status, 403);
    assert.equal(deleteBundled.json.error.code, 'read_only');

    const recreate = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'demo',
        label: 'Demo again',
        version: '0.2.0',
        stylesheet: ':root{--demo:2}\n',
      }),
    });
    assert.equal(recreate.status, 409);
    assert.equal(recreate.json.error.code, 'conflict');
    assert.match(recreate.json.error.message, /kit was deleted; restore is not supported yet/);
  } finally {
    await s.close();
  }
});

test('PATCH overlay on bundled ops updates kit.css, effectiveVersion, and revision guard', async () => {
  const s = await startServer();
  try {
    const before = await request(s.base, '/api/kits/ops');
    assert.equal(before.status, 200);
    assert.equal(before.json.kit.effectiveVersion, '1.26');
    assert.equal(before.json.kit.overlay, null);
    assert.equal(before.json.kit.writable, false);
    assert.equal(before.json.kit.pinnedStylesheetUrl, '/kit/ops/v/1.26/kit.css');
    assert.deepEqual(before.json.kit.caching, {
      stylesheetUrl: 'no-cache',
      pinnedStylesheetUrl: 'immutable',
    });
    const revision = before.json.revision;

    const patched = await request(s.base, '/api/kits/ops', {
      method: 'PATCH',
      ...json({ expectedRevision: revision, tokens: { '--radius': '8px' } }),
    });
    assert.equal(patched.status, 200, patched.text);
    assert.match(patched.json.kit.effectiveVersion, /^1\.26\+[0-9a-f]{8}$/);
    assert.equal(patched.json.kit.overlay.tokens['--radius'], '8px');
    assert.ok(patched.json.kit.overlay.updatedAt);

    const css = await request(s.base, '/kit/ops/kit.css');
    assert.equal(css.status, 200);
    assert.ok(css.text.startsWith(BUNDLED_CSS));
    assert.match(css.text, /\/\* lookie-link kit overlay \*\/\n:root\{--radius:8px\}\n$/);

    const pinned = await request(s.base, `/kit/ops/v/${encodeURIComponent(patched.json.kit.effectiveVersion)}/kit.css`);
    assert.equal(pinned.status, 200);
    assert.equal(pinned.text, css.text);
    assert.match(String(pinned.headers['cache-control'] || ''), /immutable/);

    const staleVersion = await request(s.base, '/kit/ops/v/1.26/kit.css');
    assert.equal(staleVersion.status, 404);

    const stale = await request(s.base, '/api/kits/ops', {
      method: 'PATCH',
      ...json({ expectedRevision: revision, tokens: { '--radius': '9px' } }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');
    assert.equal(typeof stale.json.currentRevision, 'string');
    assert.ok(stale.json.currentRevision.length > 0);

    const cleared = await request(s.base, '/api/kits/ops', {
      method: 'PATCH',
      ...json({ expectedRevision: patched.json.revision, tokens: {} }),
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.kit.effectiveVersion, '1.26');
    assert.equal(cleared.json.kit.overlay, null);
    const restored = await request(s.base, '/kit/ops/kit.css');
    assert.equal(restored.text, BUNDLED_CSS);
  } finally {
    await s.close();
  }
});

test('concurrent PATCHes with the same expectedRevision yield exactly one 409', async () => {
  const s = await startServer();
  try {
    const before = await request(s.base, '/api/kits');
    const revision = before.json.revision;
    const bodies = [
      { expectedRevision: revision, tokens: { '--radius': '1px' } },
      { expectedRevision: revision, tokens: { '--radius': '2px' } },
    ];
    const results = await Promise.all(bodies.map((body) => request(s.base, '/api/kits/ops', {
      method: 'PATCH',
      ...json(body),
    })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(results.filter((r) => r.status === 409)[0].json.error.code, 'revision_conflict');
  } finally {
    await s.close();
  }
});

test('unmatched /kit/ paths return the JSON error envelope', async () => {
  const s = await startServer();
  try {
    const res = await request(s.base, '/kit/ops/package.json');
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'not_found');
  } finally {
    await s.close();
  }
});
