'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const { createApp } = require('../server');

const ADMIN_TOKEN = 'publish-kit-test-admin-token';
const OPS_CSS = fsSync.readFileSync(path.join(__dirname, '..', 'kits', 'ops', 'kit.css'), 'utf8');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-publish-kit-'));
  const sourceRepo = path.join(root, 'private-source');
  await fs.mkdir(sourceRepo);
  await fs.writeFile(path.join(sourceRepo, 'secret.md'), '# not published\n');
  return {
    root,
    sourceRepo,
    publishArea: path.join(root, 'publish-area'),
    apiKeyStorePath: path.join(root, 'agent-api-keys.yaml'),
  };
}

async function startTestServer(fixture, options = {}) {
  const app = createApp({
    mappings: { secret: fixture.sourceRepo },
    rawHtmlEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      apiKeys: {
        storePath: fixture.apiKeyStorePath,
        adminTokens: { operator: { secret: ADMIN_TOKEN } },
      },
      ...(options.accessExtra || {}),
    },
    publishConfig: { areaPath: fixture.publishArea },
    kitsConfig: options.kitsConfig,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    async request(targetPath, init) {
      return fetch(`http://127.0.0.1:${address.port}${targetPath}`, init);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function createKey(server, permissions = { view: true, publish: true }, repos = { published: true }) {
  const response = await server.request('/api/agent-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Publisher',
      subject: { companyId: 'example', agentId: `agent-${Date.now()}-${Math.random()}`, label: 'Publish kit test' },
      permissions,
      repos,
      issuer: { actorType: 'operator', actorId: 'test' },
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function publishRequest(token, body) {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const PLACEHOLDER_HTML = [
  '<!doctype html>',
  '<html><head>',
  '<meta charset="utf-8">',
  '<link rel="stylesheet" href="kit.css" data-kit>',
  '<title>Kit page</title>',
  '</head><body><h1>Hello</h1></body></html>',
].join('');

const PREINLINED_HTML = [
  '<!doctype html>',
  '<html><head>',
  '<meta charset="utf-8">',
  '<style data-kit="ops" data-kit-version="1.26">',
  '/* already inlined */',
  '</style>',
  '<title>Pre</title>',
  '</head><body></body></html>',
].join('');

test('publish with kit:ops inlines stylesheet, replaces placeholder link, and projects kit', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server);
    const createdResponse = await server.request('/api/publish', publishRequest(token, {
      slug: 'with-kit',
      kit: 'ops',
      entryPath: 'index.html',
      files: [
        { path: 'index.html', content: PLACEHOLDER_HTML },
        { path: 'notes.txt', content: 'leave me alone' },
      ],
    }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.publication.kit.name, 'ops');
    assert.equal(created.publication.kit.version, '1.26');
    assert.equal(typeof created.publication.kit.revision, 'string');
    assert.ok(created.publication.kit.revision.length > 0);
    assert.equal(created.publication.revisions[0].kit.name, 'ops');

    const raw = await server.request('/raw/published/with-kit/index.html', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(raw.status, 200);
    const html = await raw.text();
    assert.match(html, /<style data-kit="ops" data-kit-version="1\.26">/);
    assert.ok(html.includes(OPS_CSS));
    // kit.css comments mention <link rel="stylesheet">; assert only on markup
    // outside <style>…</style> blocks.
    const markupOutsideStyle = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    assert.doesNotMatch(markupOutsideStyle, /<link\b/i);

    const notes = await server.request('/asset/published/with-kit/notes.txt', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(notes.status, 200);
    assert.equal(await notes.text(), 'leave me alone');

    const listed = await server.request('/api/publish', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    const summary = listBody.publications.find((entry) => entry.slug === 'with-kit');
    assert.equal(summary.kit.name, 'ops');
    assert.equal(summary.kit.version, '1.26');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish leaves pre-inlined style data-kit alone and kit:true uses the default', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server);
    const pre = await server.request('/api/publish', publishRequest(token, {
      slug: 'pre-inlined',
      kit: 'ops',
      entryPath: 'index.html',
      files: [{ path: 'index.html', content: PREINLINED_HTML }],
    }));
    assert.equal(pre.status, 201);
    const preRaw = await server.request('/raw/published/pre-inlined/index.html', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(await preRaw.text(), PREINLINED_HTML);

    const withDefault = await server.request('/api/publish', publishRequest(token, {
      slug: 'default-kit',
      kit: true,
      entryPath: 'index.html',
      files: [{ path: 'index.html', content: PLACEHOLDER_HTML }],
    }));
    assert.equal(withDefault.status, 201);
    const body = await withDefault.json();
    assert.equal(body.publication.kit.name, 'ops');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('unknown kit is 400 with details; kits disabled with kit set is feature_disabled', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server);
    const unknown = await server.request('/api/publish', publishRequest(token, {
      slug: 'bad-kit',
      kit: 'no-such-kit',
      files: [{ path: 'index.html', content: PLACEHOLDER_HTML }],
    }));
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.error.code, 'invalid_request');
    assert.deepEqual(unknownBody.error.details, [{ path: 'kit', message: 'unknown kit: no-such-kit' }]);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }

  const disabledFixture = await makeFixture();
  const disabledServer = await startTestServer(disabledFixture, { kitsConfig: { enabled: false } });
  try {
    const { token } = await createKey(disabledServer);
    const disabled = await disabledServer.request('/api/publish', publishRequest(token, {
      slug: 'kits-off',
      kit: 'ops',
      files: [{ path: 'index.html', content: PLACEHOLDER_HTML }],
    }));
    assert.equal(disabled.status, 400);
    const body = await disabled.json();
    assert.equal(body.error.code, 'feature_disabled');
  } finally {
    await disabledServer.close();
    await fs.rm(disabledFixture.root, { recursive: true, force: true });
  }
});

test('revise with kit inlines revision 2 only; revision 1 bytes and projection stay unchanged', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server);
    const v1Html = '<!doctype html><html><head><title>v1</title></head><body>one</body></html>';
    const created = await server.request('/api/publish', publishRequest(token, {
      slug: 'revise-kit',
      entryPath: 'index.html',
      files: [{ path: 'index.html', content: v1Html }],
    }));
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.publication.kit, null);
    assert.equal(createdBody.publication.revisions[0].kit, null);

    const updated = await server.request('/api/publish/revise-kit', publishRequest(token, {
      expectedRevision: 1,
      kit: 'ops',
      entryPath: 'index.html',
      files: [{ path: 'index.html', content: PLACEHOLDER_HTML }],
    }));
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.publication.currentRevision, 2);
    assert.equal(updatedBody.publication.kit.name, 'ops');
    assert.equal(updatedBody.publication.revisions[0].kit, null);
    assert.equal(updatedBody.publication.revisions[1].kit.name, 'ops');

    const v1 = await server.request('/raw/published/revise-kit/index.html?version=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(v1.status, 200);
    assert.equal(await v1.text(), v1Html);

    const v2 = await server.request('/raw/published/revise-kit/index.html?version=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(v2.status, 200);
    const v2Html = await v2.text();
    assert.match(v2Html, /<style data-kit="ops" data-kit-version="1\.26">/);
    assert.ok(v2Html.includes(OPS_CSS));

    const getV1 = await server.request('/api/publish/revise-kit?version=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getV1.status, 200);
    const getV1Body = await getV1.json();
    assert.equal(getV1Body.files.kit, null);
    assert.equal(getV1Body.publication.revisions[0].kit, null);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish without kit projects kit: null', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server);
    const created = await server.request('/api/publish', publishRequest(token, {
      slug: 'no-kit',
      files: [{ path: 'index.md', content: '# plain\n' }],
    }));
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.publication.kit, null);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a revision published under an admin token overlay bakes the overlay in; earlier revisions stay frozen', async () => {
  const fixture = await makeFixture();
  const managedFolder = path.join(fixture.root, 'managed-kits');
  const server = await startTestServer(fixture, { kitsConfig: { managedFolder }, accessExtra: { appearance: { adminTokens: { ops: { secret: ADMIN_TOKEN } } } } });
  try {
    const { token } = await createKey(server);
    const admin = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
    const first = await server.request('/api/publish', publishRequest(token, { slug: 'overlay-kit', kit: 'ops', entryPath: 'index.html', files: [{ path: 'index.html', content: PLACEHOLDER_HTML }] }));
    assert.equal(first.status, 201);
    const rev1Before = await (await server.request('/raw/published/overlay-kit/index.html', { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(!rev1Before.includes('lookie-link kit overlay'), 'no overlay yet');
    const catalogResponse = await server.request('/api/kits', { headers: { Authorization: `Bearer ${token}` } });
    const catalogText = await catalogResponse.text();
    assert.equal(catalogResponse.status, 200, catalogText);
    const catalog = JSON.parse(catalogText);
    const patch = await server.request('/api/kits/ops', { method: 'PATCH', headers: admin, body: JSON.stringify({ expectedRevision: catalog.revision, tokens: { '--radius': '3px' } }) });
    const patchText = await patch.text();
    assert.equal(patch.status, 200, patchText);
    const effective = JSON.parse(patchText).kit.effectiveVersion;
    assert.match(effective, /^1\.26\+[0-9a-f]{8}$/);
    const rev1After = await (await server.request('/raw/published/overlay-kit/index.html?version=1', { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.equal(rev1After, rev1Before, 'revision 1 bytes are frozen');
    const second = await server.request('/api/publish/overlay-kit', publishRequest(token, { expectedRevision: 1, kit: 'ops', entryPath: 'index.html', files: [{ path: 'index.html', content: PLACEHOLDER_HTML }] }));
    const secondText = await second.text();
    assert.equal(second.status, 200, secondText);
    const body = JSON.parse(secondText);
    assert.equal(body.publication.kit.version, effective, 'revision 2 records the effective version');
    assert.equal(body.publication.revisions[0].kit.version, '1.26', 'revision 1 keeps its version');
    const rev2 = await (await server.request('/raw/published/overlay-kit/index.html', { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(rev2.includes('lookie-link kit overlay') && rev2.includes('--radius:3px'), 'overlay baked into revision 2');
    assert.ok(rev2.includes(`data-kit-version="${effective}"`), 'style block carries the effective version');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
