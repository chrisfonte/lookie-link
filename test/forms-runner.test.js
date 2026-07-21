'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Duplex } = require('node:stream');
const { promisify } = require('node:util');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

const { createApp } = require('../server');
const { renderReceiptPage } = require('../lib/forms/routes');
const { TemplateRegistry } = require('../lib/forms/template-registry');
const { SubmissionStore } = require('../lib/forms/submission-store');

const PUBLIC_ORIGIN = 'http://forms.example.test';
const GYM_FIXTURE = path.join(__dirname, 'fixtures', 'forms', 'gym-session-entry.yaml');
const execFileAsync = promisify(execFile);

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
    { id: 'count', type: 'number', label: 'Count (kg)', required: true, constraints: { minimum: 1, maximum: 10, integer: true } },
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
    formsAudit: () => {},
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

function assertSharedFormsShell(response, html, customThemeMarker) {
  const document = new JSDOM(html).window.document;
  assert.ok(document.querySelector('link[rel="stylesheet"][href="/public/style.css"]'));
  assert.ok(document.querySelector('[data-theme-picker]'));
  assert.ok(document.querySelector('[data-theme-toggle]'));
  assert.match(html, /lookie-link-color-scheme/);
  assert.match(html, new RegExp(customThemeMarker));

  const policy = response.headers.get('content-security-policy');
  const nonce = policy && policy.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'forms shell scripts must use a CSP nonce');
  for (const script of document.querySelectorAll('script')) {
    assert.equal(script.getAttribute('nonce'), nonce);
  }
  for (const style of document.querySelectorAll('style')) {
    assert.equal(style.getAttribute('nonce'), nonce);
  }
  return document;
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
    'session-date': '2026-07-20T09:30',
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
    'session-date': '2026-07-20T09:30:00-04:00',
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

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function runBrowser(url, profilePath) {
  return execFileAsync(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    `--user-data-dir=${profilePath}`,
    '--virtual-time-budget=3000',
    '--dump-dom',
    url,
  ], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
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
    assert.equal(document.querySelector('.readout-unit').textContent, 'kg');
    assert.deepEqual(
      [...document.querySelectorAll('.form-section')].map((section) => section.className),
      [
        'form-section form-section-selection',
        'form-section form-section-readouts',
        'form-section form-section-details',
      ]
    );
    assert.equal(document.querySelector('#field-confirmed').type, 'checkbox');
    assert.equal(document.querySelector('#field-entry-date').type, 'date');
    assert.equal(document.querySelector('#field-entry-time').type, 'time');
    assert.equal(document.querySelector('#field-recorded-at').type, 'datetime-local');
    assert.ok(document.querySelector('input[name="recorded-at__offset"]'));
    assert.ok(document.querySelector('input[name="recorded-at__timezone"]'));
    assert.match(html, /getTimezoneOffset/);
    assert.equal(document.querySelector('#field-choice').tagName, 'SELECT');
    assert.equal(document.querySelector('#field-choices').multiple, true);
    assert.equal(document.querySelectorAll('[required]').length, everyTypeTemplate.fields.length);
  } finally {
    await cleanup(fixture, server);
  }
});

test('native datetime capture records an explicit offset and uses the configured zone when offset is absent', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, { formsTimezone: 'America/New_York' });
  try {
    const context = await getBrowserContext(server);
    const explicitBody = nativeBody(context.token, {
      'session-date': '2026-07-20T09:30',
      'session-date__offset': '-240',
      'session-date__timezone': 'America/New_York',
    });
    const explicit = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: explicitBody,
    });
    assert.equal(explicit.status, 303);

    const fallbackBody = nativeBody(context.token, { 'session-date': '2026-01-20T09:30' });
    const fallback = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: fallbackBody,
    });
    assert.equal(fallback.status, 303);

    const records = await Promise.all((await submissionFiles(fixture.submissionsPath)).map(async (fileName) => (
      JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8'))
    )));
    const summer = records.find((record) => record.eventAt.startsWith('2026-07-20'));
    const winter = records.find((record) => record.eventAt.startsWith('2026-01-20'));
    assert.deepEqual(
      { eventAt: summer.eventAt, timezone: summer.timezone, clientOffsetMinutes: summer.clientOffsetMinutes },
      { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240 }
    );
    assert.equal(summer.values.find((entry) => entry.fieldId === 'session-date').value, summer.eventAt);
    assert.deepEqual(
      { eventAt: winter.eventAt, timezone: winter.timezone, clientOffsetMinutes: winter.clientOffsetMinutes },
      { eventAt: '2026-01-20T09:30:00-05:00', timezone: 'America/New_York', clientOffsetMinutes: -300 }
    );
    assert.equal(winter.values.find((entry) => entry.fieldId === 'session-date').value, winter.eventAt);
  } finally {
    await cleanup(fixture, server);
  }
});

