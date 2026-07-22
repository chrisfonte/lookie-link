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

test('forms index offers its single API-backed creation path only to managers and rejects path destinations', async () => {
  const server = await makeServer({empty: true});
  try {
    assert.equal((await server.request('/forms/daily-log', {headers: {'X-No-Manage': 'yes'}})).status, 404);
    const deniedIndex = await browserPage(await server.request('/forms', {headers: {'X-No-Manage': 'yes'}}));
    assert.equal(deniedIndex.document.querySelector('a[href="/forms/new"]'), null);
    assert.equal((await server.request('/forms/new', {headers: {'X-No-Manage': 'yes'}})).status, 404);
    const emptyIndex = await browserPage(await server.request('/forms'));
    assert.match(emptyIndex.document.body.textContent, /Create your first template/);
    assert.ok(emptyIndex.document.querySelector('a[href="/forms/new"]'));
    let firstRun = await browserPage(await server.request('/forms/new'));
    const cookie = firstRun.cookie;
    assert.match(firstRun.document.querySelector('h1').textContent, /New template/);
    assert.deepEqual(
      [...firstRun.document.querySelector('select[name="destinationId"]').options].map((option) => option.value),
      ['default', 'gym-log'],
    );
    const form = firstRun.document.querySelector('form');
    form.querySelector('[name="templateId"]').value = 'daily-log';
    form.querySelector('[name="title"]').value = 'Daily log';
    let values = formValues(form);
    values.set('destinationId', '../../tmp');
    let response = await browserPost(server, '/forms', values, cookie);
    assert.equal(response.status, 422);
    assert.equal(await server.registry.getTemplate('daily-log'), null);

    firstRun = await browserPage(response);
    values = formValues(firstRun.document.querySelector('form'));
    values.set('templateId', 'daily-log');
    values.set('title', 'Daily log');
    values.set('destinationId', 'default');
    response = await browserPost(server, '/forms', values, cookie);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/forms/daily-log/configure');
    assert.equal((await server.registry.getTemplate('daily-log')).destinationId, 'default');
  } finally {
    await server.close();
  }
});

test('forms index separates archived templates and removes management detail for submit-only callers', async () => {
  const server = await makeServer();
  try {
    const base = {
      contractVersion: 1,
      resourceKind: 'form-template',
      ownerId: 'operator',
      revision: 1,
      grammarVersion: 1,
      destinationId: 'default',
      fields: [{id: 'entry', type: 'short-text', label: 'Entry', required: true}],
    };
    await server.registry.createDraft({...base, templateId: 'daily-log', title: 'Daily log'});
    await server.registry.createDraft({...base, templateId: 'old-log', title: 'Old log'});
    await server.registry.setArchived('old-log', 1, true);

    const formPage = await browserPage(await server.request('/forms/training-log'));
    const submitted = await browserPost(server, '/forms/training-log', new URLSearchParams({
      _csrf: formPage.document.querySelector('input[name="_csrf"]').value,
      lift: 'bench',
      notes: 'Counted entry',
    }), formPage.cookie);
    assert.equal(submitted.status, 303);

    const managerIndex = await browserPage(await server.request('/forms'));
    assert.equal(managerIndex.document.querySelectorAll('.forms-index-list[aria-label="Active templates"] > .forms-index-item').length, 2);
    assert.ok(managerIndex.document.querySelector('a[href="/forms/new"]'));
    const trainingCard = [...managerIndex.document.querySelectorAll('.forms-index-item')]
      .find((card) => /Training <log>/.test(card.textContent));
    assert.ok(trainingCard);
    assert.match(trainingCard.textContent, /Draft\s*r1/);
    assert.match(trainingCard.textContent, /Destination\s*gym-log/);
    assert.match(trainingCard.textContent, /Entries\s*1/);
    assert.deepEqual(
      [...trainingCard.querySelectorAll('.forms-index-actions a, .forms-index-actions button')].map((node) => node.textContent.trim()),
      ['Open', 'History', 'Configure', 'Clone', 'Archive'],
    );
    const archived = managerIndex.document.querySelector('.forms-index-archived');
    assert.ok(archived);
    assert.equal(archived.open, false);
    assert.match(archived.querySelector('summary').textContent, /Show archived\s*1/);
    assert.match(archived.textContent, /Old log/);

    const submitOnly = await browserPage(await server.request('/forms', {headers: {'X-No-Manage': 'yes'}}));
    assert.equal(submitOnly.document.querySelector('a[href="/forms/new"]'), null);
    assert.equal(submitOnly.document.querySelector('.forms-index-actions'), null);
    assert.equal(submitOnly.document.querySelector('.forms-index-meta'), null);
    assert.equal(submitOnly.document.querySelector('.forms-index-archived'), null);
    assert.deepEqual(
      [...submitOnly.document.querySelectorAll('.forms-index-simple')].map((link) => link.textContent.trim().replace(/›$/, '')),
      ['Daily log', 'Training <log>'],
    );
    assert.doesNotMatch(submitOnly.document.body.textContent, /Old log|Entries|Destination|Configure|Archive/);

    const cloneForm = trainingCard.querySelector('form[action$="/clone"]');
    const clonedResponse = await browserPost(server, cloneForm.getAttribute('action'), formValues(cloneForm), managerIndex.cookie);
    assert.equal(clonedResponse.status, 303);
    assert.match(clonedResponse.headers.get('location'), /^\/forms\/training-log-copy\/configure$/);
    assert.equal((await server.registry.getTemplate('training-log-copy')).revision, 1);
  } finally {
    await server.close();
  }
});

