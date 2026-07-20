'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  authenticateRequest,
  canAccessPath,
  parseAccessConfig,
} = require('../lib/access-control');
const { GrantStore } = require('../lib/grant-store');
const { createApp } = require('../server');

function requestWithBearer(secret) {
  return {
    headers: { authorization: `Bearer ${secret}` },
    query: {},
  };
}

test('static tokens normalize legacy edit and canonical write permissions', () => {
  for (const permissions of [{ edit: true }, { write: true }]) {
    const config = parseAccessConfig({
      humanDefault: 'restricted',
      tokens: {
        writer: {
          secret: 'static-writer-placeholder',
          permissions,
          repos: { docs: { paths: ['drafts/'] } },
        },
      },
    });
    const access = authenticateRequest(requestWithBearer('static-writer-placeholder'), config);

    assert.deepEqual(access.permissions, { view: true, write: true, edit: true, publish: false });
    assert.equal(canAccessPath(access, 'write', 'docs', 'drafts/note.md'), true);
    assert.equal(canAccessPath(access, 'edit', 'docs', 'drafts/note.md'), true);
  }
});

test('canAccessPath remains compatible with pre-normalized edit-only contexts', () => {
  const legacyContext = {
    mode: 'scoped',
    permissions: { view: true, edit: true },
    allRepos: true,
    repos: {},
  };

  assert.equal(canAccessPath(legacyContext, 'write', 'docs', 'note.md'), true);
  assert.equal(canAccessPath(legacyContext, 'edit', 'docs', 'note.md'), true);
});

test('managed grants normalize legacy edit to canonical write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-auth-grant-'));
  const storePath = path.join(root, 'grants.json');
  const repoRoot = path.join(root, 'docs');
  await fs.mkdir(repoRoot);
  const store = new GrantStore({
    storePath,
    projectionPath: null,
    repoOwners: { docs: 'example-company' },
    adminTokens: [],
    repoRoots: { docs: repoRoot },
  });

  try {
    const created = store.createGrant({
      repoId: 'docs',
      sourceCompanyId: 'example-company',
      targetCompanyId: 'example-company',
      subject: { companyId: 'example-company', agentIds: ['agent-example'] },
      permissions: { edit: true },
      paths: ['drafts/'],
      sourceIssueId: 'EXAMPLE-1',
      approvalId: 'APPROVAL-1',
      reason: 'Compatibility test.',
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuer: {
        role: 'manager_agent',
        companyId: 'example-company',
        agentId: 'agent-manager',
      },
    });
    const access = store.authenticateGrantToken(created.token, 'header', null);

    assert.deepEqual(created.grant.permissions, { view: true, write: true, edit: true, publish: false });
    assert.equal(canAccessPath(access, 'write', 'docs', 'drafts/note.md'), true);
    assert.equal(canAccessPath(access, 'edit', 'docs', 'drafts/note.md'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('publish remains independent from write and is consumed by the publish endpoint', async () => {
  const config = parseAccessConfig({
    humanDefault: 'restricted',
    tokens: {
      publisher: {
        secret: 'publisher-placeholder',
        permissions: { view: false, publish: true },
        repos: { docs: 'all' },
      },
    },
  });
  const access = authenticateRequest(requestWithBearer('publisher-placeholder'), config);
  const roundTrippedConfig = parseAccessConfig({
    humanDefault: 'restricted',
    tokens: {
      publisher: {
        secret: 'publisher-placeholder',
        permissions: config.tokens[0].permissions,
        repos: { docs: 'all' },
      },
    },
  });
  const roundTrippedAccess = authenticateRequest(requestWithBearer('publisher-placeholder'), roundTrippedConfig);

  assert.deepEqual(access.permissions, { view: true, write: false, edit: false, publish: true });
  assert.deepEqual(roundTrippedAccess.permissions, { view: true, write: false, edit: false, publish: true });
  assert.equal(canAccessPath(access, 'publish', 'docs', 'release.md'), true);
  assert.equal(canAccessPath(access, 'write', 'docs', 'release.md'), false);

  const app = createApp({ mappings: {}, accessConfig: config });
  const routePaths = app._router.stack
    .map((layer) => layer.route && layer.route.path)
    .filter(Boolean);
  assert.deepEqual(routePaths.filter((routePath) => String(routePath).includes('publish')), [
    '/api/publish',
    '/api/publish/:slug',
    '/api/publish/:slug/revoke',
  ]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-auth-publish-'));
  const repoRoot = path.join(root, 'docs');
  await fs.mkdir(repoRoot);
  const grantStore = new GrantStore({
    storePath: path.join(root, 'grants.json'),
    projectionPath: null,
    repoOwners: { docs: 'example-company' },
    adminTokens: [],
    repoRoots: { docs: repoRoot },
  });

  try {
    const created = grantStore.createGrant({
      repoId: 'docs',
      sourceCompanyId: 'example-company',
      targetCompanyId: 'example-company',
      subject: { companyId: 'example-company', agentIds: ['agent-publisher'] },
      permissions: { view: false, publish: true },
      paths: ['releases/'],
      sourceIssueId: 'EXAMPLE-2',
      approvalId: 'APPROVAL-2',
      reason: 'Authorization vocabulary test.',
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuer: {
        role: 'manager_agent',
        companyId: 'example-company',
        agentId: 'agent-manager',
      },
    });
    const grantAccess = grantStore.authenticateGrantToken(created.token, 'header', null);

    assert.deepEqual(created.grant.permissions, { view: true, write: false, edit: false, publish: true });
    assert.equal(canAccessPath(grantAccess, 'publish', 'docs', 'releases/v1.md'), true);
    assert.equal(canAccessPath(grantAccess, 'write', 'docs', 'releases/v1.md'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
