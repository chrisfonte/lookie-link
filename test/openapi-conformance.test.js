'use strict';

// Spec-driven conformance: every operation in the OpenAPI document is called
// against a staged, disposable createApp server and its response is checked
// against what the document declares (status set, content type, Error
// envelope). Also validates the document's structure and records, as
// discovery data, which operations reject unknown query parameters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');
const { TemplateRegistry } = require('../lib/forms/template-registry');
const { buildOpenApiDocument } = require('../lib/openapi');
const { loadWallpaperCatalog } = require('../lib/config');
const wallpaper = require('../lib/viewer-wallpaper');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const TEMPLATE_ID = 'fixture-form';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1d5d60000000049454e44ae426082', 'hex');

function stageFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-conformance-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(path.join(docs, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'README.md'), '# Fixture\nfixture text\n');
  fs.writeFileSync(path.join(docs, 'notes', 'a.md'), 'fixture note\n');
  fs.writeFileSync(path.join(docs, 'page.html'), '<!doctype html><html><body><p>fixture</p></body></html>\n');
  fs.writeFileSync(path.join(docs, 'pic.png'), PNG);
  const dark = path.join(root, 'wallpapers-dark');
  fs.mkdirSync(dark);
  fs.writeFileSync(path.join(dark, '0-sunset-a.png'), PNG);
  const templatesPath = path.join(root, 'templates');
  const destination = path.join(root, 'subs');
  fs.mkdirSync(templatesPath);
  fs.mkdirSync(destination);
  return { root, docs, dark, templatesPath, destination };
}

const fixtureTemplate = {
  contractVersion: 1,
  resourceKind: 'form-template',
  templateId: TEMPLATE_ID,
  ownerId: 'operator',
  revision: 1,
  grammarVersion: 1,
  destinationId: 'default',
  title: 'Fixture form',
  fields: [{ id: 'reps', type: 'number', label: 'Reps', required: true, constraints: { minimum: 1, maximum: 100, integer: true, step: 1 } }],
};

async function startServer(f, formsEnabled) {
  const options = {
    mappings: { docs: f.docs },
    accessConfig: {},
    apiKeyStore: null,
    grantStore: null,
    managedRepoStore: null,
    publishStore: null,
    editingEnabled: true,
    annotationsEnabled: true,
    rawHtmlEnabled: true,
    wallpaperCatalog: loadWallpaperCatalog([{ slug: 'sunset', label: 'Sunset', wallpapers: { dark: f.dark } }]),
    wallpaperThemes: [{ slug: 'sunset', aliases: [] }],
    wallpaperDefaults: { panelOpacity: 70, blur: 10 },
    appearanceOverlayPath: path.join(f.root, 'appearance.yaml'),
    appearanceManagedRoot: path.join(f.root, 'managed-wallpapers'),
  };
  if (formsEnabled) {
    const registry = new TemplateRegistry({ templatesPath: f.templatesPath, destinationIds: ['default'], logger: { warn() {} } });
    await registry.createDraft(structuredClone(fixtureTemplate));
    Object.assign(options, {
      formsConfig: { enabled: true, templatesPath: f.templatesPath, destinations: { default: f.destination } },
      formsRegistry: registry,
      formsPublicOrigin: 'http://forms.example.test',
      formsAudit: () => {},
      formsAuthorize: () => true,
    });
  }
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function send(base, route, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (_) { json = undefined; }
        resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), json, text });
      });
    });
    req.on('error', reject);
    if (body !== null) req.setHeader('content-length', Buffer.byteLength(body));
    if (body !== null) req.write(body);
    req.end();
  });
}

// Path-param fixture values. {path} depends on the route family.
function pathValue(specPath) {
  if (specPath.startsWith('/view/') || specPath.startsWith('/edit/') || specPath.startsWith('/api/save/') || specPath.startsWith('/api/preview/')) return 'docs/README.md';
  if (specPath.startsWith('/asset/')) return 'pic.png';
  if (specPath.startsWith('/raw/') || specPath.startsWith('/embed/')) return 'page.html';
  return 'README.md';
}
const PARAM_VALUES = {
  repo: 'docs', slug: 'sunset', mode: 'dark', id: 'a', templateId: TEMPLATE_ID,
  keyId: 'fixture-key', grantId: 'fixture-grant', trashId: 'fixture-trash', submissionId: 'fixture-submission',
};
const QUERY_VALUES = { q: 'fixture', since: () => String(Date.now() - 3600000), name: 'pic' };