test('builder offers server-installed themes, saves the choice, and refuses one the server does not offer', async () => {
  const {setThemeList} = require('../lib/renderer');
  setThemeList([
    {slug: 'slate', label: 'Slate'},
    {slug: 'planet-fitness', label: 'Planet Fitness'},
    {slug: 'the-bic', label: 'The BIC'},
  ]);

  const server = await makeServer();
  try {
    // A submitLabel set outside the builder must survive a builder save.
    const before = await server.registry.getManagementTemplate('training-log');
    await server.registry.reviseDraft('training-log', before.draft.revision, {
      presentation: {submitLabel: 'Log it'},
    });

    let configure = await browserPage(await server.request('/forms/training-log/configure'));
    const themeSelect = configure.document.querySelector('select[name="theme"]');
    assert.ok(themeSelect, 'builder exposes a theme control');
    assert.deepEqual(
      [...themeSelect.options].map((option) => option.value),
      ['', 'slate', 'planet-fitness', 'the-bic'],
      'options come from the server theme list, plus an explicit no-override choice'
    );
    assert.deepEqual(
      [...configure.document.querySelector('select[name="themeMode"]').options].map((option) => option.value),
      ['', 'dark', 'light']
    );

    const cookie = configure.cookie;
    const values = formValues(configure.document.querySelector('.builder-form'), 'save');
    values.set('theme', 'planet-fitness');
    values.set('themeMode', 'dark');
    const saved = await browserPost(server, '/forms/training-log/configure', values, cookie);
    assert.equal(saved.status, 200);
    assert.match((await browserPage(saved)).document.querySelector('.builder-status').textContent, /Draft saved/);

    const after = await server.registry.getManagementTemplate('training-log');
    assert.equal(after.draft.presentation.theme, 'planet-fitness');
    assert.equal(after.draft.presentation.themeMode, 'dark');
    assert.equal(after.draft.presentation.submitLabel, 'Log it', 'submitLabel survived the save');

    configure = await browserPage(await server.request('/forms/training-log/configure'));
    assert.equal(configure.document.querySelector('select[name="theme"]').value, 'planet-fitness');

    // A slug the server never offered is refused, not silently stored.
    const hostile = formValues(configure.document.querySelector('.builder-form'), 'save');
    hostile.set('theme', 'not-installed');
    const refused = await browserPost(server, '/forms/training-log/configure', hostile, configure.cookie);
    assert.equal(refused.status, 400);
    const unchanged = await server.registry.getManagementTemplate('training-log');
    assert.equal(unchanged.draft.presentation.theme, 'planet-fitness', 'rejected save changed nothing');
  } finally {
    setThemeList(null);
    await server.close();
  }
});

