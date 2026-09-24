'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

const { createApp } = require('../server');
const {
  loadKits,
  migrateFlatManagedLayout,
  kitVersionDir,
  overlayPathFor,
  DEFAULT_ORG,
} = require('../lib/kits');

const ADMIN = 'kits-org-admin-placeholder';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-kits-org-'));
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
    publishStore: extra.publishStore === undefined ? null : extra.publishStore,
    publishConfig: extra.publishConfig,
    editingEnabled: false,
    annotationsEnabled: false,
    rawHtmlEnabled: Boolean(extra.rawHtmlEnabled),
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

function treeListing(dir, prefix = '') {
  if (!fs.existsSync(dir)) return `${prefix}(missing)\n`;
  const lines = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      lines.push(treeListing(full, `${prefix}  `).trimEnd());
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

test('org kit create/PUT versions, show, pin history, tombstone, overlay path, migration, no tenant word', async () => {
  const s = await startServer();
  try {
    const created = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'brand',
        label: 'Brand',
        version: '1.0',
        description: 'Org kit',
        stylesheet: ':root{--brand:1}\n',
        templates: { 'card.html': '<html>card</html>\n' },
      }),
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.kit.scope, 'org');
    assert.equal(created.json.kit.org, 'default');
    assert.equal(created.json.kit.currentVersion, 1);
    assert.equal(created.json.kit.effectiveVersion, '1.0@1');
    assert.equal(created.json.kit.pinnedStylesheetUrl, '/kit/brand/v/1.0%401/kit.css');

    const v1Dir = kitVersionDir(s.managedFolder, DEFAULT_ORG, 'brand', 1);
    assert.ok(fs.existsSync(path.join(v1Dir, 'kit.css')));
    assert.ok(fs.existsSync(path.join(v1Dir, 'kit.yaml')));
    assert.ok(fs.existsSync(path.join(v1Dir, 'card.html')));
    const v1Css = fs.readFileSync(path.join(v1Dir, 'kit.css'));

    const show1 = await request(s.base, '/api/kits/brand');
    assert.equal(show1.status, 200);
    assert.ok(Array.isArray(show1.json.kit.versions));
    assert.equal(show1.json.kit.versions.length, 1);
    assert.equal(show1.json.kit.versions[0].version, 1);
    assert.equal(typeof show1.json.kit.versions[0].sizeBytes, 'number');
    assert.ok(show1.json.kit.versions[0].createdAt);

    const upload = await request(s.base, '/api/kits/brand/files/note.md', {
      method: 'PUT',
      ...json({ content: '# note\n' }),
    });
    assert.equal(upload.status, 200, upload.text);
    assert.equal(upload.json.kit.currentVersion, 2);
    assert.equal(upload.json.kit.effectiveVersion, '1.0@2');
    assert.ok(upload.json.kit.files.some((f) => f.file === 'note.md'));
    assert.ok(upload.json.kit.files.some((f) => f.file === 'card.html'));

    const v2Dir = kitVersionDir(s.managedFolder, DEFAULT_ORG, 'brand', 2);
    assert.ok(fs.existsSync(path.join(v2Dir, 'kit.css')));
    assert.ok(fs.existsSync(path.join(v2Dir, 'card.html')));
    assert.ok(fs.existsSync(path.join(v2Dir, 'note.md')));
    assert.ok(fs.readFileSync(path.join(v1Dir, 'kit.css')).equals(v1Css), 'versions/1 untouched');
    assert.ok(fs.existsSync(path.join(v1Dir, 'card.html')));
    assert.equal(fs.existsSync(path.join(v1Dir, 'note.md')), false);

    const show2 = await request(s.base, '/api/kits/brand');
    assert.equal(show2.json.kit.versions.length, 2);
    assert.deepEqual(show2.json.kit.versions.map((v) => v.version), [1, 2]);

    const pinnedOld = await request(s.base, '/kit/brand/v/1.0@1/kit.css');
    assert.equal(pinnedOld.status, 200);
    assert.equal(pinnedOld.text, ':root{--brand:1}\n');
    assert.ok(pinnedOld.buf.equals(v1Css));

    const pinnedNew = await request(s.base, '/kit/brand/v/1.0@2/kit.css');
    assert.equal(pinnedNew.status, 200);
    assert.equal(pinnedNew.text, ':root{--brand:1}\n');

    const deleted = await request(s.base, '/api/kits/brand', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(deleted.status, 200);
    const listed = await request(s.base, '/api/kits');
    assert.equal(listed.json.kits.some((kit) => kit.name === 'brand'), false);
    const gone = await request(s.base, '/api/kits/brand');
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.code, 'gone');
    assert.ok(fs.existsSync(v1Dir));
    assert.ok(fs.existsSync(v2Dir));

    const recreate = await request(s.base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'brand',
        label: 'Brand again',
        version: '2.0',
        stylesheet: ':root{--brand:2}\n',
      }),
    });
    assert.equal(recreate.status, 409);
    assert.equal(recreate.json.error.code, 'conflict');
    assert.match(recreate.json.error.message, /kit was deleted; restore is not supported yet/);

    // Overlay on bundled ops lands under orgs/default/overlays/
    const before = await request(s.base, '/api/kits/ops');
    const patched = await request(s.base, '/api/kits/ops', {
      method: 'PATCH',
      ...json({ expectedRevision: before.json.revision, tokens: { '--radius': '8px' } }),
    });
    assert.equal(patched.status, 200, patched.text);
    const overlayFile = overlayPathFor(s.managedFolder, 'ops', DEFAULT_ORG);
    assert.ok(fs.existsSync(overlayFile), overlayFile);
    assert.match(patched.json.kit.effectiveVersion, /^1\.26\+[0-9a-f]{8}$/);
    const css = await request(s.base, '/kit/ops/kit.css');
    assert.match(css.text, /--radius:8px/);

    // Capture layout produced by the tests for the status writeback.
    s._layoutTree = treeListing(s.managedFolder);
  } finally {
    await s.close();
  }
});

