'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');
const { chromium } = require('playwright');

const { createApp } = require('../server');
const { renderReceiptPage, renderFormsIndexPage, renderRootHistoryPage } = require('../lib/forms/routes');
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
  presentation: { submitLabel: 'Submit' },
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
  assert.ok(document.querySelector('[data-theme-menu]'));
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

function scriptedForm(html, clockState) {
  return new JSDOM(html, {
    url: PUBLIC_ORIGIN,
    runScripts: 'dangerously',
    beforeParse(window) {
      const NativeDate = window.Date;
      class ControlledDate extends NativeDate {
        constructor(...args) {
          super(...(args.length ? args : [clockState.now.getTime()]));
        }

        static now() {
          return clockState.now.getTime();
        }

        getFullYear() { return this.getUTCFullYear(); }
        getMonth() { return this.getUTCMonth(); }
        getDate() { return this.getUTCDate(); }
        getHours() { return this.getUTCHours(); }
        getMinutes() { return this.getUTCMinutes(); }
        getTimezoneOffset() { return clockState.offsetMinutes; }
      }
      window.Date = ControlledDate;
      const NativeDateTimeFormat = window.Intl.DateTimeFormat;
      const ControlledDateTimeFormat = function (...args) {
        const formatter = new NativeDateTimeFormat(...args);
        const resolvedOptions = formatter.resolvedOptions.bind(formatter);
        formatter.resolvedOptions = () => ({ ...resolvedOptions(), timeZone: clockState.timezone });
        return formatter;
      };
      ControlledDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
      ControlledDateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat);
      window.Intl.DateTimeFormat = ControlledDateTimeFormat;
    },
  });
}

function nativeBody(token, overrides = {}) {
  return new URLSearchParams({
    _csrf: token,
    'session-date': '2026-07-20T09:30',
    lift: 'bench',
    'top-weight': '225',
    'top-reps': '5',
    rpe: '8',
    'felt-strong': 'true',
    notes: 'Smooth reps',
    ...overrides,
  });
}

function formValues(form) {
  const values = new URLSearchParams();
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (!control.name || control.disabled || (control.type === 'checkbox' && !control.checked)) continue;
    if (control.tagName === 'SELECT' && control.multiple) {
      for (const option of control.selectedOptions) values.append(control.name, option.value);
    } else {
      values.append(control.name, control.value);
    }
  }
  return values;
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
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    executablePath: process.env.CHROME_BIN || undefined,
  });
  try {
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    return { stdout: await page.content(), stderr: '' };
  } finally {
    await context.close();
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
    assert.equal(document.querySelector('#field-count').placeholder, '\u2014');
    assert.equal(document.querySelector('.readout-unit').textContent, 'kg');
    assert.deepEqual(
      [...document.querySelectorAll('.form-section > h2')].map((heading) => heading.textContent),
      ['What you\u2019re logging', 'Measurements', 'More about this entry']
    );
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
    assert.ok(document.querySelector('#field-recorded-at').value);
    assert.equal(document.querySelector('#field-recorded-at').hasAttribute('data-auto-stamp'), true);
    assert.ok(document.querySelector('input[name="recorded-at__offset"]'));
    assert.ok(document.querySelector('input[name="recorded-at__timezone"]'));
    assert.equal(document.querySelector('input[name="recorded-at__stamp"]').value, 'seed');
    assert.match(html, /getTimezoneOffset/);
    assert.equal(document.querySelector('#field-choice').tagName, 'SELECT');
    assert.equal(document.querySelector('#field-choice option').textContent, 'Select…');
    assert.equal(document.querySelector('#field-choices').multiple, true);
    assert.equal(document.querySelectorAll('[required]').length, everyTypeTemplate.fields.length);
    assert.equal(document.querySelector('.topbar .subtitle'), null);
    assert.equal(document.querySelector('.form-primary-action').textContent, 'Submit');
  } finally {
    await cleanup(fixture, server);
  }
});

test('stepped number selects render bounded options, preserve selection, and store numbers', async () => {
  const fixture = await makeFixture();
  const template = {
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'stepped-numbers',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Stepped numbers',
    fields: [
      {
        id: 'load', type: 'number', component: 'stepped-select', label: 'Load (kg)', required: true,
        constraints: { minimum: 1, maximum: 3, step: 0.5 },
      },
      {
        id: 'missing-range', type: 'number', component: 'stepped-select', label: 'Missing range', required: false,
        constraints: { minimum: 0, step: 1 },
      },
      {
        id: 'too-many', type: 'number', component: 'stepped-select', label: 'Too many', required: false,
        constraints: { minimum: 0, maximum: 201, step: 1 },
      },
      { id: 'summary', type: 'short-text', label: 'Summary', required: true },
    ],
  };
  await fs.writeFile(
    path.join(fixture.templatesPath, 'stepped-numbers.yaml'),
    yaml.dump(template),
    'utf8'
  );
  const server = await startServer(fixture);
  try {
    const response = await server.request('/forms/stepped-numbers');
    assert.equal(response.status, 200);
    const html = await response.text();
    const context = browserContext(response, html);
    const load = context.document.querySelector('#field-load');
    assert.equal(load.tagName, 'SELECT');
    assert.equal(load.className, 'stepped-select');
    assert.deepEqual(
      [...load.options].map((option) => option.value),
      ['', '1', '1.5', '2', '2.5', '3']
    );
    assert.equal(context.document.querySelector('#field-missing-range').type, 'number');
    assert.equal(context.document.querySelector('#field-missing-range').step, '1');
    assert.equal(context.document.querySelector('#field-too-many').type, 'number');
    assert.equal(context.document.querySelector('.form-primary-action').textContent, 'Submit');

    const invalid = await server.request('/forms/stepped-numbers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: new URLSearchParams({ _csrf: context.token, load: '2.5', summary: '' }),
    });
    assert.equal(invalid.status, 422);
    const invalidDocument = new JSDOM(await invalid.text()).window.document;
    assert.equal(invalidDocument.querySelector('#field-load').value, '2.5');
    assert.equal(
      invalidDocument.querySelector('.entries-link').getAttribute('href'),
      '/forms/stepped-numbers/entries'
    );

    const accepted = await server.request('/forms/stepped-numbers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: new URLSearchParams({ _csrf: context.token, load: '2.5', summary: 'Working set' }),
    });
    assert.equal(accepted.status, 303);
    const records = await Promise.all((await submissionFiles(fixture.submissionsPath)).map((fileName) => (
      fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8').then(JSON.parse)
    )));
    const storedLoad = records[0].values.find((entry) => entry.fieldId === 'load').value;
    assert.equal(storedLoad, 2.5);
    assert.equal(typeof storedLoad, 'number');
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

test('untouched datetime is stamped at browser submit with freshly recomputed offset and timezone', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {
    formsClock: () => new Date('2026-07-20T13:30:00.000Z'),
    formsTimezone: 'America/New_York',
  });
  try {
    const response = await server.request('/forms/gym-session-entry');
    const html = await response.text();
    const context = browserContext(response, html);
    const clockState = {
      now: new Date('2026-07-20T09:30:00.000Z'),
      offsetMinutes: 240,
      timezone: 'Etc/GMT+4',
    };
    const dom = scriptedForm(html, clockState);
    const { document } = dom.window;
    const input = document.querySelector('#field-session-date');
    const seed = input.value;
    assert.equal(seed, '2026-07-20T09:30');
    assert.equal(document.querySelector('input[name="session-date__stamp"]').value, 'seed');

    clockState.now = new Date('2026-07-20T09:42:00.000Z');
    clockState.offsetMinutes = 300;
    clockState.timezone = 'Etc/GMT+5';
    const form = input.form;
    form.addEventListener('submit', (event) => event.preventDefault());
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    assert.equal(input.value, '2026-07-20T09:42');
    assert.equal(document.querySelector('input[name="session-date__offset"]').value, '-300');
    assert.equal(document.querySelector('input[name="session-date__timezone"]').value, 'Etc/GMT+5');
    assert.equal(document.querySelector('input[name="session-date__stamp"]').value, 'stamped');

    const body = nativeBody(context.token, {
      'session-date': input.value,
      'session-date__offset': '-300',
      'session-date__timezone': 'Etc/GMT+5',
      'session-date__seed': seed,
      'session-date__stamp': 'stamped',
    });
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body,
    });
    assert.equal(accepted.status, 303);
    const [fileName] = await submissionFiles(fixture.submissionsPath);
    const record = JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8'));
    assert.deepEqual(
      { eventAt: record.eventAt, timezone: record.timezone, clientOffsetMinutes: record.clientOffsetMinutes },
      { eventAt: '2026-07-20T09:42:00-05:00', timezone: 'Etc/GMT+5', clientOffsetMinutes: -300 }
    );
  } finally {
    await cleanup(fixture, server);
  }
});