test('toolbar section picker offers Files and Forms and disappears when there is nowhere to choose between', async () => {
  const {setNavLinks, toolbarHtml} = require('../lib/renderer');

  const server = await makeServer();
  try {
    const page = await browserPage(await server.request('/forms/training-log'));
    const picker = page.document.querySelector('[data-nav-picker]');
    assert.ok(picker, 'section picker is present');
    // Same control as the theme picker, so it looks and behaves identically.
    assert.ok(picker.classList.contains('toolbar-select'));
    assert.equal(picker.tagName, 'SELECT');
    assert.deepEqual([...picker.options].map((option) => option.textContent), ['Files', 'Forms']);
    assert.deepEqual([...picker.options].map((option) => option.value), ['/', '/forms']);
    assert.doesNotMatch(page.html, /onchange=/i);
  } finally {
    await server.close();
  }

  // One destination is not a choice, so the control is omitted rather than
  // rendered with a single entry.
  setNavLinks([{href: '/', label: 'Files'}]);
  assert.ok(!toolbarHtml().includes('data-nav-picker'), 'single destination renders no picker');

  setNavLinks([{href: '/', label: 'Files'}, {href: '/forms', label: 'Forms'}]);
  assert.ok(toolbarHtml().includes('data-nav-picker'), 'two destinations render the picker');

  // Malformed entries are dropped rather than emitted as broken options.
  setNavLinks([{href: '/', label: 'Files'}, {label: 'No href'}, {href: '/forms', label: 'Forms'}]);
  assert.doesNotMatch(toolbarHtml(), /No href/);
  setNavLinks([]);
});

test('a form carries its own Properties, reporting facts rather than claims', async () => {
  const {setThemeList} = require('../lib/renderer');
  setThemeList([{slug: 'slate', label: 'Slate'}, {slug: 'planet-fitness', label: 'Planet Fitness'}]);

  const server = await makeServer();
  try {
    const page = await browserPage(await server.request('/forms/training-log'));
    const doc = page.document;
    const panel = doc.querySelector('.toolbar-properties');
    assert.ok(panel, 'a form page exposes Properties in the toolbar');

    const rows = new Map([...panel.querySelectorAll('div')].map((row) => [
      row.querySelector('dt').textContent,
      row.querySelector('dd').textContent,
    ]));
    assert.equal(rows.get('Form'), 'training-log');
    assert.equal(rows.get('Revision'), '1');
    assert.equal(rows.get('Published'), 'not published', 'reports reality, not intent');
    assert.equal(rows.get('Destination'), 'gym-log');
    assert.equal(rows.get('Fields'), '2');
    assert.equal(rows.has('Theme'), false, 'no theme set, so no theme row');
  } finally {
    setThemeList(null);
    await server.close();
  }
});

test('Properties reports a theme only when that theme is actually installed', async () => {
  const {setThemeList} = require('../lib/renderer');
  const server = await makeServer();
  try {
    const before = await server.registry.getManagementTemplate('training-log');
    await server.registry.reviseDraft('training-log', before.draft.revision, {
      presentation: {theme: 'planet-fitness'},
    });

    setThemeList([{slug: 'slate', label: 'Slate'}, {slug: 'planet-fitness', label: 'Planet Fitness'}]);
    let page = await browserPage(await server.request('/forms/training-log'));
    let text = page.document.querySelector('.toolbar-properties').textContent;
    assert.match(text, /planet-fitness/, 'installed theme is reported');

    // The same template on a deployment without that theme: the form does NOT render
    // in it, so Properties must not claim it does.
    setThemeList([{slug: 'slate', label: 'Slate'}]);
    page = await browserPage(await server.request('/forms/training-log'));
    text = page.document.querySelector('.toolbar-properties').textContent;
    assert.doesNotMatch(text, /planet-fitness/, 'uninstalled theme is not reported as applied');
  } finally {
    setThemeList(null);
    await server.close();
  }
});