test('flat pre-R15a kit + overlay migration is idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-kits-migrate-'));
  const managedFolder = path.join(root, 'managed');
  fs.mkdirSync(path.join(managedFolder, 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(managedFolder, 'legacy', 'kit.yaml'), [
    'name: legacy',
    'label: Legacy',
    'version: "0.9"',
    'stylesheet: kit.css',
    'templates: []',
    'examples: []',
    'consumes: []',
    'description: flat',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(managedFolder, 'legacy', 'kit.css'), ':root{--legacy:1}\n');
  fs.writeFileSync(path.join(managedFolder, 'legacy.overlay.yaml'), [
    'tokens:',
    "  '--radius': 4px",
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    '',
  ].join('\n'));

  const logs = [];
  const first = migrateFlatManagedLayout(managedFolder, {
    warn: () => {},
    log: (line) => logs.push(line),
  });
  assert.equal(first.kits, 1);
  assert.equal(first.overlays, 1);
  assert.ok(fs.existsSync(kitVersionDir(managedFolder, DEFAULT_ORG, 'legacy', 1)));
  assert.ok(fs.existsSync(overlayPathFor(managedFolder, 'legacy', DEFAULT_ORG)));
  assert.equal(fs.existsSync(path.join(managedFolder, 'legacy')), false);
  assert.equal(fs.existsSync(path.join(managedFolder, 'legacy.overlay.yaml')), false);
  assert.equal(logs.length, 2);

  const secondLogs = [];
  const second = migrateFlatManagedLayout(managedFolder, {
    warn: () => {},
    log: (line) => secondLogs.push(line),
  });
  assert.equal(second.kits, 0);
  assert.equal(second.overlays, 0);
  assert.equal(secondLogs.length, 0);

  // loadKits also migrates and surfaces the kit
  const loaded = loadKits({ managedFolder, enabled: true, warn: () => {}, log: () => {} });
  const legacy = loaded.kits.find((kit) => kit.name === 'legacy');
  assert.ok(legacy);
  assert.equal(legacy.scope, 'org');
  assert.equal(legacy.org, 'default');
  assert.equal(legacy.currentVersion, 1);
  assert.match(legacy.effectiveVersion, /^0\.9@1\+[0-9a-f]{8}$/);

  fs.rmSync(root, { recursive: true, force: true });
  loadKits({ enabled: true });
});

