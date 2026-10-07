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
  assert.throws(() => new MarkerTemplateStore({ templatesPaths: [] }), /templatesPath/);
  assert.throws(() => new MarkerTemplateStore({ templatesPaths: ['/x', ''] }), /templatesPath/);
});

async function setupMulti(t) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-templates-multi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const logger = { warn: (message, details) => warnings.push({ message, details }) };
  const writable = path.join(dir, 'writable');
  const readOnly = path.join(dir, 'read-only');
  const second = path.join(dir, 'second');
  await fs.mkdir(readOnly, { recursive: true });
  await fs.mkdir(second, { recursive: true });
  const store = new MarkerTemplateStore({ templatesPaths: [writable, readOnly, second], logger });
  const write = (directory, overrides) => fs.writeFile(
    path.join(directory, `${overrides.templateId}.json`),
    canonicalize({ contractVersion: 1, resourceKind: 'marker-template', revision: 1, ...sample(overrides) }),
  );
  return { store, writable, readOnly, second, warnings, write };
}

test('read-only extra directories list as file templates and refuse mutation', async (t) => {
  const { store, readOnly, second, warnings, write } = await setupMulti(t);
  await write(readOnly, { templateId: 'shared', title: 'From first' });
  await write(second, { templateId: 'shared', title: 'From second' });
  await write(second, { templateId: 'extra' });
  await write(readOnly, { templateId: 'freeform' });

  const entries = await store.list();
  assert.deepEqual(entries.map((e) => e.templateId), ['extra', 'freeform', 'radio-imaging', 'shared', 'song-structure']);
  const shared = entries.find((e) => e.templateId === 'shared');
  assert.equal(shared.source, 'file');
  assert.equal(shared.writable, false);
  assert.equal(shared.title, 'From first');
  assert.equal(entries.find((e) => e.templateId === 'freeform').source, 'bundled');
  assert.ok(warnings.length >= 2);
  const got = await store.get('extra');
  assert.equal(got.source, 'file');
  assert.equal(got.writable, false);

  await rejects(store.update('extra', 1, { title: 'x' }), 'EREADONLY');
  await rejects(store.remove('extra', 1), 'EREADONLY');
  await rejects(store.create(sample({ templateId: 'extra' })), 'ECONFLICT');
  await rejects(store.update('ghost', 1, { title: 'x' }), 'ENOTFOUND');
  assert.equal((await store.get('extra')).revision, 1);
});

test('a writable template wins over a read-only one with the same id and logs a warning', async (t) => {
  const { store, writable, readOnly, warnings, write } = await setupMulti(t);
  await fs.mkdir(writable, { recursive: true });
  await write(readOnly, { templateId: 'clash', title: 'Read only' });
  await write(writable, { templateId: 'clash', title: 'Writable' });

  const entries = await store.list();
  const clash = entries.find((e) => e.templateId === 'clash');
  assert.equal(clash.title, 'Writable');
  assert.equal(clash.source, 'stored');
  assert.equal(clash.writable, true);
  assert.ok(warnings.some((w) => w.details && w.details.file === 'clash.json'));
  assert.equal((await store.get('clash')).title, 'Writable');
  assert.ok(warnings.some((w) => /shadows/.test(w.message)));
  const updated = await store.update('clash', 1, { title: 'Edited' });
  assert.equal(updated.title, 'Edited');
});

