'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const yaml = require('js-yaml');

const { createApp } = require('../server');
const { parseAccessConfig, authenticateRequest } = require('../lib/access-control');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-access-'));
  const alphaRoot = path.join(root, 'alpha');
  const betaRoot = path.join(root, 'beta');

  await fs.mkdir(path.join(alphaRoot, 'docs'), { recursive: true });
  await fs.mkdir(path.join(alphaRoot, 'secret'), { recursive: true });
  await fs.mkdir(betaRoot, { recursive: true });

  await fs.writeFile(path.join(alphaRoot, 'README.md'), '# Alpha\n');
  await fs.writeFile(path.join(alphaRoot, 'docs', 'guide.md'), '# Guide\n![Diagram](diagram.png)\n');
  await fs.writeFile(path.join(alphaRoot, 'docs', 'diagram.png'), 'png-bytes');
  await fs.writeFile(path.join(alphaRoot, 'secret', 'hidden.md'), '# Hidden\n');
  await fs.writeFile(path.join(betaRoot, 'notes.md'), '# Beta\n');

  return {
    root,
    mappings: {
      alpha: alphaRoot,
      beta: betaRoot,
    },
  };
}

async function startTestServer(options) {
  const app = createApp(options);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    async request(targetPath, init) {
      return fetch(`${baseUrl}${targetPath}`, init);
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('query token scopes repo listings and preserves tokenized navigation', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      tokens: {
        viewer: {
          secret: 'viewer-token',
          repos: {
            alpha: { paths: ['docs/', 'README.md'] },
          },
          permissions: {
            view: true,
            edit: false,
          },
        },
      },
    },
  });

  try {
    const indexResponse = await server.request('/?token=viewer-token');
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /\/view\/alpha\?token=viewer-token/);
    assert.doesNotMatch(indexHtml, /beta/);

    const repoResponse = await server.request('/view/alpha?token=viewer-token');
    assert.equal(repoResponse.status, 200);
    const repoHtml = await repoResponse.text();
    assert.match(repoHtml, /README\.md/);
    assert.match(repoHtml, /docs/);
    assert.doesNotMatch(repoHtml, /hidden\.md/);

    const docResponse = await server.request('/view/alpha/docs/guide.md?token=viewer-token');
    assert.equal(docResponse.status, 200);
    const docHtml = await docResponse.text();
    assert.match(docHtml, /\/asset\/alpha\/docs\/diagram\.png\?token=viewer-token/);
    assert.doesNotMatch(docHtml, />Edit</);

    const assetResponse = await server.request('/asset/alpha/docs/diagram.png?token=viewer-token');
    assert.equal(assetResponse.status, 200);

    const deniedRepo = await server.request('/view/beta/notes.md?token=viewer-token');
    assert.equal(deniedRepo.status, 403);

    const deniedEdit = await server.request('/edit/alpha/README.md?token=viewer-token');
    assert.equal(deniedEdit.status, 403);

    const previewResponse = await server.request('/api/preview/alpha/README.md?token=viewer-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Preview\n' }),
    });
    assert.equal(previewResponse.status, 200);
    const previewPayload = await previewResponse.json();
    assert.equal(previewPayload.ok, true);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('edit-scoped token can save while restricted humans and invalid tokens are denied', async () => {
  const fixture = await makeFixture();
  const targetFile = path.join(fixture.mappings.alpha, 'docs', 'guide.md');
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        editor: {
          secret: 'editor-token',
          repos: {
            alpha: { paths: ['docs/'] },
          },
          permissions: {
            view: true,
            edit: true,
          },
        },
      },
    },
  });

  try {
    const humanIndex = await server.request('/');
    assert.equal(humanIndex.status, 401);

    const invalidToken = await server.request('/?token=wrong-token');
    assert.equal(invalidToken.status, 403);

    const editPage = await server.request('/edit/alpha/docs/guide.md?token=editor-token');
    assert.equal(editPage.status, 200);
    const editHtml = await editPage.text();
    assert.match(editHtml, /"saveHref":"\/api\/save\/alpha\/docs\/guide\.md\?token=editor-token"/);

    const beforeStat = await fs.stat(targetFile);
    const saveResponse = await server.request('/api/save/alpha/docs/guide.md?token=editor-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '# Updated\n',
        expectedMtimeMs: Math.trunc(beforeStat.mtimeMs),
      }),
    });
    assert.equal(saveResponse.status, 200);

    const savedContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(savedContent, '# Updated\n');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('bearer auth is preferred for agent flows and preserves token metadata for future APIs', async () => {
  const fixture = await makeFixture();
  const priorToken = process.env.LOOKIE_TEST_HEADER_TOKEN;
  process.env.LOOKIE_TEST_HEADER_TOKEN = 'header-token';
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        cli_agent: {
          secretEnv: 'LOOKIE_TEST_HEADER_TOKEN',
          repos: {
            alpha: { paths: ['README.md'] },
          },
          permissions: {
            view: true,
            edit: false,
          },
          subject: {
            companyId: 'target-co',
            agentIds: ['agent-cli-1'],
          },
          issuer: {
            system: 'paperclip',
            issueId: 'FON-3671',
          },
          audit: {
            grantId: 'static-phase1',
          },
        },
      },
    },
  });

  try {
    const parsed = parseAccessConfig({
      tokens: {
        cli_agent: {
          secretEnv: 'LOOKIE_TEST_HEADER_TOKEN',
          repos: {
            alpha: { paths: ['README.md'] },
          },
          permissions: {
            view: true,
            edit: false,
          },
          subject: {
            companyId: 'target-co',
            agentIds: ['agent-cli-1'],
          },
          issuer: {
            system: 'paperclip',
            issueId: 'FON-3671',
          },
          audit: {
            grantId: 'static-phase1',
          },
        },
      },
    });
    const accessContext = authenticateRequest({
      headers: {
        authorization: 'Bearer header-token',
      },
      query: {
        token: 'wrong-token',
      },
    }, parsed);

    assert.equal(accessContext.mode, 'scoped');
    assert.equal(accessContext.source, 'header');
    assert.equal(accessContext.queryToken, null);
    assert.deepEqual(accessContext.subject, {
      companyId: 'target-co',
      agentIds: ['agent-cli-1'],
    });
    assert.deepEqual(accessContext.issuer, {
      system: 'paperclip',
      issueId: 'FON-3671',
    });
    assert.deepEqual(accessContext.audit, {
      grantId: 'static-phase1',
    });
    assert.deepEqual(accessContext.secretSource, {
      type: 'env',
      value: 'LOOKIE_TEST_HEADER_TOKEN',
    });

    const response = await server.request('/view/alpha/README.md?token=wrong-token', {
      headers: {
        Authorization: 'Bearer header-token',
      },
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /token=wrong-token/);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    if (priorToken === undefined) {
      delete process.env.LOOKIE_TEST_HEADER_TOKEN;
    } else {
      process.env.LOOKIE_TEST_HEADER_TOKEN = priorToken;
    }
  }
});