test('datetime input events preserve deliberate overrides, including retyping the identical seed', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {
    formsClock: () => new Date('2026-07-20T13:30:00.000Z'),
    formsTimezone: 'America/New_York',
  });
  try {
    const response = await server.request('/forms/gym-session-entry');
    const html = await response.text();
    const context = browserContext(response, html);
    const clockState = {
      now: new Date('2026-07-20T09:30:00.000Z'),
      offsetMinutes: 240,
      timezone: 'Etc/GMT+4',
    };
    const dom = scriptedForm(html, clockState);
    const { document } = dom.window;
    const input = document.querySelector('#field-session-date');
    const seed = input.value;
    input.value = seed;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(document.querySelector('input[name="session-date__stamp"]').value, 'dirty');

    clockState.now = new Date('2026-07-20T10:15:00.000Z');
    input.form.addEventListener('submit', (event) => event.preventDefault());
    input.form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(input.value, seed);

    input.value = '2026-07-19T08:05';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    clockState.now = new Date('2026-07-20T11:00:00.000Z');
    input.form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(input.value, '2026-07-19T08:05');

    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token, {
        'session-date': input.value,
        'session-date__offset': document.querySelector('input[name="session-date__offset"]').value,
        'session-date__timezone': document.querySelector('input[name="session-date__timezone"]').value,
        'session-date__seed': seed,
        'session-date__stamp': 'dirty',
      }),
    });
    assert.equal(accepted.status, 303);
    const [fileName] = await submissionFiles(fixture.submissionsPath);
    const record = JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8'));
    assert.equal(record.eventAt, '2026-07-19T08:05:00-04:00');
  } finally {
    await cleanup(fixture, server);
  }
});

test('no-JS untouched datetime seed is stamped by the server at submit', async () => {
  const fixture = await makeFixture();
  let now = new Date('2026-07-20T13:30:00.000Z');
  const server = await startServer(fixture, {
    formsClock: () => now,
    formsTimezone: 'America/New_York',
  });
  try {
    const response = await server.request('/forms/gym-session-entry');
    const html = await response.text();
    const context = browserContext(response, html);
    const document = context.document;
    const seed = document.querySelector('#field-session-date').value;
    assert.equal(seed, '2026-07-20T09:30');

    now = new Date('2026-07-20T13:47:00.000Z');
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token, {
        'session-date': seed,
        'session-date__seed': seed,
        'session-date__stamp': 'seed',
      }),
    });
    assert.equal(accepted.status, 303);
    const [fileName] = await submissionFiles(fixture.submissionsPath);
    const record = JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8'));
    assert.deepEqual(
      { eventAt: record.eventAt, timezone: record.timezone, clientOffsetMinutes: record.clientOffsetMinutes },
      { eventAt: '2026-07-20T09:47:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240 }
    );
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
    // Header is a breadcrumb ending in the form title (the coloured current crumb),
    // matching the document header. Sub-view is shown by the hub-nav tabs.
    assert.equal(formDocument.querySelector('.topbar .crumb-title').textContent, 'Gym Session Entry');
    assert.equal(formDocument.querySelector('.topbar .breadcrumbs a[href="/forms"]'), null);
    assert.equal(formDocument.querySelector('.form-primary-action').textContent, 'Submit');
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
    assert.equal(receiptDocument.querySelector('.topbar .crumb-title').textContent, 'Gym Session Entry');
    assert.equal(receiptDocument.querySelector('.topbar .breadcrumbs a[href="/forms"]'), null);
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

test('the receipt carries the tracker bar, so a logged entry is not a dead end (#356)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(accepted.status, 303);
    const receipt = await (await server.request(accepted.headers.get('location'), {
      headers: { Cookie: context.cookie },
    })).text();
    const document = new JSDOM(receipt).window.document;

    const bar = document.querySelector('.form-layout > .form-hub-nav');
    assert.ok(bar, 'the receipt renders the tracker bar');
    assert.deepEqual(
      [...bar.querySelectorAll('a')].map((link) => [link.className, link.getAttribute('href'), link.textContent]),
      [
        ['up-link', '/forms', '← Trackers'],
        ['log-link', '/forms/gym-session-entry', 'Log an entry'],
        ['entries-link', '/forms/gym-session-entry/entries', 'History'],
        ['configure-link', '/forms/gym-session-entry/configure', 'Configure'],
      ]
    );
    // A receipt is none of the four views the bar lists, so nothing claims to be current.
    assert.equal(bar.querySelector('[aria-current]'), null);
    // The bar sits outside the topbar, as it does on every other surface.
    assert.equal(document.querySelector('.topbar .form-hub-nav'), null);
    assert.equal(document.querySelector('.topbar .breadcrumbs a[href="/forms"]'), null);
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
    assert.match(html, /225/);
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
    body.set('rpe', '10');
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
    assert.equal(document.querySelector('#field-rpe').value, '10');
    assert.equal(document.querySelector('#field-lift').value, 'bench');
    assert.equal(document.querySelector('#field-top-weight').value, '225');
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
    // /embed additionally grants click-gated top navigation (#232) — /raw stays stricter.
    const embed = await server.request('/embed/artifacts/page.html');
    assert.equal(embed.status, 200);
    assert.equal(
      embed.headers.get('content-security-policy'),
      `${policy} allow-top-navigation-by-user-activation`
    );
    assert.doesNotMatch(embed.headers.get('content-security-policy'), /allow-same-origin/);
    const view = await server.request('/view/artifacts/page.html');
    const document = new JSDOM(await view.text()).window.document;
    assert.equal(document.querySelector('iframe[data-embedded-html]').getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation');

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
    const formHtml = await form.text();
    const context = browserContext(form, formHtml);
    assert.equal(
      context.document.querySelector('.entries-link').getAttribute('href'),
      '/forms/gym-session-entry/entries'
    );
    assert.match(context.document.querySelector('.recent-entries-empty').textContent, /first entry/i);
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
    await submit('other', jsonValues({ 'top-weight': 995, notes: 'Foreign secret' }));

    const refreshedForm = await server.request('/forms/gym-session-entry', {
      headers: { 'X-Principal': 'owner' },
    });
    assert.equal(refreshedForm.status, 200);
    const refreshedHtml = await refreshedForm.text();
    const refreshedDocument = new JSDOM(refreshedHtml).window.document;
    const recentRows = [...refreshedDocument.querySelectorAll('.recent-entries .entry-row')];
    assert.equal(recentRows.length, 2);
    assert.match(recentRows[0].textContent, /225/);
    assert.match(recentRows[1].textContent, /205/);
    assert.deepEqual(
      [...recentRows[0].querySelectorAll('.entry-row-summary .entry-metric-label')].map((label) => label.textContent),
      ['Top weight', 'Top reps', 'RPE'],
    );
    assert.match(recentRows[0].querySelector('.entry-row-summary').textContent, /Deadlift/);
    assert.doesNotMatch(
      [...refreshedDocument.querySelectorAll('.recent-entries .entry-row-summary')].map((row) => row.textContent).join(' '),
      /995|Foreign secret/
    );

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
    assert.doesNotMatch(
      [...document.querySelectorAll('.entry-row-summary')].map((row) => row.textContent).join(' '),
      /995|Foreign secret/
    );
    assert.equal(document.querySelectorAll('.entries-day').length, 2);
    assert.equal((document.querySelector('.entries-card').textContent.match(/2026/g) || []).length, 2);
    for (const time of document.querySelectorAll('.entry-row-heading time')) {
      assert.match(time.getAttribute('datetime'), /^2026-07-\d{2}T\d{2}:\d{2}/);
      assert.match(time.textContent, /^\d{1,2}:\d{2} [AP]M$/);
      assert.doesNotMatch(time.textContent, /Jul|2026/);
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

test('showInList fields drive recent and history rows in template order', async () => {
  const fixture = await makeFixture();
  const templatePath = path.join(fixture.templatesPath, 'gym-session-entry.yaml');
  const template = yaml.load(await fs.readFile(templatePath, 'utf8'), {schema: yaml.JSON_SCHEMA});
  template.fields.find((field) => field.id === 'lift').showInList = true;
  template.fields.find((field) => field.id === 'top-reps').showInList = true;
  await fs.writeFile(templatePath, yaml.dump(template), 'utf8');
  const server = await startServer(fixture, {formsTimezone: 'UTC'});
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
    for (const route of ['/forms/gym-session-entry', '/forms/gym-session-entry/entries']) {
      const response = await server.request(route, {headers: {Cookie: context.cookie}});
      const document = new JSDOM(await response.text()).window.document;
      // #230: the selection renders in the heading (not suppressed by showInList),
      // and the metrics never duplicate it — so 'Lift' appears as the bold heading
      // label while the marked metrics reduce to the remaining fields, in order.
      const summary = document.querySelector('.entry-row-summary');
      assert.ok(summary.querySelector('strong'), 'heading keeps the selection label');
      assert.deepEqual(
        [...document.querySelectorAll('.entry-row-summary .entry-metric-label')].slice(0, 2).map((label) => label.textContent),
        ['Top reps'],
      );
      assert.equal(summary.textContent.includes('Top weight'), false);
    }
  } finally {
    await cleanup(fixture, server);
  }
});

test('inline editors on recent and history create immutable linear corrections and edit view excludes itself', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
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

    let response = await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}});
    let document = new JSDOM(await response.text()).window.document;
    let inline = document.querySelector('.recent-entries .inline-edit-form');
    assert.ok(inline);
    assert.equal(inline.querySelector('[name="top-weight"]').tagName, 'SELECT');
    inline.querySelector('[name="top-weight"]').value = '230';
    inline.querySelector('[name="notes"]').value = 'Recent inline edit';
    response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: formValues(inline),
    });
    assert.equal(response.status, 303);
    assert.equal(Buffer.compare(originalBytes, await fs.readFile(originalPath)), 0);
    const firstCorrectionId = response.headers.get('location').split('/').pop();
    const firstCorrectionPath = path.join(fixture.submissionsPath, `${firstCorrectionId}.json`);
    const firstCorrectionBytes = await fs.readFile(firstCorrectionPath);
    const firstCorrection = JSON.parse(firstCorrectionBytes.toString('utf8'));
    assert.deepEqual(firstCorrection.supersedesRecord, {resourceKind: 'form-submission', id: originalId});

    response = await server.request('/forms/gym-session-entry/entries', {headers: {Cookie: context.cookie}});
    document = new JSDOM(await response.text()).window.document;
    inline = document.querySelector('.entries-card .inline-edit-form');
    assert.ok(inline);
    inline.querySelector('[name="top-weight"]').value = '235';
    inline.querySelector('[name="notes"]').value = 'History inline edit';
    response = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: context.cookie,
        Origin: PUBLIC_ORIGIN,
      },
      body: formValues(inline),
    });
    assert.equal(response.status, 303);
    assert.equal(Buffer.compare(firstCorrectionBytes, await fs.readFile(firstCorrectionPath)), 0);
    const latestId = response.headers.get('location').split('/').pop();
    const latest = JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, `${latestId}.json`), 'utf8'));
    assert.deepEqual(latest.supersedesRecord, {resourceKind: 'form-submission', id: firstCorrectionId});
    assert.equal(latest.values.find((entry) => entry.fieldId === 'top-weight').value, 235);

    response = await server.request(`/forms/gym-session-entry/receipts/${latestId}/edit`, {
      headers: {Cookie: context.cookie},
    });
    document = new JSDOM(await response.text()).window.document;
    assert.equal(
      [...document.querySelectorAll('.recent-entries [name="_supersedes"]')].some((input) => input.value === latestId),
      false,
    );
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
    assert.equal(editDocument.querySelector('#field-top-weight').value, '225');
    assert.equal(editDocument.querySelector('#field-notes').value, 'Smooth reps');
    assert.equal(editDocument.querySelector('#field-session-date').hasAttribute('data-auto-stamp'), false);
    assert.equal(editDocument.querySelector('input[name="session-date__stamp"]'), null);
    assert.equal(editDocument.querySelector('input[name="_supersedes"]').value, originalId);
    assert.match(editDocument.querySelector('.correction-note').textContent, /earlier version stays preserved/i);
    const editToken = editDocument.querySelector('input[name="_csrf"]').value;

    const correctionBody = nativeBody(editToken, {
      notes: 'Corrected form',
      'top-weight': '230',
      'session-date': '2026-07-19T08:15',
    });
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
    assert.equal(corrected.eventAt, '2026-07-19T08:15:00-04:00');
    assert.equal(corrected.values.find((entry) => entry.fieldId === 'session-date').value, corrected.eventAt);
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

