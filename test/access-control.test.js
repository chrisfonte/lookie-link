'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

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
