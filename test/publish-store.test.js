'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { PublishStore } = require('../lib/publish-store');

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-publish-store-'));
  return {
    root,
    store: new PublishStore({ areaPath: path.join(root, 'published'), ...options }),
  };
}

async function removeFixture(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('publish revisions are immutable snapshots and stale updates cannot mutate history', async () => {
  const { root, store } = await fixture();
  try {
    await store.createPublication({
      slug: 'release-notes',
      files: [{ path: 'index.md', content: '# One\n' }, { path: 'asset.txt', content: 'first' }],
      entryPath: 'index.md',
    });
    await store.updatePublication('release-notes', {
      expectedRevision: 1,
      files: [{ path: 'index.md', content: '# Two\n' }, { path: 'asset.txt', content: 'second' }],
      entryPath: 'index.md',
    });

    assert.equal(await fs.readFile((await store.resolvePath('release-notes', 'asset.txt', 1)).resolved, 'utf8'), 'first');
    assert.equal(await fs.readFile((await store.resolvePath('release-notes', 'asset.txt')).resolved, 'utf8'), 'second');
    await assert.rejects(
      store.updatePublication('release-notes', {
        expectedRevision: 1,
        files: [{ path: 'index.md', content: '# Stale\n' }],
      }),
      (error) => error.code === 'ECONFLICT' && error.current.currentRevision === 2
    );
    assert.equal(await fs.readFile((await store.resolvePath('release-notes', 'index.md', 1)).resolved, 'utf8'), '# One\n');
  } finally {
    await removeFixture(root);
  }
});

test('a failed multi-file create is never visible as a half-written revision', async () => {
  const { root, store } = await fixture();
  try {
    const originalWrite = store.writeRevisionFiles.bind(store);
    store.writeRevisionFiles = async (target, files) => {
      await originalWrite(target, files.slice(0, 1));
      throw new Error('injected second-file failure');
    };
    await assert.rejects(store.createPublication({
      slug: 'atomic-create',
      files: [{ path: 'one.txt', content: 'one' }, { path: 'two.txt', content: 'two' }],
    }), /injected second-file failure/);
    assert.equal(await store.readPublication('atomic-create'), null);
    const entries = await fs.readdir(store.getRuntimeRoot());
    assert.deepEqual(entries, []);
  } finally {
    await removeFixture(root);
  }
});

test('a metadata failure rolls back a staged update and leaves the prior revision current', async () => {
  const { root, store } = await fixture();
  try {
    await store.createPublication({ slug: 'atomic-update', files: [{ path: 'index.md', content: 'one' }] });
    const originalWriteJson = store.writeJsonFile.bind(store);
    store.writeJsonFile = async (target, value) => {
      if (target === store.publicationMetadataPath('atomic-update') && value.currentRevision === 2) {
        throw new Error('injected metadata failure');
      }
      return originalWriteJson(target, value);
    };
    await assert.rejects(store.updatePublication('atomic-update', {
      expectedRevision: 1,
      files: [{ path: 'index.md', content: 'two' }],
    }), /injected metadata failure/);
    assert.equal((await store.readPublication('atomic-update')).currentRevision, 1);
    await assert.rejects(fs.access(store.revisionDir('atomic-update', 2)), { code: 'ENOENT' });
    assert.equal(await fs.readFile((await store.resolvePath('atomic-update', 'index.md')).resolved, 'utf8'), 'one');
  } finally {
    await removeFixture(root);
  }
});

test('an unreferenced revision left by interruption is recovered before retry', async () => {
  const { root, store } = await fixture();
  try {
    await store.createPublication({ slug: 'recover-update', files: [{ path: 'index.md', content: 'one' }] });
    const orphan = store.revisionDir('recover-update', 2);
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'half.txt'), 'half');

    const result = await store.updatePublication('recover-update', {
      expectedRevision: 1,
      files: [{ path: 'index.md', content: 'complete' }],
    });
    assert.equal(result.publication.currentRevision, 2);
    assert.equal(await fs.readFile(path.join(orphan, 'index.md'), 'utf8'), 'complete');
    await assert.rejects(fs.access(path.join(orphan, 'half.txt')), { code: 'ENOENT' });
  } finally {
    await removeFixture(root);
  }
});

test('publish rejects slug traversal, file traversal, and symlink ancestors', async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(store.createPublication({ slug: '../escape', files: [{ path: 'x.txt', content: 'x' }] }), /slug is invalid/);
    for (const badPath of ['../escape.txt', 'dir/../../escape.txt', '/absolute.txt', 'dir\\escape.txt']) {
      await assert.rejects(store.createPublication({ slug: 'safe-slug', files: [{ path: badPath, content: 'x' }] }), /path is invalid/);
    }
    await fs.mkdir(store.getRuntimeRoot(), { recursive: true });
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, store.publicationDir('linked-slug'));
    await assert.rejects(
      store.createPublication({ slug: 'linked-slug', files: [{ path: 'x.txt', content: 'x' }] }),
      (error) => error.code === 'EACCES'
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await removeFixture(root);
  }
});

test('publish enforces file, byte, metadata, and revision limits without exposing private metadata', async () => {
  const { root, store } = await fixture({
    maxFiles: 1,
    maxFileBytes: 4,
    maxRevisionBytes: 4,
    maxMetadataBytes: 24,
    maxRevisions: 1,
  });
  try {
    await assert.rejects(store.createPublication({
      slug: 'too-many',
      files: [{ path: 'a', content: 'a' }, { path: 'b', content: 'b' }],
    }), (error) => error.code === 'ELIMIT');
    await assert.rejects(store.createPublication({ slug: 'too-large', files: [{ path: 'a', content: '12345' }] }), (error) => error.code === 'ELIMIT');
    await assert.rejects(store.createPublication({
      slug: 'metadata-large', files: [{ path: 'a', content: 'a' }], metadata: { value: 'x'.repeat(30) },
    }), (error) => error.code === 'ELIMIT');
    await assert.rejects(store.createPublication({
      slug: 'public-source-path', files: [{ path: 'a', content: 'a' }], metadata: { sourceRoot: '/x' },
    }), /use privateMetadata/);

    const created = await store.createPublication({
      slug: 'private-source',
      files: [{ path: 'a', content: 'a' }],
      metadata: { label: 'public' },
      privateMetadata: { path: '/srv/private' },
    });
    assert.deepEqual(created.publication.metadata, { label: 'public' });
    assert.equal(Object.prototype.hasOwnProperty.call(created.publication, 'privateMetadata'), false);
    assert.doesNotMatch(JSON.stringify(created.publication), /\/srv\/private/);
    await assert.rejects(store.updatePublication('private-source', {
      expectedRevision: 1,
      files: [{ path: 'a', content: 'b' }],
    }), (error) => error.code === 'ELIMIT');
  } finally {
    await removeFixture(root);
  }
});