test('publish with an org kit records kit.version as effectiveVersion 1.0@2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-kits-org-pub-'));
  const managedFolder = path.join(root, 'managed');
  const publishArea = path.join(root, 'publish');
  const apiKeyStorePath = path.join(root, 'keys.yaml');
  const sourceRepo = path.join(root, 'source');
  fs.mkdirSync(sourceRepo);
  fs.writeFileSync(path.join(sourceRepo, 'secret.md'), '# x\n');

  const app = createApp({
    mappings: { secret: sourceRepo },
    rawHtmlEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      appearance: { adminTokens: { ops: { secret: ADMIN } } },
      apiKeys: {
        storePath: apiKeyStorePath,
        adminTokens: { operator: { secret: ADMIN } },
      },
    },
    publishConfig: { areaPath: publishArea },
    kitsConfig: { enabled: true, default: 'ops', folders: [], managedFolder },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const keyRes = await request(base, '/api/agent-keys', {
      method: 'POST',
      ...json({
        label: 'Publisher',
        subject: { companyId: 'example', agentId: `agent-${Date.now()}`, label: 'pub' },
        permissions: { view: true, publish: true },
        repos: { published: true },
        issuer: { actorType: 'operator', actorId: 'test' },
      }),
    });
    assert.equal(keyRes.status, 201, keyRes.text);
    const token = keyRes.json.token;

    const created = await request(base, '/api/kits', {
      method: 'POST',
      ...json({
        name: 'pubkit',
        label: 'Pub',
        version: '1.0',
        stylesheet: ':root{--pub:1}\n',
      }),
    });
    assert.equal(created.status, 201, created.text);

    const upload = await request(base, '/api/kits/pubkit/files/extra.html', {
      method: 'PUT',
      ...json({ content: '<p>x</p>\n' }),
    });
    assert.equal(upload.status, 200, upload.text);
    assert.equal(upload.json.kit.effectiveVersion, '1.0@2');

    const html = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="kit.css" data-kit>',
      '<title>Pub</title></head><body></body></html>',
    ].join('');
    const published = await request(base, '/api/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'org-kit-pub',
        kit: 'pubkit',
        entryPath: 'index.html',
        files: [{ path: 'index.html', content: html }],
      }),
    });
    assert.equal(published.status, 201, published.text);
    assert.equal(published.json.publication.kit.version, '1.0@2');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    loadKits({ enabled: true });
  }
});

test('the word tenant does not appear in lib/, server.js, bin/, or docs/', () => {
  const roots = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, '..', 'bin'),
    path.join(__dirname, '..', 'docs'),
  ];
  const offenders = [];
  function scan(target) {
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(target)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        scan(path.join(target, name));
      }
      return;
    }
    if (!st.isFile()) return;
    if (!/\.(js|md|yml|yaml|json|html|css|txt)$/i.test(target) && path.basename(target) !== 'server.js') {
      if (!target.endsWith('.js') && !target.endsWith('.md')) return;
    }
    const text = fs.readFileSync(target, 'utf8');
    if (/tenant/i.test(text)) {
      offenders.push(path.relative(path.join(__dirname, '..'), target));
    }
  }
  for (const root of roots) scan(root);
  assert.deepEqual(offenders, [], `tenant word found in: ${offenders.join(', ')}`);
});