test('destination aliases isolate writes, lists, and receipts without disclosing storage roots', async () => {
  const fixture = await makeFixture();
  const gymRoot = path.join(fixture.root, 'private-gym-records');
  const notesRoot = path.join(fixture.root, 'private-notes-records');
  const defaultRoot = path.join(fixture.root, 'private-default-records');
  const source = yaml.load(await fs.readFile(GYM_FIXTURE, 'utf8'));
  const gymTemplate = {...source, templateId: 'gym-log', title: 'Gym Log', destinationId: 'gym-records'};
  const notesTemplate = {...source, templateId: 'training-notes', title: 'Training Notes', destinationId: 'notes-records'};
  const defaultTemplate = {...source, templateId: 'daily-log', title: 'Daily Log'};
  await fs.rm(path.join(fixture.templatesPath, 'gym-session-entry.yaml'));
  await fs.writeFile(path.join(fixture.templatesPath, 'gym-log.yaml'), yaml.dump(gymTemplate), 'utf8');
  await fs.writeFile(path.join(fixture.templatesPath, 'training-notes.yaml'), yaml.dump(notesTemplate), 'utf8');
  await fs.writeFile(path.join(fixture.templatesPath, 'daily-log.yaml'), yaml.dump(defaultTemplate), 'utf8');
  const events = [];
  const server = await startServer(fixture, {
    formsConfig: {
      enabled: true,
      templatesPath: fixture.templatesPath,
      destinations: {
        'gym-records': gymRoot,
        'notes-records': notesRoot,
        default: defaultRoot,
      },
    },
    formsAudit: (event) => events.push(event),
  });
  try {
    const created = {};
    const responseBodies = [];
    for (const templateId of ['gym-log', 'training-notes', 'daily-log']) {
      const context = await getBrowserContext(server, templateId);
      const response = await server.request(`/api/forms/${templateId}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: context.cookie,
          Origin: PUBLIC_ORIGIN,
          'X-CSRF-Token': context.token,
        },
        body: JSON.stringify({ values: jsonValues({ notes: `private value for ${templateId}` }) }),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      created[templateId] = body;
      responseBodies.push(JSON.stringify(body));
    }

    assert.deepEqual((await submissionFiles(gymRoot)), [`${created['gym-log'].submissionId}.json`]);
    assert.deepEqual((await submissionFiles(notesRoot)), [`${created['training-notes'].submissionId}.json`]);
    assert.deepEqual((await submissionFiles(defaultRoot)), [`${created['daily-log'].submissionId}.json`]);

    for (const [templateId, otherTemplateId] of [
      ['gym-log', 'training-notes'],
      ['training-notes', 'daily-log'],
      ['daily-log', 'gym-log'],
    ]) {
      const ownReceipt = await server.request(created[templateId].receiptUrl);
      assert.equal(ownReceipt.status, 200);
      responseBodies.push(await ownReceipt.text());
      const crossed = await server.request(
        `/forms/${templateId}/receipts/${created[otherTemplateId].submissionId}`
      );
      assert.equal(crossed.status, 404);
      responseBodies.push(await crossed.text());
      const entries = await server.request(`/api/forms/${templateId}/submissions`);
      assert.equal(entries.status, 200);
      const entriesBody = await entries.json();
      assert.deepEqual(entriesBody.submissions.map((entry) => entry.submissionId), [created[templateId].submissionId]);
      responseBodies.push(JSON.stringify(entriesBody));
    }

    const disclosed = `${responseBodies.join('\n')}\n${JSON.stringify(events)}`;
    for (const storageRoot of [gymRoot, notesRoot, defaultRoot]) {
      assert.doesNotMatch(disclosed, new RegExp(storageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    await cleanup(fixture, server);
  }
});

test('an unknown destination alias fails startup without silently writing to default', async () => {
  const fixture = await makeFixture();
  const defaultRoot = path.join(fixture.root, 'default-records');
  const document = yaml.load(await fs.readFile(GYM_FIXTURE, 'utf8'));
  document.destinationId = 'operator-must-approve';
  await fs.writeFile(path.join(fixture.templatesPath, 'gym-session-entry.yaml'), yaml.dump(document), 'utf8');
  try {
    await assert.rejects(
      () => startServer(fixture, {
        formsConfig: {
          enabled: true,
          templatesPath: fixture.templatesPath,
          destinations: { default: defaultRoot },
        },
      }),
      /gym-session-entry\.yaml references unknown destinationId operator-must-approve/
    );
    assert.deepEqual(await submissionFiles(defaultRoot), []);
  } finally {
    await cleanup(fixture, null);
  }
});

test('legacy submissionsPath configuration reads records created before the destination adapter', async () => {
  const fixture = await makeFixture();
  const legacyStore = new SubmissionStore({ storageRoot: fixture.submissionsPath });
  const legacyRecord = await legacyStore.createSubmission({
    actor: { id: 'local-user', type: 'human' },
    templateId: 'gym-session-entry',
    templateVersion: 1,
    schemaDigest: `sha256:${'a'.repeat(64)}`,
    values: [{ fieldId: 'notes', fieldType: 'long-text', fieldLabel: 'Notes', value: 'Legacy entry' }],
  });
  const server = await startServer(fixture);
  try {
    const receipt = await server.request(`/forms/gym-session-entry/receipts/${legacyRecord.submissionId}`);
    assert.equal(receipt.status, 200);
    assert.match(await receipt.text(), /Legacy entry/);
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

test('a template theme reaches the page and does not leak into other forms', () => {
  const themed = {
    ...everyTypeTemplate,
    templateId: 'themed-form',
    presentation: { submitLabel: 'Submit', theme: 'the-bic', themeMode: 'light' },
  };
  const record = {
    contractVersion: 1, resourceKind: 'form-submission', submissionId: 'sub-1',
    templateId: 'themed-form', templateRevision: 1, receiptAt: '2026-07-21T12:00:00.000Z',
    values: [],
  };

  const themedHtml = renderReceiptPage(themed, record, {});
  assert.ok(themedHtml.includes('"the-bic"'), 'themed receipt carries the slug');
  assert.ok(themedHtml.includes('"light"'), 'themed receipt carries the mode');

  // An unthemed template must not inherit it -- the default stays the viewer preference.
  const plainHtml = renderReceiptPage(everyTypeTemplate, {...record, templateId: 'every-field'}, {});
  assert.ok(!plainHtml.includes('"the-bic"'), 'unthemed receipt has no page theme');
});

test('a template cannot smuggle a script through the theme slug', () => {
  // Defence in depth: schema rejects this shape, and the renderer must too.
  const hostile = {
    ...everyTypeTemplate,
    templateId: 'hostile-form',
    presentation: { submitLabel: 'Submit', theme: '"};alert(1);//' },
  };
  const record = {
    contractVersion: 1, resourceKind: 'form-submission', submissionId: 'sub-2',
    templateId: 'hostile-form', templateRevision: 1, receiptAt: '2026-07-21T12:00:00.000Z',
    values: [],
  };
  const html = renderReceiptPage(hostile, record, {});
  assert.ok(!html.includes('alert(1)'), 'hostile slug is not emitted into the page');
});

test('datetimes humanize on receipts/metrics and the recent panel day-prefixes non-today rows (#231)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {
    formsTimezone: 'America/New_York',
    formsClock: () => new Date('2026-07-29T18:00:00Z'), // 2:00 PM EDT — "today"
  });
  try {
    const context = await getBrowserContext(server);
    for (const stamp of ['2026-07-29T09:30', '2026-07-28T11:05']) {
      const resp = await server.request('/forms/gym-session-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
        body: nativeBody(context.token, {
          'session-date': stamp,
          'session-date__offset': '-240',
          'session-date__timezone': 'America/New_York',
        }),
      });
      assert.equal(resp.status, 303);
    }
    const records = await Promise.all((await submissionFiles(fixture.submissionsPath)).map(async (fileName) => (
      JSON.parse(await fs.readFile(path.join(fixture.submissionsPath, fileName), 'utf8'))
    )));
    const yesterday = records.find((record) => record.eventAt.startsWith('2026-07-28'));

    // Receipt: captured datetime renders humanized, never as a raw ISO text node.
    const receipt = await server.request(`/forms/gym-session-entry/receipts/${yesterday.submissionId}`, {
      headers: { Cookie: context.cookie },
    });
    assert.equal(receipt.status, 200);
    const receiptHtml = await receipt.text();
    assert.match(receiptHtml, /Jul 28, 2026, 11:05 AM/);
    assert.doesNotMatch(receiptHtml, />2026-07-28T11:05/);

    // Form-page recent panel: yesterday's row day-prefixed, today's row stays a bare time.
    const formPage = await (await server.request('/forms/gym-session-entry', {
      headers: { Cookie: context.cookie },
    })).text();
    assert.match(formPage, /Jul 28 · 11:05 AM/);
    assert.doesNotMatch(formPage, /Jul 29 · 9:30 AM/);
    assert.match(formPage, />9:30 AM</);

    // Entries page groups by day already — rows there must NOT gain the prefix.
    const entriesPage = await (await server.request('/forms/gym-session-entry/entries', {
      headers: { Cookie: context.cookie },
    })).text();
    assert.doesNotMatch(entriesPage, /Jul 28 · /);
  } finally {
    await cleanup(fixture, server);
  }
});

test('numeric-less forms keep the selection heading and body-sized text metrics (#230)', async () => {
  const fixture = await makeFixture();
  const doseTemplate = {
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'dose-log',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Dose Log',
    fields: [
      {id: 'taken-at', type: 'datetime', label: 'Taken at', required: true},
      {id: 'med', type: 'select', label: 'Meds', required: true, options: [
        {id: 'alpha', label: 'Alpha 100'}, {id: 'beta', label: 'Beta 200'},
      ]},
      {id: 'notes', type: 'long-text', label: 'Notes', required: false},
    ],
  };
  await fs.writeFile(path.join(fixture.templatesPath, 'dose-log.yaml'), yaml.dump(doseTemplate), 'utf8');
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const accepted = await server.request('/forms/dose-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: new URLSearchParams({
        _csrf: context.token,
        'taken-at': '2026-07-29T11:05',
        'taken-at__offset': '-240',
        'taken-at__timezone': 'America/New_York',
        med: 'alpha',
      }),
    });
    assert.equal(accepted.status, 303);
    const page = await (await server.request('/forms/dose-log', {headers: {Cookie: context.cookie}})).text();
    const document = new JSDOM(page).window.document;
    const summary = document.querySelector('.entry-row-summary');
    // Heading carries the selection, gym-style.
    assert.equal(summary.querySelector('strong').textContent, 'Alpha 100');
    // The selection is not duplicated into the metrics.
    const metricLabels = [...summary.querySelectorAll('.entry-metric-label')].map((n) => n.textContent);
    assert.ok(!metricLabels.includes('Meds'), 'selection must not repeat as a metric');
    // The datetime metric renders humanized and carries the text-metric class.
    const textMetric = summary.querySelector('.entry-metric-text strong');
    assert.ok(textMetric, 'non-number metrics carry the text class');
    assert.match(textMetric.textContent, /Jul 29, 2026/);
    assert.doesNotMatch(textMetric.textContent, /2026-07-29T/);
  } finally {
    await cleanup(fixture, server);
  }
});

test('form and receipt pages render tag-based related-forms navigation (#234 interim)', async () => {
  const fixture = await makeFixture();
  const sibling = {
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'mobility-log',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Mobility Log',
    tags: ['gym'],
    fields: [{id: 'notes', type: 'long-text', label: 'Notes', required: true}],
  };
  const stranger = { ...sibling, templateId: 'pantry-log', title: 'Pantry Log', tags: ['kitchen'] };
  await fs.writeFile(path.join(fixture.templatesPath, 'mobility-log.yaml'), yaml.dump(sibling), 'utf8');
  await fs.writeFile(path.join(fixture.templatesPath, 'pantry-log.yaml'), yaml.dump(stranger), 'utf8');
  // tag the gym fixture so it participates
  const gymPath = path.join(fixture.templatesPath, 'gym-session-entry.yaml');
  const gym = yaml.load(await fs.readFile(gymPath, 'utf8'), {schema: yaml.JSON_SCHEMA});
  gym.tags = ['gym'];
  await fs.writeFile(gymPath, yaml.dump(gym), 'utf8');
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const page = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    const document = new JSDOM(page).window.document;
    const links = [...document.querySelectorAll('.related-forms .related-form-link')];
    assert.deepEqual(links.map((a) => a.textContent), ['Mobility Log'], 'same-tag sibling only');
    assert.equal(links[0].getAttribute('href'), '/forms/mobility-log');
    // #269: the toolbar jump menu lists every tracker, so scope the exclusion
    // to the related-forms strip — its guarantee, not the whole page's.
    const strip = page.match(/<nav class="related-forms"[\s\S]*?<\/nav>/);
    assert.ok(strip && !strip[0].includes('Pantry Log'), 'unrelated tags stay out of the related strip');

    // receipt carries the same nav
    const accepted = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(accepted.status, 303);
    const receiptPath = accepted.headers.get('location');
    const receipt = await (await server.request(receiptPath, {headers: {Cookie: context.cookie}})).text();
    assert.ok(new JSDOM(receipt).window.document.querySelector('.related-forms .related-form-link'), 'receipt shows related forms');

    // untagged sibling-less form renders no nav block
    const strangerPage = await (await server.request('/forms/pantry-log', {headers: {Cookie: context.cookie}})).text();
    assert.ok(!strangerPage.includes('related-forms-list') || !new JSDOM(strangerPage).window.document.querySelector('.related-form-link'), 'no siblings, no nav');
  } finally {
    await cleanup(fixture, server);
  }
});

test('container forms: lifecycle, page, membership nav, root grouping, guards (#234)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const post = (route, body) => server.request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify(body),
    });
    // create a container through the same template API
    const created = await post('/api/forms/templates', {templateId: 'gym', title: 'Gym', kind: 'container', grammarVersion: 1});
    assert.equal(created.status, 201);
    // bad containerId fails closed
    const bad = await server.request('/api/forms/templates/gym-session-entry', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify({revision: 1, containerId: 'nope'}),
    });
    assert.equal(bad.status, 422);
    // membership via PATCH
    const joined = await server.request('/api/forms/templates/gym-session-entry', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify({revision: 1, containerId: 'gym'}),
    });
    assert.equal(joined.status, 200);

    // container page renders the member; submissions to it are refused
    const page = await (await server.request('/forms/gym', {headers: {Cookie: context.cookie}})).text();
    assert.match(page, /container-member-title/);
    assert.match(page, /gym-session-entry/);
    // #343: member rows expand to a REAL entry form — live fields, csrf, submit
    assert.match(page, /container-member-quick/);
    assert.match(page, /quick-gym-session-entry-lift/);
    assert.doesNotMatch(page, /fieldset disabled class="container-form-preview"/);
    assert.match(page, /container-member-open/);
    const submit = await server.request('/forms/gym', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(submit.status, 404);

    // #345: /forms/entries resolves as root history, not a template lookup
    const rootHistory = await server.request('/forms/entries', {headers: {Cookie: context.cookie}});
    assert.equal(rootHistory.status, 200, 'root history must not be eaten by :templateId');

    // #343: quick entry from the listing actually WORKS — scrape the row form, submit
    const listing = await (await server.request('/forms/gym', {headers: {Cookie: context.cookie}})).text();
    const {JSDOM: QuickDOM} = require('jsdom');
    const quickDom = new QuickDOM(listing);
    const quickForm = quickDom.window.document.querySelector('.container-member-quick');
    const quickValues = new URLSearchParams();
    for (const control of quickForm.querySelectorAll('input, select, textarea')) {
      if (!control.name || (control.type === 'checkbox' && !control.checked)) continue;
      quickValues.append(control.name, control.value);
    }
    quickValues.set('lift', 'bench');
    quickValues.set('top-weight', '135');
    quickValues.set('top-reps', '8');
    quickValues.set('rpe', '7');
    quickValues.set('notes', 'Quick entry from the listing');
    if (!quickValues.get('session-date')) quickValues.set('session-date', '2026-07-21T10:00');
    const quickSubmit = await server.request(quickForm.getAttribute('action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: quickValues.toString(),
    });
    assert.equal(quickSubmit.status, 303, 'quick entry must submit to a receipt');
    assert.match(quickSubmit.headers.get('location'), /receipts/);

    // #248: the container dashboard — a member entry surfaces on the container
    // page's recent list (chipped by form) and on the aggregated history page.
    const logged = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.ok(logged.status === 200 || logged.status === 303, `submit status ${logged.status}`);
    // #293: the group page carries no recent-entries aside — History owns it
    const dashboard = await (await server.request('/forms/gym', {headers: {Cookie: context.cookie}})).text();
    assert.doesNotMatch(dashboard, /recent-entries/);
    const history = await server.request('/forms/gym/entries', {headers: {Cookie: context.cookie}});
    assert.equal(history.status, 200);
    const historyPage = await history.text();
    assert.match(historyPage, /entries-day/);
    assert.match(historyPage, /entry-form-chip/);

    // member form carries the back-to-container button
    const member = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    // #345: the strip is purely lateral — no group back-link (the bar goes home)
    assert.doesNotMatch(member, /related-container-link/);

    // #335: the root renders group sections through the shared nested listing
    const root = await (await server.request('/forms', {headers: {Cookie: context.cookie}})).text();
    assert.match(root, /forms-index-container-head/);
    assert.match(root, /1 tracker</);
    assert.match(root, /container-member-row/);
    // member titles are direct entry links inside the container page
    const containerPage = await (await server.request('/forms/gym', {headers: {Cookie: context.cookie}})).text();
    assert.match(containerPage, /<a class="container-member-title" href="\/forms\/gym-session-entry"/);
    assert.match(containerPage, /container-member-configure/);
    // #285: hierarchy lives in the bars — a group's bar leads with Groups; no dropdown
    assert.match(containerPage, /groups-link" href="\/forms">← Trackers</);
    assert.doesNotMatch(containerPage, /data-group-menu/);
    assert.match(containerPage, /toolbar-properties/);
    assert.match(containerPage, /<dt>Group<\/dt>|Group<\/dt>/);
    const exclusives = (containerPage.match(/name="lookie-toolbar"/g) || []).length;
    assert.ok(exclusives >= 3, `expected >=3 exclusive toolbar disclosures, got ${exclusives}`);
    // #284/#285: a tracker's bar leads with the way up to its group
    const memberToolbar = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.match(memberToolbar, /up-link" href="\/forms">← Trackers</);
    // #273: the ancestor path is gone — the heading is title-only; the toolbar navigates
    assert.match(containerPage, /<nav class="breadcrumbs"><h1 class="crumb-title">/);
    assert.doesNotMatch(containerPage, /breadcrumbs"><a href="\/forms">Trackers/);
    const memberPage = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.doesNotMatch(memberPage, /<span class="sep">/);

    // container Configure: member checkboxes; unchecking releases membership
    const configure = await (await server.request('/forms/gym/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(configure, /container-member-choice/);
    assert.match(configure, /checked/);
    const gymRev = JSON.parse(await (await server.request('/api/forms/templates/gym')).text()).template.revision;
    const saved = await server.request('/forms/gym/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: new URLSearchParams({_csrf: context.token, revision: String(gymRev), title: 'Gym'}),
    });
    assert.equal(saved.status, 200);
    const released = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text());
    assert.equal(released.template.containerId, undefined);
  } finally {
    await cleanup(fixture, server);
  }
});

test('parent/sub-form inheritance: resolution, overrides, live edits, detach, guards (#245)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const jsonHeaders = { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token };
    const post = (route, body) => server.request(route, {method: 'POST', headers: jsonHeaders, body: JSON.stringify(body)});
    const patch = (route, body) => server.request(route, {method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body)});

    // child of the fixture form: one override (lift narrowed + default) + one extra
    const created = await post('/api/forms/templates', {
      templateId: 'bench-day', title: 'Bench day', grammarVersion: 1, destinationId: 'default',
      parentId: 'gym-session-entry',
      fields: [
        {id: 'lift', type: 'select', label: 'Lift', required: true, default: 'bench', options: [{id: 'bench', label: 'Bench press'}]},
        {id: 'spotter', type: 'short-text', label: 'Spotter', required: false},
      ],
    });
    assert.equal(created.status, 201);
    await post('/api/forms/templates/bench-day/publish', {revision: 1});

    // resolved serving: parent fields present, override in the parent's position,
    // extra appended; the draft keeps only the child's OWN fields.
    const got = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.equal(got.template.parentId, 'gym-session-entry');
    assert.equal(got.template.fields.length, 2);
    const ids = got.resolvedFields.map((field) => field.id);
    assert.ok(ids.includes('session-date') && ids.includes('notes'), `inherited fields missing: ${ids}`);
    assert.equal(ids.indexOf('lift'), JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.fields.map((f) => f.id).indexOf('lift'));
    assert.equal(ids.at(-1), 'spotter');
    assert.equal(got.resolvedFields.find((field) => field.id === 'lift').options.length, 1);
    assert.match(String(got.resolvedSchemaDigest), /./);
    const digestBefore = got.resolvedSchemaDigest;

    // the child form page renders inherited fields and accepts a submission
    const page = await (await server.request('/forms/bench-day', {headers: {Cookie: context.cookie}})).text();
    assert.match(page, /Session date|session-date/);
    assert.match(page, /Spotter/);
    // #321: the pinned single-option select stamps instead of asking
    assert.match(page, /field-pinned/);
    assert.match(page, /type="hidden" name="lift" value="bench"/);
    const submitted = await server.request('/forms/bench-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token, {spotter: 'Sam'}),
    });
    assert.equal(submitted.status, 303);

    // live inheritance: revise the parent, the child's resolved schema follows
    const parentRev = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    const parentFields = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.fields;
    const grown = await patch('/api/forms/templates/gym-session-entry', {
      revision: parentRev,
      fields: [...parentFields, {id: 'warmup-done', type: 'checkbox', label: 'Warmed up', required: false}],
    });
    assert.equal(grown.status, 200);
    const after = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.ok(after.resolvedFields.some((field) => field.id === 'warmup-done'), 'child did not inherit the new parent field');
    assert.notEqual(after.resolvedSchemaDigest, digestBefore);

    // guards: nesting refused; archiving a parent with children refused
    const nested = await post('/api/forms/templates', {templateId: 'nested-kid', title: 'Nested', grammarVersion: 1, parentId: 'bench-day', fields: []});
    assert.equal(nested.status, 422);
    const benchRevForArchive = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    const archived = await post('/api/forms/templates/gym-session-entry/archive', {revision: benchRevForArchive});
    assert.ok(archived.status === 422 || archived.status === 409, `parent archive not refused: ${archived.status}`);

    // #307: a child's Configure shows the inherited schema read-only
    const childConfigure = await (await server.request('/forms/bench-day/configure', {headers: {Cookie: context.cookie}})).text();
    // #324: the unified fields table — serving order, source column, theme rows
    assert.match(childConfigure, /fields-table/);
    assert.match(childConfigure, /fields-table-head/);
    assert.match(childConfigure, /Warmed up/);
    assert.match(childConfigure, /field-source">Gym Session Entry</);
    assert.match(childConfigure, /field-source">this tracker</);
    assert.match(childConfigure, /drag-handle/);
    assert.match(childConfigure, /fields-table-theme/);
    assert.match(childConfigure, /field-source">inherited from Gym Session Entry<|field-source">viewer choice</);
    // #310: the own override field says so
    assert.match(childConfigure, /builder-override-marker">Overrides inherited</);
    assert.match(childConfigure, /Entry storage/);

    // #307: cloning a child keeps its parent (and thus the full resolved schema)
    const cloneResp = await post('/api/forms/templates/bench-day/clone', {});
    assert.equal(cloneResp.status, 201, await cloneResp.text());
    const cloneId = JSON.parse(await cloneResp.text()).template.templateId;
    const clonedGet = JSON.parse(await (await server.request(`/api/forms/templates/${cloneId}`)).text());
    assert.equal(clonedGet.template.parentId, 'gym-session-entry');
    assert.ok(clonedGet.resolvedFields.some((field) => field.id === 'warmup-done'), 'clone lost the inherited fields');

    // #313: exclude an inherited field on THIS child only (API), serving honors it
    const exRev = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/bench-day', {revision: exRev, inherit: {exclude: ['notes']}})).status, 200);
    const excluded = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.ok(!excluded.resolvedFields.some((field) => field.id === 'notes'), 'excluded field still serving');
    assert.ok(excluded.resolvedFields.some((field) => field.id === 'warmup-done'), 'other inherited fields must survive');
    const exPage = await (await server.request('/forms/bench-day', {headers: {Cookie: context.cookie}})).text();
    assert.doesNotMatch(exPage, /name="notes"/);
    // configure shows it unchecked; GUI one-tap override copies a parent field down
    const exConfigure = await (await server.request('/forms/bench-day/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(exConfigure, /name="inheritInclude" value="notes"(?! checked)/);
    assert.match(exConfigure, /off · long-text/);
    assert.match(exConfigure, /name="inheritInclude" value="warmup-done" checked/);
    assert.match(exConfigure, /inherit-copy:warmup-done/);
    assert.doesNotMatch(exConfigure, /inherit-override:|inherit-clone:/);
    // rows with a local copy render as the editable field (source: this tracker)
    assert.doesNotMatch(exConfigure, /name="inheritInclude" value="lift"/);

    // #319: the one-checkbox flow via the GUI save endpoint —
    // uncheck an inherited field -> an editable copy appears (override)
    const {JSDOM: JSDOM319} = require('jsdom');
    const guiSave = async (mutate) => {
      const pageHtml = await (await server.request('/forms/bench-day/configure', {headers: {Cookie: context.cookie}})).text();
      const dom = new JSDOM319(pageHtml);
      const form = dom.window.document.querySelector('.builder-form');
      const values = new URLSearchParams();
      for (const control of form.querySelectorAll('input, select, textarea')) {
        if (!control.name || control.disabled) continue;
        if (control.type === 'checkbox' && !control.checked) continue;
        values.append(control.name, control.value);
      }
      values.set('_action', 'save');
      mutate(values);
      return server.request('/forms/bench-day/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
        body: values.toString(),
      });
    };
    // #322: uncheck = OFF (no copy materializes)
    let saveResp = await guiSave((values) => {
      const keep = values.getAll('inheritInclude').filter((id) => id !== 'warmup-done');
      values.delete('inheritInclude');
      for (const id of keep) values.append('inheritInclude', id);
    });
    assert.equal(saveResp.status, 200);
    let draftNow = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.ok(!draftNow.fields.some((field) => field.id === 'warmup-done'), 'uncheck must NOT create a copy');
    assert.ok((draftNow.inherit.exclude || []).includes('warmup-done'), 'uncheck must exclude');
    // re-check = back on
    saveResp = await guiSave((values) => values.append('inheritInclude', 'warmup-done'));
    assert.equal(saveResp.status, 200);
    draftNow = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.ok(!((draftNow.inherit && draftNow.inherit.exclude) || []).includes('warmup-done'), 're-check must clear the exclusion');
    // Copy to this tracker = same-id local copy
    saveResp = await guiSave((values) => values.set('_action', 'inherit-copy:warmup-done'));
    assert.equal(saveResp.status, 200);
    draftNow = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.ok(draftNow.fields.some((field) => field.id === 'warmup-done'), 'copy must create the same-id local field');
    // removing the copy resumes inheritance (isDestroyed converts to deletion)
    saveResp = await guiSave((values) => values.set('field.' + draftNow.fields.findIndex((field) => field.id === 'warmup-done') + '.isDestroyed', 'true'));
    assert.equal(saveResp.status, 200);
    draftNow = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.ok(!draftNow.fields.some((field) => field.id === 'warmup-done'), 'removing the copy must resume inheritance');
    // #313: theme inheritance — parent presentation flows to a themeless child page
    const pRev = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/gym-session-entry', {revision: pRev, presentation: {theme: 'nord', themeMode: 'dark'}})).status, 200);
    const themedChild = await (await server.request('/forms/bench-day', {headers: {Cookie: context.cookie}})).text();
    assert.match(themedChild, /nord/);

    // #307: cloning a container yields a container
    assert.equal((await post('/api/forms/templates', {templateId: 'hub', title: 'Hub', kind: 'container', grammarVersion: 1})).status, 201);
    const hubClone = await post('/api/forms/templates/hub/clone', {});
    assert.equal(hubClone.status, 201);
    assert.equal(JSON.parse(await hubClone.text()).template.kind, 'container');

    // #324: reorder — API order patch, then a GUI move, both reflected in serving order
    const ordRev = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/bench-day', {revision: ordRev, inherit: {exclude: ['notes'], order: ['spotter', 'lift']}})).status, 200);
    let ordered = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.equal(ordered.resolvedFields.filter((f) => !f.isDestroyed)[0].id, 'spotter');
    assert.equal(ordered.resolvedFields.filter((f) => !f.isDestroyed)[1].id, 'lift');
    // #332: arrows retired — order changes arrive as a dragged resolvedOrder
    const moveSave = await guiSave((values) => values.set('resolvedOrder', 'warmup-done spotter lift'));
    assert.equal(moveSave.status, 200);
    ordered = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.equal(ordered.template.inherit.order[0], 'warmup-done');
    assert.ok((ordered.template.inherit.exclude || []).includes('notes'), 'drag must preserve exclusions');

    // #326: theme rows in the inherit idiom — parent nord/dark shows as effective
    // text with Set locally; the action materializes it as a local value
    const themedConfigure = await (await server.request('/forms/bench-day/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(themedConfigure, /theme-effective">Nord<|theme-effective">nord</);
    assert.match(themedConfigure, /value="theme-local"/);
    assert.match(themedConfigure, /inherited from Gym Session Entry/);
    const localizeResp = await guiSave((values) => { values.set('_action', 'theme-local'); values.delete('theme'); });
    assert.equal(localizeResp.status, 200);
    const localized = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.equal(localized.presentation && localized.presentation.theme, 'nord', 'Set locally must materialize the effective theme');

    // #327: the DnD input exists; posting a full resolvedOrder applies it
    const dndConfigure = await (await server.request('/forms/bench-day/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(dndConfigure, /resolved-order-input/);
    assert.match(dndConfigure, /drag-handle/);
    assert.doesNotMatch(dndConfigure, /resolved-up:/);
    const dndSave = await guiSave((values) => values.set('resolvedOrder', 'warmup-done spotter lift'));
    assert.equal(dndSave.status, 200);
    const dndOrdered = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text());
    assert.deepEqual(dndOrdered.template.inherit.order.slice(0, 3), ['warmup-done', 'spotter', 'lift']);
    assert.ok((dndOrdered.template.inherit.exclude || []).includes('notes'), 'drag order must preserve exclusions');

    // #337: the version viewer — Published is a dropdown; ?version renders read-only
    const viewer = await (await server.request('/forms/bench-day/configure?version=1', {headers: {Cookie: context.cookie}})).text();
    assert.match(viewer, /version-select-form/);
    assert.match(viewer, /Viewing Version 1 — read-only/);
    assert.match(viewer, /Current draft/);
    assert.doesNotMatch(viewer, /from r[0-9]/);
    assert.match(viewer, /fieldset disabled class="version-view"/);
    assert.match(viewer, /Restore to draft/);
    // publish/save sit inside the disabled fieldset while viewing; lifecycle hides
    assert.doesNotMatch(viewer, /configure-lifecycle/);

    // #347: three kinds — the emergent parent's page is its children, not a form
    const parentPage = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.match(parentPage, /Defines 2 trackers/);
    assert.match(parentPage, /container-member-title" href="\/forms\/bench-day"/);
    assert.doesNotMatch(parentPage, /name="_supersedes"|form-primary-action" type="submit">Submit/);
    // new entries into an emergent parent are refused; corrections still land
    const refuse = await server.request('/forms/gym-session-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: nativeBody(context.token),
    });
    assert.equal(refuse.status, 404, 'parent with children must refuse new entries');
    // born parent: kind parent from creation — never logs, no destination
    const born = await post('/api/forms/templates', {templateId: 'measurements', title: 'Measurements', grammarVersion: 1, kind: 'parent',
      fields: [{id: 'value', type: 'number', label: 'Value', required: true}]});
    assert.equal(born.status, 201);
    const bornBad = await post('/api/forms/templates', {templateId: 'bad-parent', title: 'Bad', grammarVersion: 1, kind: 'parent', destinationId: 'default',
      fields: [{id: 'value', type: 'number', label: 'Value', required: true}]});
    assert.equal(bornBad.status, 422, 'parents must not carry entry storage');
    const bornPage = await (await server.request('/forms/measurements', {headers: {Cookie: context.cookie}})).text();
    assert.match(bornPage, /Defines 0 trackers/);
    // #347: groups get the version paradigm — Showing select + read-only viewer
    assert.equal((await post('/api/forms/templates/vgroup', {})).status >= 400, true);
    await post('/api/forms/templates', {templateId: 'vgroup', title: 'VGroup', grammarVersion: 1, kind: 'container'});
    await post('/api/forms/templates/vgroup/publish', {revision: 1});
    const groupConfigure = await (await server.request('/forms/vgroup/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(groupConfigure, /version-showing/);
    assert.match(groupConfigure, /Current draft/);
    const groupViewer = await (await server.request('/forms/vgroup/configure?version=1', {headers: {Cookie: context.cookie}})).text();
    assert.match(groupViewer, /Viewing Version 1 — read-only/);
    assert.match(groupViewer, /fieldset disabled class="version-view"/);

    // detach materializes the resolved fields onto the child
    const childRev = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template.revision;
    const detached = await patch('/api/forms/templates/bench-day', {revision: childRev, parentId: null});
    assert.equal(detached.status, 200);
    assert.equal(detached.headers.get('content-type').includes('json'), true);
    const solo = JSON.parse(await (await server.request('/api/forms/templates/bench-day')).text()).template;
    assert.equal(solo.parentId, undefined);
    assert.ok(solo.fields.some((field) => field.id === 'warmup-done'), 'detach did not materialize inherited fields');
    assert.ok(solo.fields.some((field) => field.id === 'spotter'));
  } finally {
    await cleanup(fixture, server);
  }
});

test('creation follows containment: slug-derived IDs and group-joined trackers (#279)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const post = (body) => server.request('/forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: new URLSearchParams(body),
    });
    // group via the GUI, no ID typed — slug derives from the name
    const group = await post({_csrf: context.token, title: 'Gym & Fitness!', kind: 'container'});
    assert.equal(group.status, 303);
    assert.match(group.headers.get('location'), /^\/forms\/gym-fitness\/configure$/);
    // tracker created from inside the group joins it; duplicate name gets a suffix
    const first = await post({_csrf: context.token, title: 'Rowing', destinationId: 'default', group: 'gym-fitness'});
    assert.equal(first.status, 303);
    const second = await post({_csrf: context.token, title: 'Rowing', destinationId: 'default', group: 'gym-fitness'});
    assert.equal(second.status, 303);
    assert.match(second.headers.get('location'), /^\/forms\/rowing-2\/configure$/);
    const rowing = JSON.parse(await (await server.request('/api/forms/templates/rowing')).text()).template;
    assert.equal(rowing.containerId, 'gym-fitness');
    // group page carries the New tracker action, preset to the group
    const groupPage = await (await server.request('/forms/gym-fitness', {headers: {Cookie: context.cookie}})).text();
    assert.match(groupPage, /href="\/forms\/new\?group=gym-fitness"/);
    // #317: create-from-group presets the group's majority cabinet, behind Advanced
    const advCreate = await (await server.request('/forms/new?group=gym-fitness', {headers: {Cookie: context.cookie}})).text();
    assert.match(advCreate, /builder-advanced/);
    assert.match(advCreate, /<option value="default" selected>/);
    // the create page shows the joining note AND the group's bar persists (#281)
    const createPage = await (await server.request('/forms/new?group=gym-fitness', {headers: {Cookie: context.cookie}})).text();
    assert.match(createPage, /Joining group/);
    assert.match(createPage, /Gym &amp; Fitness!/);
    assert.match(createPage, /href="\/forms\/gym-fitness\/entries"/);
    assert.match(createPage, /Joining group/);
    assert.match(createPage, /groups-link" href="\/forms">← Trackers</);
    // #293: archive a group member — it lists on the GROUP page, not the root
    const rowing2 = JSON.parse(await (await server.request('/api/forms/templates/rowing-2')).text()).template;
    const archivedResp = await server.request('/api/forms/templates/rowing-2/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify({revision: rowing2.revision}),
    });
    assert.equal(archivedResp.status, 200);
    // #335: ONE archive — the root holds it (restore + delete); group pages don't
    const groupWithArchived = await (await server.request('/forms/gym-fitness', {headers: {Cookie: context.cookie}})).text();
    assert.doesNotMatch(groupWithArchived, /archived-member-row/);
    const rootAfterArchive = await (await server.request('/forms', {headers: {Cookie: context.cookie}})).text();
    assert.match(rootAfterArchive, /rowing-2\/restore/);
    assert.match(rootAfterArchive, /rowing-2\/delete/);

    // the root create page carries the Browse escape
    const rootCreate = await (await server.request('/forms/new?kind=container', {headers: {Cookie: context.cookie}})).text();
    // #365: the unscoped create page carries the ROOT bar, with New group lit.
    assert.match(rootCreate, /view-link" href="\/forms">Trackers</);
    assert.match(rootCreate, /newgroup-link" href="\/forms\/new\?kind=container" aria-current="page">New group</);
  } finally {
    await cleanup(fixture, server);
  }
});

test('related-strip config: all-in-group default, cross-group picks, API roundtrip (#300)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const jsonHeaders = { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token };
    const post = (route, body) => server.request(route, {method: 'POST', headers: jsonHeaders, body: JSON.stringify(body)});
    const patch = (route, body) => server.request(route, {method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body)});

    // a group with two members, plus an ungrouped weight tracker
    assert.equal((await post('/api/forms/templates', {templateId: 'gym', title: 'Gym', kind: 'container', grammarVersion: 1})).status, 201);
    assert.equal((await post('/api/forms/templates', {templateId: 'cardio', title: 'Cardio', grammarVersion: 1, destinationId: 'default', containerId: 'gym',
      fields: [{id: 'minutes', type: 'number', label: 'Minutes', required: true}]})).status, 201);
    assert.equal((await patch('/api/forms/templates/gym-session-entry', {revision: 1, containerId: 'gym'})).status, 200);
    assert.equal((await post('/api/forms/templates', {templateId: 'weight', title: 'Weight', grammarVersion: 1, destinationId: 'default',
      fields: [{id: 'lbs', type: 'number', label: 'Pounds', required: true}]})).status, 201);

    // default: the whole group rides the strip
    let page = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.match(page, /related-form-link" href="\/forms\/cardio"/);
    assert.doesNotMatch(page, /related-form-link" href="\/forms\/weight"/);

    // API: add a cross-group pick — survives PATCH and publish
    const rev = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    const patched = await patch('/api/forms/templates/gym-session-entry', {revision: rev, related: {group: true, include: ['weight']}});
    assert.equal(patched.status, 200);
    const pub = await post('/api/forms/templates/gym-session-entry/publish', {revision: patched.status === 200 ? JSON.parse(await patched.text()).template.revision : 0});
    assert.equal(pub.status, 201);
    assert.deepEqual(JSON.parse(await pub.text()).version.related, {group: true, include: ['weight']});
    page = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.match(page, /related-form-link" href="\/forms\/cardio"/);
    assert.match(page, /related-form-link" href="\/forms\/weight"/);

    // group:false narrows the strip to the picks (back-to-group link survives)
    const rev2 = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/gym-session-entry', {revision: rev2, related: {group: false, include: ['weight']}})).status, 200);
    page = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.doesNotMatch(page, /related-form-link" href="\/forms\/cardio"/);
    assert.match(page, /related-form-link" href="\/forms\/weight"/);
    assert.doesNotMatch(page, /related-container-link/);

    // configure carries the compact disclosure; bad include ids are refused
    const configure = await (await server.request('/forms/gym-session-entry/configure', {headers: {Cookie: context.cookie}})).text();
    assert.match(configure, /builder-related/);
    assert.match(configure, /name="relatedAll"/);
    assert.match(configure, /name="related" value="weight" checked/);
    // #302: group rows are checkable (another group's id includes it whole, live)
    assert.match(configure, /related-group-box/);

    // #302: the GUI save path — scrape the real builder form, tick a box, save
    const {JSDOM} = require('jsdom');
    const guiPage = await (await server.request('/forms/gym-session-entry/configure', {headers: {Cookie: context.cookie}})).text();
    const dom = new JSDOM(guiPage);
    const builderForm = dom.window.document.querySelector('.builder-form');
    const guiValues = new URLSearchParams();
    for (const control of builderForm.querySelectorAll('input, select, textarea')) {
      if (!control.name || control.disabled) continue;
      if (control.type === 'checkbox' && !control.checked) continue;
      guiValues.append(control.name, control.value);
    }
    guiValues.set('_action', 'save');
    const guiSave = await server.request('/forms/gym-session-entry/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: context.cookie, Origin: PUBLIC_ORIGIN },
      body: guiValues.toString(),
    });
    assert.equal(guiSave.status, 200, (await guiSave.text()).slice(0, 300));
    const afterGui = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template;
    assert.deepEqual(afterGui.related, {group: false, include: ['weight']}, 'GUI save must preserve the related config');
    const rev3 = JSON.parse(await (await server.request('/api/forms/templates/gym-session-entry')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/gym-session-entry', {revision: rev3, related: {include: ['NOT AN ID']}})).status, 422);
  } finally {
    await cleanup(fixture, server);
  }
});

test('tracker listings that are indexes sort by title (#357, #358)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const jsonHeaders = { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token };
    const post = (route, body) => server.request(route, {method: 'POST', headers: jsonHeaders, body: JSON.stringify(body)});
    const patch = (route, body) => server.request(route, {method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body)});
    const titles = (html, selector) => [...new JSDOM(html).window.document.querySelectorAll(selector)].map((node) => node.textContent);

    assert.equal((await post('/api/forms/templates', {templateId: 'gym', title: 'Gym', kind: 'container', grammarVersion: 1})).status, 201);
    // The parent, plus children registered deliberately out of alphabetical order.
    assert.equal((await patch('/api/forms/templates/gym-session-entry', {revision: 1, containerId: 'gym'})).status, 200);
    for (const [templateId, title] of [['zeta', 'Zeta Machine'], ['alpha', 'Alpha Machine'], ['mid', 'Mid Machine']]) {
      assert.equal((await post('/api/forms/templates', {
        templateId, title, grammarVersion: 1, destinationId: 'default', containerId: 'gym',
        parentId: 'gym-session-entry', fields: [],
      })).status, 201, `create ${templateId}`);
    }
    // A standalone member the group pins first — the curated order, last alphabetically.
    const zuluCreate = await post('/api/forms/templates', {templateId: 'zulu', title: 'Zulu Standalone', grammarVersion: 1,
      destinationId: 'default', containerId: 'gym', fields: [{id: 'n', type: 'number', label: 'N', required: false}]});
    assert.equal(zuluCreate.status, 201, await zuluCreate.text());
    const gymRev = JSON.parse(await (await server.request('/api/forms/templates/gym')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/gym', {revision: gymRev, memberOrder: ['zulu']})).status, 200);

    // #358: the parent's page lists its children alphabetically, not in registry order.
    const parentPage = await (await server.request('/forms/gym-session-entry', {headers: {Cookie: context.cookie}})).text();
    assert.deepEqual(
      titles(parentPage, '.container-members .container-member-title'),
      ['Alpha Machine', 'Mid Machine', 'Zeta Machine'],
      'parent page children sort by title'
    );

    // #357: the strip is one alphabetical run — memberOrder does not pin it.
    const childPage = await (await server.request('/forms/alpha', {headers: {Cookie: context.cookie}})).text();
    const strip = titles(childPage, '.related-forms .related-form-link');
    assert.deepEqual(strip, [...strip].sort((a, b) => a.localeCompare(b)), 'strip is alphabetical');
    assert.equal(strip[strip.length - 1], 'Zulu Standalone',
      'the memberOrder-pinned member sorts to its alphabetical place, not the front');

    // The group hub keeps its curated memberOrder — there the order IS the sequence.
    const groupPage = await (await server.request('/forms/gym', {headers: {Cookie: context.cookie}})).text();
    assert.equal(titles(groupPage, '.container-members .container-member-title')[0], 'Zulu Standalone',
      'group hub still leads with the pinned member');

    // Cross-group includes join the same single alphabetical run.
    assert.equal((await post('/api/forms/templates', {templateId: 'beta-solo', title: 'Beta Solo', grammarVersion: 1,
      destinationId: 'default', fields: [{id: 'n', type: 'number', label: 'N', required: false}]})).status, 201);
    const alphaRev = JSON.parse(await (await server.request('/api/forms/templates/alpha')).text()).template.revision;
    assert.equal((await patch('/api/forms/templates/alpha', {revision: alphaRev, related: {group: true, include: ['beta-solo']}})).status, 200);
    const withInclude = titles(await (await server.request('/forms/alpha', {headers: {Cookie: context.cookie}})).text(),
      '.related-forms .related-form-link');
    assert.deepEqual(withInclude, [...withInclude].sort((a, b) => a.localeCompare(b)),
      'an included cross-group pick sorts in, not appended after the group');
    assert.ok(withInclude.includes('Beta Solo'));
  } finally {
    await cleanup(fixture, server);
  }
});

test('the root family shares one bar, with the right item lit (#364, #365)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture, {formsTimezone: 'America/New_York'});
  try {
    const context = await getBrowserContext(server);
    const barOf = (html) => {
      const nav = new JSDOM(html).window.document.querySelector('.form-hub-nav');
      return {
        links: [...nav.querySelectorAll('a')].map((a) => a.textContent),
        current: nav.querySelector('[aria-current="page"]')?.textContent ?? null,
      };
    };
    const get = async (route) => barOf(await (await server.request(route, {headers: {Cookie: context.cookie}})).text());

    const expected = ['Trackers', 'History', 'New tracker', 'New group'];
    const root = await get('/forms');
    const history = await get('/forms/entries');
    const newTracker = await get('/forms/new');
    const newGroup = await get('/forms/new?kind=container');

    // #365: one link set across the whole root family — no page quietly drops items.
    for (const [name, bar] of [['root', root], ['history', history], ['new tracker', newTracker], ['new group', newGroup]]) {
      assert.deepEqual(bar.links, expected, `${name} bar`);
    }
    // ...and each lights its own page. The create pages used to both light New group.
    assert.equal(root.current, 'Trackers');
    assert.equal(history.current, 'History');
    assert.equal(newTracker.current, 'New tracker');
    assert.equal(newGroup.current, 'New group');

    // #364: nothing calls the root "Groups" any more.
    for (const route of ['/forms', '/forms/entries', '/forms/new', '/forms/new?kind=container', '/forms/gym-session-entry']) {
      const html = await (await server.request(route, {headers: {Cookie: context.cookie}})).text();
      assert.doesNotMatch(html, /← Groups/, `${route} must not call the root Groups`);
    }

    // A group's bar leads with the root under its settled name.
    const created = await server.request('/api/forms/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify({templateId: 'gym', title: 'Gym', kind: 'container', grammarVersion: 1}),
    });
    assert.equal(created.status, 201, await created.text());
    const groupBar = await get('/forms/gym');
    assert.equal(groupBar.links[0], '← Trackers');
    // /forms/new?group=<id> still inherits the GROUP's bar, not the root's.
    const scopedCreate = await get('/forms/new?group=gym');
    assert.equal(scopedCreate.links[0], '← Trackers');
    assert.equal(scopedCreate.current, 'New tracker');
    assert.ok(scopedCreate.links.includes('Configure'), 'scoped create keeps the group bar');
  } finally {
    await cleanup(fixture, server);
  }
});

test('canCreate gates the create links on root and history together (#365)', () => {
  // The access model makes a browser principal that can read but not manage
  // awkward to stand up here, so drive the gate directly — it is the same flag
  // on both pages now, which is the property that stops them drifting apart.
  const barLinks = (html) => [...new JSDOM(html).window.document
    .querySelector('.form-hub-nav').querySelectorAll('a')].map((a) => a.textContent);

  for (const canCreate of [true, false]) {
    const root = barLinks(renderFormsIndexPage([], canCreate, '', {}));
    const history = barLinks(renderRootHistoryPage([], '', {canCreate}));
    assert.deepEqual(root, history, `root and history must agree when canCreate=${canCreate}`);
    assert.deepEqual(root, canCreate
      ? ['Trackers', 'History', 'New tracker', 'New group']
      : ['Trackers', 'History'], `canCreate=${canCreate}`);
  }
});

test('the create surface says tracker, never template or form (#367)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    assert.equal((await server.request('/api/forms/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: context.cookie, Origin: PUBLIC_ORIGIN, 'x-csrf-token': context.token },
      body: JSON.stringify({templateId: 'gym', title: 'Gym', kind: 'container', grammarVersion: 1}),
    })).status, 201);

    const visible = (html) => {
      const main = new JSDOM(html).window.document.querySelector('main');
      return main.textContent.replace(/\s+/g, ' ');
    };
    const page = async (route) => visible(await (await server.request(route, {headers: {Cookie: context.cookie}})).text());

    const plain = await page('/forms/new');
    assert.match(plain, /New tracker/);
    assert.match(plain, /Create tracker/);
    assert.match(plain, /Tracker \(logs entries\)/);

    const group = await page('/forms/new?kind=container');
    assert.match(group, /New group/);
    assert.match(group, /Create group/);

    const scoped = await page('/forms/new?group=gym');
    assert.match(scoped, /New tracker/);
    assert.match(scoped, /Create tracker/);

    // The internal words must not reach the surface a person reads.
    for (const [route, text] of [['/forms/new', plain], ['/forms/new?kind=container', group], ['/forms/new?group=gym', scoped]]) {
      assert.doesNotMatch(text, /\btemplate\b/i, `${route} must not say template`);
    }
  } finally {
    await cleanup(fixture, server);
  }
});

test('no user-facing copy carries an internal issue number (#368)', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const context = await getBrowserContext(server);
    // Asserted over the rendered text, not the two known strings, so a third
    // provenance note cannot be added quietly.
    for (const route of ['/forms', '/forms/entries', '/forms/new', '/forms/new?kind=container',
      '/forms/gym-session-entry', '/forms/gym-session-entry/configure', '/forms/gym-session-entry/entries']) {
      const html = await (await server.request(route, {headers: {Cookie: context.cookie}})).text();
      const main = new JSDOM(html).window.document.querySelector('main');
      assert.ok(main, `${route} rendered a main`);
      const leaked = main.textContent.match(/\(#\d+\)/g);
      assert.equal(leaked, null, `${route} leaks ${leaked && leaked.join(', ')}`);
    }
  } finally {
    await cleanup(fixture, server);
  }
});
