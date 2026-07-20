'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-managed-http-'));
  const allowRoot = path.join(root, 'managed');
  await fs.mkdir(allowRoot);
  const app = createApp({
    mappings: {},
    managedReposConfig: {
      storePath: path.join(root, 'registry.yaml'),
      allowRoots: [allowRoot],
      adminTokens: { operator: { secret: 'managed-admin-placeholder' } },
    },
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        writer: {
          secret: 'writer-placeholder',
          repos: { 'shared-notes': { paths: ['notes/'] } },
          permissions: { view: true, write: true },
        },
        reader: {
          secret: 'reader-placeholder',
          repos: { 'shared-notes': { paths: ['notes/'] } },
          permissions: { view: true },
        },
        maintainer: {
          secret: 'maintainer-placeholder',
          repos: ['shared-notes'],
          permissions: { view: true, write: true },
        },
      },
    },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  return {
    root,
    allowRoot,
    async request(route, init = {}) {
      return fetch(`http://127.0.0.1:${address.port}${route}`, init);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function auth(token, extras = {}) {
  return { Authorization: `Bearer ${token}`, ...extras };
}

test('managed repo HTTP CRUD is scoped, conflict-aware, non-leaking, and recoverable', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const create = await fixture.request('/api/managed-repos', {
    method: 'POST',
    headers: auth('managed-admin-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ repoId: 'shared-notes', rootPath: path.join(fixture.allowRoot, 'shared-notes') }),
  });
  assert.equal(create.status, 201);
  assert.equal(Object.hasOwn((await create.json()).repo, 'rootPath'), false);

  const discovery = await fixture.request('/api/repos', { headers: auth('writer-placeholder') });
  assert.equal(discovery.status, 200);
  assert.equal(Object.hasOwn((await discovery.json()).repos[0], 'rootPath'), false);

  const write = await fixture.request('/api/managed-repos/shared-notes/files/notes/topic.md', {
    method: 'PUT',
    headers: auth('writer-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: '# Shared topic\n', expectedMtimeMs: null }),
  });
  assert.equal(write.status, 201);
  const written = await write.json();

  const hiddenWrite = await fixture.request('/api/managed-repos/shared-notes/files/private/secret.md', {
    method: 'PUT',
    headers: auth('maintainer-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: 'private marker\n', expectedMtimeMs: null }),
  });
  assert.equal(hiddenWrite.status, 201);

  const forbiddenExisting = await fixture.request('/api/managed-repos/shared-notes/files/private/secret.md', {
    headers: auth('reader-placeholder'),
  });
  const absent = await fixture.request('/api/managed-repos/shared-notes/files/private/absent.md', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(forbiddenExisting.status, 404);
  assert.equal(absent.status, 404);
  assert.deepEqual(await forbiddenExisting.json(), await absent.json());

  const hiddenAsset = await fixture.request('/asset/shared-notes/private/secret.md', {
    headers: auth('reader-placeholder'),
  });
  const absentAsset = await fixture.request('/asset/shared-notes/private/absent.md', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(hiddenAsset.status, 404);
  assert.equal(absentAsset.status, 404);
  assert.equal(await hiddenAsset.text(), await absentAsset.text());

  const viewOnlyMutation = await fixture.request('/api/managed-repos/shared-notes/files/notes/topic.md', {
    method: 'PUT',
    headers: auth('reader-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: 'not allowed\n' }),
  });
  assert.equal(viewOnlyMutation.status, 404);

  const stale = await fixture.request('/api/managed-repos/shared-notes/files/notes/topic.md', {
    method: 'PUT',
    headers: auth('writer-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: 'stale\n', expectedMtimeMs: written.mtimeMs - 1 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.exists, true);

  const tree = await fixture.request('/api/managed-repos/shared-notes/tree?maxEntries=50', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(tree.status, 200);
  const treePayload = await tree.json();
  assert.ok(treePayload.entries.some((entry) => entry.path === 'notes/topic.md'));
  assert.equal(treePayload.entries.some((entry) => entry.path.includes('private')), false);

  const softDelete = await fixture.request('/api/managed-repos/shared-notes/files/notes/topic.md', {
    method: 'DELETE',
    headers: auth('writer-placeholder'),
  });
  assert.equal(softDelete.status, 200);
  const deleted = await softDelete.json();
  assert.equal(deleted.deleted, 'soft');

  const hiddenTrash = await fixture.request(`/asset/shared-notes/.lookie-link-trash/${deleted.trashId}/payload`, {
    headers: auth('maintainer-placeholder'),
  });
  assert.equal(hiddenTrash.status, 404);

  const restore = await fixture.request(`/api/managed-repos/shared-notes/trash/${deleted.trashId}/restore`, {
    method: 'POST',
    headers: auth('writer-placeholder'),
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).path, 'notes/topic.md');

  const softDeleteAgain = await fixture.request('/api/managed-repos/shared-notes/files/notes/topic.md', {
    method: 'DELETE',
    headers: auth('writer-placeholder'),
  });
  const discarded = await softDeleteAgain.json();
  const hardDeleteTrash = await fixture.request(`/api/managed-repos/shared-notes/trash/${discarded.trashId}`, {
    method: 'DELETE',
    headers: auth('writer-placeholder'),
  });
  assert.equal(hardDeleteTrash.status, 200);
  assert.equal((await hardDeleteTrash.json()).deleted, 'hard');
});

test('search and suggest responses contain only caller-visible managed paths', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const create = await fixture.request('/api/managed-repos', {
    method: 'POST',
    headers: auth('managed-admin-placeholder', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ repoId: 'shared-notes', rootPath: path.join(fixture.allowRoot, 'shared-notes') }),
  });
  assert.equal(create.status, 201);

  for (const [filePath, content] of [
    ['notes/visible-topic.md', 'common scope marker in visible content\n'],
    ['private/hidden-topic.md', 'common scope marker in private content\n'],
  ]) {
    const write = await fixture.request(`/api/managed-repos/shared-notes/files/${filePath}`, {
      method: 'PUT',
      headers: auth('maintainer-placeholder', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content, expectedMtimeMs: null }),
    });
    assert.equal(write.status, 201);
  }

  const search = await fixture.request('/api/search?q=common%20scope%20marker&limit=10&maxEntries=50', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(search.status, 200);
  const searchText = await search.text();
  const searchPayload = JSON.parse(searchText);
  assert.deepEqual(searchPayload.results.map((entry) => entry.path), ['notes/visible-topic.md']);
  assert.equal(searchText.includes('hidden-topic'), false);
  assert.equal(searchText.includes('private content'), false);

  const suggest = await fixture.request('/api/search/suggest?q=topic&limit=10', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(suggest.status, 200);
  const suggestText = await suggest.text();
  assert.deepEqual(JSON.parse(suggestText).suggestions.map((entry) => entry.path), ['notes/visible-topic.md']);
  assert.equal(suggestText.includes('hidden-topic'), false);

  const excludedScope = await fixture.request('/api/search?q=common&scope=unknown-repo', {
    headers: auth('reader-placeholder'),
  });
  assert.equal(excludedScope.status, 200);
  assert.deepEqual((await excludedScope.json()).results, []);
});
