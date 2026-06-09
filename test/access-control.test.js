'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const yaml = require('js-yaml');

const { createApp } = require('../server');
const { parseAccessConfig, authenticateRequest } = require('../lib/access-control');
const HTML_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'html', 'render-demo.htm');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-access-'));
  const alphaRoot = path.join(root, 'alpha');
  const betaRoot = path.join(root, 'beta');
  const htmlFixture = await fs.readFile(HTML_FIXTURE_PATH, 'utf8');

  await fs.mkdir(path.join(alphaRoot, 'docs'), { recursive: true });
  await fs.mkdir(path.join(alphaRoot, 'secret'), { recursive: true });
  await fs.mkdir(betaRoot, { recursive: true });

  await fs.writeFile(path.join(alphaRoot, 'README.md'), '# Alpha\n');
  await fs.writeFile(path.join(alphaRoot, 'docs', 'guide.md'), '# Guide\n![Diagram](diagram.png)\n');
  await fs.writeFile(path.join(alphaRoot, 'docs', 'landing.htm'), htmlFixture);
  await fs.writeFile(
    path.join(alphaRoot, 'docs', 'settings.yaml'),
    [
      'database:',
      '  connection:',
      '    host: localhost',
      '    port: 5432',
      'features:',
      '  dark_mode: true',
      '',
    ].join('\n')
  );
  await fs.writeFile(path.join(alphaRoot, 'docs', 'manual.pdf'), '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await fs.writeFile(path.join(alphaRoot, 'docs', 'diagram.png'), 'png-bytes');
  await fs.writeFile(path.join(alphaRoot, 'secret', 'hidden.md'), '# Hidden\n');
  await fs.writeFile(path.join(betaRoot, 'notes.md'), '# Beta\n');

  return {
    root,
    mappings: {
      alpha: alphaRoot,
      beta: betaRoot,
    },
    grantPaths: {
      store: path.join(root, 'grants.yaml'),
      projection: path.join(root, 'grants-projection.yaml'),
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

test('GET /api/repos returns repo discovery payload for unrestricted humans', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
  });

  try {
    const response = await server.request('/api/repos');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);

    const payload = await response.json();
    assert.ok(Array.isArray(payload.repos));
    assert.equal(payload.count, payload.repos.length);
    assert.equal(payload.count, 2);

    const reposByName = new Map(payload.repos.map((entry) => [entry.repo, entry]));
    assert.ok(reposByName.has('alpha'));
    assert.ok(reposByName.has('beta'));

    const alphaEntry = reposByName.get('alpha');
    assert.equal(alphaEntry.rootPath, fixture.mappings.alpha);
    assert.equal(alphaEntry.viewUrl, '/view/alpha/');
    assert.equal(alphaEntry.assetUrl, '/asset/alpha/');
    for (const entry of payload.repos) {
      assert.equal(typeof entry.repo, 'string');
      assert.equal(typeof entry.rootPath, 'string');
      assert.equal(typeof entry.viewUrl, 'string');
      assert.equal(typeof entry.assetUrl, 'string');
    }
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GET /api/repos filters by grant scope and rejects unauthenticated/invalid tokens', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
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
    const unauthenticated = await server.request('/api/repos');
    assert.equal(unauthenticated.status, 401);

    const invalid = await server.request('/api/repos?token=wrong-token');
    assert.equal(invalid.status, 403);

    const scoped = await server.request('/api/repos?token=viewer-token');
    assert.equal(scoped.status, 200);
    const scopedPayload = await scoped.json();
    assert.equal(scopedPayload.count, 1);
    assert.equal(scopedPayload.repos.length, 1);
    assert.equal(scopedPayload.repos[0].repo, 'alpha');
    assert.equal(scopedPayload.repos[0].rootPath, fixture.mappings.alpha);
    assert.equal(scopedPayload.repos[0].viewUrl, '/view/alpha/');
    assert.equal(scopedPayload.repos[0].assetUrl, '/asset/alpha/');
    assert.ok(!scopedPayload.repos.some((entry) => entry.repo === 'beta'));

    const bearer = await server.request('/api/repos', {
      headers: { Authorization: 'Bearer viewer-token' },
    });
    assert.equal(bearer.status, 200);
    const bearerPayload = await bearer.json();
    assert.equal(bearerPayload.count, 1);
    assert.equal(bearerPayload.repos[0].repo, 'alpha');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('home page (/) still renders the repo index for unrestricted humans', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
  });

  try {
    const response = await server.request('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const body = await response.text();
    assert.match(body, /Available Repositories/);
    assert.match(body, /\/view\/alpha/);
    assert.match(body, /\/view\/beta/);
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

test('html and htm files render as sanitized documents with raw toggle and edit access', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
  });

  try {
    const viewResponse = await server.request('/view/alpha/docs/landing.htm');
    assert.equal(viewResponse.status, 200);
    const viewHtml = await viewResponse.text();
    assert.match(viewHtml, /<article class="content html" data-rendered-view>/);
    assert.match(viewHtml, /<section>\s*<h1 id="hello">Hello<a class="anchor-link"/);
    assert.doesNotMatch(viewHtml, /<script>alert\(1\)<\/script>/);
    assert.match(viewHtml, /data-raw-toggle/);
    assert.match(viewHtml, /language-xml" data-raw-code/);
    assert.match(viewHtml, /· html<\/p>/);

    const editResponse = await server.request('/edit/alpha/docs/landing.htm');
    assert.equal(editResponse.status, 200);
    const editHtml = await editResponse.text();
    assert.match(editHtml, /Edit landing\.htm/);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('yaml files render nested key anchors with full-path slugs', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
  });

  try {
    const viewResponse = await server.request('/view/alpha/docs/settings.yaml');
    assert.equal(viewResponse.status, 200);
    const viewHtml = await viewResponse.text();
    assert.match(viewHtml, /<span id="database" class="yaml-anchor-wrap">/);
    assert.match(viewHtml, /<span id="database-connection" class="yaml-anchor-wrap yaml-anchor-l2">/);
    assert.match(viewHtml, /<span id="database-connection-host" class="yaml-anchor-wrap yaml-anchor-l2">/);
    assert.match(viewHtml, /data-anchor-id="database-connection-host"/);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('pdf files render in a dedicated viewer page and stream from the asset route', async () => {
  const fixture = await makeFixture();
  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      tokens: {
        viewer: {
          secret: 'viewer-token',
          repos: {
            alpha: { paths: ['docs/'] },
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
    const viewResponse = await server.request('/view/alpha/docs/manual.pdf?token=viewer-token');
    assert.equal(viewResponse.status, 200);
    const viewHtml = await viewResponse.text();
    assert.match(viewHtml, /class="content pdf-view"/);
    assert.match(viewHtml, /<iframe[\s\S]*class="pdf-frame"/);
    assert.match(viewHtml, /\/asset\/alpha\/docs\/manual\.pdf\?token=viewer-token#view=FitH/);
    assert.match(viewHtml, /· pdf<\/p>/);
    assert.doesNotMatch(viewHtml, />Edit</);

    const assetResponse = await server.request('/asset/alpha/docs/manual.pdf?token=viewer-token');
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('content-type'), 'application/pdf');

    const editResponse = await server.request('/edit/alpha/docs/manual.pdf?token=viewer-token');
    assert.equal(editResponse.status, 403);
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

test('managed grant API creates issue-linked grants and enforces grant tokens', async () => {
  const fixture = await makeFixture();
  const priorAdminToken = process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
  process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = 'grant-admin-token';

  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      grants: {
        storePath: fixture.grantPaths.store,
        projectionPath: fixture.grantPaths.projection,
        repoOwners: {
          alpha: 'source-company',
        },
        repoRoots: fixture.mappings,
        adminTokens: {
          paperclip: {
            secretEnv: 'LOOKIE_TEST_GRANT_ADMIN_TOKEN',
          },
        },
      },
    },
  });

  try {
    const createResponse = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'alpha',
        sourceCompanyId: 'source-company',
        targetCompanyId: 'target-company',
        subject: {
          companyId: 'target-company',
          agentIds: ['agent-bob'],
        },
        permissions: {
          view: true,
          edit: false,
        },
        paths: ['docs/'],
        sourceIssueId: 'FON-3675',
        approvalId: 'APR-100',
        reason: 'Cross-company review requested in issue.',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
        adapterAllowRoots: [fixture.mappings.alpha],
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json();
    assert.equal(createPayload.ok, true);
    assert.equal(createPayload.grant.sourceIssueId, 'FON-3675');
    assert.match(createPayload.issueComment.markdown, /\[FON-3675\]\(\/FON\/issues\/FON-3675\)/);
    assert.ok(createPayload.token);

    const grantedView = await server.request('/view/alpha/docs/guide.md', {
      headers: {
        Authorization: `Bearer ${createPayload.token}`,
      },
    });
    assert.equal(grantedView.status, 200);

    const deniedView = await server.request('/view/alpha/secret/hidden.md', {
      headers: {
        Authorization: `Bearer ${createPayload.token}`,
      },
    });
    assert.equal(deniedView.status, 403);

    const projectionRaw = await fs.readFile(fixture.grantPaths.projection, 'utf8');
    assert.match(projectionRaw, /id:/);
    assert.doesNotMatch(projectionRaw, /Cross-company review requested in issue/);

    const listResponse = await server.request('/api/grants?state=active&includeAudit=1', {
      headers: {
        Authorization: 'Bearer grant-admin-token',
      },
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.grants.length, 1);
    assert.ok(Array.isArray(listPayload.auditEvents));

    const renewResponse = await server.request(`/api/grants/${createPayload.grant.id}/renew`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
        reason: 'Need additional review time.',
        expiresAt: '2099-01-02T00:00:00.000Z',
      }),
    });
    assert.equal(renewResponse.status, 200);
    const renewPayload = await renewResponse.json();
    assert.equal(renewPayload.grant.expiresAt, '2099-01-02T00:00:00.000Z');
    assert.ok(renewPayload.token);
    assert.match(renewPayload.issueComment.markdown, /Renewed Lookie-Link grant/);

    const oldTokenDenied = await server.request('/view/alpha/docs/guide.md', {
      headers: {
        Authorization: `Bearer ${createPayload.token}`,
      },
    });
    assert.equal(oldTokenDenied.status, 403);

    const renewedTokenView = await server.request('/view/alpha/docs/guide.md', {
      headers: {
        Authorization: `Bearer ${renewPayload.token}`,
      },
    });
    assert.equal(renewedTokenView.status, 200);

    const revokeResponse = await server.request(`/api/grants/${createPayload.grant.id}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
        reason: 'Issue resolved.',
      }),
    });
    assert.equal(revokeResponse.status, 200);
    const revokePayload = await revokeResponse.json();
    assert.equal(revokePayload.grant.state, 'revoked');
    assert.match(revokePayload.issueComment.markdown, /Revoked Lookie-Link grant/);

    const revokedView = await server.request('/view/alpha/docs/guide.md', {
      headers: {
        Authorization: `Bearer ${renewPayload.token}`,
      },
    });
    assert.equal(revokedView.status, 403);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    if (priorAdminToken === undefined) {
      delete process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
    } else {
      process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = priorAdminToken;
    }
  }
});

test('managed grant API rejects issue-linked creates and renewals without explicit expiry', async () => {
  const fixture = await makeFixture();
  const priorAdminToken = process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
  process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = 'grant-admin-token';

  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      grants: {
        storePath: fixture.grantPaths.store,
        repoOwners: {
          alpha: 'source-company',
        },
        repoRoots: fixture.mappings,
        adminTokens: {
          paperclip: {
            secretEnv: 'LOOKIE_TEST_GRANT_ADMIN_TOKEN',
          },
        },
      },
    },
  });

  try {
    const createResponse = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'alpha',
        sourceCompanyId: 'source-company',
        targetCompanyId: 'source-company',
        subject: {
          companyId: 'source-company',
          agentIds: ['agent-bob'],
        },
        permissions: {
          view: true,
          edit: false,
        },
        paths: ['docs/'],
        sourceIssueId: 'FON-3675',
        reason: 'Missing explicit expiry should fail.',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
      }),
    });
    assert.equal(createResponse.status, 400);
    const createPayload = await createResponse.json();
    assert.match(createPayload.error, /expiresAt is required/);

    const seededCreate = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'alpha',
        sourceCompanyId: 'source-company',
        targetCompanyId: 'source-company',
        subject: {
          companyId: 'source-company',
          agentIds: ['agent-bob'],
        },
        permissions: {
          view: true,
          edit: false,
        },
        paths: ['docs/'],
        sourceIssueId: 'FON-3675',
        approvalId: 'APR-101',
        reason: 'Seed grant for renew validation.',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
      }),
    });
    assert.equal(seededCreate.status, 201);
    const seededPayload = await seededCreate.json();

    const renewResponse = await server.request(`/api/grants/${seededPayload.grant.id}/renew`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
        reason: 'Missing explicit expiry should fail.',
      }),
    });
    assert.equal(renewResponse.status, 400);
    const renewPayload = await renewResponse.json();
    assert.match(renewPayload.error, /expiresAt is required/);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    if (priorAdminToken === undefined) {
      delete process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
    } else {
      process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = priorAdminToken;
    }
  }
});

test('managed grant expiry emits a linked issue comment helper in audit events', async () => {
  const fixture = await makeFixture();
  const priorAdminToken = process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
  process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = 'grant-admin-token';

  const server = await startTestServer({
    mappings: fixture.mappings,
    editingEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      grants: {
        storePath: fixture.grantPaths.store,
        repoOwners: {
          alpha: 'source-company',
        },
        repoRoots: fixture.mappings,
        adminTokens: {
          paperclip: {
            secretEnv: 'LOOKIE_TEST_GRANT_ADMIN_TOKEN',
          },
        },
      },
    },
  });

  try {
    const createResponse = await server.request('/api/grants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer grant-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'alpha',
        sourceCompanyId: 'source-company',
        targetCompanyId: 'source-company',
        subject: {
          companyId: 'source-company',
          agentIds: ['agent-bob'],
        },
        permissions: {
          view: true,
          edit: false,
        },
        paths: ['docs/'],
        sourceIssueId: 'FON-3675',
        approvalId: 'APR-102',
        reason: 'Grant that will be force-expired for audit coverage.',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuer: {
          role: 'manager_agent',
          companyId: 'source-company',
          agentId: 'agent-manager',
        },
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    const storeRaw = await fs.readFile(fixture.grantPaths.store, 'utf8');
    const store = yaml.load(storeRaw);
    store.grants[0].expiresAt = '2000-01-01T00:00:00.000Z';
    await fs.writeFile(fixture.grantPaths.store, yaml.dump(store, { noRefs: true, sortKeys: true }), 'utf8');

    const listResponse = await server.request('/api/grants?includeAudit=1', {
      headers: {
        Authorization: 'Bearer grant-admin-token',
      },
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    const expiredEvent = listPayload.auditEvents.find((event) => event.grantId === created.grant.id && event.type === 'grant.expired');
    assert.ok(expiredEvent);
    assert.equal(expiredEvent.expiresAt, '2000-01-01T00:00:00.000Z');
    assert.equal(expiredEvent.issueComment.issueId, 'FON-3675');
    assert.match(expiredEvent.issueComment.markdown, /Expired Lookie-Link grant/);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });

    if (priorAdminToken === undefined) {
      delete process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN;
    } else {
      process.env.LOOKIE_TEST_GRANT_ADMIN_TOKEN = priorAdminToken;
    }
  }
});
