'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');

const ADMIN_TOKEN = 'publish-test-admin-token';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-publish-routes-'));
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

async function startTestServer(fixture) {
  const app = createApp({
    mappings: { secret: fixture.sourceRepo },
    rawHtmlEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      apiKeys: {
        storePath: fixture.apiKeyStorePath,
        adminTokens: { operator: { secret: ADMIN_TOKEN } },
      },
    },
    publishConfig: { areaPath: fixture.publishArea },
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

async function createKey(server, permissions, repos = { published: true }) {
  const response = await server.request('/api/agent-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Publisher',
      subject: { companyId: 'example', agentId: `agent-${Date.now()}`, label: 'Publish test' },
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

test('publish routes create immutable history, reuse view/asset/raw readback, revoke, and audit', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server, { view: true, publish: true });
    const createdResponse = await server.request('/api/publish', publishRequest(token, {
      slug: 'route-history',
      files: [
        { path: 'index.md', content: '# First revision\n\n![Asset](asset.txt)\n' },
        { path: 'asset.txt', content: 'first asset' },
        { path: 'page.html', content: '<!doctype html><title>Raw one</title>' },
      ],
      entryPath: 'index.md',
    }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.viewUrl, '/view/published/route-history/index.md');

    const updateResponse = await server.request('/api/publish/route-history', publishRequest(token, {
      expectedRevision: 1,
      files: [
        { path: 'index.md', content: '# Second revision\n' },
        { path: 'asset.txt', content: 'second asset' },
        { path: 'page.html', content: '<!doctype html><title>Raw two</title>' },
      ],
      entryPath: 'index.md',
    }));
    assert.equal(updateResponse.status, 200);

    const latest = await server.request('/view/published/route-history/index.md', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(latest.status, 200);
    assert.match(await latest.text(), /Second revision/);

    const historical = await server.request('/view/published/route-history/index.md?version=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(historical.status, 200);
    assert.match(await historical.text(), /First revision/);

    const asset = await server.request('/asset/published/route-history/asset.txt?version=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'first asset');

    const raw = await server.request('/raw/published/route-history/page.html?version=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(raw.status, 200);
    assert.match(await raw.text(), /Raw one/);

    const revoke = await server.request('/api/publish/route-history/revoke', publishRequest(token, {
      reason: 'superseded',
    }));
    assert.equal(revoke.status, 200);
    for (const url of [
      '/view/published/route-history/index.md',
      '/asset/published/route-history/asset.txt?version=1',
      '/raw/published/route-history/page.html?version=1',
    ]) {
      const response = await server.request(url, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 410);
    }

    const audit = await server.request('/api/agent-keys?includeAudit=1', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(audit.status, 200);
    const auditPayload = await audit.json();
    const eventTypes = auditPayload.auditEvents.map((event) => event.type);
    assert.ok(eventTypes.includes('publish.create'));
    assert.ok(eventTypes.includes('publish.update'));
    assert.ok(eventTypes.includes('publish.revoke'));
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish mutations require publish capability and matching expectedRevision', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const viewKey = await createKey(server, { view: true, write: true, publish: false });
    const denied = await server.request('/api/publish', publishRequest(viewKey.token, {
      slug: 'denied', files: [{ path: 'index.md', content: 'denied' }],
    }));
    assert.equal(denied.status, 403);

    const missing = await server.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'missing', files: [{ path: 'index.md', content: 'missing' }] }),
    });
    assert.equal(missing.status, 401);

    const publishKey = await createKey(server, { view: true, publish: true });
    const create = await server.request('/api/publish', publishRequest(publishKey.token, {
      slug: 'stale-guard', files: [{ path: 'index.md', content: 'one' }],
    }));
    assert.equal(create.status, 201);
    const update = await server.request('/api/publish/stale-guard', publishRequest(publishKey.token, {
      expectedRevision: 1, files: [{ path: 'index.md', content: 'two' }],
    }));
    assert.equal(update.status, 200);
    const conflict = await server.request('/api/publish/stale-guard', publishRequest(publishKey.token, {
      expectedRevision: 1, files: [{ path: 'index.md', content: 'stale' }],
    }));
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.equal(payload.currentRevision, 2);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish requires whole-repo scope for create, update, and revoke', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const repoPublisher = await createKey(server, { view: true, publish: true });
    const create = await server.request('/api/publish', publishRequest(repoPublisher.token, {
      slug: 'repo-level', files: [{ path: 'index.md', content: 'one' }],
    }));
    assert.equal(create.status, 201);

    const pathPublisher = await createKey(
      server,
      { view: true, publish: true },
      { published: { paths: ['repo-level/'] } }
    );
    const deniedRequests = [
      server.request('/api/publish', publishRequest(pathPublisher.token, {
        files: [{ path: 'index.md', content: 'must not mint an out-of-scope slug' }],
      })),
      server.request('/api/publish/repo-level', publishRequest(pathPublisher.token, {
        expectedRevision: 1, files: [{ path: 'index.md', content: 'must not update' }],
      })),
      server.request('/api/publish/repo-level/revoke', publishRequest(pathPublisher.token, {
        reason: 'must not revoke',
      })),
    ];

    for (const response of await Promise.all(deniedRequests)) {
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { ok: false, error: 'Access denied.' });
    }

    const entries = await fs.readdir(fixture.publishArea);
    assert.deepEqual(entries, ['repo-level']);
    const publication = JSON.parse(await fs.readFile(
      path.join(fixture.publishArea, 'repo-level', 'publication.json'),
      'utf8'
    ));
    assert.equal(publication.currentRevision, 1);
    assert.equal(publication.revokedAt, null);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('publish repo id cannot shadow a configured repository mapping', async () => {
  const fixture = await makeFixture();
  try {
    assert.throws(() => createApp({
      mappings: { published: fixture.sourceRepo },
      accessConfig: { humanDefault: 'restricted' },
      publishConfig: { areaPath: fixture.publishArea, repoId: 'published' },
    }), /publish\.repoId "published" conflicts with a configured repository mapping/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('private publish metadata is not exposed and never grants source-repo access', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token } = await createKey(server, { view: true, publish: true });
    const response = await server.request('/api/publish', publishRequest(token, {
      slug: 'isolated',
      files: [{ path: 'index.md', content: '# Public artifact\n' }],
      metadata: { sourceRepo: 'secret', label: 'safe public label' },
      privateMetadata: { sourceRepo: 'secret', sourceRoot: fixture.sourceRepo },
    }));
    assert.equal(response.status, 201);
    const payloadText = await response.text();
    assert.doesNotMatch(payloadText, new RegExp(fixture.sourceRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(payloadText, /privateMetadata/);

    const source = await server.request('/view/secret/secret.md', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(source.status, 403);

    const internalMetadata = await server.request('/asset/published/isolated/publication.json', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(internalMetadata.status, 404);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
