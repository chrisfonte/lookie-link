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
  return {
    app,
    async request(targetPath, init) {
      const target = new URL(targetPath, 'http://127.0.0.1:9876');
      const headers = Object.fromEntries(Object.entries(init && init.headers || {})
        .map(([name, value]) => [name.toLowerCase(), value]));
      const layer = app._router.stack.find((entry) => entry.route && entry.route.path === target.pathname);
      assert.ok(layer, `registered GET route for ${target.pathname}`);
      const handler = layer.route.stack.find((entry) => entry.method === 'get');
      assert.ok(handler, `GET handler for ${target.pathname}`);
      const req = {
        method: 'GET',
        path: target.pathname,
        protocol: 'http',
        headers,
        query: Object.fromEntries(target.searchParams.entries()),
        get(name) {
          return name.toLowerCase() === 'host'
            ? '127.0.0.1:9876'
            : headers[name.toLowerCase()];
        },
      };
      let statusCode = 200;
      let contentType = null;
      let body;
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        type(value) {
          contentType = value;
          return this;
        },
        json(value) {
          contentType = 'application/json';
          body = value;
          return this;
        },
        send(value) {
          body = value;
          return this;
        },
      };
      await handler.handle(req, res, () => {});
      return {
        status: statusCode,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
        async json() {
          return typeof body === 'string' ? JSON.parse(body) : body;
        },
        async text() {
          return typeof body === 'string' ? body : JSON.stringify(body);
        },
      };
    },
    async close() {},
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

const ROUTE_FOR_ENDPOINT = Object.freeze({
  agentDiscovery: ['get', '/.well-known/agent.json'],
  whoami: ['get', '/api/whoami'],
  repos: ['get', '/api/repos'],
  view: ['get', '/view/*'],
  assetRead: ['get', '/asset/:repo/*'],
  edit: ['get', '/edit/*'],
  save: ['post', '/api/save/*'],
  preview: ['post', '/api/preview/*'],
  annotationRead: ['get', '/api/annotations/:repo/*'],
  annotationCreate: ['post', '/api/annotations/:repo/*'],
  annotationUpdate: ['patch', '/api/annotations/:repo/*'],
  rawHtml: ['get', '/raw/:repo/*'],
  embeddedHtml: ['get', '/embed/:repo/*'],
  managedRepoList: ['get', '/api/managed-repos'],
  managedFileRead: ['get', '/api/managed-repos/:repo/files/*'],
  managedFileWrite: ['put', '/api/managed-repos/:repo/files/*'],
  managedTree: ['get', '/api/managed-repos/:repo/tree'],
  managedChanges: ['get', '/api/managed-repos/:repo/changes'],
  search: ['get', '/api/search'],
  searchSuggest: ['get', '/api/search/suggest'],
  publishCreate: ['post', '/api/publish'],
  publishUpdate: ['post', '/api/publish/:slug'],
  publishRevoke: ['post', '/api/publish/:slug/revoke'],
});

const CAPABILITY_ENDPOINTS = Object.freeze({
  whoami: ['whoami'],
  repoDiscovery: ['repos'],
  assetRead: ['assetRead'],
  editing: ['edit', 'save'],
  annotations: ['annotationRead'],
  annotationWrite: ['annotationCreate', 'annotationUpdate'],
  rawHtml: ['rawHtml'],
  embeddedHtml: ['embeddedHtml'],
  managedRepos: ['managedRepoList', 'managedFileRead', 'managedTree', 'managedChanges'],
  search: ['search', 'searchSuggest'],
  publish: ['publishCreate', 'publishUpdate', 'publishRevoke'],
});

function registeredRoutes(app) {
  return app._router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods || {})
      .filter((method) => layer.route.methods[method])
      .map((method) => `${method}:${layer.route.path}`));
}

