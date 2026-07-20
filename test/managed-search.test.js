'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ManagedRepoStore } = require('../lib/managed-repo-store');
const { searchManagedRepos, suggestManagedRepos } = require('../lib/managed-repo-search');

test('managed search and suggestions never return out-of-scope repos or paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-managed-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await fs.mkdir(allowed);
  const store = new ManagedRepoStore({ storePath: path.join(root, 'registry.json'), allowRoots: [allowed] });
  const visibleRepo = store.createRepo({ repoId: 'visible-repo', rootPath: path.join(allowed, 'visible-repo') }).repo;
  const hiddenRepo = store.createRepo({ repoId: 'hidden-repo', rootPath: path.join(allowed, 'hidden-repo') }).repo;

  await store.writeFile(visibleRepo, 'notes/shared-topic.md', 'scope marker in visible notes\n', null);
  await store.writeFile(visibleRepo, 'private/hidden-topic.md', 'scope marker in hidden path\n', null);
  await store.writeFile(hiddenRepo, 'notes/other-topic.md', 'scope marker in hidden repo\n', null);

  const canView = (repo, relativePath, type) => {
    if (repo !== 'visible-repo') return false;
    if (type === 'directory') return relativePath === '' || relativePath === 'notes';
    return relativePath.startsWith('notes/');
  };
  const search = await searchManagedRepos({
    store,
    repos: store.listRepos().repos,
    query: 'scope marker',
    canView,
  });
  assert.deepEqual(search.results.map((entry) => [entry.repo, entry.path]), [
    ['visible-repo', 'notes/shared-topic.md'],
  ]);
  assert.equal(JSON.stringify(search).includes('hidden-topic'), false);
  assert.equal(JSON.stringify(search).includes('hidden-repo'), false);

  const suggestions = await suggestManagedRepos({
    store,
    repos: store.listRepos().repos,
    query: 'topic',
    canView,
  });
  assert.deepEqual(suggestions.suggestions.map((entry) => [entry.repo, entry.path]), [
    ['visible-repo', 'notes/shared-topic.md'],
  ]);
  assert.equal(JSON.stringify(suggestions).includes('hidden-topic'), false);
  assert.equal(JSON.stringify(suggestions).includes('hidden-repo'), false);
});

test('managed search caps results and traversal work', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-managed-search-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await fs.mkdir(allowed);
  const store = new ManagedRepoStore({ storePath: path.join(root, 'registry.json'), allowRoots: [allowed] });
  const repo = store.createRepo({ repoId: 'bounded-repo', rootPath: path.join(allowed, 'bounded-repo') }).repo;
  for (let index = 0; index < 5; index += 1) {
    await store.writeFile(repo, `notes/match-${index}.md`, 'bounded marker\n', null);
  }
  const result = await searchManagedRepos({
    store,
    repos: [repo],
    query: 'bounded marker',
    limit: 2,
    maxEntries: 3,
    canView: () => true,
  });
  assert.ok(result.results.length <= 2);
  assert.equal(result.limits.results, 2);
  assert.equal(result.limits.entries, 3);
  assert.equal(result.truncated, true);
});
