'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { canonicalize } = require('../lib/forms/canonical');
const { MarkerTemplateStore } = require('../lib/markers/template-store');

function sample(overrides = {}) {
  return {
    templateId: 'sample',
    title: 'Sample',
    unit: 'ms',
    markers: [{ id: 'a', label: 'A', kind: 'point', color: '#112233' }],
    ...overrides,
  };
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-templates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const logger = { warn: (message, details) => warnings.push({ message, details }) };
  const templatesPath = path.join(dir, 'templates');
  const store = new MarkerTemplateStore({ templatesPath, logger });
  return { dir, templatesPath, store, warnings };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('list includes bundled templates, read-only, even before the directory exists', async (t) => {
  const { store } = await setup(t);
  const entries = await store.list();
  assert.deepEqual(entries.map((e) => e.templateId), ['freeform', 'radio-imaging', 'song-structure']);
  for (const entry of entries) {
    assert.equal(entry.source, 'bundled');
    assert.equal(entry.writable, false);
  }
  const got = await store.get('freeform');
  assert.equal(got.title, 'Free-form markers');
  assert.equal(got.source, 'bundled');
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.get('../etc'), null);
});

test('returned entries are copies', async (t) => {
  const { store } = await setup(t);
  const first = await store.get('freeform');
  first.markers.length = 0;
  assert.equal((await store.get('freeform')).markers.length, 2);
});

test('create, get, update, remove lifecycle with revision CAS', async (t) => {
  const { store, templatesPath } = await setup(t);
  const created = await store.create(sample());
  assert.equal(created.revision, 1);
  assert.equal(created.contractVersion, 1);
  assert.equal(created.resourceKind, 'marker-template');
  assert.equal(created.source, 'stored');
  assert.equal(created.writable, true);

  const file = path.join(templatesPath, 'sample.json');
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const bytes = await fs.readFile(file, 'utf8');
  const onDisk = JSON.parse(bytes);
  assert.equal(bytes, canonicalize(onDisk));
  assert.equal(onDisk.source, undefined);
  assert.equal(onDisk.writable, undefined);

  assert.deepEqual((await store.list()).map((e) => e.templateId), ['freeform', 'radio-imaging', 'sample', 'song-structure']);
  assert.equal((await store.get('sample')).title, 'Sample');

  const updated = await store.update('sample', 1, {
    title: 'Renamed', templateId: 'other', revision: 99, contractVersion: 7, description: 'Text',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.templateId, 'sample');
  assert.equal(updated.contractVersion, 1);
  assert.equal((await store.get('sample')).description, 'Text');

  const cleared = await store.update('sample', 2, { description: null });
  assert.equal(cleared.revision, 3);
  assert.equal(cleared.description, undefined);

  await rejects(store.update('sample', 2, { title: 'Late' }), 'ESTALE');
  await rejects(store.remove('sample', 2), 'ESTALE');
  assert.equal((await store.get('sample')).revision, 3);

  assert.equal(await store.remove('sample', 3), true);
  assert.equal(await store.get('sample'), null);
  await rejects(store.remove('sample', 3), 'ENOTFOUND');
  await rejects(store.update('sample', 3, { title: 'x' }), 'ENOTFOUND');
  assert.deepEqual((await fs.readdir(templatesPath)).filter((n) => n.endsWith('.tmp')), []);
});

test('stale error carries the current revision', async (t) => {
  const { store } = await setup(t);
  await store.create(sample());
  await store.update('sample', 1, { title: 'B' });
  await assert.rejects(store.update('sample', 1, { title: 'C' }), (error) => {
    assert.equal(error.code, 'ESTALE');
    assert.equal(error.currentRevision, 2);
    return true;
  });
});

test('invalid create and update are EVALIDATION with details and write nothing', async (t) => {
  const { store, templatesPath } = await setup(t);
  await assert.rejects(store.create(sample({ unit: 'frames' })), (error) => {
    assert.equal(error.code, 'EVALIDATION');
    assert.ok(error.details.some((d) => d.path === 'unit'));
    return true;
  });
  await rejects(store.create(sample({ revision: 4 })), 'EVALIDATION');
  await rejects(store.create('nope'), 'EVALIDATION');
  await store.create(sample());
  await rejects(store.update('sample', 1, { markers: [] }), 'EVALIDATION');
  await rejects(store.update('sample', 1, { surprise: true }), 'EVALIDATION');
  assert.equal((await store.get('sample')).revision, 1);
  assert.deepEqual(await fs.readdir(templatesPath), ['sample.json']);
});

test('bundled ids conflict on create and are read-only on update and remove', async (t) => {
  const { store } = await setup(t);
  await rejects(store.create(sample({ templateId: 'freeform' })), 'ECONFLICT');
  await rejects(store.update('song-structure', 1, { title: 'x' }), 'EREADONLY');
  await rejects(store.remove('radio-imaging', 1), 'EREADONLY');
});

test('duplicate create is ECONFLICT', async (t) => {
  const { store } = await setup(t);
  await store.create(sample());
  await rejects(store.create(sample()), 'ECONFLICT');
});

test('concurrent updates serialize under the per-id mutex', async (t) => {
  const { store } = await setup(t);
  await store.create(sample());
  const results = await Promise.allSettled([
    store.update('sample', 1, { title: 'one' }),
    store.update('sample', 1, { title: 'two' }),
    store.update('sample', 1, { title: 'three' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'ESTALE').length, 2);
  assert.equal((await store.get('sample')).revision, 2);
});

test('invalid, mismatched, symlinked and bundled-id files are skipped and logged', async (t) => {
  const { dir, store, templatesPath, warnings } = await setup(t);
  await fs.mkdir(templatesPath, { recursive: true });
  const good = { contractVersion: 1, resourceKind: 'marker-template', revision: 1, ...sample({ templateId: 'good' }) };
  await fs.writeFile(path.join(templatesPath, 'good.json'), canonicalize(good));
  await fs.writeFile(path.join(templatesPath, 'broken.json'), '{not json');
  await fs.writeFile(path.join(templatesPath, 'invalid.json'), canonicalize({ ...good, templateId: 'invalid', unit: 'x' }));
  await fs.writeFile(path.join(templatesPath, 'wrong-name.json'), canonicalize({ ...good, templateId: 'other' }));
  await fs.writeFile(path.join(templatesPath, 'freeform.json'), canonicalize({ ...good, templateId: 'freeform' }));
  await fs.writeFile(path.join(dir, 'outside.json'), canonicalize({ ...good, templateId: 'linked' }));
  await fs.symlink(path.join(dir, 'outside.json'), path.join(templatesPath, 'linked.json'));
  await fs.writeFile(path.join(templatesPath, 'notes.txt'), 'x');

  const entries = await store.list();
  assert.deepEqual(entries.map((e) => e.templateId), ['freeform', 'good', 'radio-imaging', 'song-structure']);
  assert.equal(entries.find((e) => e.templateId === 'freeform').source, 'bundled');
  assert.equal(await store.get('linked'), null);
  assert.equal(await store.get('broken'), null);
  const logged = JSON.stringify(warnings);
  for (const name of ['broken.json', 'invalid.json', 'wrong-name.json', 'freeform.json', 'linked.json']) {
    assert.ok(logged.includes(name), `expected a warning naming ${name}`);
  }
});

test('missing templatesPath option throws', () => {
  assert.throws(() => new MarkerTemplateStore({}), /templatesPath/);
});
