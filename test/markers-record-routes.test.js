'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { MarkerRecordStore } = require('../lib/markers/record-store');
const { MarkerTemplateStore } = require('../lib/markers/template-store');
const { createMarkerRecordRouter } = require('../lib/markers/routes-records');

const SHA = 'c'.repeat(64);
const SHA_TARGET = 'd'.repeat(64);

const TEMPLATE = {
  templateId: 'sample-set',
  title: 'Sample set',
  unit: 'samples',
  groups: [{ id: 'g', label: 'G' }],
  markers: [
    { id: 'alpha', label: 'Alpha', kind: 'point', color: '#112233', required: true },
    { id: 'beta', label: 'Beta', kind: 'point', color: '#223344', constraints: { after: 'alpha' } },
  ],
  pickers: [{ id: 'scene', label: 'Scene', options: [{ id: 'one', label: 'One' }] }],
  projections: [{ id: 'sample-yaml', kind: 'rivendell', map: { alpha: 'START_POINT' } }],
};

const point = (id, sample, type = id) => ({ id, type, kind: 'point', sample });

async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-record-routes-'));
  const templateStore = new MarkerTemplateStore({ templatesPath: path.join(dir, 'templates'), logger: { warn() {} } });
  await templateStore.create(TEMPLATE);
  const recordStores = new Map();
  const stores = {
    forDestination(id) {
      if (!recordStores.has(id)) recordStores.set(id, new MarkerRecordStore({ storageRoot: path.join(dir, 'records', id) }));
      return recordStores.get(id);
    },
  };
  const state = {
    gateOpen: true, write: true, read: true, audits: [], projectCalls: [], hashed: [], principal: { id: 'operator', type: 'operator' },
    audioSha: SHA, hashResult: SHA, projectImpl: null, projectionAllowed: true, projectionAuthCalls: [], peaksUnavailable: false,
  };
  const gate = {
    check(req, res) {
      if (state.gateOpen) return true;
      res.status(403).json({ ok: false, error: { code: 'origin_rejected', message: 'refused' } });
      return false;
    },
  };
  const deps = {
    stores,
    templateStore,
    gate,
    authorizeRead: () => state.read,
    authorizeWrite: () => state.write,
    authorizeProjection: (req, info) => { state.projectionAuthCalls.push(info); return state.projectionAllowed; },
    resolveAudio: async (req, repo, audioPath) => (audioPath === 'missing.wav'
      ? { ok: false, status: 404, code: 'not_found', message: 'Audio not found.' }
      : state.peaksUnavailable
      ? { ok: false, status: 500, code: 'peaks_unavailable', message: 'No analysis tools.' }
      : { ok: true, sampleRate: 48000, channels: 2, frames: 100000, sha256: state.audioSha, absPath: `/abs/${audioPath}` }),
    hashAudio: async (absPath) => { state.hashed.push(absPath); return state.hashResult; },
    principalFor: () => state.principal,
    audit: (event, req, details) => state.audits.push({ event, ...details }),
    project: async (args) => {
      state.projectCalls.push({ ...args, recordFilesAtCall: (await fs.readdir(path.join(dir, 'records', 'default')).catch(() => [])).length });
      if (state.projectImpl) return state.projectImpl(args);
      return { kind: 'sample', mode: args.mode, status: args.mode === 'live' ? 'applied' : 'preview', after: { sha256: SHA_TARGET } };
    },
    operatorName: 'Config Name',
    logger: { warn() {} },
    ...overrides,
  };
  const app = express();
  app.use(createMarkerRecordRouter(deps));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: { code: 'boom', message: error.message } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, route, body, headers = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: response.status, body: await response.json() };
  }
  return { call, state, deps, dir, stores };
}

function saveBody(overrides = {}) {
  return {
    audio: { repo: 'audio-root', path: 'folder/clip.wav' },
    templateId: 'sample-set',
    templateRevision: 1,
    markers: [point('a1', 100, 'alpha'), point('b1', 200, 'beta')],
    tags: { scene: 'one' },
    reason: 'by ear',
    ...overrides,
  };
}

async function recordFiles(dir) {
  return (await fs.readdir(path.join(dir, 'records', 'default')).catch(() => [])).filter((name) => name.endsWith('.json'));
}

