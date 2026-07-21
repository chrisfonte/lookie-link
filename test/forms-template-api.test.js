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

const PUBLIC_ORIGIN = 'http://forms.example.test';
const AGENT_HEADERS = {
  Authorization: 'Bearer template-secret',
  'X-Manage': 'yes',
};

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
    request.headers = {host: 'forms.example.test'};
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

async function makeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-template-api-'));
  const templatesPath = path.join(root, 'templates');
  const defaultRoot = path.join(root, 'default-submissions');
  const gymRoot = path.join(root, 'gym-submissions');
  await fs.mkdir(templatesPath);
  const times = [
    new Date('2026-07-21T12:00:00.000Z'),
    new Date('2026-07-21T13:00:00.000Z'),
    new Date('2026-07-21T14:00:00.000Z'),
  ];
  let tick = 0;
  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['default', 'gym-log'],
    clock: () => times[tick++] || times.at(-1),
    logger: {warn() {}},
  });
  const app = createApp({
    mappings: {},
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        templateAgent: {
          secret: 'template-secret',
          permissions: {view: true},
          repos: 'all',
          subject: {agentId: 'template-agent'},
        },
      },
    },
    formsConfig: {
      enabled: true,
      templatesPath,
      destinations: {default: defaultRoot, 'gym-log': gymRoot},
    },
    formsRegistry: registry,
    formsPublicOrigin: PUBLIC_ORIGIN,
    formsAudit: () => {},
    formsAuthorize: ({req, capability}) => req.get('x-manage') === 'yes'
      && (capability === 'forms.manage' || capability === 'forms.submit'),
  });
  return {
    root,
    templatesPath,
    defaultRoot,
    gymRoot,
    registry,
    request: (route, init) => inject(app, route, init),
    close: () => fs.rm(root, {recursive: true, force: true}),
  };
}

function draftBody(templateId = 'training-log') {
  return {
    templateId,
    grammarVersion: 1,
    destinationId: 'gym-log',
    title: 'Training log',
    fields: [
      {
        id: 'lift',
        type: 'select',
        label: 'Lift',
        required: true,
        options: [{id: 'squat', label: 'Squat'}, {id: 'bench', label: 'Bench press'}],
      },
      {id: 'notes', type: 'long-text', label: 'Notes', required: true},
    ],
  };
}

function jsonMutation(body, headers = AGENT_HEADERS) {
  return {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
  };
}

function patchMutation(body, headers = AGENT_HEADERS) {
  return {...jsonMutation(body, headers), method: 'PATCH'};
}

async function diskSnapshot(root) {
  const snapshot = {};
  async function walk(directory, prefix = '') {
    let entries;
    try {
      entries = await fs.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(prefix, entry.name);
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, relative);
      else snapshot[relative] = (await fs.readFile(fullPath)).toString('base64');
    }
  }
  await walk(root);
  return snapshot;
}

