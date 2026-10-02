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
const { ListStateStore } = require('../lib/forms/list-state-store');
const { validateTemplate } = require('../lib/forms/schema');

const PUBLIC_ORIGIN = 'http://forms.example.test';
const AGENT_HEADERS = {
  Authorization: 'Bearer list-secret',
  'X-Manage': 'yes',
};

function inject(app, route, init = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
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
        headers: { get: (name) => {
          const value = headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        } },
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

async function makeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-list-'));
  const templatesPath = path.join(root, 'templates');
  await fs.mkdir(templatesPath);
  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['default'],
    logger: { warn() {} },
  });
  const app = createApp({
    mappings: {},
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        listAgent: {
          secret: 'list-secret',
          permissions: { view: true },
          repos: 'all',
          subject: { agentId: 'list-agent' },
        },
      },
    },
    formsConfig: {
      enabled: true,
      templatesPath,
      destinations: { default: path.join(root, 'subs') },
    },
    formsRegistry: registry,
    formsPublicOrigin: PUBLIC_ORIGIN,
    formsAudit: () => {},
    formsAuthorize: ({ req, capability }) => (req.get('x-manage') === 'yes'
      && (capability === 'forms.manage' || capability === 'forms.submit' || capability === 'forms.view'))
      || (req.get('x-submit') === 'yes' && (capability === 'forms.submit' || capability === 'forms.view')),
  });
  return { root, templatesPath, registry, app, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('list kind validates without fields or destination', () => {
  const result = validateTemplate({
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'packing',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Packing',
    kind: 'list',
  });
  assert.equal(result.valid, true);
});

test('list kind rejects fields and destinationId', () => {
  const withFields = validateTemplate({
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'packing',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Packing',
    kind: 'list',
    fields: [{ id: 'entry', type: 'short-text', label: 'Entry', required: true }],
  });
  assert.ok(withFields.errors.some((error) => error.path === 'fields'));
  const withDest = validateTemplate({
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'packing',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Packing',
    kind: 'list',
    destinationId: 'default',
  });
  assert.ok(withDest.errors.some((error) => error.path === 'destinationId'));
});

test('GET list state is read-only virtual revision 0 when absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-list-store-'));
  const templatesPath = path.join(root, 'templates');
  await fs.mkdir(path.join(templatesPath, 'packing'), { recursive: true });
  const store = new ListStateStore({ templatesPath });
  const state = await store.getState('packing');
  assert.equal(state.revision, 0);
  assert.equal(state.persisted, false);
  await assert.rejects(() => fs.access(path.join(templatesPath, 'packing', 'list-state.json')));
  await fs.rm(root, { recursive: true, force: true });
});

test('PUT with revision 0 creates; stale revision conflicts; validate is dry-run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-list-store-'));
  const templatesPath = path.join(root, 'templates');
  await fs.mkdir(path.join(templatesPath, 'packing'), { recursive: true });
  const store = new ListStateStore({
    templatesPath,
    clock: () => new Date('2026-10-02T21:00:00.000Z'),
  });
  const candidate = {
    revision: 0,
    sections: [{ id: 'general', title: 'General' }],
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      text: 'Tent',
      sectionId: 'general',
      checked: false,
      owner: 'Chris',
    }],
  };
  const validated = store.validateCandidate(candidate);
  assert.equal(validated.valid, true);
  await assert.rejects(() => fs.access(path.join(templatesPath, 'packing', 'list-state.json')));

  const created = await store.putState('packing', candidate);
  assert.equal(created.revision, 1);
  assert.equal(created.items[0].owner, 'Chris');
  const onDisk = JSON.parse(await fs.readFile(path.join(templatesPath, 'packing', 'list-state.json'), 'utf8'));
  assert.equal(onDisk.revision, 1);

  await assert.rejects(() => store.putState('packing', candidate), (error) => error.code === 'ESTALE');
  const again = await store.getState('packing');
  assert.equal(again.revision, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('list API: bearer create/read/write, validate, CSRF reject, stale revision, unauthorized', async () => {
  const fixture = await makeServer();
  try {
    const created = await inject(fixture.app, '/api/forms/templates', {
      method: 'POST',
      headers: { ...AGENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'packing-list',
        grammarVersion: 1,
        title: 'Packing list',
        kind: 'list',
      }),
    });
    assert.equal(created.status, 201, await created.text());

    const unread = await inject(fixture.app, '/api/forms/packing-list/list', {
      headers: { Authorization: 'Bearer list-secret' },
    });
    assert.equal(unread.status, 404);

    const empty = await inject(fixture.app, '/api/forms/packing-list/list', {
      headers: { ...AGENT_HEADERS },
    });
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.state.revision, 0);
    assert.equal(emptyBody.state.persisted, false);
    await assert.rejects(() => fs.access(path.join(fixture.templatesPath, 'packing-list', 'list-state.json')));

    const invalid = await inject(fixture.app, '/api/forms/packing-list/list/validate', {
      method: 'POST',
      headers: { ...AGENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        sections: [],
        items: [],
      }),
    });
    assert.equal(invalid.status, 422);

    const putBody = {
      revision: 0,
      sections: [{ id: 'general', title: 'General' }, { id: 'kitchen', title: 'Kitchen' }],
      items: [{
        id: '22222222-2222-4222-8222-222222222222',
        text: 'Stakes',
        sectionId: 'general',
        checked: false,
      }],
    };
    const written = await inject(fixture.app, '/api/forms/packing-list/list', {
      method: 'PUT',
      headers: { ...AGENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    assert.equal(written.status, 200, await written.text());
    assert.equal((await written.json()).state.revision, 1);

    const stale = await inject(fixture.app, '/api/forms/packing-list/list', {
      method: 'PUT',
      headers: { ...AGENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error.code, 'revision_conflict');
    assert.equal(staleBody.state.revision, 1);

    const csrfRejected = await inject(fixture.app, '/api/forms/packing-list/list', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: PUBLIC_ORIGIN,
        Cookie: 'lookie_forms_context=not-a-real-context',
        'X-CSRF-Token': 'wrong',
        'X-Manage': 'yes',
      },
      body: JSON.stringify({ ...putBody, revision: 1 }),
    });
    assert.equal(csrfRejected.status, 403);

    const page = await inject(fixture.app, '/forms/packing-list', {
      headers: { ...AGENT_HEADERS },
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /list-root/);
    assert.match(html, /Hide completed/);
    assert.doesNotMatch(html, /Log an entry/);
  } finally {
    await fixture.close();
  }
});
