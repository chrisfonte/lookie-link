'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ApiKeyStore } = require('../lib/api-key-store');
const {
  mutationUsesQueryToken,
  parseAccessConfig,
  resolveCredentialAccess,
} = require('../lib/access-control');
const { createApp } = require('../server');

function bearerRequest(secret, query = {}) {
  return {
    method: 'GET',
    path: '/view/docs/readme.md',
    headers: { authorization: `Bearer ${secret}` },
    query,
    get(name) {
      return this.headers[String(name).toLowerCase()] || null;
    },
  };
}

function makeStore(storePath) {
  return new ApiKeyStore({
    storePath,
    adminTokens: [{ name: 'local_operator', secret: 'admin-placeholder-secret' }],
  });
}

function keyInput() {
  return {
    label: 'Example automation',
    subject: {
      companyId: 'example-company',
      agentId: 'agent-example',
      label: 'Display label is not audit identity',
    },
    permissions: { view: true, write: true, publish: false },
    repos: { docs: { paths: ['drafts/'] } },
    issuer: {
      actorType: 'operator',
      actorId: 'operator',
      actorLabel: 'Display label is redacted from audit',
    },
  };
}

function captureResponse() {
  const captured = { status: null, body: null };
  return {
    captured,
    response: {
      status(status) {
        captured.status = status;
        return this;
      },
      json(body) {
        captured.body = body;
        return this;
      },
    },
  };
}

async function invokeRoute(app, routePath, req) {
  const routeLayer = app._router.stack.find((layer) => layer.route && layer.route.path === routePath);
  assert.ok(routeLayer, `expected route ${routePath}`);
  const { captured, response } = captureResponse();
  await routeLayer.route.stack[0].handle(req, response);
  return captured;
}

