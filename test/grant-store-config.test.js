'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { GrantStore } = require('../lib/grant-store');

test('fromAccessConfig expands ~ in storePath, projectionPath, and repoRoots', () => {
  const store = GrantStore.fromAccessConfig({
    storePath: '~/.local/share/lookie-link/grants.yaml',
    projectionPath: '~/.local/share/lookie-link/grants-projection.yaml',
    repoRoots: {
      docs: '~/operations',
      notes: '~/projects/notes',
    },
  });

  assert.ok(store);
  assert.equal(store.storePath, path.join(os.homedir(), '.local/share/lookie-link/grants.yaml'));
  assert.equal(store.projectionPath, path.join(os.homedir(), '.local/share/lookie-link/grants-projection.yaml'));
  assert.equal(store.getRepoRoot('docs'), path.join(os.homedir(), 'operations'));
  assert.equal(store.getRepoRoot('notes'), path.join(os.homedir(), 'projects/notes'));
});

test('fromAccessConfig leaves absolute paths unchanged', () => {
  const store = GrantStore.fromAccessConfig({
    storePath: '/var/lib/lookie-link/grants.yaml',
    projectionPath: '/var/lib/lookie-link/grants-projection.yaml',
    repoRoots: { docs: '/srv/docs' },
  });

  assert.ok(store);
  assert.equal(store.storePath, '/var/lib/lookie-link/grants.yaml');
  assert.equal(store.projectionPath, '/var/lib/lookie-link/grants-projection.yaml');
  assert.equal(store.getRepoRoot('docs'), '/srv/docs');
});

test('fromAccessConfig does not treat ~other-prefixed values as the home dir', () => {
  const store = GrantStore.fromAccessConfig({
    storePath: '~other/grants.yaml',
  });

  assert.ok(store);
  assert.ok(!store.storePath.startsWith(os.homedir() + path.sep + 'other'));
  assert.equal(store.storePath, path.resolve('~other/grants.yaml'));
});

test('fromAccessConfig without storePath disables grants', () => {
  assert.equal(GrantStore.fromAccessConfig({ projectionPath: '~/p.yaml' }), null);
  assert.equal(GrantStore.fromAccessConfig({}), null);
});