test('grant lifecycle API issues hashed tokens, enforces approvals, and revokes access', async () => {
  const fixture = await makeFixture();
  const grantStorePath = path.join(fixture.root, 'grants.yaml');
  const projectionPath = path.join(fixture.root, 'grants-projection.yaml');
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      grants: {
        storePath: grantStorePath,
        projectionPath,
        repoOwners: {
          alpha: 'source-co',
        },
        adminTokens: {
          paperclip: {
            secret: 'grant-admin-token',
          },
        },
      },
    },
  });

  try {
    const createMissingApproval = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-1'],
        },
        repoId: 'alpha',
        paths: [],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-1',
        reason: 'Need full repo review',
        adapterAllowRoots: [fixture.mappings.alpha],
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
      }),
    });
    assert.equal(createMissingApproval.status, 400);
    const createMissingApprovalPayload = await createMissingApproval.json();
    assert.match(createMissingApprovalPayload.error, /approvalId is required/i);

    const createMissingAllowRoots = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-1'],
        },
        repoId: 'alpha',
        paths: ['docs/'],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-allow-roots-missing',
        reason: 'Cross-company review without adapter roots',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
        expiresAt: new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString(),
      }),
    });
    assert.equal(createMissingAllowRoots.status, 400);
    const createMissingAllowRootsPayload = await createMissingAllowRoots.json();
    assert.match(createMissingAllowRootsPayload.error, /adapterAllowRoots is required/i);

    const createDisallowedGrant = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-1'],
        },
        repoId: 'alpha',
        paths: ['secret/'],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-allow-roots-denied',
        reason: 'Cross-company review outside adapter roots',
        adapterAllowRoots: [path.join(fixture.mappings.alpha, 'docs')],
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
        expiresAt: new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString(),
      }),
    });
    assert.equal(createDisallowedGrant.status, 400);
    const createDisallowedGrantPayload = await createDisallowedGrant.json();
    assert.match(createDisallowedGrantPayload.error, /outside adapter allow roots/i);

    const createGrantResponse = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-1'],
        },
        repoId: 'alpha',
        paths: ['docs/', 'README.md'],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-1',
        reason: 'Cross-company review requested in FON-3674',
        adapterAllowRoots: [path.join(fixture.mappings.alpha, 'docs'), path.join(fixture.mappings.alpha, 'README.md')],
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
        expiresAt: new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString(),
      }),
    });
    assert.equal(createGrantResponse.status, 201);
    const createdGrantPayload = await createGrantResponse.json();
    assert.equal(createdGrantPayload.ok, true);
    assert.ok(createdGrantPayload.token);
    assert.equal(createdGrantPayload.grant.tokenHash.length, 64);
    assert.equal(createdGrantPayload.grant.state, 'active');
    const expectedAllowRoots = [
      await fs.realpath(path.join(fixture.mappings.alpha, 'README.md')),
      await fs.realpath(path.join(fixture.mappings.alpha, 'docs')),
    ];
    assert.deepEqual(createdGrantPayload.grant.adapterAllowRoots, [
      ...expectedAllowRoots,
    ]);
    assert.deepEqual(createdGrantPayload.grant.paths, ['README.md', 'docs/']);

    const storedYaml = yaml.load(await fs.readFile(grantStorePath, 'utf8'));
    assert.equal(storedYaml.grants.length, 1);
    assert.equal(storedYaml.grants[0].tokenHash, createdGrantPayload.grant.tokenHash);
    assert.notEqual(storedYaml.grants[0].tokenHash, createdGrantPayload.token);
    assert.equal(storedYaml.auditEvents[0].type, 'grant.created');
    const projectedYaml = yaml.load(await fs.readFile(projectionPath, 'utf8'));
    assert.equal(projectedYaml.version, 1);
    assert.equal(projectedYaml.grants.length, 1);
    assert.equal(projectedYaml.grants[0].id, createdGrantPayload.grant.id);
    assert.equal(projectedYaml.grants[0].tokenHash, createdGrantPayload.grant.tokenHash);
    assert.equal(projectedYaml.grants[0].reason, undefined);
    assert.equal(projectedYaml.grants[0].sourceIssueId, undefined);
    assert.equal(projectedYaml.grants[0].adapterAllowRoots, undefined);

    const targetSelfGrant = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-2'],
        },
        repoId: 'alpha',
        paths: ['docs/'],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-2',
        reason: 'Unauthorized self-grant attempt',
        adapterAllowRoots: [fixture.mappings.alpha],
        issuer: {
          role: 'manager_agent',
          companyId: 'target-co',
          agentId: 'manager-2',
        },
      }),
    });
    assert.equal(targetSelfGrant.status, 400);
    const targetSelfGrantPayload = await targetSelfGrant.json();
    assert.match(targetSelfGrantPayload.error, /not allowed to create a grant/i);

    const grantedDoc = await server.request(`/view/alpha/docs/guide.md?token=${createdGrantPayload.token}`);
    assert.equal(grantedDoc.status, 200);

    const deniedSecret = await server.request(`/view/alpha/secret/hidden.md?token=${createdGrantPayload.token}`);
    assert.equal(deniedSecret.status, 403);

    const listResponse = await server.request('/api/grants?includeAudit=true', {
      headers: {
        Authorization: 'Bearer grant-admin-token',
      },
    });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.grants.length, 1);
    assert.ok(Array.isArray(listed.auditEvents));
    assert.equal(listed.grants[0].lastUsedAt === null, false);

    const renewResponse = await server.request(`/api/grants/${createdGrantPayload.grant.id}/renew`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'Extend active review window',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
      }),
    });
    assert.equal(renewResponse.status, 200);
    const renewed = await renewResponse.json();
    assert.ok(renewed.token);
    assert.notEqual(renewed.token, createdGrantPayload.token);
    const renewedProjection = yaml.load(await fs.readFile(projectionPath, 'utf8'));
    assert.equal(renewedProjection.grants.length, 1);
    assert.equal(renewedProjection.grants[0].tokenHash, renewed.grant.tokenHash);

    const oldTokenDenied = await server.request(`/view/alpha/docs/guide.md?token=${createdGrantPayload.token}`);
    assert.equal(oldTokenDenied.status, 403);

    const newTokenGranted = await server.request(`/view/alpha/docs/guide.md?token=${renewed.token}`);
    assert.equal(newTokenGranted.status, 200);

    const revokeResponse = await server.request(`/api/grants/${createdGrantPayload.grant.id}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'Review complete',
        issuer: {
          role: 'ceo_agent',
          companyId: 'source-co',
          agentId: 'ceo-1',
        },
      }),
    });
    assert.equal(revokeResponse.status, 200);

    const revokedTokenDenied = await server.request(`/view/alpha/docs/guide.md?token=${renewed.token}`);
    assert.equal(revokedTokenDenied.status, 403);
    const revokedProjection = yaml.load(await fs.readFile(projectionPath, 'utf8'));
    assert.deepEqual(revokedProjection.grants, []);

    const finalYaml = yaml.load(await fs.readFile(grantStorePath, 'utf8'));
    assert.equal(finalYaml.auditEvents.some((event) => event.type === 'grant.renewed'), true);
    assert.equal(finalYaml.auditEvents.some((event) => event.type === 'grant.token.rotated'), true);
    assert.equal(finalYaml.auditEvents.some((event) => event.type === 'grant.revoked'), true);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('expired grants are removed from the projection on lifecycle rollover', async () => {
  const fixture = await makeFixture();
  const grantStorePath = path.join(fixture.root, 'grants.yaml');
  const projectionPath = path.join(fixture.root, 'grants-projection.yaml');
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      grants: {
        storePath: grantStorePath,
        projectionPath,
        repoOwners: {
          alpha: 'source-co',
        },
        adminTokens: {
          paperclip: {
            secret: 'grant-admin-token',
          },
        },
      },
    },
  });

  try {
    const createGrantResponse = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceCompanyId: 'source-co',
        targetCompanyId: 'target-co',
        subject: {
          companyId: 'target-co',
          agentIds: ['agent-expiring'],
        },
        repoId: 'alpha',
        paths: ['docs/'],
        permissions: {
          view: true,
          edit: false,
        },
        sourceIssueId: 'issue-expiring',
        reason: 'Short-lived projection test',
        adapterAllowRoots: [path.join(fixture.mappings.alpha, 'docs')],
        issuer: {
          role: 'manager_agent',
          companyId: 'source-co',
          agentId: 'manager-1',
        },
        expiresAt: new Date(Date.now() + 25).toISOString(),
      }),
    });
    assert.equal(createGrantResponse.status, 201);

    const initialProjection = yaml.load(await fs.readFile(projectionPath, 'utf8'));
    assert.equal(initialProjection.grants.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const listExpiredResponse = await server.request('/api/grants?state=expired&includeAudit=true', {
      headers: {
        Authorization: 'Bearer grant-admin-token',
      },
    });
    assert.equal(listExpiredResponse.status, 200);
    const expiredPayload = await listExpiredResponse.json();
    assert.equal(expiredPayload.grants.length, 1);
    assert.equal(expiredPayload.grants[0].state, 'expired');
    assert.equal(expiredPayload.auditEvents.some((event) => event.type === 'grant.expired'), true);

    const updatedProjection = yaml.load(await fs.readFile(projectionPath, 'utf8'));
    assert.deepEqual(updatedProjection.grants, []);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
