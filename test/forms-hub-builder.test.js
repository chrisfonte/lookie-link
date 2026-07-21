'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {Duplex} = require('node:stream');
const {JSDOM} = require('jsdom');

const {createApp} = require('../server');
const {TemplateRegistry} = require('../lib/forms/template-registry');

const ORIGIN = 'http://forms.example.test';

function inject(app, route, init = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({read() {}, write(_chunk, _encoding, callback) { callback(); }});
    socket.remoteAddress = '127.0.0.1';
    const request = new http.IncomingMessage(socket);
    request.method = init.method || 'GET';
    request.url = route;
    request.headers = {host: 'forms.example.test'};
    for (const [name, value] of Object.entries(init.headers || {})) request.headers[name.toLowerCase()] = value;
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(String(init.body));
    if (body.length && request.headers['content-length'] === undefined) request.headers['content-length'] = String(body.length);
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
      const headers = response.getHeaders();
      resolve({
        status: response.statusCode,
        headers: {get(name) {
          const value = headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        }},
        text: async () => Buffer.concat(chunks).toString('utf8'),
      });
    });
    response.on('error', reject);
    request.push(body);
    request.push(null);
    app.handle(request, response, reject);
  });
}

function documentFor(html) {
  return new JSDOM(html).window.document;
}

function formValues(form, action) {
  const values = new URLSearchParams();
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (!control.name || control.disabled || (control.type === 'checkbox' && !control.checked)) continue;
    values.append(control.name, control.value);
  }
  if (action) values.set('_action', action);
  return values;
}

async function browserPage(response) {
  const html = await response.text();
  return {
    html,
    document: documentFor(html),
    cookie: response.headers.get('set-cookie') && response.headers.get('set-cookie').split(';', 1)[0],
  };
}

function browserPost(server, route, body, cookie, headers = {}) {
  return server.request(route, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: body.toString(),
  });
}

async function makeServer({empty = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-hub-builder-'));
  const templatesPath = path.join(root, 'templates');
  const defaultRoot = path.join(root, 'default');
  const gymRoot = path.join(root, 'gym');
  await fs.mkdir(templatesPath);
  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['default', 'gym-log'],
    clock: () => new Date('2026-07-21T12:00:00.000Z'),
    logger: {warn() {}},
  });
  if (!empty) {
    await registry.createDraft({
      contractVersion: 1,
      resourceKind: 'form-template',
      templateId: 'training-log',
      ownerId: 'operator',
      revision: 1,
      grammarVersion: 1,
      destinationId: 'gym-log',
      title: 'Training <log>',
      fields: [
        {
          id: 'lift', type: 'select', label: 'Lift <name>', required: true,
          options: [{id: 'squat', label: 'Squat <heavy>'}, {id: 'bench', label: 'Bench'}],
        },
        {id: 'notes', type: 'long-text', label: 'Notes', required: true},
      ],
    });
  }
  const app = createApp({
    mappings: {},
    formsConfig: {
      enabled: true,
      templatesPath,
      destinations: {default: defaultRoot, 'gym-log': gymRoot},
    },
    formsRegistry: registry,
    formsPublicOrigin: ORIGIN,
    formsAudit: () => {},
    formsAuthorize: ({req, capability}) => capability !== 'forms.manage' || req.get('x-no-manage') !== 'yes',
  });
  return {
    root,
    registry,
    request: (route, init) => inject(app, route, init),
    close: () => fs.rm(root, {recursive: true, force: true}),
  };
}