test('form and receipt use the themed shell, preserve escaping, and offer Log another', async () => {
  const fixture = await makeFixture();
  const templatePath = path.join(fixture.templatesPath, 'gym-session-entry.yaml');
  const template = yaml.load(await fs.readFile(templatePath, 'utf8'));
  template.fields.find((field) => field.id === 'notes').label = '<em>Notes</em>';
  await fs.writeFile(templatePath, yaml.dump(template), 'utf8');
  const customThemeMarker = '--forms-shell-test';
  const server = await startServer(fixture, {
    customThemeCss: `:root { ${customThemeMarker}: #123456; }`,
  });

  try {
    const formResponse = await server.request('/forms/gym-session-entry');
    assert.equal(formResponse.status, 200);
    const formHtml = await formResponse.text();
    const formDocument = assertSharedFormsShell(formResponse, formHtml, customThemeMarker);
    const context = browserContext(formResponse, formHtml);
    assert.equal(formDocument.querySelector('.topbar h1').textContent, 'Gym Session Entry');
    assert.equal(formDocument.querySelector('.topbar .back').getAttribute('href'), '/');
    assert.equal(formDocument.querySelector('label[for="field-notes"]').textContent, '<em>Notes</em> *');
    assert.match(formHtml, /&lt;em&gt;Notes&lt;\/em&gt;/);
    assert.doesNotMatch(formHtml, /<em>Notes<\/em>/);
    assert.ok(formDocument.querySelector('input[name="_csrf"]'));
    assert.equal(formDocument.querySelector('iframe'), null, 'first-party forms must not be iframed');

    const submittedMarkup = '<img src=x onerror=alert(1)>';
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: nativeBody(context.token, { notes: submittedMarkup }),
    });
    assert.equal(accepted.status, 303);

    const receiptResponse = await server.request(accepted.headers.get('location'), {
      headers: { Cookie: context.cookie },
    });
    assert.equal(receiptResponse.status, 200);
    const receiptHtml = await receiptResponse.text();
    const receiptDocument = assertSharedFormsShell(receiptResponse, receiptHtml, customThemeMarker);
    assert.equal(receiptDocument.querySelector('.topbar h1').textContent, 'Entry logged');
    assert.equal(receiptDocument.querySelector('.topbar .back').getAttribute('href'), '/');
    assert.equal(
      receiptDocument.querySelector('.form-primary-action').getAttribute('href'),
      '/forms/gym-session-entry'
    );
    assert.equal(receiptDocument.querySelector('.form-primary-action').textContent, 'Log another');
    assert.ok(receiptDocument.querySelector('.receipt-table'));
    assert.equal(receiptDocument.querySelector('.receipt-card').firstElementChild.className, 'receipt-table-wrap');
    assert.ok(receiptDocument.querySelector('.receipt-meta').textContent.includes('Receipt ID'));
    assert.match(receiptHtml, /&lt;em&gt;Notes&lt;\/em&gt;/);
    assert.match(receiptHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(receiptHtml, /<dd><img/);
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

test('native validation re-render survives browser-context eviction', async () => {
  const fixture = await makeFixture();
  const contexts = new Map();
  const server = await startServer(fixture, {
    formsCsrfContexts: contexts,
    formsService: {
      submit: async () => {
        contexts.clear();
        return { error: { code: 'validation_error', message: 'Submission validation failed.', details: [{ path: 'values.notes', message: 'is required' }] } };
      },
    },
  });
  try {
    const context = await getBrowserContext(server);
    const response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(response.status, 422);
    assert.match(response.headers.get('set-cookie'), /^lookie_forms_context=/);
    assert.match(await response.text(), /Please correct/);
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
    assert.equal(created.receipt.values.find((entry) => entry.fieldId === 'lift').fieldLabel, 'Lift');

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

test('JSON clients cannot forge server fields or capture-time labels', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const headers = { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'X-CSRF-Token': context.token };
    const forgedMetadata = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        values: jsonValues(),
        actor: { id: 'attacker', type: 'user' },
        submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        receiptAt: '2020-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(forgedMetadata.status, 400);

    const forgedLabel = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ values: jsonValues({ lift: { optionId: 'bench', optionLabel: 'Forged label' } }) }),
    });
    assert.equal(forgedLabel.status, 422);
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);
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
    const embed = await server.request('/embed/artifacts/page.html');
    assert.equal(embed.status, 200);
    assert.equal(embed.headers.get('content-security-policy'), policy);
    const view = await server.request('/view/artifacts/page.html');
    const document = new JSDOM(await view.text()).window.document;
    assert.equal(document.querySelector('iframe[data-embedded-html]').getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups');

    const asset = await server.request('/asset/artifacts/page.html');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /^text\/plain/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('real browser canary blocks artifact token harvesting through embed and view', { timeout: 45000 }, async (t) => {
  const fixture = await makeFixture();
  const artifactsPath = path.join(fixture.root, 'artifacts');
  await fs.mkdir(artifactsPath);
  const attack = `<!doctype html><body data-attack="started"><script>
(async () => {
  try {
    const form = await fetch('/forms/gym-session-entry', { credentials: 'include' });
    const html = await form.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    const body = new URLSearchParams({_csrf: token, 'session-date':'2026-07-20', lift:'bench', 'top-weight':'225', 'top-reps':'5', rpe:'8', 'felt-strong':'true', notes:'artifact attack'});
    await fetch('/forms/gym-session-entry', { method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    document.body.dataset.attack = 'sent';
  } catch (_error) {
    document.body.dataset.attack = 'blocked';
  }
})();
</script></body>`;
  await fs.writeFile(path.join(artifactsPath, 'attack.html'), attack, 'utf8');
  let port;
  try {
    port = await availablePort();
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('loopback listeners are prohibited by this execution sandbox');
      await cleanup(fixture, null);
      return;
    }
    throw error;
  }
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    mappings: { artifacts: artifactsPath },
    rawHtmlEnabled: true,
    accessConfig: { humanDefault: 'full' },
    formsConfig: { enabled: true, templatesPath: fixture.templatesPath, submissionsPath: fixture.submissionsPath },
    formsPublicOrigin: origin,
    formsAudit: () => {},
  });
  const browserServer = await new Promise((resolve, reject) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    const embed = await runBrowser(`${origin}/embed/artifacts/attack.html`, path.join(fixture.root, 'chrome-embed'));
    assert.match(embed.stdout, /data-attack="blocked"/);
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);

    await runBrowser(`${origin}/view/artifacts/attack.html`, path.join(fixture.root, 'chrome-view'));
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);
  } finally {
    await new Promise((resolve) => browserServer.close(resolve));
    await cleanup(fixture, null);
  }
});

