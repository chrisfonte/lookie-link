'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { MarkerRecordStore, normalizeMarkers } = require('../lib/markers/record-store');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-record-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++));
  const root = path.join(dir, 'records');
  return { root, store: new MarkerRecordStore({ storageRoot: root, clock }), clock };
}

function input(overrides = {}) {
  return {
    actor: { id: 'operator', type: 'operator' },
    reason: 'by ear',
    audio: { repo: 'audio-root', path: 'folder/clip.wav', sha256: SHA_A, sampleRate: 48000, channels: 2, frames: 100000 },
    templateId: 'sample',
    templateRevision: 1,
    markers: [
      { id: 'alpha', type: 'alpha', kind: 'point', sample: 500 },
      { type: 'span', kind: 'region', startSample: 10, endSample: 90, label: 'x' },
    ],
    tags: { scene: 'one' },
    ...overrides,
  };
}

test('round trip: shape, defaults, generated marker ids, 0600', async (t) => {
  const { store, root } = await setup(t);
  const record = await store.createRecord(input());
  assert.equal(record.contractVersion, 1);
  assert.equal(record.resourceKind, 'marker-record');
  assert.match(record.recordId, /^[0-9a-f-]{36}$/);
  assert.equal(record.receiptAt, '2026-10-07T12:00:00.000Z');
  assert.equal(record.supersedesRecord, null);
  assert.equal(record.projection, null);
  assert.equal('touched' in record, false);
  assert.deepEqual(record.markers[0], { id: 'alpha', type: 'alpha', kind: 'point', sample: 500, label: null, note: null });
  assert.match(record.markers[1].id, /^m-[0-9a-f]{4}$/);
  assert.equal(record.markers[1].note, null);
  const stat = await fs.stat(path.join(root, `${record.recordId}.json`));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(await store.getRecord(record.recordId), record);
  assert.equal(await store.getRecord('00000000-0000-4000-8000-000000000000'), null);
  assert.equal(await store.getRecord('../x'), null);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('.')), []);
});

test('overrides are validated and stored', async (t) => {
  const { store } = await setup(t);
  const record = await store.createRecord(input({ overrides: [{ markerId: 'alpha', reason: ' by ear ' }] }));
  assert.deepEqual(record.overrides, [{ markerId: 'alpha', reason: 'by ear' }]);
  for (const bad of [[{ markerId: 'alpha', reason: '' }], [{ markerId: 'alpha' }], 'x', [{ markerId: 'alpha', reason: 'r', extra: 1 }]]) {
    await assert.rejects(store.createRecord(input({ overrides: bad })), (error) => error.code === 'EVALIDATION' && error.details.some((d) => d.path === 'overrides'));
  }
});

test('touched is stored when given', async (t) => {
  const { store } = await setup(t);
  const record = await store.createRecord(input({ touched: ['alpha', 'alpha', 'gone'] }));
  assert.deepEqual(record.touched, ['alpha', 'gone']);
});