test('create, get, list and history round trip', async (t) => {
  const { call, state } = await setup(t);
  const created = await call('POST', '/api/markers/records', saveBody());
  assert.equal(created.status, 201);
  const { record } = created.body;
  assert.equal(record.resourceKind, 'marker-record');
  assert.deepEqual(record.audio, { repo: 'audio-root', path: 'folder/clip.wav', sha256: SHA, sampleRate: 48000, channels: 2, frames: 100000 });
  assert.deepEqual(record.actor, { id: 'operator', type: 'operator', name: 'Config Name', nameSource: 'config' });
  assert.equal(record.templateRevision, 1);
  assert.deepEqual(state.hashed, ['/abs/folder/clip.wav']);
  assert.equal('targetSha256After' in created.body, false);

  const got = await call('GET', `/api/markers/records/${record.recordId}`);
  assert.deepEqual(got.body, { ok: true, record });
  const listed = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav');
  assert.deepEqual(listed.body, { ok: true, records: [record] });
  const history = await call('GET', `/api/markers/records/${record.recordId}/history`);
  assert.equal(history.body.latest.recordId, record.recordId);
  assert.deepEqual(history.body.predecessors, []);

  const correction = await call('POST', '/api/markers/records', saveBody({
    markers: [point('a1', 150, 'alpha'), point('b1', 200, 'beta')],
    supersedesRecord: { id: record.recordId },
  }));
  assert.equal(correction.status, 201);
  assert.equal(correction.body.record.supersedesRecord.id, record.recordId);
  const latestOnly = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav');
  assert.deepEqual(latestOnly.body.records.map((r) => r.recordId), [correction.body.record.recordId]);
  const all = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav&all=1');
  assert.equal(all.body.records.length, 2);
  const filtered = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav&templateId=other-set');
  assert.deepEqual(filtered.body.records, []);
  const hist = await call('GET', `/api/markers/records/${record.recordId}/history`);
  assert.equal(hist.body.latest.recordId, correction.body.record.recordId);
  assert.deepEqual(hist.body.predecessors.map((r) => r.recordId), [record.recordId]);
  assert.ok(state.audits.some((entry) => entry.event === 'markers.record.create' && entry.outcome === 'accepted'));
});

test('a second create without supersedes is 409 revision_conflict with currentRecordId', async (t) => {
  const { call } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody());
  const second = await call('POST', '/api/markers/records', saveBody());
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'revision_conflict');
  assert.equal(second.body.currentRecordId, first.body.record.recordId);
  assert.equal(second.body.currentRecord.recordId, first.body.record.recordId);
  // Superseding an already superseded record: same code.
  await call('POST', '/api/markers/records', saveBody({ supersedesRecord: { id: first.body.record.recordId } }));
  const stale = await call('POST', '/api/markers/records', saveBody({ supersedesRecord: { id: first.body.record.recordId } }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'revision_conflict');
  assert.ok(stale.body.currentRecordId);
  assert.notEqual(stale.body.currentRecordId, first.body.record.recordId);
});

test('a predecessor recorded for different audio bytes is 409 revision_conflict, not 404', async (t) => {
  const { call, state } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody());
  state.audioSha = 'f'.repeat(64);
  state.hashResult = 'f'.repeat(64);
  const result = await call('POST', '/api/markers/records', saveBody({ supersedesRecord: { id: first.body.record.recordId } }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'revision_conflict');
  assert.equal(result.body.error.message, 'the audio bytes changed since that record');
  // New bytes with no predecessor start a fresh history.
  assert.equal((await call('POST', '/api/markers/records', saveBody())).status, 201);
});

test('unknown or foreign predecessor is 404 not_found', async (t) => {
  const { call } = await setup(t);
  const result = await call('POST', '/api/markers/records', saveBody({ supersedesRecord: { id: '44444444-4444-4444-8444-444444444444' }, reason: 'x' }));
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'not_found');
});

test('a superseding save of a non-freeform template needs a reason', async (t) => {
  const { call } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody({ reason: undefined }));
  assert.equal(first.status, 201);
  const noReason = await call('POST', '/api/markers/records', saveBody({ reason: '  ', supersedesRecord: { id: first.body.record.recordId } }));
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error.details[0].path, 'reason');
});

test('stale templateRevision is 409 revision_conflict with currentRevision', async (t) => {
  const { call } = await setup(t);
  const stale = await call('POST', '/api/markers/records', saveBody({ templateRevision: 7 }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'revision_conflict');
  assert.equal(stale.body.currentRevision, 1);
  const missing = saveBody();
  delete missing.templateRevision;
  const result = await call('POST', '/api/markers/records', missing);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'invalid_request');
});