test('browser mutations fail closed without configured public origins despite matching hostile Host', async () => {
  const fixture = await makeFixture();
  const warnings = [];
  const server = await startServer(fixture, {
    formsPublicOrigin: undefined,
    formsAudit: () => {},
    logger: { warn: (message) => warnings.push(message), info() {}, error() {} },
  });
  try {
    const form = await server.request('/forms/gym-session-entry', { headers: { Host: 'evil.test' } });
    const context = browserContext(form, await form.text());
    const response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        Host: 'evil.test',
        Origin: 'http://evil.test',
        'X-Forwarded-Proto': 'http',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
      },
      body: nativeBody(context.token),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), []);
    assert.ok(warnings.some((message) => /without an explicit valid public origin/.test(message)));
  } finally {
    await cleanup(fixture, server);
  }
});

test('temporal validation, idempotency conflict, and oversized JSON map without path leaks', async () => {
  const fixture = await makeFixture();
  const logs = [];
  const server = await startServer(fixture, {
    formsAudit: () => {},
    logger: { warn() {}, info() {}, error: (...args) => logs.push(args) },
  });
  try {
    const context = await getBrowserContext(server);
    const headers = { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'X-CSRF-Token': context.token };
    const invalidTimes = [
      { eventAt: 'garbage', timezone: 'America/New_York', clientOffsetMinutes: -240 },
      { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'Not/AZone', clientOffsetMinutes: -240 },
      { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: 0 },
      { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240.5 },
    ];
    const bodies = [];
    for (const eventTime of invalidTimes) {
      const response = await server.request('/api/forms/gym-session-entry/submissions', {
        method: 'POST', headers, body: JSON.stringify({ values: jsonValues(), ...eventTime }),
      });
      bodies.push(await response.text());
      assert.equal(response.status, 400);
    }

    const first = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers, body: JSON.stringify({ values: jsonValues(), idempotencyKey: 'conflict-route-key-0001' }),
    });
    assert.equal(first.status, 201);
    const conflict = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers, body: JSON.stringify({ values: jsonValues({ notes: 'different' }), idempotencyKey: 'conflict-route-key-0001' }),
    });
    bodies.push(await conflict.text());
    assert.equal(conflict.status, 409);

    const oversized = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers, body: JSON.stringify({ values: { notes: 'x'.repeat(3 * 1024 * 1024) } }),
    });
    bodies.push(await oversized.text());
    assert.equal(oversized.status, 413);
    assert.doesNotMatch(bodies.join('\n'), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(logs), /submission-store\.js|forms-runner\.test\.js/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('form audit events cover reads, submissions, and denials without sensitive material', async () => {
  const fixture = await makeFixture();
  const events = [];
  const server = await startServer(fixture, { formsAudit: (event) => events.push(event) });
  try {
    const context = await getBrowserContext(server);
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(accepted.status, 303);
    assert.equal((await server.request(accepted.headers.get('location'))).status, 200);
    const denied = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: 'http://evil.test' },
      body: nativeBody(context.token),
    });
    assert.equal(denied.status, 403);
    assert.ok(events.some((event) => event.type === 'form.render' && event.outcome === 'accepted'));
    assert.ok(events.some((event) => event.type === 'form.submit' && event.outcome === 'accepted'));
    assert.ok(events.some((event) => event.type === 'form.receipt.read' && event.outcome === 'accepted'));
    assert.ok(events.some((event) => event.outcome === 'rejected_origin'));
    const serialized = JSON.stringify(events);
    for (const secret of [context.token, 'Smooth reps', 'Session date', 'Bench press', fixture.root]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  } finally {
    await cleanup(fixture, server);
  }
});

