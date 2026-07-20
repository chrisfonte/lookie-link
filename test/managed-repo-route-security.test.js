'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ManagedRepoStore } = require('../lib/managed-repo-store');
const { createApp } = require('../server');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-managed-route-security-'));
  const allowed = path.join(root, 'allowed');
  await fs.mkdir(allowed);
  const store = new ManagedRepoStore({
    storePath: path.join(root, 'registry.yaml'),
    allowRoots: [allowed],
  });
  const repo = store.createRepo({
    repoId: 'shared-notes',
    rootPath: path.join(allowed, 'shared-notes'),
  }).repo;
  return { root, store, repo };
}

function getRouteHandler(app, method, routePath) {
  const layer = app._router.stack.find((entry) => (
    entry.route && entry.route.path === routePath && entry.route.methods[method]
  ));
  assert(layer, `Missing route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function rootScopedViewer(repoId) {
  return {
    mode: 'scoped',
    permissions: { view: true, write: false, edit: false, publish: false },
    allRepos: false,
    repos: { [repoId]: [{ type: 'all', path: '' }] },
  };
}

test('tree route uniformly hides trash starts from a root-scoped viewer', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  await setup.store.writeFile(setup.repo, 'notes/topic.md', '# Topic\n', null);
  const deleted = await setup.store.deleteFile(setup.repo, 'notes/topic.md');

  let listTreeCalls = 0;
  setup.store.listTree = async () => {
    listTreeCalls += 1;
    throw new Error('The route guard must reject internal paths before listTree.');
  };
  const app = createApp({ managedRepoStore: setup.store, mappings: {} });
  const handler = getRouteHandler(app, 'get', '/api/managed-repos/:repo/tree');

  for (const relativePath of [
    setup.repo.policy.trashDirName,
    `${setup.repo.policy.trashDirName}/${deleted.trashId}`,
  ]) {
    const res = createMockRes();
    await handler({
      params: { repo: setup.repo.id },
      query: { path: relativePath },
      accessContext: rootScopedViewer(setup.repo.id),
    }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, error: 'Not found.' });
    assert.equal(JSON.stringify(res.body).includes(deleted.trashId), false);
    assert.equal(JSON.stringify(res.body).includes('metadata'), false);
  }
  assert.equal(listTreeCalls, 0);
});

test('unauthorized trash mutations do not read metadata or reveal existence', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  await setup.store.writeFile(setup.repo, 'notes/topic.md', '# Topic\n', null);
  const deleted = await setup.store.deleteFile(setup.repo, 'notes/topic.md');

  let metadataReads = 0;
  const originalGetTrashMetadata = setup.store.getTrashMetadata.bind(setup.store);
  setup.store.getTrashMetadata = async (...args) => {
    metadataReads += 1;
    return originalGetTrashMetadata(...args);
  };
  const app = createApp({ managedRepoStore: setup.store, mappings: {} });
  const missingTrashId = '00000000-0000-4000-8000-000000000000';

  for (const [method, routePath] of [
    ['post', '/api/managed-repos/:repo/trash/:trashId/restore'],
    ['delete', '/api/managed-repos/:repo/trash/:trashId'],
  ]) {
    const handler = getRouteHandler(app, method, routePath);
    const responses = [];
    for (const trashId of [deleted.trashId, missingTrashId]) {
      const res = createMockRes();
      await handler({
        params: { repo: setup.repo.id, trashId },
        accessContext: rootScopedViewer(setup.repo.id),
      }, res);
      responses.push(res);
    }
    assert.deepEqual(
      responses.map((res) => ({ status: res.statusCode, body: res.body })),
      [
        { status: 404, body: { ok: false, error: 'Not found.' } },
        { status: 404, body: { ok: false, error: 'Not found.' } },
      ]
    );
  }
  assert.equal(metadataReads, 0);
});