test('template API lifecycle uses CAS and preserves immutable versions and old receipts', async () => {
  const server = await makeServer();
  try {
    const createdResponse = await server.request('/api/forms/templates', jsonMutation(draftBody()));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.template.revision, 1);
    assert.equal(created.template.ownerId, 'template-agent');
    assert.equal(created.state, 'draft');
    assert.equal(created.publishedVersion, null);

    const revisedResponse = await server.request('/api/forms/templates/training-log', patchMutation({
      revision: 1,
      title: 'Strength training log',
    }));
    assert.equal(revisedResponse.status, 200);
    assert.equal((await revisedResponse.json()).template.revision, 2);

    const draftPath = path.join(server.templatesPath, 'training-log', 'draft.json');
    const beforeStale = await fs.readFile(draftPath);
    const staleResponse = await server.request('/api/forms/templates/training-log', patchMutation({
      revision: 1,
      title: 'Stale overwrite',
    }));
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).error.code, 'revision_conflict');
    assert.equal(Buffer.compare(beforeStale, await fs.readFile(draftPath)), 0);

    const firstPublish = await server.request(
      '/api/forms/templates/training-log/publish',
      jsonMutation({}),
    );
    assert.equal(firstPublish.status, 201);
    const firstVersion = (await firstPublish.json()).version;
    assert.equal(firstVersion.templateVersion, 1);
    assert.equal(firstVersion.sourceRevision, 2);
    assert.deepEqual(firstVersion.publishedBy, {id: 'template-agent', type: 'agent'});
    assert.match(firstVersion.schemaDigest, /^sha256:[0-9a-f]{64}$/);
    const firstVersionPath = path.join(server.templatesPath, 'training-log', 'versions', '1.json');
    const firstVersionBytes = await fs.readFile(firstVersionPath);

    const submitted = await server.request('/api/forms/training-log/submissions', jsonMutation({
      values: {lift: 'squat', notes: 'Original receipt value'},
    }));
    assert.equal(submitted.status, 201);
    const receiptUrl = (await submitted.json()).receiptUrl;

    const nextFields = draftBody().fields;
    nextFields[0].label = 'Movement';
    nextFields[0].options[0].label = 'Back squat';
    const secondRevision = await server.request('/api/forms/templates/training-log', patchMutation({
      revision: 2,
      fields: nextFields,
    }));
    assert.equal(secondRevision.status, 200);
    assert.equal((await secondRevision.json()).template.revision, 3);
    const secondPublish = await server.request(
      '/api/forms/templates/training-log/publish',
      jsonMutation({}),
    );
    assert.equal(secondPublish.status, 201);
    assert.equal((await secondPublish.json()).version.templateVersion, 2);
    assert.equal(Buffer.compare(firstVersionBytes, await fs.readFile(firstVersionPath)), 0);
    assert.ok(await fs.readFile(path.join(server.templatesPath, 'training-log', 'versions', '2.json')));

    const receipt = await server.request(receiptUrl, {headers: AGENT_HEADERS});
    assert.equal(receipt.status, 200);
    const receiptHtml = await receipt.text();
    assert.match(receiptHtml, /<th scope="row">Lift<\/th>/);
    assert.match(receiptHtml, />Squat</);
    assert.match(receiptHtml, /Original receipt value/);
    assert.doesNotMatch(receiptHtml, />Movement</);
    assert.doesNotMatch(receiptHtml, />Back squat</);

    const listed = await server.request('/api/forms/templates', {headers: AGENT_HEADERS});
    assert.deepEqual((await listed.json()).templates, [{
      templateId: 'training-log',
      title: 'Strength training log',
      revision: 3,
      publishedVersion: 2,
      state: 'published',
    }]);
    const fetchedResponse = await server.request('/api/forms/templates/training-log', {headers: AGENT_HEADERS});
    assert.equal(fetchedResponse.status, 200);
    const fetched = await fetchedResponse.json();
    assert.equal(fetched.publishedVersions.length, 2);
    assert.equal(fetched.publishedVersion.templateVersion, 2);
    assert.doesNotMatch(JSON.stringify(fetched), new RegExp(server.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await server.close();
  }
});

test('invalid grammar and server-derived fields return exact paths with no write', async () => {
  const server = await makeServer();
  try {
    const before = await diskSnapshot(server.templatesPath);
    const invalid = draftBody('invalid-template');
    invalid.fields[1].constraints = {minimum: 2};
    const invalidResponse = await server.request('/api/forms/templates', jsonMutation(invalid));
    assert.equal(invalidResponse.status, 422);
    assert.deepEqual(
      (await invalidResponse.json()).error.details.map((error) => error.path),
      ['fields[1].constraints.minimum'],
    );
    assert.deepEqual(await diskSnapshot(server.templatesPath), before);

    const forged = {...draftBody('forged-template'), revision: 40, schemaDigest: `sha256:${'a'.repeat(64)}`};
    const forgedResponse = await server.request('/api/forms/templates', jsonMutation(forged));
    assert.equal(forgedResponse.status, 400);
    assert.deepEqual(
      (await forgedResponse.json()).error.details.map((error) => error.path),
      ['revision', 'schemaDigest'],
    );
    assert.deepEqual(await diskSnapshot(server.templatesPath), before);
  } finally {
    await server.close();
  }
});

