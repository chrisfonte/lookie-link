'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');

const { createApp } = require('../server');
const { TemplateRegistry } = require('../lib/forms/template-registry');
const { buildOpenApiDocument } = require('../lib/openapi');

function inject(app, route, init = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    socket.remoteAddress = '127.0.0.1';
    const request = new http.IncomingMessage(socket);
    request.method = init.method || 'GET';
    request.url = route;
    request.headers = { host: '127.0.0.1:9876' };
    for (const [name, value] of Object.entries(init.headers || {})) {
      request.headers[name.toLowerCase()] = value;
    }
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(String(init.body));
    if (body.length > 0 && request.headers['content-length'] === undefined) {
      request.headers['content-length'] = String(body.length);
    }
    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    const chunks = [];
    response.write = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      return true;
    };
    response.end = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      response.finished = true;
      response.emit('finish');
      return response;
    };
    response.on('finish', () => {
      const responseBody = Buffer.concat(chunks);
      const headers = response.getHeaders();
      resolve({
        status: response.statusCode,
        headers: {get: (name) => {
          const value = headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        }},
        text: async () => responseBody.toString('utf8'),
        json: async () => JSON.parse(responseBody.toString('utf8')),
      });
    });
    response.on('error', reject);
    request.push(body);
    request.push(null);
    app.handle(request, response, reject);
  });
}

// Copied from test/agent-discovery.test.js (do not import across test files).
function registeredRoutes(app, { includeRouters = false } = {}) {
  const fromStack = (stack) => stack.flatMap((layer) => {
    if (layer.route) {
      return Object.keys(layer.route.methods || {})
        .filter((method) => layer.route.methods[method])
        .map((method) => `${method}:${layer.route.path}`);
    }
    if (includeRouters && layer.handle && Array.isArray(layer.handle.stack)) return fromStack(layer.handle.stack);
    return [];
  });
  return fromStack(app._router.stack);
}

// OpenAPI templating back to Express syntax: {path} is the wildcard.
function specRoutes(doc) {
  return Object.entries(doc.paths).flatMap(([specPath, item]) => Object.keys(item)
    .map((method) => `${method}:${specPath.replace(/\{path\}/g, '*').replace(/\{([A-Za-z]+)\}/g, ':$1')}`));
}

function defaultApp() {
  return createApp({
    mappings: {},
    accessConfig: {},
    apiKeyStore: null,
    grantStore: null,
    managedRepoStore: null,
    publishStore: null,
    editingEnabled: false,
    annotationsEnabled: false,
    rawHtmlEnabled: false,
  });
}

async function formsApp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-openapi-'));
  const templatesPath = path.join(root, 'templates');
  await fs.mkdir(templatesPath);
  const app = createApp({
    mappings: {},
    accessConfig: {},
    formsConfig: { enabled: true, templatesPath, destinations: { default: path.join(root, 'subs') } },
    formsRegistry: new TemplateRegistry({ templatesPath, destinationIds: ['default'], logger: { warn() {} } }),
    formsPublicOrigin: 'http://forms.example.test',
    formsAudit: () => {},
    formsAuthorize: () => true,
  });
  return { app, close: () => fs.rm(root, { recursive: true, force: true }) };
}

const sorted = (values) => [...new Set(values)].sort();

test('OpenAPI method:path set equals the registered application routes', () => {
  const app = defaultApp();
  const registered = registeredRoutes(app).filter((entry) => !entry.startsWith('get:/public/'));
  assert.deepEqual(sorted(specRoutes(buildOpenApiDocument({ formsEnabled: false }))), sorted(registered));
});

test('with forms enabled the spec adds exactly the forms router routes', async () => {
  const doc = buildOpenApiDocument({ formsEnabled: true });
  const base = new Set(specRoutes(buildOpenApiDocument({ formsEnabled: false })));
  const added = specRoutes(doc).filter((entry) => !base.has(entry));
  assert.ok(added.length > 0);
  for (const entry of added) {
    const routePath = entry.slice(entry.indexOf(':') + 1);
    assert.ok(routePath.startsWith('/forms') || routePath.startsWith('/api/forms'), entry);
  }
  const { app, close } = await formsApp();
  try {
    const all = registeredRoutes(app, { includeRouters: true }).filter((entry) => !entry.startsWith('get:/public/'));
    assert.deepEqual(sorted(specRoutes(doc)), sorted(all));
  } finally {
    await close();
  }
});

test('every operation is complete and references the shared Error envelope', () => {
  const doc = buildOpenApiDocument({ formsEnabled: true, version: '9.9.9', baseUrl: 'http://x.test' });
  assert.match(doc.openapi, /^3\.1/);
  assert.equal(doc.info.version, '9.9.9');
  assert.deepEqual(doc.servers, [{ url: 'http://x.test' }]);
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.deepEqual([doc.components.securitySchemes.queryToken.in, doc.components.securitySchemes.queryToken.name], ['query', 'token']);
  assert.ok(doc.components.schemas.Error.properties.error);
  const ids = new Set();
  let count = 0;
  for (const [specPath, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      count += 1;
      const label = `${method} ${specPath}`;
      assert.ok(op.operationId, label);
      assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`);
      ids.add(op.operationId);
      assert.ok(op.summary, label);
      assert.ok(Array.isArray(op.tags) && op.tags.length === 1, label);
      assert.ok(Object.keys(op.responses).length > 0, label);
      const errors = Object.entries(op.responses).filter(([status]) => /^[45]/.test(status));
      assert.ok(errors.some(([status, response]) => status.startsWith('4')
        && response.$ref === '#/components/responses/Error'), label);
      if (method !== 'get') assert.deepEqual(op.security, [{ bearerAuth: [] }], `${label} mutations are bearer-only`);
      for (const match of specPath.matchAll(/\{([A-Za-z]+)\}/g)) {
        assert.ok((op.parameters || []).some((p) => p.in === 'path' && p.name === match[1]), `${label} path param ${match[1]}`);
      }
    }
  }
  assert.ok(count > 60, `operation count ${count}`);
});

test('GET /openapi.json serves the 3.1 document without caching', async () => {
  const app = defaultApp();
  const response = await inject(app, '/openapi.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const doc = await response.json();
  assert.match(doc.openapi, /^3\.1/);
  assert.equal(doc.info.version, require('../package.json').version);
});

test('GET /api/docs serves the themed explorer page', async () => {
  const response = await inject(defaultApp(), '/api/docs');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.ok(html.includes('openapi.json'));
  assert.ok(html.includes('/public/api-docs.js'));
  assert.ok(html.includes('/public/style.css'));
});

test('OpenAPI and explorer honour a denying access policy', async () => {
  const app = createApp({ mappings: {}, accessConfig: { humanDefault: 'restricted' } });
  assert.equal((await inject(app, '/openapi.json')).status, 401);
  assert.equal((await inject(app, '/api/docs')).status, 401);
});

test('agent card advertises the OpenAPI and explorer URLs', async () => {
  const doc = await (await inject(defaultApp(), '/.well-known/agent.json')).json();
  assert.equal(doc.discovery.openapiUrl, '/openapi.json');
  assert.equal(doc.discovery.apiDocsUrl, '/api/docs');
});
