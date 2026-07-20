'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ManagedRepoStore } = require('../lib/managed-repo-store');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-managed-store-'));
  const allowed = path.join(root, 'allowed');
  await fs.mkdir(allowed);
  const store = new ManagedRepoStore({
    storePath: path.join(root, 'registry.yaml'),
    allowRoots: [allowed],
    adminTokens: { operator: { secret: 'registry-admin-placeholder' } },
  });
  return { root, allowed, store };
}

test('managed repo store provides atomic CRUD, mtime conflicts, recovery, and bounded trees', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));

  const { repo } = setup.store.createRepo({
    repoId: 'shared-notes',
    rootPath: path.join(setup.allowed, 'shared-notes'),
  }, { tokenName: 'operator' });
  assert.equal(repo.id, 'shared-notes');
  assert.equal(setup.store.listRepos().repos.length, 1);
  assert.equal(setup.store.authenticateAdminToken('registry-admin-placeholder').tokenName, 'operator');

  const created = await setup.store.writeFile(repo, 'notes/topic.md', '# Topic\n', null);
  assert.equal(created.created, true);
  assert.equal((await setup.store.readFile(repo, 'notes/topic.md')).content, '# Topic\n');

  await assert.rejects(
    setup.store.writeFile(repo, 'notes/topic.md', '# Stale\n', created.mtimeMs - 1),
    (error) => error.code === 'ECONFLICT' && error.current.exists === true
  );
  const updated = await setup.store.writeFile(repo, 'notes/topic.md', '# Updated\n', created.mtimeMs);
  assert.equal(updated.created, false);
  assert.equal((await fs.readdir(path.join(repo.rootPath, 'notes'))).some((name) => name.endsWith('.tmp')), false);

  const concurrent = await Promise.allSettled([
    setup.store.writeFile(repo, 'notes/topic.md', '# Writer one\n', updated.mtimeMs),
    setup.store.writeFile(repo, 'notes/topic.md', '# Writer two\n', updated.mtimeMs),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected' && result.reason.code === 'ECONFLICT').length, 1);

  await setup.store.writeFile(repo, 'notes/second.md', 'second\n', null);
  const bounded = await setup.store.listTree(repo, '', { maxDepth: 10, maxEntries: 1 });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.truncated, true);

  const softDeleted = await setup.store.deleteFile(repo, 'notes/topic.md');
  assert.equal(softDeleted.deleted, 'soft');
  await assert.rejects(setup.store.readFile(repo, 'notes/topic.md'), { code: 'ENOENT' });
  await assert.rejects(
    setup.store.readFile(repo, `${repo.policy.trashDirName}/${softDeleted.trashId}/payload`),
    { code: 'EACCES' }
  );
  assert.deepEqual(await setup.store.restoreTrash(repo, softDeleted.trashId), {
    path: 'notes/topic.md',
    restored: true,
  });
  assert.match((await setup.store.readFile(repo, 'notes/topic.md')).content, /^# Writer (?:one|two)\n$/);

  const discarded = await setup.store.deleteFile(repo, 'notes/topic.md');
  assert.equal((await setup.store.hardDeleteTrash(repo, discarded.trashId)).deleted, 'hard');
  await assert.rejects(setup.store.getTrashMetadata(repo, discarded.trashId), { code: 'ENOENT' });
});

test('managed repo creation rejects a symlink ancestor that escapes the allow-root', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  const outside = path.join(setup.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(setup.allowed, 'escape'));

  assert.throws(
    () => setup.store.createRepo({
      repoId: 'escaped-repo',
      rootPath: path.join(setup.allowed, 'escape', 'created-outside'),
    }),
    (error) => error.code === 'EACCES'
  );
  await assert.rejects(fs.stat(path.join(outside, 'created-outside')), { code: 'ENOENT' });
});

test('managed file resolution rejects symlink escapes for reads and missing descendants', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  const { repo } = setup.store.createRepo({
    repoId: 'safe-repo',
    rootPath: path.join(setup.allowed, 'safe-repo'),
  });
  const outside = path.join(setup.root, 'outside-files');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'not visible\n');
  await fs.symlink(outside, path.join(repo.rootPath, 'linked'));

  await assert.rejects(setup.store.readFile(repo, 'linked/secret.md'), { code: 'EACCES' });
  await assert.rejects(setup.store.writeFile(repo, 'linked/new.md', 'escape\n'), { code: 'EACCES' });
  await assert.rejects(fs.stat(path.join(outside, 'new.md')), { code: 'ENOENT' });
});