test('constraint failure is 422 validation_error with details; nothing is written', async (t) => {
  const { call, dir } = await setup(t);
  const result = await call('POST', '/api/markers/records', saveBody({ markers: [point('a1', 300, 'alpha'), point('b1', 200, 'beta')] }));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_error');
  assert.equal(result.body.error.details[0].markerId, 'b1');
  assert.deepEqual(await recordFiles(dir), []);
  const missingRequired = await call('POST', '/api/markers/records', saveBody({ markers: [point('b1', 200, 'beta')] }));
  assert.equal(missingRequired.status, 422);
  const badTag = await call('POST', '/api/markers/records', saveBody({ tags: { scene: 'two' } }));
  assert.equal(badTag.status, 422);
  const badShape = await call('POST', '/api/markers/records', saveBody({ markers: [{ id: 'q', type: 'alpha', kind: 'blob' }] }));
  assert.equal(badShape.status, 422);
  const extra = await call('POST', '/api/markers/records', saveBody({ unexpected: true }));
  assert.equal(extra.status, 422);
});

test('the server re-hashes audio and refuses a sidecar mismatch with 409 sidecar_conflict', async (t) => {
  const { call, state, dir } = await setup(t);
  state.hashResult = 'e'.repeat(64);
  const result = await call('POST', '/api/markers/records', saveBody());
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'sidecar_conflict');
  assert.match(result.body.error.message, /audio changed since its peaks sidecar was generated/);
  assert.deepEqual(await recordFiles(dir), []);
});

test('actor name handling: self-asserted, config, and token', async (t) => {
  const { call, state } = await setup(t);
  const named = await call('POST', '/api/markers/records', saveBody({ actor: { name: 'Pat Example' } }));
  assert.deepEqual(named.body.record.actor, { id: 'operator', type: 'operator', name: 'Pat Example', nameSource: 'self-asserted' });
  const bad = await call('POST', '/api/markers/records', saveBody({ actor: { name: 'x'.repeat(200) } }));
  assert.equal(bad.status, 422);
  state.principal = { id: 'agent-7', type: 'agent' };
  const token = await call('POST', '/api/markers/records', saveBody({
    actor: { name: 'Ignored' }, supersedesRecord: { id: named.body.record.recordId },
  }), { authorization: 'Bearer abc' });
  assert.deepEqual(token.body.record.actor, { id: 'agent-7', type: 'agent', name: 'agent-7', nameSource: 'token' });
});

test('touched is stored on the record', async (t) => {
  const { call } = await setup(t);
  const result = await call('POST', '/api/markers/records', saveBody({ touched: ['a1'] }));
  assert.deepEqual(result.body.record.touched, ['a1']);
});

test('a live projection runs before the write; its receipt lands on the record', async (t) => {
  const { call, state, dir } = await setup(t);
  const result = await call('POST', '/api/markers/records', saveBody({
    touched: ['a1'],
    projection: { id: 'sample-yaml', mode: 'live', accept: true, expectedTargetSha256: SHA },
  }));
  assert.equal(result.status, 201);
  assert.equal(state.projectCalls.length, 1);
  const call0 = state.projectCalls[0];
  assert.equal(call0.mode, 'live');
  assert.equal(call0.recordFilesAtCall, 0);
  assert.equal(call0.projectionId, 'sample-yaml');
  assert.equal(call0.accept, true);
  assert.equal(call0.expectedTargetSha256, SHA);
  assert.deepEqual(call0.touched, ['a1']);
  assert.equal(call0.template.templateId, 'sample-set');
  assert.equal(call0.record.recordId, result.body.record.recordId);
  assert.equal(call0.record.projection, null);
  assert.equal(call0.audio.absPath, '/abs/folder/clip.wav');
  assert.equal(result.body.record.projection.status, 'applied');
  assert.equal(result.body.targetSha256After, SHA_TARGET);
  assert.equal((await recordFiles(dir)).length, 1);
  assert.ok(state.audits.some((entry) => entry.event === 'markers.projection.apply'));
});