test('update copies the replaced revision to .history and getRevision reads it', async (t) => {
  const { store, templatesPath } = await setup(t);
  await store.create(sample());
  const v1Bytes = await fs.readFile(path.join(templatesPath, 'sample.json'), 'utf8');
  await store.update('sample', 1, { title: 'Two' });
  await store.update('sample', 2, { title: 'Three' });

  const historyDir = path.join(templatesPath, '.history', 'sample');
  assert.deepEqual((await fs.readdir(historyDir)).sort(), ['r1.json', 'r2.json']);
  assert.equal(await fs.readFile(path.join(historyDir, 'r1.json'), 'utf8'), v1Bytes);
  assert.equal((await fs.stat(path.join(historyDir, 'r1.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(historyDir, 'r2.json'), 'utf8')).title, 'Two');

  const first = await store.getRevision('sample', 1);
  assert.equal(first.title, 'Sample');
  assert.equal(first.revision, 1);
  assert.equal(first.writable, false);
  assert.equal((await store.getRevision('sample', 2)).title, 'Two');
  const current = await store.getRevision('sample', 3);
  assert.equal(current.title, 'Three');
  assert.equal(current.writable, true);
  assert.equal(await store.getRevision('sample', 4), null);
  assert.equal(await store.getRevision('sample', 0), null);
  assert.equal(await store.getRevision('sample', '1'), null);
  assert.equal(await store.getRevision('ghost', 1), null);
  assert.equal(await store.getRevision('../x', 1), null);
  assert.equal((await store.getRevision('freeform', 1)).source, 'bundled');
  assert.equal(await store.getRevision('freeform', 2), null);

  // .history is not scanned as a template and leaves no temp files behind
  assert.deepEqual((await store.list()).map((e) => e.templateId), ['freeform', 'radio-imaging', 'sample', 'song-structure']);
  assert.deepEqual((await fs.readdir(historyDir)).filter((n) => n.endsWith('.tmp')), []);
});

test('a failed update (stale or invalid) writes no history', async (t) => {
  const { store, templatesPath } = await setup(t);
  await store.create(sample());
  await rejects(store.update('sample', 5, { title: 'x' }), 'ESTALE');
  await rejects(store.update('sample', 1, { markers: [] }), 'EVALIDATION');
  await assert.rejects(fs.readdir(path.join(templatesPath, '.history')), { code: 'ENOENT' });
});

test('remove is a tombstone: history stays, getRevision works, get is null, recreate is refused', async (t) => {
  const { store, templatesPath } = await setup(t);
  await store.create(sample());
  await store.update('sample', 1, { title: 'Two' });
  assert.equal(await store.remove('sample', 2), true);

  assert.equal(await store.get('sample'), null);
  assert.deepEqual((await store.list()).map((e) => e.templateId), ['freeform', 'radio-imaging', 'song-structure']);
  assert.equal((await store.getRevision('sample', 1)).title, 'Sample');
  const last = await store.getRevision('sample', 2);
  assert.equal(last.title, 'Two');
  assert.equal(last.writable, false);
  assert.equal(await store.getRevision('sample', 3), null);

  const historyDir = path.join(templatesPath, '.history', 'sample');
  assert.deepEqual((await fs.readdir(historyDir)).sort(), ['r1.json', 'r2.json', 'tombstone.json']);
  assert.equal(JSON.parse(await fs.readFile(path.join(historyDir, 'tombstone.json'), 'utf8')).revision, 2);
  await assert.rejects(fs.lstat(path.join(templatesPath, 'sample.json')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(templatesPath, '.history'))).filter((n) => n.includes('removed')).length, 0);

  await rejects(store.create(sample({ title: 'Again' })), 'ECONFLICT');
  await rejects(store.update('sample', 2, { title: 'x' }), 'ENOTFOUND');
  await rejects(store.remove('sample', 2), 'ENOTFOUND');
  assert.equal(await store.get('sample'), null);
});

test('create with restore revives a tombstone at the next revision and keeps history', async (t) => {
  const { store, templatesPath } = await setup(t);
  await store.create(sample());
  await store.update('sample', 1, { title: 'Two' });
  await store.remove('sample', 2);

  await rejects(store.create(sample({ revision: 1 }), { restore: true }), 'EVALIDATION');
  const restored = await store.create(sample({ title: 'Back' }), { restore: true });
  assert.equal(restored.revision, 3);
  assert.equal((await store.get('sample')).title, 'Back');
  assert.equal((await store.getRevision('sample', 2)).title, 'Two');
  assert.equal((await store.getRevision('sample', 1)).title, 'Sample');
  assert.deepEqual((await fs.readdir(path.join(templatesPath, '.history', 'sample'))).sort(), ['r1.json', 'r2.json']);
  const next = await store.update('sample', 3, { title: 'Four' });
  assert.equal(next.revision, 4);
  assert.equal((await store.getRevision('sample', 3)).title, 'Back');
  // restore on an id that was never removed behaves like create
  const fresh = await store.create(sample({ templateId: 'fresh' }), { restore: true });
  assert.equal(fresh.revision, 1);
});

test('read-only template history is imported on load and served for older revisions', async (t) => {
  const { store, writable, readOnly, write } = await setupMulti(t);
  await write(readOnly, { templateId: 'shared', title: 'Rev one' });
  const loaded = await store.load();
  assert.equal(loaded.find((e) => e.templateId === 'shared').title, 'Rev one');
  const historyFile = path.join(writable, '.history', 'shared', 'r1.json');
  const bytes = await fs.readFile(historyFile, 'utf8');
  assert.equal(bytes, await fs.readFile(path.join(readOnly, 'shared.json'), 'utf8'));
  assert.equal((await fs.stat(historyFile)).mode & 0o777, 0o600);

  // git moves the read-only file to revision 2; the old revision stays renderable
  await write(readOnly, { templateId: 'shared', title: 'Rev two', revision: 2 });
  assert.equal((await store.get('shared')).revision, 2);
  assert.equal((await store.getRevision('shared', 1)).title, 'Rev one');
  assert.equal((await store.getRevision('shared', 2)).title, 'Rev two');
  assert.deepEqual((await fs.readdir(path.join(writable, '.history', 'shared'))).sort(), ['r1.json', 'r2.json']);
  // reading again is idempotent
  assert.equal((await store.list()).find((e) => e.templateId === 'shared').revision, 2);
});

test('a read-only template whose revision has different history bytes is skipped with a warning', async (t) => {
  const { store, writable, readOnly, warnings, write } = await setupMulti(t);
  await write(readOnly, { templateId: 'shared', title: 'Original' });
  await store.load();
  await write(readOnly, { templateId: 'shared', title: 'Edited without a bump' });

  assert.equal((await store.list()).some((e) => e.templateId === 'shared'), false);
  assert.equal(await store.get('shared'), null);
  assert.ok(warnings.some((w) => /Refusing read-only/.test(w.message) && w.details.templateId === 'shared'));
  // pinned records still render the original bytes
  assert.equal((await store.getRevision('shared', 1)).title, 'Original');
  assert.equal(JSON.parse(await fs.readFile(path.join(writable, '.history', 'shared', 'r1.json'), 'utf8')).title, 'Original');
  // a refused id is not handed to a later entry, and the warning is not repeated
  assert.equal(warnings.filter((w) => /Refusing read-only/.test(w.message)).length, 1);
});

test('a refused read-only template still claims its id against later entries', async (t) => {
  const { store, readOnly, second, write } = await setupMulti(t);
  await write(readOnly, { templateId: 'shared', title: 'Original' });
  await store.load();
  await write(readOnly, { templateId: 'shared', title: 'Edited' });
  await write(second, { templateId: 'shared', title: 'Other' });
  assert.equal(await store.get('shared'), null);
  assert.equal((await store.list()).some((e) => e.templateId === 'shared'), false);
});

test('ids are unique across entries: the first read-only entry wins and the collision is logged', async (t) => {
  const { store, writable, readOnly, second, warnings, write } = await setupMulti(t);
  await write(readOnly, { templateId: 'dup', title: 'First' });
  await write(second, { templateId: 'dup', title: 'Second' });
  const entries = await store.load();
  assert.equal(entries.find((e) => e.templateId === 'dup').title, 'First');
  assert.equal((await store.get('dup')).title, 'First');
  assert.ok(warnings.some((w) => /already provided/.test(w.message) && w.details.file === 'dup.json'));
  // only the winner's history is imported
  assert.equal(JSON.parse(await fs.readFile(path.join(writable, '.history', 'dup', 'r1.json'), 'utf8')).title, 'First');
  await rejects(store.create(sample({ templateId: 'dup' })), 'ECONFLICT');
  await rejects(store.update('dup', 1, { title: 'x' }), 'EREADONLY');
});

test('an existing history file with different bytes refuses the update', async (t) => {
  const { store, templatesPath } = await setup(t);
  await store.create(sample());
  const historyDir = path.join(templatesPath, '.history', 'sample');
  await fs.mkdir(historyDir, { recursive: true });
  await fs.writeFile(path.join(historyDir, 'r1.json'), '{"other":true}');
  await rejects(store.update('sample', 1, { title: 'x' }), 'ECONFLICT');
  assert.equal((await store.get('sample')).revision, 1);
  // identical bytes (a retry after a crash) are accepted
  await fs.writeFile(path.join(historyDir, 'r1.json'), canonicalize(await store.getRevision('sample', 1).then(({ source, writable, ...doc }) => doc)));
  assert.equal((await store.update('sample', 1, { title: 'x' })).revision, 2);
});

test('listWithSkipped names every skipped file by base name with a short reason', async (t) => {
  const { dir, store, templatesPath } = await setup(t);
  const readOnly = path.join(dir, 'shared');
  const withShared = new MarkerTemplateStore({ templatesPath, templatesPaths: [templatesPath, readOnly], logger: { warn() {} } });
  await fs.mkdir(templatesPath, { recursive: true });
  await fs.mkdir(readOnly, { recursive: true });
  const good = { contractVersion: 1, resourceKind: 'marker-template', revision: 1, ...sample({ templateId: 'good' }) };
  await fs.writeFile(path.join(templatesPath, 'good.json'), canonicalize(good));
  await fs.writeFile(path.join(templatesPath, 'broken.json'), '{not json');
  await fs.writeFile(path.join(templatesPath, 'invalid.json'), canonicalize({ ...good, templateId: 'invalid', unit: 'x' }));
  await fs.writeFile(path.join(templatesPath, 'wrong-name.json'), canonicalize({ ...good, templateId: 'other' }));
  await fs.writeFile(path.join(templatesPath, 'freeform.json'), canonicalize({ ...good, templateId: 'freeform' }));
  await fs.writeFile(path.join(templatesPath, 'Bad_Name.json'), '{}');
  await fs.writeFile(path.join(templatesPath, 'notes.txt'), 'x');
  await fs.writeFile(path.join(readOnly, 'shared-bad.json'), canonicalize({ ...good, templateId: 'shared-bad', markers: [] }));
  await fs.writeFile(path.join(readOnly, 'good.json'), canonicalize(good));

  for (const target of [store, withShared]) {
    const { templates, skipped } = await target.listWithSkipped();
    assert.ok(templates.some((entry) => entry.templateId === 'good'));
    const byFile = Object.fromEntries(skipped.map((entry) => [entry.file, entry]));
    assert.deepEqual(Object.keys(byFile).sort(), target === store
      ? ['Bad_Name.json', 'broken.json', 'freeform.json', 'invalid.json', 'wrong-name.json']
      : ['Bad_Name.json', 'broken.json', 'freeform.json', 'good.json', 'invalid.json', 'shared-bad.json', 'wrong-name.json']);
    assert.equal(byFile['broken.json'].reason, 'parse error: SyntaxError');
    assert.match(byFile['invalid.json'].reason, /^unit: must be one of/);
    assert.equal(byFile['wrong-name.json'].reason, 'templateId does not match the file name');
    assert.equal(byFile['freeform.json'].reason, 'id is reserved by a bundled template');
    assert.equal(byFile['Bad_Name.json'].reason, 'invalid file name');
    assert.equal(byFile['invalid.json'].source, 'stored');
    for (const entry of skipped) {
      assert.deepEqual(Object.keys(entry).sort(), ['file', 'reason', 'source']);
      assert.ok(!entry.file.includes('/') && !entry.reason.includes(dir));
    }
    if (target === withShared) {
      assert.deepEqual(byFile['shared-bad.json'], { file: 'shared-bad.json', source: 'file', reason: byFile['shared-bad.json'].reason });
      assert.match(byFile['shared-bad.json'].reason, /^markers: /);
      assert.equal(byFile['good.json'].source, 'file');
      assert.equal(byFile['good.json'].reason, 'id is already provided by another template');
    }
  }
  assert.deepEqual((await store.list()).map((e) => e.templateId), ['freeform', 'good', 'radio-imaging', 'song-structure']);
});

test('listWithSkipped is empty when every file is usable', async (t) => {
  const { store } = await setup(t);
  await store.create(sample());
  assert.deepEqual((await store.listWithSkipped()).skipped, []);
});