test('managed API keys are hashed, mode 0600, one-time, rotatable, revocable, and audit-redacted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-api-keys-'));
  const storePath = path.join(root, 'agent-api-keys.json');
  const store = makeStore(storePath);
  const admin = store.authenticateAdminToken('admin-placeholder-secret');

  try {
    const created = store.createKey(keyInput(), admin);
    assert.ok(created.token);
    assert.equal(created.key.subject.agentId, 'agent-example');
    assert.equal(Object.hasOwn(created.key, 'secretHash'), false);
    assert.equal(Object.hasOwn(created.key, 'token'), false);

    const initialRaw = await fs.readFile(storePath, 'utf8');
    const initialDisk = JSON.parse(initialRaw);
    assert.equal(initialRaw.includes(created.token), false);
    assert.match(initialDisk.keys[0].secretHash, /^[a-f0-9]{64}$/);
    assert.equal((await fs.stat(storePath)).mode & 0o777, 0o600);

    const listed = store.listKeys({ includeAudit: true });
    assert.equal(Object.hasOwn(listed.keys[0], 'secretHash'), false);
    assert.equal(Object.hasOwn(listed.keys[0], 'token'), false);
    const access = store.authenticateKey(created.token, 'header', null);
    assert.deepEqual(access.principal, {
      kind: 'agent',
      id: 'agent-example',
      credentialKind: 'api_key',
      credentialId: created.key.id,
    });

    const rotated = store.rotateKey(created.key.id, { reason: created.token }, admin);
    assert.ok(rotated.token);
    assert.notEqual(rotated.token, created.token);
    assert.equal(store.authenticateKey(created.token, 'header', null), null);
    assert.equal(store.authenticateKey(rotated.token, 'header', null).keyId, created.key.id);

    store.recordAuditEvent('content.write', store.authenticateKey(rotated.token, 'header', null), {
      repo: 'docs',
      relativePath: 'drafts/example.md',
    }, {
      outcome: 'accepted',
      byteCount: 12,
      secret: rotated.token,
    });
    const revoked = store.revokeKey(created.key.id, { reason: rotated.token }, admin);
    assert.equal(revoked.key.state, 'revoked');
    assert.equal(store.authenticateKey(rotated.token, 'header', null), null);

    const finalDisk = JSON.parse(await fs.readFile(storePath, 'utf8'));
    const auditJson = JSON.stringify(finalDisk.auditEvents);
    assert.equal(auditJson.includes(created.token), false);
    assert.equal(auditJson.includes(rotated.token), false);
    assert.equal(auditJson.includes('Display label is redacted from audit'), false);
    assert.equal(auditJson.includes('Display label is not audit identity'), false);
    assert.equal((await fs.stat(storePath)).mode & 0o777, 0o600);

    for (const keyId of [created.key.id, 'random-key-id']) {
      assert.throws(
        () => store.rotateKey(keyId, {}, admin),
        (error) => error.code === 'ENOTFOUND' && error.message === 'Agent API key not found.'
      );
      assert.throws(
        () => store.revokeKey(keyId, { reason: 'repeat' }, admin),
        (error) => error.code === 'ENOTFOUND' && error.message === 'Agent API key not found.'
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('API-key comparison explicitly uses timingSafeEqual', async () => {
  for (const relativePath of ['lib/access-control.js', 'lib/api-key-store.js', 'lib/grant-store.js']) {
    const source = await fs.readFile(path.join(__dirname, '..', relativePath), 'utf8');
    assert.match(source, /crypto\.createHash\('sha256'\).*\.digest\(\)/s);
    assert.match(source, /crypto\.timingSafeEqual\(/);
    assert.doesNotMatch(source, /if \(leftBuffer\.length !== rightBuffer\.length\)/);
  }

  const apiKeySource = await fs.readFile(path.join(__dirname, '..', 'lib', 'api-key-store.js'), 'utf8');
  assert.match(apiKeySource, /constantTimeEqual\(apiKey\.secretHash, hash\)/);
  assert.doesNotMatch(apiKeySource, /apiKey\.secretHash\s*!==\s*hash/);
});

test('credentials resolve static token then API key then grant with header precedence', () => {
  const calls = [];
  const apiKeyStore = {
    isEnabled: () => true,
    authenticateKey(secret, source, queryToken) {
      calls.push(['api_key', secret, source, queryToken]);
      return secret === 'api-placeholder' ? { mode: 'scoped', authType: 'api_key' } : null;
    },
  };
  const grantStore = {
    isEnabled: () => true,
    authenticateGrantToken(secret, source, queryToken) {
      calls.push(['grant', secret, source, queryToken]);
      return secret === 'grant-placeholder' ? { mode: 'scoped', authType: 'grant' } : null;
    },
  };
  const staticConfig = parseAccessConfig({
    humanDefault: 'restricted',
    tokens: {
      static: { secret: 'static-placeholder', repos: 'all', permissions: { view: true } },
    },
  });

  const staticAccess = resolveCredentialAccess(
    bearerRequest('static-placeholder', { token: 'api-placeholder' }),
    staticConfig,
    apiKeyStore,
    grantStore
  );
  assert.equal(staticAccess.authType, 'static_token');
  assert.deepEqual(calls, []);

  const deniedStaticConfig = parseAccessConfig({ humanDefault: 'restricted' });
  const apiAccess = resolveCredentialAccess(
    bearerRequest('api-placeholder', { token: 'grant-placeholder' }),
    deniedStaticConfig,
    apiKeyStore,
    grantStore
  );
  assert.equal(apiAccess.authType, 'api_key');
  assert.deepEqual(calls, [['api_key', 'api-placeholder', 'header', null]]);

  calls.length = 0;
  const grantAccess = resolveCredentialAccess(
    bearerRequest('grant-placeholder'),
    deniedStaticConfig,
    apiKeyStore,
    grantStore
  );
  assert.equal(grantAccess.authType, 'grant');
  assert.deepEqual(calls, [
    ['api_key', 'grant-placeholder', 'header', null],
    ['grant', 'grant-placeholder', 'header', null],
  ]);
});

test('mutation query tokens are rejected even when a bearer header is present', () => {
  assert.equal(mutationUsesQueryToken({
    method: 'POST',
    path: '/api/save/docs/file.md',
    headers: { authorization: 'Bearer header-placeholder' },
    query: { token: 'query-placeholder' },
  }), true);
  assert.equal(mutationUsesQueryToken({
    method: 'GET',
    path: '/view/docs/file.md',
    query: { token: 'query-placeholder' },
  }), false);
  assert.equal(mutationUsesQueryToken({
    method: 'POST',
    path: '/api/preview/docs/file.md',
    query: { token: 'query-placeholder' },
  }), true);
  assert.equal(mutationUsesQueryToken({
    method: 'PATCH',
    path: '/API/ANNOTATIONS/docs/file.md',
    query: { token: 'query-placeholder' },
  }), true);
  assert.equal(mutationUsesQueryToken({
    method: 'DELETE',
    path: '/future/mutation',
    query: { token: 'query-placeholder' },
  }), true);
  assert.equal(mutationUsesQueryToken({
    method: 'PUT',
    path: '/future/mutation',
    query: { token: '' },
  }), true);
});

test('key-ID denials are uniform before and after authorized lookup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-api-key-routes-'));
  const store = makeStore(path.join(root, 'keys.json'));
  const admin = store.authenticateAdminToken('admin-placeholder-secret');
  const created = store.createKey(keyInput(), admin);
  store.revokeKey(created.key.id, { reason: 'completed' }, admin);
  const app = createApp({ mappings: {}, accessConfig: { humanDefault: 'restricted' }, apiKeyStore: store });

  try {
    const invalidKnown = await invokeRoute(app, '/api/agent-keys/:keyId/rotate', {
      ...bearerRequest('invalid-admin'),
      params: { keyId: created.key.id },
      body: {},
    });
    const invalidRandom = await invokeRoute(app, '/api/agent-keys/:keyId/rotate', {
      ...bearerRequest('invalid-admin'),
      params: { keyId: 'random-key-id' },
      body: {},
    });
    assert.deepEqual(invalidKnown, invalidRandom);
    assert.equal(invalidKnown.status, 403);

    const missingRevoked = await invokeRoute(app, '/api/agent-keys/:keyId/rotate', {
      ...bearerRequest('admin-placeholder-secret'),
      params: { keyId: created.key.id },
      body: {},
    });
    const missingRandom = await invokeRoute(app, '/api/agent-keys/:keyId/rotate', {
      ...bearerRequest('admin-placeholder-secret'),
      params: { keyId: 'random-key-id' },
      body: {},
    });
    assert.deepEqual(missingRevoked, missingRandom);
    assert.deepEqual(missingRevoked, {
      status: 404,
      body: { ok: false, error: 'Agent API key not found.' },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
