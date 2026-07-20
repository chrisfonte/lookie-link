'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');
const { ManagedRepoStore } = require('../lib/managed-repo-store');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-discovery-'));
  const docsRoot = path.join(root, 'docs-root');
  const privateRoot = path.join(root, 'private-root');
  const managedRoot = path.join(root, 'managed');
  await fs.mkdir(path.join(docsRoot, 'notes'), { recursive: true });
  await fs.mkdir(privateRoot, { recursive: true });
  await fs.mkdir(managedRoot, { recursive: true });
  await fs.writeFile(path.join(docsRoot, 'notes', 'readme.md'), '# Notes\n');
  return {
    root,
    mappings: { docs: docsRoot, private: privateRoot },
    managedRoot,
    managedStorePath: path.join(root, 'managed-repos.json'),
    publishArea: path.join(root, 'publish-area'),
  };
}

async function startServer(options) {
  const app = createApp(options);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    async request(targetPath, init) {
      return fetch(`${baseUrl}${targetPath}`, init);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function bearer(secret) {
  return { headers: { Authorization: `Bearer ${secret}` } };
}

function assertNoHostRoots(value, fixture) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(fixture.root), false);
  assert.equal(serialized.includes(os.homedir()), false);
  assert.equal(serialized.includes('rootPath'), false);
  assert.equal(serialized.includes('repoMappings'), false);
}

test('discovery reflects scoped caller identity and omits unauthorized repos, routes, and roots', async () => {
  const fixture = await makeFixture();
  const server = await startServer({
    mappings: fixture.mappings,
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        reader: {
          secret: 'reader-placeholder',
          subject: {
            companyId: 'example-company',
            agentId: 'agent-reader',
            label: 'Reader Agent',
            internalPath: fixture.privateRoot,
          },
          issuer: { internalPath: fixture.privateRoot },
          audit: { sourcePath: fixture.privateRoot },
          repos: { docs: { paths: ['notes/'] } },
          permissions: { view: true },
        },
      },
    },
    publishConfig: { areaPath: fixture.publishArea },
    editingEnabled: true,
    annotationsEnabled: true,
    rawHtmlEnabled: true,
  });

  try {
    const whoamiResponse = await server.request('/api/whoami', bearer('reader-placeholder'));
    assert.equal(whoamiResponse.status, 200);
    const whoami = await whoamiResponse.json();
    assert.deepEqual(whoami.auth, {
      mode: 'scoped',
      type: 'static_token',
      source: 'header',
      queryToken: false,
    });
    assert.deepEqual(whoami.subject, {
      companyId: 'example-company',
      agentId: 'agent-reader',
      label: 'Reader Agent',
    });
    assert.deepEqual(whoami.repoScopes, [{
      repo: 'docs',
      managed: false,
      scopes: [{ type: 'directory', path: 'notes' }],
    }]);
    assert.equal(whoami.capabilities.assetRead, true);
    assert.equal(whoami.capabilities.annotations, true);
    assert.equal(whoami.capabilities.rawHtml, true);
    assert.equal(whoami.capabilities.editing, false);
    assert.equal(whoami.capabilities.annotationWrite, false);
    assert.equal(whoami.capabilities.publish, false);
    assert.equal(whoami.capabilities.managedRepos, false);
    assert.equal(whoami.capabilities.search, false);
    assert.equal(Object.hasOwn(whoami.endpoints, 'save'), false);
    assert.equal(Object.hasOwn(whoami.endpoints, 'annotationCreate'), false);
    assert.equal(Object.hasOwn(whoami.endpoints, 'publishCreate'), false);
    assert.equal(Object.hasOwn(whoami.endpoints, 'managedFileRead'), false);
    assertNoHostRoots(whoami, fixture);

    const discoveryResponse = await server.request('/.well-known/agent.json', bearer('reader-placeholder'));
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.name, 'lookie-link');
    assert.deepEqual(discovery.caller, {
      auth: whoami.auth,
      subject: whoami.subject,
      permissions: whoami.permissions,
      repoScopes: whoami.repoScopes,
    });
    assert.deepEqual(discovery.capabilities, whoami.capabilities);
    assert.deepEqual(discovery.endpoints, whoami.endpoints);
    assert.equal(JSON.stringify(discovery).includes('"repo":"private"'), false);
    assert.equal(JSON.stringify(discovery).includes('reader-placeholder'), false);
    assertNoHostRoots(discovery, fixture);

    const reposResponse = await server.request('/api/repos', bearer('reader-placeholder'));
    assert.equal(reposResponse.status, 200);
    const repos = await reposResponse.json();
    assert.deepEqual(repos, {
      repos: [{ repo: 'docs', viewUrl: '/view/docs/', assetUrl: '/asset/docs/' }],
      count: 1,
    });
    assertNoHostRoots(repos, fixture);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('discovery derives unrestricted capabilities from enabled config and registered routes', async () => {
  const fixture = await makeFixture();
  const managedRepoStore = new ManagedRepoStore({
    storePath: fixture.managedStorePath,
    allowRoots: [fixture.managedRoot],
    adminTokens: {},
  });
  managedRepoStore.createRepo({
    repoId: 'shared-notes',
    rootPath: path.join(fixture.managedRoot, 'shared-notes'),
  });
  const server = await startServer({
    mappings: { docs: fixture.mappings.docs },
    managedRepoStore,
    publishConfig: { areaPath: fixture.publishArea },
    editingEnabled: false,
    annotationsEnabled: false,
    rawHtmlEnabled: false,
  });

  try {
    const response = await server.request('/.well-known/agent.json');
    assert.equal(response.status, 200);
    const discovery = await response.json();
    assert.equal(discovery.caller.auth.mode, 'unrestricted');
    assert.deepEqual(discovery.caller.repoScopes.map((entry) => entry.repo), ['docs', 'shared-notes']);
    assert.equal(discovery.capabilities.assetRead, true);
    assert.equal(discovery.capabilities.publish, true);
    assert.equal(discovery.capabilities.managedRepos, true);
    assert.equal(discovery.capabilities.search, true);
    assert.equal(discovery.capabilities.editing, false);
    assert.equal(discovery.capabilities.annotations, false);
    assert.equal(discovery.capabilities.rawHtml, false);
    assert.equal(Object.hasOwn(discovery.endpoints, 'publishCreate'), true);
    assert.equal(Object.hasOwn(discovery.endpoints, 'managedRepoList'), true);
    assert.equal(Object.hasOwn(discovery.endpoints, 'managedFileRead'), true);
    assert.equal(Object.hasOwn(discovery.endpoints, 'search'), true);
    assert.equal(Object.hasOwn(discovery.endpoints, 'edit'), false);
    assert.equal(Object.hasOwn(discovery.endpoints, 'annotationRead'), false);
    assert.equal(Object.hasOwn(discovery.endpoints, 'rawHtml'), false);
    assertNoHostRoots(discovery, fixture);
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