test('a live projection requires expectedTargetSha256, a declared id, and a project hook', async (t) => {
  const { call, state, dir } = await setup(t);
  const missing = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', mode: 'live' } }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'invalid_request');
  const undeclared = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'nope', expectedTargetSha256: SHA } }));
  assert.equal(undeclared.status, 422);
  const preview = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', mode: 'preview', expectedTargetSha256: SHA } }));
  assert.equal(preview.status, 400);
  assert.equal(state.projectCalls.length, 0);
  assert.deepEqual(await recordFiles(dir), []);

  const bare = await setup(t, { project: undefined });
  const disabled = await bare.call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.error.code, 'feature_disabled');
  assert.match(disabled.body.error.message, /no projection configured/);
});

test('a projection error passes through and writes no record', async (t) => {
  const { call, state, dir } = await setup(t);
  state.projectImpl = () => {
    throw Object.assign(new Error('Target changed.'), { status: 409, code: 'target_conflict', details: [{ path: 'target', message: 'changed' }], extra: { currentTargetSha256: SHA_TARGET } });
  };
  const result = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'target_conflict');
  assert.equal(result.body.currentTargetSha256, SHA_TARGET);
  assert.deepEqual(await recordFiles(dir), []);
});

test('after a live projection the record is written even when the receipt is uncertain', async (t) => {
  const { call, state, dir } = await setup(t);
  state.projectImpl = () => ({ kind: 'sample', mode: 'live', status: 'uncertain' });
  const result = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(result.status, 201);
  assert.equal(result.body.record.projection.status, 'uncertain');
  assert.equal((await recordFiles(dir)).length, 1);
});

test('the save lock spans the projection: concurrent saves do not interleave', async (t) => {
  const { call, state } = await setup(t);
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.open = resolve; });
  state.projectImpl = async () => { await gate.promise; return { mode: 'live', status: 'applied' }; };
  const body = saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } });
  const first = call('POST', '/api/markers/records', body);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = call('POST', '/api/markers/records', saveBody());
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.open();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 201);
  assert.equal(two.status, 409);
  assert.equal(two.body.currentRecordId, one.body.record.recordId);
  assert.equal(state.projectCalls.length, 1);
});

test('preview writes nothing and returns constraints plus the projection result', async (t) => {
  const { call, state, dir } = await setup(t);
  const result = await call('POST', '/api/markers/preview', saveBody({ projection: { id: 'sample-yaml' } }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.constraints, { ok: true, errors: [], warnings: [] });
  assert.equal(result.body.projection.mode, 'preview');
  assert.equal(state.projectCalls[0].mode, 'preview');
  assert.deepEqual(await recordFiles(dir), []);
  await fs.access(path.join(dir, 'records')).then(() => assert.fail('preview created the store'), () => {});

  const noProjection = await call('POST', '/api/markers/preview', saveBody());
  assert.deepEqual(noProjection.body, { ok: true, constraints: { ok: true, errors: [], warnings: [] }, projection: null });

  const failing = await call('POST', '/api/markers/preview', saveBody({
    markers: [point('b1', 1, 'beta')], projection: { id: 'sample-yaml' },
  }));
  assert.equal(failing.status, 200);
  assert.equal(failing.body.constraints.ok, false);
  assert.equal(failing.body.projection, null);
  assert.equal(state.projectCalls.length, 1);
});

test('preview diffs against the latest record when no predecessor is named', async (t) => {
  const { call, state } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody());
  await call('POST', '/api/markers/preview', saveBody({ projection: { id: 'sample-yaml' } }));
  assert.equal(state.projectCalls[0].record.supersedesRecord.id, first.body.record.recordId);
  const stale = await call('POST', '/api/markers/preview', saveBody({ templateRevision: 3 }));
  assert.equal(stale.status, 409);
});

test('gate, authentication, authorization and body checks', async (t) => {
  const { call, state } = await setup(t);
  state.gateOpen = false;
  assert.equal((await call('POST', '/api/markers/records', saveBody())).body.error.code, 'origin_rejected');
  assert.equal((await call('POST', '/api/markers/preview', saveBody())).body.error.code, 'origin_rejected');
  state.gateOpen = true;
  state.write = false;
  const forbidden = await call('POST', '/api/markers/records', saveBody());
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'forbidden');
  state.write = true;
  state.principal = null;
  assert.equal((await call('POST', '/api/markers/records', saveBody())).status, 401);
  state.principal = { id: 'operator', type: 'operator' };
  const invalid = await call('POST', '/api/markers/records', '{not json');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_json');
  const unknownTemplate = await call('POST', '/api/markers/records', saveBody({ templateId: 'no-such-set' }));
  assert.equal(unknownTemplate.status, 404);
  const missingAudio = await call('POST', '/api/markers/records', saveBody({ audio: { repo: 'audio-root', path: 'missing.wav' } }));
  assert.equal(missingAudio.status, 404);
  assert.equal(missingAudio.body.error.code, 'not_found');
});

