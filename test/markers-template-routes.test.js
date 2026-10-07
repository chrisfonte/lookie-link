'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { MarkerTemplateStore } = require('../lib/markers/template-store');
const { createMarkerTemplateRouter } = require('../lib/markers/routes-templates');

function sample(overrides = {}) {
  return {
    templateId: 'sample',
    title: 'Sample',
    unit: 'ms',
    markers: [{ id: 'a', label: 'A', kind: 'point', color: '#112233' }],
    ...overrides,
  };
}

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-template-routes-'));
  const store = new MarkerTemplateStore({ templatesPath: path.join(dir, 'templates'), logger: { warn() {} } });
  const state = { admin: true, gateOpen: true, gateCalls: [], audits: [] };
  const gate = {
    check(req, res, info) {
      state.gateCalls.push(info);
      if (state.gateOpen) return true;
      res.status(403).json({ ok: false, error: { code: 'origin_rejected', message: 'refused by gate' } });
      return false;
    },
  };
  const app = express();
  app.use(createMarkerTemplateRouter({
    store,
    gate,
    authorizeAdmin: () => state.admin,
    audit: (event, req, details) => state.audits.push({ event, ...details }),
    logger: { warn() {} },
    ...options,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, route, body, headers = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { call, state, store };
}

test('list and get serve bundled templates with summaries', async (t) => {
  const { call } = await setup(t);
  const list = await call('GET', '/api/markers/templates');
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.deepEqual(list.body.templates.map((x) => x.templateId), ['freeform', 'radio-imaging', 'song-structure']);
  assert.deepEqual(list.body.templates[2], {
    templateId: 'song-structure', revision: 1, title: 'Song structure', unit: 'ms', markerCount: 5, source: 'bundled', writable: false,
  });
  const one = await call('GET', '/api/markers/templates/song-structure');
  assert.equal(one.status, 200);
  assert.equal(one.body.source, 'bundled');
  assert.equal(one.body.writable, false);
  assert.equal(one.body.template.templateId, 'song-structure');
  assert.equal(one.body.template.source, undefined);
  const missing = await call('GET', '/api/markers/templates/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, 'not_found');
  assert.equal((await call('GET', '/api/markers/templates/Bad_Id')).status, 404);
});

test('create, patch and delete lifecycle with audit events', async (t) => {
  const { call, state } = await setup(t);
  const created = await call('POST', '/api/markers/templates', sample());
  assert.equal(created.status, 201);
  assert.equal(created.body.template.revision, 1);
  assert.equal(created.body.template.resourceKind, 'marker-template');
  assert.deepEqual(state.gateCalls[0], { mutation: true, type: 'markers.template' });

  const fetched = await call('GET', '/api/markers/templates/sample');
  assert.equal(fetched.body.source, 'stored');
  assert.equal(fetched.body.writable, true);

  const patched = await call('PATCH', '/api/markers/templates/sample', { revision: 1, title: 'Renamed' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.template.revision, 2);
  assert.equal(patched.body.template.title, 'Renamed');

  const deleted = await call('DELETE', '/api/markers/templates/sample', { revision: 2 });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, deleted: true });
  assert.equal((await call('GET', '/api/markers/templates/sample')).status, 404);

  assert.deepEqual(state.audits, [
    { event: 'markers.template.create', templateId: 'sample', outcome: 'accepted' },
    { event: 'markers.template.update', templateId: 'sample', outcome: 'accepted' },
    { event: 'markers.template.delete', templateId: 'sample', outcome: 'accepted' },
  ]);
});

test('patch requires a positive integer revision and a change', async (t) => {
  const { call } = await setup(t);
  await call('POST', '/api/markers/templates', sample());
  for (const body of [{ title: 'x' }, { revision: 0, title: 'x' }, { revision: '1', title: 'x' }, { revision: 1.5, title: 'x' }]) {
    const response = await call('PATCH', '/api/markers/templates/sample', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_request');
  }
  const empty = await call('PATCH', '/api/markers/templates/sample', { revision: 1 });
  assert.equal(empty.status, 400);
  const del = await call('DELETE', '/api/markers/templates/sample', {});
  assert.equal(del.status, 400);
  assert.equal(del.body.error.code, 'invalid_request');
  const bare = await call('DELETE', '/api/markers/templates/sample');
  assert.equal(bare.status, 400);
});

test('stale revision is 409 revision_conflict with currentRevision', async (t) => {
  const { call } = await setup(t);
  await call('POST', '/api/markers/templates', sample());
  await call('PATCH', '/api/markers/templates/sample', { revision: 1, title: 'B' });
  const stale = await call('PATCH', '/api/markers/templates/sample', { revision: 1, title: 'C' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'revision_conflict');
  assert.equal(stale.body.currentRevision, 2);
  const staleDelete = await call('DELETE', '/api/markers/templates/sample', { revision: 1 });
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.body.currentRevision, 2);
});

test('validation, conflict, read-only and not-found map to their envelopes', async (t) => {
  const { call } = await setup(t);
  const invalid = await call('POST', '/api/markers/templates', sample({ unit: 'frames' }));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'validation_error');
  assert.ok(invalid.body.error.details.some((d) => d.path === 'unit'));

  const bundled = await call('POST', '/api/markers/templates', sample({ templateId: 'freeform' }));
  assert.equal(bundled.status, 409);
  assert.equal(bundled.body.error.code, 'conflict');

  await call('POST', '/api/markers/templates', sample());
  assert.equal((await call('POST', '/api/markers/templates', sample())).status, 409);

  const readOnly = await call('PATCH', '/api/markers/templates/freeform', { revision: 1, title: 'x' });
  assert.equal(readOnly.status, 403);
  assert.equal(readOnly.body.error.code, 'read_only');
  assert.equal((await call('DELETE', '/api/markers/templates/freeform', { revision: 1 })).status, 403);

  const missing = await call('PATCH', '/api/markers/templates/ghost', { revision: 1, title: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
  const badUpdate = await call('PATCH', '/api/markers/templates/sample', { revision: 1, markers: [] });
  assert.equal(badUpdate.status, 422);
});

test('mutations answer 403 forbidden when the caller is not a template admin', async (t) => {
  const { call, state } = await setup(t);
  state.admin = false;
  for (const [method, route, body] of [
    ['POST', '/api/markers/templates', sample()],
    ['PATCH', '/api/markers/templates/sample', { revision: 1, title: 'x' }],
    ['DELETE', '/api/markers/templates/sample', { revision: 1 }],
  ]) {
    const response = await call(method, route, body);
    assert.equal(response.status, 403, method);
    assert.equal(response.body.error.code, 'forbidden');
  }
  assert.ok(state.audits.every((a) => a.outcome === 'rejected_authz'));
  assert.equal((await call('GET', '/api/markers/templates')).status, 200);
});

test('a refusing gate stops the mutation and its response stands', async (t) => {
  const { call, state, store } = await setup(t);
  state.gateOpen = false;
  const response = await call('POST', '/api/markers/templates', sample());
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'origin_rejected');
  assert.equal(await store.get('sample'), null);
  state.admin = false;
  assert.equal((await call('PATCH', '/api/markers/templates/sample', { revision: 1, title: 'x' })).body.error.code, 'origin_rejected');
  assert.deepEqual(state.audits, []);
  // reads never touch the gate
  state.gateCalls.length = 0;
  assert.equal((await call('GET', '/api/markers/templates')).status, 200);
  assert.deepEqual(state.gateCalls, []);
});

test('?token= is rejected on every method', async (t) => {
  const { call } = await setup(t);
  for (const [method, body] of [['GET'], ['POST', sample()], ['PATCH', { revision: 1, title: 'x' }], ['DELETE', { revision: 1 }]]) {
    const route = method === 'POST' || (method === 'GET') ? '/api/markers/templates?token=abc' : '/api/markers/templates/sample?token=abc';
    const response = await call(method, route, body);
    assert.equal(response.status, 400, method);
    assert.equal(response.body.error.code, 'query_credentials_rejected');
  }
  assert.equal((await call('GET', '/api/markers/templates/freeform?token=abc')).status, 400);
});

test('bad JSON and wrong content type are refused with envelopes', async (t) => {
  const raw = await setupRaw(t);
  const bad = await fetch(`${raw}/api/markers/templates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_json');
  const plain = await fetch(`${raw}/api/markers/templates`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(plain.status, 415);
  const array = await fetch(`${raw}/api/markers/templates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
  assert.equal(array.status, 400);
});

test('constructor requires its collaborators', () => {
  assert.throws(() => createMarkerTemplateRouter({}), /store/);
  assert.throws(() => createMarkerTemplateRouter({ store: {} }), /authorizeAdmin/);
  assert.throws(() => createMarkerTemplateRouter({ store: {}, authorizeAdmin() {} }), /gate/);
});

async function setupRaw(t) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-template-raw-'));
  const store = new MarkerTemplateStore({ templatesPath: path.join(dir, 'templates'), logger: { warn() {} } });
  const app = express();
  app.use(createMarkerTemplateRouter({ store, gate: { check: () => true }, authorizeAdmin: () => true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
