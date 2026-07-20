'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { GrantStore } = require('../lib/grant-store');

function grantInput(repoRoot, overrides = {}) {
  return {
    repoId: 'docs',
    sourceCompanyId: 'source-company',
    targetCompanyId: 'target-company',
    subject: { companyId: 'target-company', agentIds: ['agent-example'] },
    permissions: { view: true, write: false, publish: false },
    paths: ['shared/'],
    sourceIssueId: 'EXAMPLE-3',
    approvalId: 'APPROVAL-3',
    reason: 'Cross-company review.',
    expiresAt: '2099-01-01T00:00:00.000Z',
    issuer: {
      role: 'manager_agent',
      companyId: 'source-company',
      agentId: 'agent-manager',
    },
    adapterAllowRoots: [repoRoot],
    ...overrides,
  };
}

test('grant access carries tested non-secret issuer and subject lineage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-grant-policy-'));
  const repoRoot = path.join(root, 'docs');
  await fs.mkdir(path.join(repoRoot, 'shared'), { recursive: true });
  const store = new GrantStore({
    storePath: path.join(root, 'grants.json'),
    projectionPath: null,
    repoOwners: { docs: 'source-company' },
    adminTokens: [],
    repoRoots: { docs: repoRoot },
  });

  try {
    const created = store.createGrant(grantInput(repoRoot));
    const access = store.authenticateGrantToken(created.token, 'header', null);

    assert.equal(access.authType, 'grant');
    assert.equal(access.grantId, created.grant.id);
    assert.deepEqual(access.subject, {
      companyId: 'target-company',
      agentIds: ['agent-example'],
      userIds: [],
      agents: null,
    });
    assert.deepEqual(access.principal, {
      kind: 'agent',
      id: 'agent-example',
      credentialKind: 'grant',
      credentialId: created.grant.id,
      grantId: created.grant.id,
    });
    assert.deepEqual(access.issuer, { agentId: 'agent-manager', userId: null });
    assert.equal(access.sourceCompanyId, 'source-company');
    assert.equal(access.targetCompanyId, 'target-company');
    assert.equal(Object.hasOwn(access, 'grant'), false);
    assert.equal(JSON.stringify(access).includes('tokenHash'), false);
    assert.equal(JSON.stringify(access).includes(repoRoot), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('grant subject company and cross-company allow roots are enforced', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-grant-roots-'));
  const repoRoot = path.join(root, 'docs');
  const outsideRoot = path.join(root, 'outside');
  await fs.mkdir(path.join(repoRoot, 'shared'), { recursive: true });
  await fs.mkdir(outsideRoot);
  const store = new GrantStore({
    storePath: path.join(root, 'grants.json'),
    projectionPath: null,
    repoOwners: { docs: 'source-company' },
    adminTokens: [],
    repoRoots: { docs: repoRoot },
  });

  try {
    assert.throws(
      () => store.createGrant(grantInput(repoRoot, {
        subject: { companyId: 'unrelated-company', agentIds: ['agent-example'] },
      })),
      /subject\.companyId must match targetCompanyId/
    );
    assert.throws(
      () => store.createGrant(grantInput(repoRoot, { adapterAllowRoots: undefined })),
      /adapterAllowRoots is required/
    );
    assert.throws(
      () => store.createGrant(grantInput(repoRoot, { adapterAllowRoots: [outsideRoot] })),
      /outside adapter allow roots/
    );
    assert.doesNotThrow(() => store.createGrant(grantInput(repoRoot)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('grant hash lookup uses constant-time comparison', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'lib', 'grant-store.js'), 'utf8');
  assert.match(source, /constantTimeEqual\(grant\.tokenHash, hash\)/);
  assert.doesNotMatch(source, /grant\.tokenHash\s*!==\s*hash/);
});