function buildUrl(specPath, op, extraQuery) {
  let url = specPath.replace(/\{([A-Za-z]+)\}/g, (_, name) => {
    if (name === 'path') return pathValue(specPath);
    assert.ok(PARAM_VALUES[name], `no fixture value for path param ${name} in ${specPath}`);
    return encodeURIComponent(PARAM_VALUES[name]);
  });
  const params = new URLSearchParams();
  for (const p of op.parameters || []) {
    if (p.in !== 'query' || !p.required) continue;
    const value = QUERY_VALUES[p.name];
    assert.ok(value !== undefined, `no example value for required query ${p.name}`);
    params.set(p.name, typeof value === 'function' ? value() : value);
  }
  if (extraQuery) for (const [k, v] of Object.entries(extraQuery)) params.set(k, v);
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return url;
}

function kindOf(op) {
  const success = Object.entries(op.responses).find(([s]) => /^[23]/.test(s));
  const content = (success && success[1].content) || {};
  if (content['application/json']) return 'json';
  if (content['text/html']) return 'html';
  if (content['application/octet-stream']) return 'binary';
  return 'none';
}

function requestFor(method, op) {
  if (method === 'get') return { headers: { accept: kindOf(op) === 'json' ? 'application/json' : '*/*' } };
  const content = op.requestBody && op.requestBody.content ? Object.keys(op.requestBody.content) : [];
  if (content.includes('application/json') || content.length === 0) {
    return { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' };
  }
  if (content.includes('application/x-www-form-urlencoded')) {
    return { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: '' };
  }
  return { headers: { 'content-type': content[0], accept: 'application/json' }, body: PNG };
}

function assertEnvelope(label, res) {
  assert.ok(res.json && typeof res.json === 'object', `${label}: error body is not JSON: ${res.status} ${res.type} ${res.text.slice(0, 200)}`);
  assert.equal(res.json.ok, false, `${label}: error ok !== false: ${res.text.slice(0, 300)}`);
  assert.equal(typeof res.json.error, 'object', `${label}: error is not an object (string error?): ${res.text.slice(0, 300)}`);
  assert.ok(res.json.error !== null);
  assert.equal(typeof res.json.error.code, 'string', `${label}: error.code: ${res.text.slice(0, 300)}`);
  assert.equal(typeof res.json.error.message, 'string', `${label}: error.message: ${res.text.slice(0, 300)}`);
  if (res.json.error.details !== undefined) assert.ok(Array.isArray(res.json.error.details), `${label}: details not array`);
}

function operations(doc) {
  const ops = [];
  for (const [specPath, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) ops.push({ specPath, method, op, label: `${method.toUpperCase()} ${specPath}` });
  }
  // Reads first, then writes, deletes last, so mutations do not starve reads of fixtures.
  const rank = { get: 0, post: 1, put: 1, patch: 1, delete: 2 };
  return ops.sort((a, b) => rank[a.method] - rank[b.method]);
}

const unknownParamTable = [];
const tally = { operations: 0, byTag: {}, assertions: 0, observed: [] };

function validateDocument(doc) {
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.components && doc.components.schemas && doc.components.schemas.Error, 'components.schemas.Error exists');
  assert.equal(doc.components.responses.Error.content['application/json'].schema.$ref, '#/components/schemas/Error');
  const ids = new Set();
  for (const { specPath, method, op, label } of operations(doc)) {
    assert.ok(METHODS.includes(method), `${label}: method`);
    assert.ok(op.operationId && !ids.has(op.operationId), `${label}: operationId unique (${op.operationId})`);
    ids.add(op.operationId);
    const pathParams = (op.parameters || []).filter((p) => p.in === 'path');
    const templated = [...specPath.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
    for (const name of templated) assert.ok(pathParams.some((p) => p.name === name && p.required === true), `${label}: path param ${name} declared+required`);
    for (const p of pathParams) assert.ok(templated.includes(p.name), `${label}: declared path param ${p.name} is in the template`);
    const seen = new Set();
    for (const p of op.parameters || []) {
      const key = `${p.in}:${p.name}`;
      assert.ok(!seen.has(key), `${label}: duplicate parameter ${key}`);
      seen.add(key);
      assert.ok(p.schema, `${label}: parameter ${key} has a schema`);
    }
    for (const [status, response] of Object.entries(op.responses)) {
      assert.match(status, /^[1-5]\d\d$/, `${label}: status key ${status}`);
      const resolved = response.$ref ? doc.components.responses[response.$ref.split('/').pop()] : response;
      assert.ok(resolved && typeof resolved.description === 'string' && resolved.description, `${label} ${status}: description`);
      if (/^[45]/.test(status)) {
        assert.equal(response.$ref, '#/components/responses/Error', `${label} ${status}: error response refs the Error envelope`);
      }
    }
    for (const tag of op.tags) assert.ok(doc.tags.some((t) => t.name === tag), `${label}: tag ${tag} declared`);
    for (const requirement of op.security || []) {
      for (const scheme of Object.keys(requirement)) assert.ok(doc.components.securitySchemes[scheme], `${label}: security scheme ${scheme}`);
    }
  }
}

async function exercise(t, formsEnabled) {
  const doc = buildOpenApiDocument({ formsEnabled });
  validateDocument(doc);
  const f = stageFixture();
  const { server, base } = await startServer(f, formsEnabled);
  try {
    const failures = [];
    for (const { specPath, method, op, label } of operations(doc)) {
      try { await checkOne(); } catch (error) { failures.push(`${label}: ${error.message.split('\n')[0]}`); }
      async function checkOne() {
      const scoped = `${label}${formsEnabled ? ' [forms]' : ''}`;
      if (!formsEnabled || (op.tags[0] === 'forms')) {
        tally.operations += 1;
        tally.byTag[op.tags[0]] = (tally.byTag[op.tags[0]] || 0) + 1;
      }
      const kind = kindOf(op);
      const declared = Object.keys(op.responses);
      const res = await send(base, buildUrl(specPath, op), { method: method.toUpperCase(), ...requestFor(method, op) });
      tally.observed.push(`${scoped} -> ${res.status}`);

      assert.ok(declared.includes(String(res.status)), `${scoped}: status ${res.status} not declared (${declared.join(',')}); body ${res.text.slice(0, 300)}`);
      tally.assertions += 1;
      if (res.status >= 400) {
        if (kind === 'json' || kind === 'none' || /json/.test(res.type)) { assertEnvelope(scoped, res); tally.assertions += 1; }
      } else if (res.status < 300) {
        if (kind === 'json') {
          assert.match(res.type, /application\/json/, `${scoped}: content type ${res.type}`);
          assert.equal(typeof res.json, 'object', `${scoped}: JSON body`);
          if (specPath !== '/openapi.json' && specPath !== '/healthz') assert.equal(res.json.ok, true, `${scoped}: 2xx ok !== true: ${res.text.slice(0, 200)}`);
          tally.assertions += 3;
        } else if (kind === 'html') {
          if (!(specPath === '/view/{path}' && res.type.includes('application/json'))) {
            assert.match(res.type, /text\/html/, `${scoped}: content type ${res.type}`);
          }
          tally.assertions += 1;
        } else if (kind === 'binary') {
          assert.ok(res.type && !/text\/html|application\/json/.test(res.type), `${scoped}: binary content type ${res.type}`);
          tally.assertions += 1;
        }
      }

      const hasQuery = (op.parameters || []).some((p) => p.in === 'query');
      if (hasQuery) {
        const probe = await send(base, buildUrl(specPath, op, { zzUnknownParam: '1' }), { method: method.toUpperCase(), ...requestFor(method, op) });
        unknownParamTable.push({ op: scoped, baseline: res.status, withUnknown: probe.status, rejected: probe.status === 400 && res.status !== 400 ? 'yes' : 'no' });
      }

      if (kind === 'json') {
        const methodsOnPath = Object.keys(doc.paths[specPath]);
        const wrong = METHODS.find((m) => !methodsOnPath.includes(m));
        if (wrong) {
          const bad = await send(base, buildUrl(specPath, op), { method: wrong.toUpperCase(), headers: { accept: 'application/json', 'content-type': 'application/json' }, body: wrong === 'get' ? null : '{}' });
          assert.ok([404, 405].includes(bad.status), `${wrong.toUpperCase()} ${specPath}: wrong-method status ${bad.status} ${bad.text.slice(0, 200)}`);
          assertEnvelope(`${wrong.toUpperCase()} ${specPath} (wrong method)`, bad);
          tally.assertions += 2;
        }
      }
      }
    }
    assert.deepEqual(failures, [], `conformance failures:\n${failures.join('\n')}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

test.after(() => {
  wallpaper.setWallpaperCatalog({}, [], { panelOpacity: 72, blur: 12 });
  console.log(`\nConformance: ${tally.operations} distinct operations, ${tally.assertions} response assertions`);
  console.log('By tag:', JSON.stringify(tally.byTag));
  console.log('\nUnknown query parameter probe (discovery data, not asserted):');
  console.log('| operation | baseline | with ?zzUnknownParam=1 | rejected |');
  console.log('|---|---|---|---|');
  for (const row of unknownParamTable) console.log(`| ${row.op} | ${row.baseline} | ${row.withUnknown} | ${row.rejected} |`);
  if (process.env.CONFORMANCE_VERBOSE) console.log(tally.observed.join('\n'));
});

test('OpenAPI document (forms off) is structurally valid and every operation conforms', async (t) => {
  await exercise(t, false);
});

test('OpenAPI document (forms on) is structurally valid and every operation conforms', async (t) => {
  await exercise(t, true);
});