async function documentedEndpointTemplates() {
  const apiDocs = await fs.readFile(path.join(__dirname, '..', 'docs', 'API.md'), 'utf8');
  const entries = [...apiDocs.matchAll(/^\| `([a-zA-Z]+)` \| `([^`]+)` \| .+ \|$/gm)]
    .map((match) => [match[1], match[2]]);
  return new Map(entries);
}

async function readDiscoveryTriplet(server, init) {
  const [agentResponse, whoamiResponse, reposResponse] = await Promise.all([
    server.request('/.well-known/agent.json', init),
    server.request('/api/whoami', init),
    server.request('/api/repos', init),
  ]);
  const parse = async (response) => ({ status: response.status, body: await response.json() });
  return Promise.all([parse(agentResponse), parse(whoamiResponse), parse(reposResponse)]);
}

test('discovery matrix agrees across caller class, route availability, repo discovery, and docs', async () => {
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
  const runtimeOptions = {
    mappings: fixture.mappings,
    managedRepoStore,
    publishConfig: { areaPath: fixture.publishArea },
    editingEnabled: true,
    annotationsEnabled: true,
    rawHtmlEnabled: true,
  };
  const unrestrictedServer = await startServer(runtimeOptions);
  const restrictedServer = await startServer({
    ...runtimeOptions,
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        reader: {
          secret: 'matrix-reader-placeholder',
          subject: { companyId: 'example-company', agentId: 'matrix-reader' },
          repos: { docs: { paths: ['notes/'] } },
          permissions: { view: true },
        },
      },
    },
  });

  try {
    const docs = await documentedEndpointTemplates();
    const cases = [
      {
        name: 'unrestricted',
        server: unrestrictedServer,
        init: undefined,
        status: 200,
        repos: ['docs', 'private', 'shared-notes'],
        capabilities: {
          editing: true,
          annotationWrite: true,
          managedRepos: true,
          search: true,
          publish: true,
        },
      },
      {
        name: 'scoped',
        server: restrictedServer,
        init: bearer('matrix-reader-placeholder'),
        status: 200,
        repos: ['docs'],
        capabilities: {
          editing: false,
          annotationWrite: false,
          managedRepos: false,
          search: false,
          publish: false,
        },
      },
      {
        name: 'invalid',
        server: restrictedServer,
        init: bearer('invalid-placeholder'),
        status: 403,
      },
      {
        name: 'unauthenticated',
        server: restrictedServer,
        init: undefined,
        status: 401,
      },
    ];

    for (const callerCase of cases) {
      const [agentResult, whoamiResult, reposResult] = await readDiscoveryTriplet(
        callerCase.server,
        callerCase.init
      );
      assert.equal(agentResult.status, callerCase.status, `${callerCase.name} agent status`);
      assert.equal(whoamiResult.status, callerCase.status, `${callerCase.name} whoami status`);
      assert.equal(reposResult.status, callerCase.status, `${callerCase.name} repos status`);

      if (callerCase.status !== 200) {
        assert.equal(agentResult.body.ok, false);
        assert.deepEqual(agentResult.body, whoamiResult.body);
        assert.equal(Object.hasOwn(agentResult.body, 'capabilities'), false);
        assertNoHostRoots(agentResult.body, fixture);
        continue;
      }

      assert.deepEqual(agentResult.body.capabilities, whoamiResult.body.capabilities);
      assert.deepEqual(agentResult.body.endpoints, whoamiResult.body.endpoints);
      assert.deepEqual(agentResult.body.caller.repoScopes, whoamiResult.body.repoScopes);
      const scopeRepos = whoamiResult.body.repoScopes.map((entry) => entry.repo).sort();
      const discoveredRepos = reposResult.body.repos.map((entry) => entry.repo).sort();
      assert.deepEqual(scopeRepos, callerCase.repos, `${callerCase.name} whoami scopes`);
      assert.deepEqual(discoveredRepos, callerCase.repos, `${callerCase.name} /api/repos`);

      for (const [capability, expected] of Object.entries(callerCase.capabilities)) {
        assert.equal(whoamiResult.body.capabilities[capability], expected, `${callerCase.name} ${capability}`);
      }
      for (const [capability, endpointKeys] of Object.entries(CAPABILITY_ENDPOINTS)) {
        for (const endpointKey of endpointKeys) {
          if (whoamiResult.body.capabilities[capability]) {
            assert.equal(typeof whoamiResult.body.endpoints[endpointKey], 'string', `${capability} exposes ${endpointKey}`);
          } else {
            assert.equal(Object.hasOwn(whoamiResult.body.endpoints, endpointKey), false, `${capability} hides ${endpointKey}`);
          }
        }
      }

      const routes = new Set(registeredRoutes(callerCase.server.app));
      for (const [endpointKey, template] of Object.entries(whoamiResult.body.endpoints)) {
        assert.equal(docs.get(endpointKey), template, `docs template for ${endpointKey}`);
        const [method, routePath] = ROUTE_FOR_ENDPOINT[endpointKey];
        assert.equal(routes.has(`${method}:${routePath}`), true, `registered route for ${endpointKey}`);
      }
      for (const privateCapability of ['grants', 'apiKeys', 'managedRepoAdmin']) {
        assert.equal(Object.hasOwn(whoamiResult.body.capabilities, privateCapability), false);
      }
      for (const privateEndpoint of ['grantList', 'apiKeyList', 'managedRepoCreate']) {
        assert.equal(Object.hasOwn(whoamiResult.body.endpoints, privateEndpoint), false);
      }
      assertNoHostRoots(agentResult.body, fixture);
      assertNoHostRoots(whoamiResult.body, fixture);
      assertNoHostRoots(reposResult.body, fixture);
    }
  } finally {
    await Promise.all([unrestrictedServer.close(), restrictedServer.close()]);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