test('creation never overwrites an existing id', async (t) => {
  const { store, root } = await setup(t);
  const recordId = '11111111-1111-4111-8111-111111111111';
  await store.createRecord(input({ recordId }));
  const before = await fs.readFile(path.join(root, `${recordId}.json`), 'utf8');
  await assert.rejects(store.createRecord(input({ recordId, audio: { ...input().audio, sha256: SHA_B } })), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(root, `${recordId}.json`), 'utf8'), before);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('validation errors carry details', async (t) => {
  const { store } = await setup(t);
  const cases = [
    [{ templateRevision: 0 }, 'templateRevision'],
    [{ templateId: 'Bad Id' }, 'templateId'],
    [{ audio: { ...input().audio, sha256: 'xyz' } }, 'audio.sha256'],
    [{ audio: { ...input().audio, frames: -1 } }, 'audio.frames'],
    [{ markers: 'nope' }, 'markers'],
    [{ markers: [{ id: 'a', type: 't', kind: 'blob' }] }, 'markers[0].kind'],
    [{ markers: [{ id: 'a', type: 't', kind: 'point', sample: 1, extra: 1 }] }, 'markers[0].extra'],
    [{ markers: [{ id: 'dup', type: 't', kind: 'point', sample: 1 }, { id: 'dup', type: 't', kind: 'point', sample: 2 }] }, 'markers[1].id'],
    [{ actor: { id: 'x', type: 'operator', name: 'bad\nname', nameSource: 'config' } }, 'actor.name'],
    [{ supersedesRecord: { id: 'not-a-uuid' } }, 'supersedesRecord'],
    [{ unknownField: 1 }, 'unknownField'],
  ];
  for (const [overrides, expectedPath] of cases) {
    await assert.rejects(store.createRecord(input(overrides)), (error) => {
      assert.equal(error.code, 'EVALIDATION');
      assert.ok(error.details.some((detail) => detail.path === expectedPath), `${expectedPath}: ${JSON.stringify(error.details)}`);
      return true;
    });
  }
});

test('normalizeMarkers generates unique ids', () => {
  const markers = normalizeMarkers(Array.from({ length: 50 }, (_, i) => ({ type: 't', kind: 'point', sample: i })));
  assert.equal(new Set(markers.map((marker) => marker.id)).size, 50);
});

test('supersession chain, history and listing', async (t) => {
  const { store } = await setup(t);
  const first = await store.createRecord(input());
  const second = await store.createRecord(input({ supersedesRecord: { resourceKind: 'marker-record', id: first.recordId } }));
  const third = await store.createRecord(input({ supersedesRecord: { id: second.recordId } }));
  assert.equal((await store.latestFor(SHA_A, 'sample')).recordId, third.recordId);
  assert.equal((await store.resolveLatest(first.recordId)).recordId, third.recordId);
  const history = await store.getHistory(first.recordId);
  assert.equal(history.latest.recordId, third.recordId);
  assert.deepEqual(history.predecessors.map((record) => record.recordId), [second.recordId, first.recordId]);
  assert.deepEqual((await store.listLatest({ sha256: SHA_A })).map((record) => record.recordId), [third.recordId]);
  assert.equal((await store.listLatest({ sha256: SHA_A, all: true })).length, 3);
  assert.equal((await store.listLatest({ repo: 'audio-root', path: 'folder/clip.wav' })).length, 1);
  assert.equal((await store.listLatest({ repo: 'audio-root', path: 'elsewhere.wav' })).length, 0);
  assert.equal((await store.listLatest({ templateId: 'other' })).length, 0);
  assert.equal(await store.getHistory('00000000-0000-4000-8000-000000000000'), null);
});

test('stale-latest rule: one code for a newer record', async (t) => {
  const { store } = await setup(t);
  const first = await store.createRecord(input());
  // No predecessor named while a latest exists.
  await assert.rejects(store.createRecord(input()), (error) => {
    assert.equal(error.code, 'ESTALE_LATEST');
    assert.equal(error.currentRecordId, first.recordId);
    assert.equal(error.currentRecord.recordId, first.recordId);
    return true;
  });
  const second = await store.createRecord(input({ supersedesRecord: { id: first.recordId } }));
  // Predecessor already superseded.
  await assert.rejects(store.createRecord(input({ supersedesRecord: { id: first.recordId } })), (error) => {
    assert.equal(error.code, 'ESTALE_LATEST');
    assert.equal(error.currentRecordId, second.recordId);
    return true;
  });
  assert.equal((await store.listLatest({ all: true })).length, 2);
});

test('a predecessor of another template or audio is not found; other keys are independent', async (t) => {
  const { store } = await setup(t);
  const first = await store.createRecord(input());
  await assert.rejects(store.createRecord(input({ templateId: 'other', supersedesRecord: { id: first.recordId } })), { code: 'ENOTFOUND' });
  // Same template, different bytes: a distinct code (the route maps it to 409 revision_conflict).
  await assert.rejects(store.createRecord(input({ audio: { ...input().audio, sha256: SHA_B }, supersedesRecord: { id: first.recordId } })),
    { code: 'ESTALE_AUDIO', message: 'the audio bytes changed since that record' });
  await assert.rejects(store.createRecord(input({ supersedesRecord: { id: '22222222-2222-4222-8222-222222222222' } })), { code: 'ENOTFOUND' });
  // Different template or bytes: their own first record needs no predecessor.
  await store.createRecord(input({ templateId: 'other' }));
  await store.createRecord(input({ audio: { ...input().audio, sha256: SHA_B, path: 'copy.wav' } }));
  assert.equal((await store.listLatest({})).length, 3);
});

test('same bytes under two paths share one history', async (t) => {
  const { store } = await setup(t);
  const first = await store.createRecord(input());
  await assert.rejects(store.createRecord(input({ audio: { ...input().audio, path: 'moved/clip.wav' } })), { code: 'ESTALE_LATEST' });
  const second = await store.createRecord(input({ audio: { ...input().audio, path: 'moved/clip.wav' }, supersedesRecord: { id: first.recordId } }));
  assert.equal(second.audio.path, 'moved/clip.wav');
});

test('latest is found by scanning disk: a fresh store instance sees prior records', async (t) => {
  const { store, root, clock } = await setup(t);
  const first = await store.createRecord(input());
  const fresh = new MarkerRecordStore({ storageRoot: root, clock });
  assert.equal((await fresh.latestFor(SHA_A, 'sample')).recordId, first.recordId);
  await assert.rejects(fresh.createRecord(input()), { code: 'ESTALE_LATEST' });
  // Files that are not records are ignored.
  await fs.writeFile(path.join(root, 'notes.json'), '{}');
  await fs.writeFile(path.join(root, '33333333-3333-4333-8333-333333333333.json'), 'not json');
  assert.equal((await fresh.listLatest({})).length, 1);
});

test('withSaveLock serializes per key, not across keys, across instances', async (t) => {
  const { store, root, clock } = await setup(t);
  const other = new MarkerRecordStore({ storageRoot: root, clock });
  const order = [];
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.open = resolve; });
  const one = store.withSaveLock(SHA_A, 'sample', async () => { order.push('one-start'); await gate.promise; order.push('one-end'); });
  const two = other.withSaveLock(SHA_A, 'sample', async () => { order.push('two'); });
  const three = store.withSaveLock(SHA_B, 'sample', async () => { order.push('three'); });
  await three;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['one-start', 'three']);
  gate.open();
  await Promise.all([one, two]);
  assert.deepEqual(order, ['one-start', 'three', 'one-end', 'two']);
});

test('concurrent creates for the same key: exactly one wins', async (t) => {
  const { store } = await setup(t);
  const results = await Promise.allSettled([store.createRecord(input()), store.createRecord(input()), store.createRecord(input())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'ESTALE_LATEST'));
});

test('buildRecord does not write; persistRecord with lockHeld and skipChecks writes', async (t) => {
  const { store, root } = await setup(t);
  const first = await store.createRecord(input());
  const built = store.buildRecord(input({ recordId: store.newRecordId() }));
  assert.equal((await fs.readdir(root)).length, 1);
  await store.withSaveLock(SHA_A, 'sample', async () => {
    await assert.rejects(store.persistRecord(built, { lockHeld: true }), { code: 'ESTALE_LATEST' });
    const saved = await store.persistRecord({ ...built, projection: { status: 'applied' } }, { lockHeld: true, skipChecks: true });
    assert.equal(saved.projection.status, 'applied');
  });
  assert.equal((await fs.readdir(root)).length, 2);
  assert.ok(first);
});