test('template routes enforce forms.manage, browser CSRF, URL credential, and destination safety', async () => {
  const server = await makeServer();
  try {
    assert.equal((await server.request('/api/forms/templates', {headers: AGENT_HEADERS})).status, 200);
    assert.equal((await server.request('/api/forms/templates', jsonMutation(draftBody()))).status, 201);
    const before = await diskSnapshot(server.templatesPath);
    const deniedHeaders = {Authorization: 'Bearer template-secret'};
    const deniedCases = [
      ['/api/forms/templates', {headers: deniedHeaders}, 200],
      ['/api/forms/templates/training-log', {headers: deniedHeaders}, 404],
      ['/api/forms/templates', jsonMutation(draftBody('denied-create'), deniedHeaders), 403],
      ['/api/forms/templates/training-log', patchMutation({revision: 1, title: 'Denied'}, deniedHeaders), 404],
      ['/api/forms/templates/training-log/publish', jsonMutation({}, deniedHeaders), 404],
    ];
    for (const [route, init, expected] of deniedCases) {
      const response = await server.request(route, init);
      assert.equal(response.status, expected, `${init.method || 'GET'} ${route}`);
      if (route === '/api/forms/templates' && !init.method) {
        assert.deepEqual((await response.json()).templates, []);
      }
      assert.deepEqual(await diskSnapshot(server.templatesPath), before);
    }

    const unauthenticated = await server.request('/api/forms/templates');
    assert.equal(unauthenticated.status, 401);
    const missingBrowserEnvelope = await server.request('/api/forms/templates', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(draftBody('browser-attempt')),
    });
    assert.equal(missingBrowserEnvelope.status, 403);
    const queryCredential = await server.request('/api/forms/templates?token=template-secret', jsonMutation(draftBody('query-attempt')));
    assert.equal(queryCredential.status, 400);
    assert.deepEqual(await diskSnapshot(server.templatesPath), before);

    for (const [templateId, destinationId] of [
      ['path-destination', '../outside'],
      ['unknown-destination', 'operator-created'],
    ]) {
      const body = draftBody(templateId);
      body.destinationId = destinationId;
      const response = await server.request('/api/forms/templates', jsonMutation(body));
      assert.equal(response.status, 422);
      assert.deepEqual((await response.json()).error.details.map((error) => error.path), ['destinationId']);
      assert.deepEqual(await diskSnapshot(server.templatesPath), before);
    }

    const responseBodies = [];
    for (const route of ['/api/forms/templates', '/api/forms/templates/training-log']) {
      const response = await server.request(route, {headers: AGENT_HEADERS});
      responseBodies.push(await response.text());
    }
    for (const body of responseBodies) {
      assert.doesNotMatch(body, new RegExp(server.defaultRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(body, new RegExp(server.gymRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    await server.close();
  }
});

test('managed drafts and version metadata retain their last-known-good registry state', async () => {
  const server = await makeServer();
  try {
    assert.equal((await server.request('/api/forms/templates', jsonMutation(draftBody()))).status, 201);
    assert.equal((await server.request(
      '/api/forms/templates/training-log/publish',
      jsonMutation({}),
    )).status, 201);
    const draftPath = path.join(server.templatesPath, 'training-log', 'draft.json');
    const versionPath = path.join(server.templatesPath, 'training-log', 'versions', '1.json');
    const draftBytes = await fs.readFile(draftPath);
    const versionBytes = await fs.readFile(versionPath);

    await fs.writeFile(draftPath, '{broken');
    assert.equal((await server.registry.getTemplate('training-log')).title, 'Training log');
    await fs.writeFile(draftPath, draftBytes);
    await server.registry.getTemplate('training-log');

    await fs.writeFile(versionPath, '{broken');
    const retained = await server.registry.getManagementTemplate('training-log');
    assert.equal(retained.publishedVersion.templateVersion, 1);
    assert.equal(retained.state, 'published');
    await fs.writeFile(versionPath, versionBytes);
  } finally {
    await server.close();
  }
});
