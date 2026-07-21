'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

const { createApp } = require('../server');
const { TemplateRegistry } = require('../lib/forms/template-registry');
const { SubmissionStore } = require('../lib/forms/submission-store');

const PUBLIC_ORIGIN = 'http://forms.example.test';
const GYM_FIXTURE = path.join(__dirname, 'fixtures', 'forms', 'gym-session-entry.yaml');

const everyTypeTemplate = {
  contractVersion: 1,
  resourceKind: 'form-template',
  templateId: 'every-field',
  ownerId: 'operator',
  revision: 1,
  grammarVersion: 1,
  title: 'Every Field',
  fields: [
    { id: 'summary', type: 'short-text', label: 'Summary', required: true },
    { id: 'notes', type: 'long-text', label: 'Notes', required: true },
    { id: 'count', type: 'number', label: 'Count', required: true, constraints: { minimum: 1, maximum: 10, integer: true } },
    { id: 'confirmed', type: 'checkbox', label: 'Confirmed', required: true },
    { id: 'entry-date', type: 'date', label: 'Entry date', required: true },
    { id: 'entry-time', type: 'time', label: 'Entry time', required: true },
    { id: 'recorded-at', type: 'datetime', label: 'Recorded at', required: true },
    { id: 'choice', type: 'select', label: 'Choice', required: true, options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] },
    { id: 'choices', type: 'multi-select', label: 'Choices', required: true, options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }] },
  ],
};

async function makeFixture({ everyType = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-forms-runner-'));
  const templatesPath = path.join(root, 'templates');
  const submissionsPath = path.join(root, 'submissions');
  await fs.mkdir(templatesPath);
  await fs.copyFile(GYM_FIXTURE, path.join(templatesPath, 'gym-session-entry.yaml'));
  if (everyType) {
    await fs.writeFile(path.join(templatesPath, 'every-field.yaml'), yaml.dump(everyTypeTemplate), 'utf8');
  }
  return { root, templatesPath, submissionsPath };
}

async function startServer(fixture, overrides = {}) {
  const app = createApp({
    mappings: {},
    accessConfig: { humanDefault: 'full' },
    formsConfig: {
      enabled: true,
      templatesPath: fixture.templatesPath,
      submissionsPath: fixture.submissionsPath,
    },
    formsPublicOrigin: PUBLIC_ORIGIN,
    ...overrides,
  });
  return listenApp(app, fixture.root);
}

async function listenApp(app, root) {
  void root;
  return {
    app,
    request: (route, init = {}) => inject(app, route, init),
    close: async () => {},
  };
}

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
    request.headers = { host: 'forms.example.test' };
    for (const [name, value] of Object.entries(init.headers || {})) {
      request.headers[name.toLowerCase()] = value;
    }
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(String(init.body));
    if (body.length > 0 && request.headers['content-length'] === undefined) {
      request.headers['content-length'] = String(body.length);
    }
    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    const responseBodyChunks = [];
    response.write = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) responseBodyChunks.push(Buffer.from(chunk, encoding));
      return true;
    };
    response.end = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) responseBodyChunks.push(Buffer.from(chunk, encoding));
      response.finished = true;
      response.emit('finish');
      return response;
    };
    response.on('finish', () => {
      const responseBody = Buffer.concat(responseBodyChunks);
      const headers = response.getHeaders();
      resolve({
        status: response.statusCode,
        headers: { get: (name) => {
          const value = headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        } },
        text: async () => responseBody.toString('utf8'),
        json: async () => JSON.parse(responseBody.toString('utf8')),
      });
    });
    response.on('error', reject);
    app.handle(request, response, reject);
    request.push(body);
    request.push(null);
  });
}

async function cleanup(fixture, server) {
  if (server) await server.close();
  await fs.rm(fixture.root, { recursive: true, force: true });
}

function browserContext(response, html) {
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie && setCookie.split(';', 1)[0];
  const document = new JSDOM(html).window.document;
  const token = document.querySelector('input[name="_csrf"]')?.value;
  assert.ok(cookie, 'form GET must set a browser context cookie');
  assert.ok(token, 'form GET must render a synchronizer token');
  return { cookie, token, document };
}