test('receipt preserves capture-time field labels after a template rename', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, { formsAudit: () => {} });
  try {
    const context = await getBrowserContext(server);
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    const templatePath = path.join(fixture.templatesPath, 'gym-session-entry.yaml');
    const template = yaml.load(await fs.readFile(templatePath, 'utf8'));
    template.fields.find((field) => field.id === 'lift').label = 'Renamed lift';
    await fs.writeFile(templatePath, yaml.dump(template), 'utf8');
    const receipt = await server.request(accepted.headers.get('location'));
    const html = await receipt.text();
    assert.match(html, /<th scope="row">Lift<\/th>/);
    assert.doesNotMatch(html, /Renamed lift/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('receipt authorization conceals submissions from a different principal', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {
    formsAuthorize: ({ req, capability }) => {
      if (capability === 'forms.submit' || capability === 'forms.view') {
        req.accessContext = { mode: 'scoped', principal: { id: req.get('x-principal') || 'owner', kind: 'user' } };
        return true;
      }
      return capability === 'forms.read_submissions' && req.get('x-read-all') === 'yes';
    },
  });
  try {
    const form = await server.request('/forms/gym-session-entry', { headers: { 'X-Principal': 'owner' } });
    const context = browserContext(form, await form.text());
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'X-Principal': 'owner',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: nativeBody(context.token),
    });
    const denied = await server.request(accepted.headers.get('location'), { headers: { 'X-Principal': 'other' } });
    assert.equal(denied.status, 404);
    assert.equal(await denied.text(), 'Not found.');
    const deniedEdit = await server.request(`${accepted.headers.get('location')}/edit`, {
      headers: { 'X-Principal': 'other' },
    });
    assert.equal(deniedEdit.status, 404);
    assert.equal(await deniedEdit.text(), 'Not found.');
    const reader = await server.request(accepted.headers.get('location'), { headers: { 'X-Read-All': 'yes' } });
    assert.equal(reader.status, 200);
    assert.match(await reader.text(), /Smooth reps/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('entries page is reverse chronological, grouped with date and time, and strictly owner scoped', async () => {
  const fixture = await makeFixture();
  const times = [
    new Date('2026-07-19T18:15:00.000Z'),
    new Date('2026-07-20T08:30:00.000Z'),
    new Date('2026-07-21T12:45:00.000Z'),
  ];
  let tick = 0;
  const formsStore = new SubmissionStore({
    storageRoot: fixture.submissionsPath,
    clock: () => times[tick++],
  });
  const server = await startServer(fixture, {
    formsStore,
    formsTimezone: 'UTC',
    formsAuthorize: ({ req, capability }) => {
      req.accessContext = {
        mode: 'scoped',
        principal: { id: req.get('x-principal') || 'owner', kind: 'user' },
      };
      return capability === 'forms.submit' || capability === 'forms.view';
    },
  });
  try {
    const form = await server.request('/forms/gym-session-entry', { headers: { 'X-Principal': 'owner' } });
    const context = browserContext(form, await form.text());
    const submit = async (principal, values) => {
      const response = await server.request('/api/forms/gym-session-entry/submissions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: context.cookie,
          Origin: PUBLIC_ORIGIN,
          'X-CSRF-Token': context.token,
          'X-Principal': principal,
        },
        body: JSON.stringify({ values }),
      });
      assert.equal(response.status, 201);
    };
    await submit('owner', jsonValues({ 'top-weight': 205, notes: 'Older own' }));
    await submit('owner', jsonValues({ 'top-weight': 225, notes: 'Newer own' }));
    await submit('other', jsonValues({ 'top-weight': 999, notes: 'Foreign secret' }));

    const response = await server.request('/forms/gym-session-entry/entries', {
      headers: { 'X-Principal': 'owner' },
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    const document = new JSDOM(html).window.document;
    const rows = [...document.querySelectorAll('.entry-row')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /225/);
    assert.match(rows[1].textContent, /205/);
    assert.doesNotMatch(html, /999|Foreign secret/);
    assert.equal(document.querySelectorAll('.entries-day').length, 2);
    for (const time of document.querySelectorAll('.entry-row-heading time')) {
      assert.match(time.getAttribute('datetime'), /^2026-07-\d{2}T\d{2}:\d{2}/);
      assert.match(time.textContent, /Jul \d{1,2}, 2026, \d{1,2}:\d{2} [AP]M/);
    }

    const empty = await server.request('/forms/gym-session-entry/entries', {
      headers: { 'X-Principal': 'nobody' },
    });
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /Ready for your first entry\?/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('receipt edit prefills values and saves an immutable superseding correction', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, { formsTimezone: 'America/New_York' });
  try {
    const context = await getBrowserContext(server);
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: nativeBody(context.token),
    });
    assert.equal(accepted.status, 303);
    const originalId = accepted.headers.get('location').split('/').pop();
    const originalPath = path.join(fixture.submissionsPath, `${originalId}.json`);
    const originalBytes = await fs.readFile(originalPath);

    const edit = await server.request(`${accepted.headers.get('location')}/edit`, {
      headers: { Cookie: context.cookie },
    });
    assert.equal(edit.status, 200);
    const editDocument = new JSDOM(await edit.text()).window.document;
    assert.equal(editDocument.querySelector('#field-top-weight').value, '225.5');
    assert.equal(editDocument.querySelector('#field-notes').value, 'Smooth reps');
    assert.equal(editDocument.querySelector('input[name="_supersedes"]').value, originalId);
    assert.match(editDocument.querySelector('.correction-note').textContent, /earlier version stays preserved/i);
    const editToken = editDocument.querySelector('input[name="_csrf"]').value;

    const correctionBody = nativeBody(editToken, { notes: 'Corrected form', 'top-weight': '230' });
    correctionBody.set('_supersedes', originalId);
    const correctedResponse = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: correctionBody,
    });
    assert.equal(correctedResponse.status, 303);
    assert.equal(Buffer.compare(originalBytes, await fs.readFile(originalPath)), 0);
    const correctedId = correctedResponse.headers.get('location').split('/').pop();
    const corrected = JSON.parse(await fs.readFile(
      path.join(fixture.submissionsPath, `${correctedId}.json`),
      'utf8'
    ));
    assert.deepEqual(corrected.supersedesRecord, { resourceKind: 'form-submission', id: originalId });
    assert.equal(corrected.values.find((entry) => entry.fieldId === 'top-weight').value, 230);
    assert.equal((await submissionFiles(fixture.submissionsPath)).length, 2);

    const receipt = await server.request(correctedResponse.headers.get('location'), {
      headers: { Cookie: context.cookie },
    });
    assert.match(await receipt.text(), /supersedes an earlier version/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('correction API is immutable, linear, concealed, and list/history stay owner scoped', async () => {
  const fixture = await makeFixture();
  let tick = 0;
  const formsStore = new SubmissionStore({
    storageRoot: fixture.submissionsPath,
    clock: () => new Date(Date.UTC(2026, 6, 20, 12, 0, tick++)),
  });
  const server = await startServer(fixture, {
    formsStore,
    formsAuthorize: ({ req, capability }) => {
      req.accessContext = {
        mode: 'scoped',
        principal: { id: req.get('x-principal') || 'owner', kind: 'user' },
      };
      return capability === 'forms.submit' || capability === 'forms.view'
        || ((capability === 'forms.read_submissions' || capability === 'forms.manage')
          && req.get('x-reader') === 'yes');
    },
  });
  try {
    const form = await server.request('/forms/gym-session-entry', { headers: { 'X-Principal': 'owner' } });
    const context = browserContext(form, await form.text());
    const apiHeaders = (principal) => ({
      'Content-Type': 'application/json',
      Cookie: context.cookie,
      Origin: PUBLIC_ORIGIN,
      'X-CSRF-Token': context.token,
      'X-Principal': principal,
    });
    const create = async (principal, values) => {
      const response = await server.request('/api/forms/gym-session-entry/submissions', {
        method: 'POST', headers: apiHeaders(principal), body: JSON.stringify({ values }),
      });
      assert.equal(response.status, 201);
      return response.json();
    };

    const original = await create('owner', jsonValues({ notes: 'Original' }));
    const originalPath = path.join(fixture.submissionsPath, `${original.submissionId}.json`);
    const predecessorBytes = await fs.readFile(originalPath);
    const second = await create('owner', jsonValues({ notes: 'Second entry' }));
    const foreign = await create('other', jsonValues({ notes: 'Foreign entry' }));
    const beforeDenied = await submissionFiles(fixture.submissionsPath);
    const correctionBody = (id, notes = 'Corrected') => JSON.stringify({
      values: jsonValues({ notes }),
      supersedesRecord: { resourceKind: 'form-submission', id },
    });

    const denied = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers: apiHeaders('other'), body: correctionBody(original.submissionId),
    });
    const unknown = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers: apiHeaders('owner'),
      body: correctionBody('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    });
    assert.equal(denied.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await denied.json(), await unknown.json());
    assert.deepEqual(await submissionFiles(fixture.submissionsPath), beforeDenied);

    const correctedResponse = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers: apiHeaders('owner'), body: correctionBody(original.submissionId),
    });
    assert.equal(correctedResponse.status, 201);
    const corrected = await correctedResponse.json();
    assert.equal(Buffer.compare(predecessorBytes, await fs.readFile(originalPath)), 0);

    const duplicate = await server.request('/api/forms/gym-session-entry/submissions', {
      method: 'POST', headers: apiHeaders('owner'), body: correctionBody(original.submissionId, 'Fork'),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await submissionFiles(fixture.submissionsPath)).length, beforeDenied.length + 1);

    const list = await server.request('/api/forms/gym-session-entry/submissions?limit=1000', {
      headers: { 'X-Principal': 'owner' },
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.limit, 100);
    assert.deepEqual(listed.submissions.map((record) => record.submissionId), [
      corrected.submissionId,
      second.submissionId,
    ]);
    assert.equal(listed.submissions.some((record) => record.submissionId === foreign.submissionId), false);
    assert.equal(listed.submissions.some((record) => record.submissionId === original.submissionId), false);
    assert.equal(listed.submissions[0].values.find((entry) => entry.fieldId === 'notes').value, 'Corrected');

    const bounded = await server.request('/api/forms/gym-session-entry/submissions?limit=1', {
      headers: { 'X-Principal': 'owner' },
    });
    assert.equal((await bounded.json()).submissions.length, 1);
    const history = await server.request(
      `/api/forms/gym-session-entry/submissions/${original.submissionId}/history`,
      { headers: { 'X-Principal': 'owner' } }
    );
    assert.equal(history.status, 200);
    const chain = await history.json();
    assert.equal(chain.latestSubmissionId, corrected.submissionId);
    assert.deepEqual(chain.submissions.map((record) => record.submissionId), [
      corrected.submissionId,
      original.submissionId,
    ]);
  } finally {
    await cleanup(fixture, server);
  }
});

test('capture-time receipt labels and values remain HTML escaped', () => {
  const html = renderReceiptPage(null, {
    submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    receiptAt: '2026-07-20T00:00:00.000Z',
    values: [{
      fieldId: 'notes',
      fieldType: 'long-text',
      fieldLabel: '<script>label()</script>',
      value: '<img src=x onerror=alert(1)>',
    }],
  });
  assert.doesNotMatch(html, /<script>label|<dd><img/);
  assert.match(html, /&lt;script&gt;label\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
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