test('hub navigation and builder lifecycle preserve snapshots, option IDs, CAS, aliases, and escaping', async () => {
  const server = await makeServer();
  try {
    for (const route of ['/forms/training-log', '/forms/training-log/entries', '/forms/training-log/configure']) {
      const response = await server.request(route);
      assert.equal(response.status, 200, route);
      const page = await browserPage(response);
      assert.deepEqual(
        [...page.document.querySelectorAll('.form-hub-nav a')].map((link) => link.textContent),
        ['Log an entry', 'History', 'Configure'],
      );
    }

    const deniedForm = await browserPage(await server.request('/forms/training-log', {headers: {'X-No-Manage': 'yes'}}));
    assert.equal(deniedForm.document.querySelector('.configure-link'), null);
    assert.equal((await server.request('/forms/training-log/configure', {headers: {'X-No-Manage': 'yes'}})).status, 404);

    const formPage = await browserPage(await server.request('/forms/training-log'));
    const submit = new URLSearchParams({
      _csrf: formPage.document.querySelector('input[name="_csrf"]').value,
      lift: 'squat',
      notes: 'Earlier entry',
    });
    const accepted = await browserPost(server, '/forms/training-log', submit, formPage.cookie);
    assert.equal(accepted.status, 303);
    const receiptUrl = accepted.headers.get('location');

    let configure = await browserPage(await server.request('/forms/training-log/configure'));
    assert.doesNotMatch(configure.html, /Training <log>|Lift <name>|Squat <heavy>/);
    assert.match(configure.html, /Training &lt;log&gt;/);
    assert.deepEqual(
      [...configure.document.querySelector('select[name="destinationId"]').options].map((option) => option.value),
      ['default', 'gym-log'],
    );
    const cookie = configure.cookie;

    let editForm = configure.document.querySelector('.builder-form');
    let response = await browserPost(server, '/forms/training-log/configure', formValues(editForm, 'option-add:0'), cookie);
    assert.equal(response.status, 200);
    configure = await browserPage(response);
    editForm = configure.document.querySelector('.builder-form');
    response = await browserPost(server, '/forms/training-log/configure', formValues(editForm, 'field-add'), cookie);
    assert.equal(response.status, 200);
    configure = await browserPage(response);
    editForm = configure.document.querySelector('.builder-form');
    editForm.querySelector('[name="field.0.label"]').value = 'Movement';
    editForm.querySelector('[name="field.0.option.0.label"]').value = 'Back squat';
    editForm.querySelector('[name="field.0.option.2.label"]').value = 'Row';
    editForm.querySelector('[name="field.2.label"]').value = 'Coach note';
    response = await browserPost(server, '/forms/training-log/configure', formValues(editForm, 'save'), cookie);
    assert.equal(response.status, 200);
    configure = await browserPage(response);
    assert.match(configure.document.querySelector('.builder-status').textContent, /Draft saved/);

    const revised = await server.registry.getManagementTemplate('training-log');
    assert.equal(revised.draft.revision, 4);
    assert.equal(revised.draft.fields[0].options[0].id, 'squat');
    assert.equal(revised.draft.fields[0].options[0].label, 'Back squat');
    assert.equal(revised.draft.fields[0].options[2].label, 'Row');
    assert.equal(revised.draft.fields[2].label, 'Coach note');

    const receipt = await browserPage(await server.request(receiptUrl));
    assert.match(receipt.document.body.textContent, /Lift <name>/);
    assert.match(receipt.document.body.textContent, /Squat <heavy>/);
    assert.doesNotMatch(receipt.document.body.textContent, /Back squat/);

    const publishForm = configure.document.querySelector('.builder-publish form');
    response = await browserPost(server, '/forms/training-log/configure/publish', formValues(publishForm), cookie);
    assert.equal(response.status, 200);
    const published = await server.registry.getManagementTemplate('training-log');
    assert.equal(published.publishedVersion.templateVersion, 1);
    assert.equal(published.publishedVersion.sourceRevision, 4);

    const firstEditor = await browserPage(await server.request('/forms/training-log/configure'));
    const secondEditor = await browserPage(await server.request('/forms/training-log/configure'));
    const firstForm = firstEditor.document.querySelector('.builder-form');
    firstForm.querySelector('[name="title"]').value = 'First editor wins';
    response = await browserPost(server, '/forms/training-log/configure', formValues(firstForm, 'save'), firstEditor.cookie);
    assert.equal(response.status, 200);
    const secondForm = secondEditor.document.querySelector('.builder-form');
    secondForm.querySelector('[name="title"]').value = 'Stale overwrite';
    response = await browserPost(server, '/forms/training-log/configure', formValues(secondForm, 'save'), secondEditor.cookie);
    assert.equal(response.status, 409);
    const conflict = await browserPage(response);
    assert.match(conflict.document.querySelector('.builder-conflict').textContent, /changed since you opened it/i);
    assert.equal((await server.registry.getTemplate('training-log')).title, 'First editor wins');

    const maliciousForm = conflict.document.querySelector('.builder-form');
    maliciousForm.querySelector('[name="destinationId"]').value = '../outside';
    const maliciousValues = formValues(maliciousForm, 'save');
    maliciousValues.set('destinationId', '../outside');
    response = await browserPost(server, '/forms/training-log/configure', maliciousValues, secondEditor.cookie);
    assert.equal(response.status, 422);
    const rejected = await browserPage(response);
    assert.match(rejected.document.querySelector('.builder-errors').textContent, /destinationId/);
    assert.deepEqual(
      [...rejected.document.querySelector('select[name="destinationId"]').options].map((option) => option.value),
      ['default', 'gym-log'],
    );
    assert.equal((await server.registry.getTemplate('training-log')).destinationId, 'gym-log');
  } finally {
    await server.close();
  }
});