async function getBrowserContext(server, templateId = 'gym-session-entry') {
  const response = await server.request(`/forms/${templateId}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  return browserContext(response, html);
}

function nativeBody(token, overrides = {}) {
  return new URLSearchParams({
    _csrf: token,
    'session-date': '2026-07-20',
    lift: 'bench',
    'top-weight': '225.5',
    'top-reps': '5',
    rpe: '8',
    'felt-strong': 'true',
    notes: 'Smooth reps',
    ...overrides,
  });
}

function jsonValues(overrides = {}) {
  return {
    'session-date': '2026-07-20',
    lift: 'deadlift',
    'top-weight': 315,
    'top-reps': 3,
    rpe: 9,
    'felt-strong': true,
    notes: 'Strong lockout',
    ...overrides,
  };
}

async function submissionFiles(submissionsPath) {
  try {
    return (await fs.readdir(submissionsPath)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

test('GET renders every field type, required markers, constraints, and a CSRF token', async () => {
  const fixture = await makeFixture({ everyType: true });
  const server = await startServer(fixture);
  try {
    const response = await server.request('/forms/every-field');
    assert.equal(response.status, 200);
    const html = await response.text();
    const { document, token } = browserContext(response, html);
    assert.ok(token);
    assert.equal(document.querySelector('#field-summary').type, 'text');
    assert.equal(document.querySelector('#field-notes').tagName, 'TEXTAREA');
    assert.equal(document.querySelector('#field-count').type, 'number');
    assert.equal(document.querySelector('#field-count').min, '1');
    assert.equal(document.querySelector('#field-count').max, '10');
    assert.equal(document.querySelector('#field-count').step, '1');
    assert.equal(document.querySelector('#field-confirmed').type, 'checkbox');
    assert.equal(document.querySelector('#field-entry-date').type, 'date');
    assert.equal(document.querySelector('#field-entry-time').type, 'time');
    assert.equal(document.querySelector('#field-recorded-at').type, 'datetime-local');
    assert.equal(document.querySelector('#field-choice').tagName, 'SELECT');
    assert.equal(document.querySelector('#field-choices').multiple, true);
    assert.equal(document.querySelectorAll('[required]').length, everyTypeTemplate.fields.length);
  } finally {
    await cleanup(fixture, server);
  }
});

test('native POST redirects with 303 and the receipt page renders submitted values', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: nativeBody(context.token),
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /^\/forms\/gym-session-entry\/receipts\/[0-9a-f-]{36}$/);
    const receipt = await server.request(response.headers.get('location'), { headers: { Cookie: context.cookie } });
    assert.equal(receipt.status, 200);
    const html = await receipt.text();
    assert.match(html, /Bench press/);
    assert.match(html, /225\.5/);
    assert.match(html, /Smooth reps/);
    assert.equal((await submissionFiles(fixture.submissionsPath)).length, 1);
  } finally {
    await cleanup(fixture, server);
  }
});

test('native validation failure preserves entered values, renders errors, and writes nothing', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const body = nativeBody(context.token);
    body.delete('notes');
    body.set('rpe', '11');
    const response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body,
    });
    assert.equal(response.status, 422);
    const document = new JSDOM(await response.text()).window.document;
    assert.match(document.body.textContent, /Please correct/);
    assert.equal(document.querySelector('#field-rpe').value, '11');
    assert.equal(document.querySelector('#field-lift').value, 'bench');
    assert.equal(document.querySelector('#field-top-weight').value, '225.5');
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);
  } finally {
    await cleanup(fixture, server);
  }
});

test('JSON POST uses the shared service for success and structured validation errors', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const headers = {
      'Content-Type': 'application/json',
      Cookie: context.cookie,
      Origin: PUBLIC_ORIGIN,
      'X-CSRF-Token': context.token,
    };
    const success = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: jsonValues(), idempotencyKey: 'json-happy-path-0001' }),
    });
    assert.equal(success.status, 201);
    const created = await success.json();
    assert.equal(created.ok, true);
    assert.equal(created.receipt.submissionId, created.submissionId);
    assert.deepEqual(created.receipt.values.find((entry) => entry.fieldId === 'lift').selectedOptions, [
      { optionId: 'deadlift', optionLabel: 'Deadlift' },
    ]);

    const invalid = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: jsonValues({ rpe: 12 }) }),
    });
    assert.equal(invalid.status, 422);
    const payload = await invalid.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'validation_error');
    assert.ok(payload.error.details.some((entry) => entry.path === 'values.rpe'));

    const partialTime = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: jsonValues(), timezone: 'America/New_York' }),
    });
    assert.equal(partialTime.status, 422);
    assert.equal((await partialTime.json()).error.details[0].path, 'eventTime');
    assert.equal((await submissionFiles(fixture.submissionsPath)).length, 1);
  } finally {
    await cleanup(fixture, server);
  }
});

test('CSRF and query-token negatives are refused with no submission file written', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const cases = [
      { name: 'missing token', token: null, origin: PUBLIC_ORIGIN, route: '/forms/gym-session-entry', expected: 403 },
      { name: 'wrong token', token: 'wrong-token', origin: PUBLIC_ORIGIN, route: '/forms/gym-session-entry', expected: 403 },
      { name: 'foreign origin', token: context.token, origin: 'https://attacker.example.test', route: '/forms/gym-session-entry', expected: 403 },
      { name: 'query credential', token: context.token, origin: PUBLIC_ORIGIN, route: '/forms/gym-session-entry?token=secret', expected: 400 },
    ];
    for (const item of cases) {
      const body = nativeBody(item.token || '');
      if (item.token === null) body.delete('_csrf');
      const response = await server.request(item.route, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: context.cookie,
          Origin: item.origin,
        },
        body,
      });
      assert.equal(response.status, item.expected, item.name);
      assert.deepEqual(await submissionFiles(fixture.submissionsPath), [], item.name);
    }
  } finally {
    await cleanup(fixture, server);
  }
});

test('submission requires forms.submit even when forms.view can render the form', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {
    formsAuthorize: ({ capability }) => capability === 'forms.view',
  });
  try {
    const context = await getBrowserContext(server);
    const response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: nativeBody(context.token),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);
  } finally {
    await cleanup(fixture, server);
  }
});

test('enabled forms isolate raw HTML with the opaque-origin sandbox profile', async () => {
  const fixture = await makeFixture();
  const artifactsPath = path.join(fixture.root, 'artifacts');
  await fs.mkdir(artifactsPath);
  await fs.writeFile(path.join(artifactsPath, 'page.html'), '<!doctype html><title>Artifact</title>', 'utf8');
  const server = await startServer(fixture, {
    mappings: { artifacts: artifactsPath },
    rawHtmlEnabled: true,
  });
  try {
    const response = await server.request('/raw/artifacts/page.html');
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy');
    assert.equal(policy, 'sandbox allow-scripts allow-forms allow-popups');
    assert.doesNotMatch(policy, /allow-same-origin/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('template traversal is a uniform not-found and never indexes the filesystem', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const incoming = await server.request('/forms/../../etc/passwd');
    const response = { status: incoming.status, body: await incoming.text() };
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body, /root:|\/etc\/passwd/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('forms routes do not exist when forms configuration is absent', async () => {
  const fixture = await makeFixture();
  const app = createApp({ mappings: {}, accessConfig: { humanDefault: 'full' }, formsConfig: {} });
  const server = await listenApp(app, fixture.root);
  try {
    assert.equal((await server.request('/forms/gym-session-entry')).status, 404);
    assert.equal((await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: jsonValues() }),
    })).status, 404);
  } finally {
    await cleanup(fixture, server);
  }
});

test('exit gate survives fresh registry, store, service, and app construction', async () => {
  const fixture = await makeFixture();
  let server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const response = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
        'X-CSRF-Token': context.token,
      },
      body: JSON.stringify({ values: jsonValues() }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const filePath = path.join(fixture.submissionsPath, `${created.submissionId}.json`);
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.deepEqual(persisted, created.receipt);
    await server.close();
    server = null;

    const freshRegistry = new TemplateRegistry({ templatesPath: fixture.templatesPath });
    const freshStore = new SubmissionStore({ storageRoot: fixture.submissionsPath });
    assert.deepEqual(await freshStore.getSubmission(created.submissionId), persisted);
    server = await startServer(fixture, { formsRegistry: freshRegistry, formsStore: freshStore });
    const receipt = await server.request(created.receiptUrl);
    assert.equal(receipt.status, 200);
    const html = await receipt.text();
    assert.match(html, new RegExp(created.submissionId));
    assert.match(html, /Strong lockout/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('registry keeps last-known-good data and rejects non-definition IDs without path reads', async () => {
  const fixture = await makeFixture();
  const warnings = [];
  try {
    const registry = new TemplateRegistry({
      templatesPath: fixture.templatesPath,
      logger: { warn: (message) => warnings.push(message) },
    });
    const original = await registry.getTemplate('gym-session-entry');
    assert.equal(original.title, 'Gym Session Entry');
    assert.match(original.schemaDigest, /^[0-9a-f]{64}$/);
    await fs.writeFile(path.join(fixture.templatesPath, 'gym-session-entry.yaml'), 'not: a-valid-template\n', 'utf8');
    assert.equal((await registry.getTemplate('gym-session-entry')).title, 'Gym Session Entry');
    assert.equal(await registry.getTemplate('../../etc/passwd'), null);
    assert.equal(warnings.length, 1);
  } finally {
    await cleanup(fixture, null);
  }
});
