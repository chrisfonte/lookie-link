'use strict';

// Read-only access to plainly mapped repositories (the `repositories:` roots),
// with the same bounded tree walk and containment rules the managed store
// uses, so tree / changes / search / file-read work for every repo Lookie
// serves and not only for managed ones (API roadmap R2, 2026-09-23).
//
// resolveRepo() is the one door: it returns a managed repo (with the managed
// store as its reader) when the store knows the id, otherwise the mapped root
// (with this reader). Route handlers and search never care which it was.

const fs = require('node:fs');
const path = require('node:path');
const { MAX_TREE_DEPTH, MAX_TREE_ENTRIES } = require('./managed-repo-store');

// Folders that are never part of a repo's readable tree: VCS internals,
// Syncthing state and versions, dependency trees.
const SKIP_DIRECTORIES = new Set(['.git', '.stversions', '.stfolder', '.stignore', 'node_modules']);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(relativePath, { allowEmpty = false } = {}) {
  const raw = String(relativePath == null ? '' : relativePath).replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw codedError('EACCES', 'Path escapes repository root.');
  if (!parts.length && !allowEmpty) throw codedError('EINVAL', 'A path is required.');
  return parts.join('/');
}

class MappedRepoReader {
  resolvePath(repo, relativePath, { allowEmpty = false } = {}) {
    const normalized = normalizeRelativePath(relativePath, { allowEmpty });
    const realRoot = fs.realpathSync(repo.rootPath);
    const targetPath = path.resolve(realRoot, ...normalized.split('/').filter(Boolean));
    if (!isWithin(realRoot, targetPath)) throw codedError('EACCES', 'Path escapes repository root.');
    const realTarget = fs.realpathSync(targetPath);
    if (!isWithin(realRoot, realTarget)) throw codedError('EACCES', 'Path escapes repository root.');
    return { relativePath: normalized, absolutePath: realTarget, realRoot };
  }

  isInternalPath(_repo, relativePath) {
    const normalized = normalizeRelativePath(relativePath, { allowEmpty: true });
    return normalized.split('/').some((part) => SKIP_DIRECTORIES.has(part));
  }

  async readFile(repo, relativePath) {
    if (this.isInternalPath(repo, relativePath)) throw codedError('ENOENT', 'Not found.');
    const resolved = this.resolvePath(repo, relativePath);
    const stat = await fs.promises.stat(resolved.absolutePath);
    if (!stat.isFile()) throw codedError('ENOENT', 'Not found.');
    return {
      path: resolved.relativePath,
      content: await fs.promises.readFile(resolved.absolutePath, 'utf8'),
      mtimeMs: Math.trunc(stat.mtimeMs),
      size: stat.size,
    };
  }

  // Same contract as ManagedRepoStore.listTree: bounded by depth and visited
  // entries, symlinks skipped, includeEntry / shouldDescend hooks for caller
  // filtering, and { entries, truncated, maxDepth, maxEntries, visited }.
  async listTree(repo, relativePath = '', options = {}) {
    if (this.isInternalPath(repo, relativePath)) throw codedError('ENOENT', 'Not found.');
    const maxDepth = Math.max(0, Math.min(MAX_TREE_DEPTH, Number.isFinite(Number(options.maxDepth)) ? Math.trunc(Number(options.maxDepth)) : 5));
    const maxEntries = Math.max(1, Math.min(MAX_TREE_ENTRIES, Number.isFinite(Number(options.maxEntries)) ? Math.trunc(Number(options.maxEntries)) : 1000));
    const start = this.resolvePath(repo, relativePath, { allowEmpty: true });
    const entries = [];
    let visited = 0;
    let truncated = false;
    const walk = async (directory, relativeDirectory, depth) => {
      if (visited >= maxEntries || depth > maxDepth) { truncated = true; return; }
      const handle = await fs.promises.opendir(directory);
      for await (const dirent of handle) {
        if (visited >= maxEntries) { truncated = true; break; }
        if (SKIP_DIRECTORIES.has(dirent.name)) continue;
        if (dirent.isSymbolicLink()) continue;
        visited += 1;
        const entryRelative = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        const entryPath = path.join(directory, dirent.name);
        let stat;
        try { stat = await fs.promises.stat(entryPath); } catch (_) { continue; }
        const type = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other';
        const entry = { path: entryRelative, type, size: type === 'file' ? stat.size : null, mtimeMs: Math.trunc(stat.mtimeMs) };
        if (!options.includeEntry || options.includeEntry(entry)) entries.push(entry);
        if (type === 'directory' && depth < maxDepth && (!options.shouldDescend || options.shouldDescend(entry))) {
          await walk(entryPath, entryRelative, depth + 1);
        }
      }
    };
    await walk(start.absolutePath, start.relativePath, 0);
    return { entries, truncated, maxDepth, maxEntries, visited };
  }
}

// Every repo the server serves, each carrying its reader. Managed repos win
// on id collision (the server already refuses a mapping that collides with
// the publish repo; managed ids are validated separately).
function createRepoResolver({ mappings, managedRepoStore }) {
  const mapped = new MappedRepoReader();
  const managedEnabled = () => Boolean(managedRepoStore && typeof managedRepoStore.isEnabled === 'function' && managedRepoStore.isEnabled());

  function resolve(repoId) {
    const id = String(repoId || '');
    if (managedEnabled()) {
      const repo = managedRepoStore.getRepo(id);
      if (repo) return { repo: { ...repo, managed: true }, reader: managedRepoStore };
    }
    if (Object.prototype.hasOwnProperty.call(mappings, id) && mappings[id]) {
      return { repo: { id, rootPath: mappings[id], managed: false }, reader: mapped };
    }
    return null;
  }

  function listAll() {
    const seen = new Set();
    const all = [];
    if (managedEnabled()) {
      for (const repo of managedRepoStore.listRepos().repos) {
        seen.add(repo.id);
        all.push({ ...repo, managed: true });
      }
    }
    for (const [id, rootPath] of Object.entries(mappings)) {
      if (seen.has(id) || !rootPath) continue;
      // A configured root that is not on this host yet (fleet config, partial
      // sync) is served as 404 per request elsewhere; keep it out of cross-repo
      // walks so one absent folder cannot fail search for the rest.
      let present = false;
      try { present = fs.statSync(rootPath).isDirectory(); } catch (_) { present = false; }
      if (!present) continue;
      all.push({ id, rootPath, managed: false });
    }
    return all;
  }

  // A store-shaped facade so search and suggest work over the union.
  const store = {
    listTree: (repo, relativePath, options) => (repo.managed ? managedRepoStore : mapped).listTree(repo, relativePath, options),
    readFile: (repo, relativePath) => (repo.managed ? managedRepoStore : mapped).readFile(repo, relativePath),
  };

  return { resolve, listAll, store, mappedReader: mapped };
}

module.exports = { MappedRepoReader, createRepoResolver, SKIP_DIRECTORIES };