test('collapsed field rows reorder with CAS and soft-delete identities can only be restored', async () => {
  const server = await makeServer();
  try {
    const formPage = await browserPage(await server.request('/forms/training-log'));
    const submitted = await browserPost(server, '/forms/training-log', new URLSearchParams({
      _csrf: formPage.document.querySelector('input[name="_csrf"]').value,
      lift: 'squat',
      notes: 'Captured before removal',
    }), formPage.cookie);
    assert.equal(submitted.status, 303);
    const receiptHref = submitted.headers.get('location');

    const first = await browserPage(await server.request('/forms/training-log/configure'));
    const rows = [...first.document.querySelectorAll('details.builder-field')];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.open === false));
    rows[0].open = true;
    assert.ok(rows[0].querySelector('[name="field.0.label"]'));
    rows[0].querySelector('[name="field.0.showInList"]').checked = true;

    let response = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(first.document.querySelector('.builder-form'), 'field-down:0'),
      first.cookie,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await server.registry.getTemplate('training-log')).fields.map((field) => field.id), ['notes', 'lift']);
    assert.equal((await server.registry.getTemplate('training-log')).fields[1].showInList, true);
    assert.match((await browserPage(response)).document.querySelectorAll('.builder-list-marker')[0].textContent, /In list/);

    const stale = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(first.document.querySelector('.builder-form'), 'save'),
      first.cookie,
    );
    assert.equal(stale.status, 409);

    let latest = await browserPage(response);
    response = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(latest.document.querySelector('.builder-form'), 'field-remove:1'),
      first.cookie,
    );
    assert.equal(response.status, 200);
    let draft = (await server.registry.getManagementTemplate('training-log')).draft;
    assert.equal(draft.fields[1].id, 'lift');
    assert.equal(draft.fields[1].isDestroyed, true);

    const currentForm = await browserPage(await server.request('/forms/training-log'));
    assert.equal(currentForm.document.querySelector('[name="lift"]'), null);
    assert.ok(currentForm.document.querySelector('[name="notes"]'));
    const entriesWhileRemoved = await browserPage(await server.request('/forms/training-log/entries'));
    assert.doesNotMatch(entriesWhileRemoved.document.querySelector('.entries-card').textContent, /Lift <name>|Squat <heavy>/);
    const oldReceipt = await browserPage(await server.request(receiptHref));
    assert.match(oldReceipt.document.body.textContent, /Lift <name>|Lift/);
    assert.match(oldReceipt.document.body.textContent, /Squat <heavy>|Squat/);

    latest = await browserPage(response);
    assert.equal(latest.document.querySelectorAll('.builder-field-removed').length, 1);
    assert.match(latest.document.querySelector('.builder-field-removed').textContent, /Restore field/);
    await assert.rejects(
      server.registry.reviseDraft('training-log', draft.revision, {fields: draft.fields.filter((field) => field.id !== 'lift')}),
      (error) => error && error.code === 'EVALIDATION',
    );

    response = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(latest.document.querySelector('.builder-form'), 'field-add'),
      first.cookie,
    );
    assert.equal(response.status, 200);
    latest = await browserPage(response);
    const addedId = latest.document.querySelector('[name="field.2.id"]').value;
    assert.notEqual(addedId, 'lift');
    latest.document.querySelector('[name="field.2.id"]').value = 'lift';
    response = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(latest.document.querySelector('.builder-form'), 'save'),
      first.cookie,
    );
    assert.equal(response.status, 200);
    draft = (await server.registry.getManagementTemplate('training-log')).draft;
    assert.equal(draft.fields[2].id, addedId);
    assert.equal(new Set(draft.fields.map((field) => field.id)).size, 3);

    latest = await browserPage(response);
    response = await browserPost(
      server,
      '/forms/training-log/configure',
      formValues(latest.document.querySelector('.builder-form'), 'field-restore:1'),
      first.cookie,
    );
    assert.equal(response.status, 200);
    draft = (await server.registry.getManagementTemplate('training-log')).draft;
    assert.equal(draft.fields[1].id, 'lift');
    assert.equal(draft.fields[1].isDestroyed, undefined);
    assert.ok((await browserPage(await server.request('/forms/training-log'))).document.querySelector('[name="lift"]'));
  } finally {
    await server.close();
  }
});

test('first-run hub offers API-backed creation only to managers and rejects path destinations', async () => {
  const server = await makeServer({empty: true});
  try {
    assert.equal((await server.request('/forms/daily-log', {headers: {'X-No-Manage': 'yes'}})).status, 404);
    let firstRun = await browserPage(await server.request('/forms/daily-log'));
    const cookie = firstRun.cookie;
    assert.match(firstRun.document.querySelector('h1').textContent, /Create your first form/);
    assert.deepEqual(
      [...firstRun.document.querySelector('select[name="destinationId"]').options].map((option) => option.value),
      ['default', 'gym-log'],
    );
    const form = firstRun.document.querySelector('form');
    form.querySelector('[name="title"]').value = 'Daily log';
    let values = formValues(form);
    values.set('destinationId', '../../tmp');
    let response = await browserPost(server, '/forms/daily-log/configure/create', values, cookie);
    assert.equal(response.status, 422);
    assert.equal(await server.registry.getTemplate('daily-log'), null);

    firstRun = await browserPage(response);
    values = formValues(firstRun.document.querySelector('form'));
    values.set('title', 'Daily log');
    values.set('destinationId', 'default');
    response = await browserPost(server, '/forms/daily-log/configure/create', values, cookie);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/forms/daily-log/configure');
    assert.equal((await server.registry.getTemplate('daily-log')).destinationId, 'default');
  } finally {
    await server.close();
  }
});