test('non-JSON content type is 415 and the body limit is 2 MB', async (t) => {
  const { call } = await setup(t);
  const plain = await call('POST', '/api/markers/records', 'hello', { 'content-type': 'text/plain' });
  assert.equal(plain.status, 415);
  assert.equal(plain.body.error.code, 'unsupported_media_type');
  const big = await call('POST', '/api/markers/records', saveBody({ reason: 'x'.repeat(2.5 * 1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'payload_too_large');
});

test('?token= is refused on mutations', async (t) => {
  const { call, dir } = await setup(t);
  const record = await call('POST', '/api/markers/records?token=abc', saveBody());
  assert.equal(record.status, 400);
  assert.equal(record.body.error.code, 'query_credentials_rejected');
  const preview = await call('POST', '/api/markers/preview?token=abc', saveBody());
  assert.equal(preview.body.error.code, 'query_credentials_rejected');
  assert.deepEqual(await recordFiles(dir), []);
});

test('read authorization: denied reads look like not found', async (t) => {
  const { call, state } = await setup(t);
  const created = await call('POST', '/api/markers/records', saveBody());
  state.read = false;
  assert.equal((await call('GET', `/api/markers/records/${created.body.record.recordId}`)).status, 404);
  assert.equal((await call('GET', `/api/markers/records/${created.body.record.recordId}/history`)).status, 404);
  assert.equal((await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav')).status, 404);
  state.read = true;
  assert.equal((await call('GET', '/api/markers/records/not-a-uuid')).status, 404);
  assert.equal((await call('GET', '/api/markers/records?repo=audio-root')).status, 400);
});

test('templates with another destinationId store records in that destination', async (t) => {
  const { call, dir, deps } = await setup(t);
  await deps.templateStore.create({ ...TEMPLATE, templateId: 'other-set', destinationId: 'archive' });
  const created = await call('POST', '/api/markers/records', saveBody({ templateId: 'other-set' }));
  assert.equal(created.status, 201);
  assert.equal((await fs.readdir(path.join(dir, 'records', 'archive'))).length, 1);
  assert.equal((await call('GET', `/api/markers/records/${created.body.record.recordId}`)).status, 200);
  const listed = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav');
  assert.equal(listed.body.records.length, 1);
});

test('the re-hash runs before the save lock and the lock key is the server hash', async (t) => {
  const { call, state, deps } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody());
  // The peaks header still says the old hash; the bytes hash differently: refused before any record check.
  state.hashResult = 'e'.repeat(64);
  const result = await call('POST', '/api/markers/records', saveBody({ supersedesRecord: { id: first.body.record.recordId } }));
  assert.equal(result.body.error.code, 'sidecar_conflict');
  assert.ok(deps);
});

test('projection authority: false is 403 projection_not_allowed on records and preview, mode is passed', async (t) => {
  const { call, state, dir } = await setup(t);
  state.projectionAllowed = false;
  const live = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(live.status, 403);
  assert.equal(live.body.error.code, 'projection_not_allowed');
  const preview = await call('POST', '/api/markers/preview', saveBody({ projection: { id: 'sample-yaml' } }));
  assert.equal(preview.status, 403);
  assert.equal(preview.body.error.code, 'projection_not_allowed');
  assert.deepEqual(state.projectionAuthCalls.map((info) => info.mode), ['live', 'preview']);
  assert.equal(state.projectionAuthCalls[0].projection.id, 'sample-yaml');
  assert.equal(state.projectCalls.length, 0);
  assert.deepEqual(await recordFiles(dir), []);
  // A save with no projection never asks.
  state.projectionAuthCalls.length = 0;
  assert.equal((await call('POST', '/api/markers/records', saveBody())).status, 201);
  assert.equal(state.projectionAuthCalls.length, 0);
});

test('a missing authorizeProjection hook denies projections', async (t) => {
  const { call } = await setup(t, { authorizeProjection: undefined });
  const result = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'projection_not_allowed');
});

test('preview mode on the records route is 400 invalid_request, and live on preview too', async (t) => {
  const { call, state } = await setup(t);
  state.projectionAllowed = false; // the mode check comes before authority
  const record = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', mode: 'preview', expectedTargetSha256: SHA } }));
  assert.equal(record.status, 400);
  assert.equal(record.body.error.code, 'invalid_request');
  const preview = await call('POST', '/api/markers/preview', saveBody({ projection: { id: 'sample-yaml', mode: 'live' } }));
  assert.equal(preview.status, 400);
  assert.equal(preview.body.error.code, 'invalid_request');
});

test('peaks unavailable: create is 503 peaks_unavailable, reads still work', async (t) => {
  const { call, state, dir } = await setup(t);
  const first = await call('POST', '/api/markers/records', saveBody());
  state.peaksUnavailable = true;
  const create = await call('POST', '/api/markers/records', saveBody());
  assert.equal(create.status, 503);
  assert.equal(create.body.error.code, 'peaks_unavailable');
  const preview = await call('POST', '/api/markers/preview', saveBody());
  assert.equal(preview.status, 503);
  assert.equal((await call('GET', `/api/markers/records/${first.body.record.recordId}`)).status, 200);
  const listed = await call('GET', '/api/markers/records?repo=audio-root&path=folder/clip.wav');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.records.map((r) => r.recordId), [first.body.record.recordId]);
  assert.equal((await recordFiles(dir)).length, 1);
});

test('overrides: a violated after/before/within constraint passes with a reason and is stored; others still fail', async (t) => {
  const { call, dir } = await setup(t);
  const violating = [point('a1', 300, 'alpha'), point('b1', 200, 'beta')];
  const noOverride = await call('POST', '/api/markers/records', saveBody({ markers: violating }));
  assert.equal(noOverride.status, 422);
  const wrongMarker = await call('POST', '/api/markers/records', saveBody({ markers: violating, overrides: [{ markerId: 'a1', reason: 'by ear' }] }));
  assert.equal(wrongMarker.status, 422);
  const blank = await call('POST', '/api/markers/records', saveBody({ markers: violating, overrides: [{ markerId: 'b1', reason: ' ' }] }));
  assert.equal(blank.status, 422);
  const unknown = await call('POST', '/api/markers/records', saveBody({ markers: violating, overrides: [{ markerId: 'zzz', reason: 'x' }] }));
  assert.equal(unknown.status, 422);
  assert.deepEqual(await recordFiles(dir), []);
  const allowed = await call('POST', '/api/markers/records', saveBody({ markers: violating, overrides: [{ markerId: 'b1', reason: 'beta leads here' }] }));
  assert.equal(allowed.status, 201);
  assert.deepEqual(allowed.body.record.overrides, [{ markerId: 'b1', reason: 'beta leads here' }]);
  // Overrides never excuse other rules (required, range).
  const range = await call('POST', '/api/markers/records', saveBody({
    markers: [point('a1', 100, 'alpha'), point('b1', 999999, 'beta')], overrides: [{ markerId: 'b1', reason: 'x' }], supersedesRecord: { id: allowed.body.record.recordId },
  }));
  assert.equal(range.status, 422);
});

test('preview reports overridden violations as warnings', async (t) => {
  const { call } = await setup(t);
  const result = await call('POST', '/api/markers/preview', saveBody({
    markers: [point('a1', 300, 'alpha'), point('b1', 200, 'beta')], overrides: [{ markerId: 'b1', reason: 'by ear' }],
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.constraints.ok, true);
  assert.deepEqual(result.body.constraints.errors, []);
  assert.equal(result.body.constraints.warnings.length, 1);
  assert.equal(result.body.constraints.warnings[0].markerId, 'b1');
});

test('a skipped receipt lands on the record with no targetSha256After', async (t) => {
  const { call, state } = await setup(t);
  state.projectImpl = () => ({ kind: 'sample', mode: 'live', status: 'skipped', after: { sha256: SHA_TARGET } });
  const result = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(result.status, 201);
  assert.equal(result.body.record.projection.status, 'skipped');
  assert.equal('targetSha256After' in result.body, false);
});

test('an uncertain receipt lands on the record and still reports targetSha256After', async (t) => {
  const { call, state } = await setup(t);
  state.projectImpl = () => ({ kind: 'sample', mode: 'live', status: 'uncertain', targetSha256After: SHA_TARGET });
  const result = await call('POST', '/api/markers/records', saveBody({ projection: { id: 'sample-yaml', expectedTargetSha256: SHA } }));
  assert.equal(result.status, 201);
  assert.equal(result.body.record.projection.status, 'uncertain');
  assert.equal(result.body.targetSha256After, SHA_TARGET);
});
