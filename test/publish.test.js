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
      assert.deepEqual(await response.json(), { ok: false, error: { code: 'forbidden', message: 'Access denied.' } });
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

function readRequest(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

test('GET /api/publish lists publications, filters by state, and 304s on a matching ETag', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token: publishToken } = await createKey(server, { view: true, publish: true });
    const { token: viewToken } = await createKey(server, { view: true, publish: false });

    const empty = await server.request('/api/publish', readRequest(viewToken));
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.publications, []);
    assert.equal(emptyBody.count, 0);
    assert.equal(typeof emptyBody.revision, 'string');
    assert.equal(typeof emptyBody.generatedAt, 'string');
    assert.ok(empty.headers.get('etag'));

    await server.request('/api/publish', publishRequest(publishToken, {
      slug: 'listed-one', files: [{ path: 'index.md', content: 'one' }],
    }));
    await server.request('/api/publish', publishRequest(publishToken, {
      slug: 'listed-two', files: [{ path: 'index.md', content: 'two' }],
    }));

    const afterCreate = await server.request('/api/publish', readRequest(viewToken));
    assert.equal(afterCreate.status, 200);
    const afterCreateBody = await afterCreate.json();
    assert.equal(afterCreateBody.count, 2);
    const slugs = afterCreateBody.publications.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ['listed-one', 'listed-two']);
    assert.ok(afterCreateBody.publications.every((p) => p.revisions === undefined));
    assert.notEqual(afterCreateBody.revision, emptyBody.revision);

    await server.request('/api/publish/listed-one/revoke', publishRequest(publishToken, { reason: 'testing filter' }));

    const activeOnly = await server.request('/api/publish?state=active', readRequest(viewToken));
    const activeBody = await activeOnly.json();
    assert.deepEqual(activeBody.publications.map((p) => p.slug), ['listed-two']);

    const revokedOnly = await server.request('/api/publish?state=revoked', readRequest(viewToken));
    const revokedBody = await revokedOnly.json();
    assert.deepEqual(revokedBody.publications.map((p) => p.slug), ['listed-one']);
    assert.equal(revokedBody.publications[0].state, 'revoked');

    const currentEtag = revokedOnly.headers.get('etag');
    const notModified = await server.request('/api/publish?state=revoked', {
      headers: { Authorization: `Bearer ${viewToken}`, 'If-None-Match': currentEtag },
    });
    assert.equal(notModified.status, 304);

    const badState = await server.request('/api/publish?state=nope', readRequest(viewToken));
    assert.equal(badState.status, 400);

    const unknownParam = await server.request('/api/publish?bogus=1', readRequest(viewToken));
    assert.equal(unknownParam.status, 400);
    const unknownParamBody = await unknownParam.json();
    assert.equal(unknownParamBody.error.code, 'invalid_request');

    // Path-scoped (not whole-repo) credentials cannot list, same as they
    // cannot publish/update/revoke (canAccessRepo requires a whole-repo scope).
    const pathScoped = await createKey(
      server,
      { view: true, publish: true },
      { published: { paths: ['listed-two/'] } }
    );
    const denied = await server.request('/api/publish', readRequest(pathScoped.token));
    assert.equal(denied.status, 403);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /api/publish/:slug returns the record with revision history, ?version, revoked readback, and 404', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer(fixture);
  try {
    const { token: publishToken } = await createKey(server, { view: true, publish: true });
    const { token: viewToken } = await createKey(server, { view: true, publish: false });

    await server.request('/api/publish', publishRequest(publishToken, {
      slug: 'show-me',
      files: [{ path: 'index.md', content: '# One\n' }],
      entryPath: 'index.md',
    }));
    await server.request('/api/publish/show-me', publishRequest(publishToken, {
      expectedRevision: 1,
      files: [{ path: 'index.md', content: '# Two\n' }],
      entryPath: 'index.md',
    }));

    const show = await server.request('/api/publish/show-me', readRequest(viewToken));
    assert.equal(show.status, 200);
    const showBody = await show.json();
    assert.equal(showBody.publication.slug, 'show-me');
    assert.equal(showBody.publication.currentRevision, 2);
    assert.equal(showBody.publication.revisions.length, 2);
    assert.equal(showBody.publication.viewUrl, '/view/published/show-me/index.md');
    assert.equal(showBody.publication.rootViewUrl, '/view/published/show-me');
    assert.ok(show.headers.get('etag'));

    const withVersion = await server.request('/api/publish/show-me?version=1', readRequest(viewToken));
    assert.equal(withVersion.status, 200);
    const withVersionBody = await withVersion.json();
    assert.equal(withVersionBody.version, 1);
    assert.equal(withVersionBody.files.revision, 1);
    assert.equal(withVersionBody.files.entryPath, 'index.md');

    const badVersion = await server.request('/api/publish/show-me?version=99', readRequest(viewToken));
    assert.equal(badVersion.status, 404);

    const badParam = await server.request('/api/publish/show-me?version=abc', readRequest(viewToken));
    assert.equal(badParam.status, 400);

    const unknownSlug = await server.request('/api/publish/does-not-exist', readRequest(viewToken));
    assert.equal(unknownSlug.status, 404);
    const unknownSlugBody = await unknownSlug.json();
    assert.equal(unknownSlugBody.error.code, 'not_found');

    await server.request('/api/publish/show-me/revoke', publishRequest(publishToken, { reason: 'done' }));
    const revokedShow = await server.request('/api/publish/show-me', readRequest(viewToken));
    assert.equal(revokedShow.status, 200);
    const revokedBody = await revokedShow.json();
    assert.equal(revokedBody.publication.state, 'revoked');
    assert.equal(revokedBody.publication.revokedReason, 'done');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
