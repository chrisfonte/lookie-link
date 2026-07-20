'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const DEFAULT_TRASH_DIR = '.lookie-link-trash';
const STORE_VERSION = 1;
const MAX_TREE_DEPTH = 10;
const MAX_TREE_ENTRIES = 5000;
const MAX_MANAGED_REPOS = 1000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(rootPath, candidatePath) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function normalizeRepoId(value) {
  const repoId = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(repoId)) {
    throw codedError('EINVAL', 'repoId must contain only lowercase letters, numbers, dots, underscores, and hyphens.');
  }
  return repoId;
}

function normalizeRelativePath(value, { allowEmpty = false } = {}) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (raw.includes('\0') || raw.startsWith('/') || /^[a-z]:\//i.test(raw)) {
    throw codedError('EINVAL', 'Invalid path.');
  }
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw codedError('EINVAL', 'Invalid path.');
  }
  const normalized = parts.join('/');
  if (!normalized && !allowEmpty) {
    throw codedError('EINVAL', 'A file path is required.');
  }
  return normalized;
}

function serializeStore(storePath, store) {
  if (/\.ya?ml$/i.test(storePath)) {
    return yaml.dump(store, { noRefs: true, sortKeys: true });
  }
  return `${JSON.stringify(store, null, 2)}\n`;
}

function atomicWriteFileSync(targetPath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined && fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch (_unlinkError) { /* best effort */ }
    throw error;
  }
}

function readStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = /\.ya?ml$/i.test(storePath) ? yaml.load(raw) : JSON.parse(raw);
    return {
      version: Number.isInteger(parsed && parsed.version) ? parsed.version : STORE_VERSION,
      repos: Array.isArray(parsed && parsed.repos) ? parsed.repos : [],
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { version: STORE_VERSION, repos: [] };
    }
    throw error;
  }
}

function resolveSecret(config) {
  if (!config || typeof config !== 'object') return null;
  if (typeof config.secretEnv === 'string' && config.secretEnv.trim()) {
    const secret = process.env[config.secretEnv.trim()];
    if (typeof secret === 'string' && secret.trim()) return secret.trim();
  }
  return typeof config.secret === 'string' && config.secret.trim() ? config.secret.trim() : null;
}

function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || '')).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function existingAncestor(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function resolveForCreation(realRoot, targetPath) {
  const ancestor = existingAncestor(targetPath);
  const realAncestor = fs.realpathSync(ancestor);
  if (!isWithin(realRoot, realAncestor)) {
    throw codedError('EACCES', 'Path escapes managed repo root.');
  }
  return targetPath;
}

function cloneRepo(repo) {
  return {
    id: repo.id,
    label: repo.label || null,
    rootPath: repo.rootPath,
    policy: {
      softDelete: !repo.policy || repo.policy.softDelete !== false,
      trashDirName: repo.policy && repo.policy.trashDirName || DEFAULT_TRASH_DIR,
    },
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    createdBy: repo.createdBy || null,
  };
}

class ManagedRepoStore {
  static fromConfig(config) {
    if (!config || typeof config !== 'object' || !config.storePath) return null;
    return new ManagedRepoStore(config);
  }

  constructor(config) {
    this.storePath = path.resolve(String(config.storePath));
    this.allowRoots = (Array.isArray(config.allowRoots) ? config.allowRoots : []).map((rootPath) => {
      const realRoot = fs.realpathSync(path.resolve(String(rootPath)));
      if (!fs.statSync(realRoot).isDirectory()) {
        throw codedError('EINVAL', 'managedRepos.allowRoots entries must be existing directories.');
      }
      return realRoot;
    });
    this.adminTokens = Object.entries(config.adminTokens || {}).map(([name, tokenConfig]) => ({
      name,
      secret: resolveSecret(tokenConfig),
    })).filter((entry) => entry.secret);
    this.mutationLocks = new Map();
  }

  isEnabled() {
    return true;
  }

  authenticateAdminToken(secret) {
    const token = secret && this.adminTokens.find((entry) => constantTimeEqual(entry.secret, secret));
    return token ? { tokenName: token.name } : null;
  }

  listRepos() {
    const repos = [];
    for (const storedRepo of readStore(this.storePath).repos) {
      if (repos.length >= MAX_MANAGED_REPOS) break;
      try {
        const repo = cloneRepo(storedRepo);
        if (normalizeRepoId(repo.id) !== repo.id) continue;
        normalizeRelativePath(repo.policy.trashDirName);
        if (repo.policy.trashDirName.includes('/')) continue;
        const realRoot = fs.realpathSync(repo.rootPath);
        if (!fs.statSync(realRoot).isDirectory()) continue;
        if (!this.allowRoots.some((allowRoot) => isWithin(allowRoot, realRoot))) continue;
        repo.rootPath = realRoot;
        repos.push(repo);
      } catch (_error) {
        // Invalid, missing, or out-of-policy registry entries fail closed.
      }
    }
    return { repos };
  }

  getRepo(repoId) {
    let normalized;
    try { normalized = normalizeRepoId(repoId); } catch (_error) { return null; }
    const repo = this.listRepos().repos.find((entry) => entry.id === normalized);
    return repo ? cloneRepo(repo) : null;
  }

  createRepo(input, admin = null) {
    if (this.allowRoots.length === 0) {
      throw codedError('EACCES', 'managedRepos.allowRoots must contain at least one existing directory.');
    }
    const repoId = normalizeRepoId(input && input.repoId);
    const requestedRoot = path.resolve(String(input && input.rootPath || ''));
    if (!input || !String(input.rootPath || '').trim() || !path.isAbsolute(String(input.rootPath))) {
      throw codedError('EINVAL', 'rootPath must be absolute.');
    }

    const lexicalAllowed = this.allowRoots.some((allowRoot) => isWithin(allowRoot, requestedRoot));
    if (!lexicalAllowed) throw codedError('EACCES', 'rootPath is outside managedRepos.allowRoots.');
    resolveForCreation(this.allowRoots.find((allowRoot) => isWithin(allowRoot, requestedRoot)), requestedRoot);

    const store = readStore(this.storePath);
    if (store.repos.length >= MAX_MANAGED_REPOS) {
      throw codedError('ECONFLICT', 'Managed repo registry limit reached.');
    }
    if (store.repos.some((entry) => entry.id === repoId)) {
      throw codedError('ECONFLICT', 'Managed repo already exists.');
    }

    fs.mkdirSync(requestedRoot, { recursive: true });
    const realRoot = fs.realpathSync(requestedRoot);
    if (!this.allowRoots.some((allowRoot) => isWithin(allowRoot, realRoot))) {
      throw codedError('EACCES', 'rootPath is outside managedRepos.allowRoots.');
    }

    const now = new Date().toISOString();
    const trashDirName = normalizeRelativePath(input.policy && input.policy.trashDirName || DEFAULT_TRASH_DIR);
    if (trashDirName.includes('/')) throw codedError('EINVAL', 'trashDirName must be a single directory name.');
    const repo = {
      id: repoId,
      label: input.label == null ? null : String(input.label).trim() || null,
      rootPath: realRoot,
      policy: {
        softDelete: !(input.policy && input.policy.softDelete === false),
        trashDirName,
      },
      createdAt: now,
      updatedAt: now,
      createdBy: admin && admin.tokenName || null,
    };
    store.repos.push(repo);
    atomicWriteFileSync(this.storePath, serializeStore(this.storePath, store));
    return { repo: cloneRepo(repo) };
  }

  resolvePath(repo, relativePath, { allowEmpty = false, allowMissing = false } = {}) {
    const normalized = normalizeRelativePath(relativePath, { allowEmpty });
    const realRoot = fs.realpathSync(repo.rootPath);
    const targetPath = path.resolve(realRoot, ...normalized.split('/').filter(Boolean));
    if (!isWithin(realRoot, targetPath)) throw codedError('EACCES', 'Path escapes managed repo root.');
    if (allowMissing) {
      resolveForCreation(realRoot, targetPath);
      return { relativePath: normalized, absolutePath: targetPath, realRoot };
    }
    const realTarget = fs.realpathSync(targetPath);
    if (!isWithin(realRoot, realTarget)) throw codedError('EACCES', 'Path escapes managed repo root.');
    return { relativePath: normalized, absolutePath: realTarget, realRoot };
  }

  isInternalPath(repo, relativePath) {
    const normalized = normalizeRelativePath(relativePath, { allowEmpty: true });
    return normalized === repo.policy.trashDirName || normalized.startsWith(`${repo.policy.trashDirName}/`);
  }

  async readFile(repo, relativePath) {
    if (this.isInternalPath(repo, relativePath)) throw codedError('EACCES', 'Not found.');
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

  async writeFile(repo, relativePath, content, expectedMtimeMs) {
    const lockPath = normalizeRelativePath(relativePath);
    if (this.isInternalPath(repo, lockPath)) throw codedError('EACCES', 'Not found.');
    return this.withMutationLock(`${repo.id}:${lockPath}`, () => (
      this.writeFileUnlocked(repo, lockPath, content, expectedMtimeMs)
    ));
  }

  async writeFileUnlocked(repo, relativePath, content, expectedMtimeMs) {
    const resolved = this.resolvePath(repo, relativePath, { allowMissing: true });
    let current = null;
    try {
      current = await fs.promises.stat(resolved.absolutePath);
      if (!current.isFile()) throw codedError('ENOENT', 'Not found.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    if (expectedMtimeMs !== undefined) {
      const expected = expectedMtimeMs === null ? null : Number(expectedMtimeMs);
      if (expected !== null && !Number.isFinite(expected)) throw codedError('EINVAL', 'Invalid expectedMtimeMs value.');
      const actual = current ? Math.trunc(current.mtimeMs) : null;
      if (actual !== (expected === null ? null : Math.trunc(expected))) {
        const conflict = codedError('ECONFLICT', 'Conflict detected.');
        conflict.current = current ? { exists: true, mtimeMs: actual } : { exists: false, mtimeMs: null };
        throw conflict;
      }
    }

    await fs.promises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    this.resolvePath(repo, path.posix.dirname(resolved.relativePath) === '.' ? '' : path.posix.dirname(resolved.relativePath), { allowEmpty: true });
    const tempPath = path.join(path.dirname(resolved.absolutePath), `.${path.basename(resolved.absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.promises.rename(tempPath, resolved.absolutePath);
    } catch (error) {
      try { await fs.promises.unlink(tempPath); } catch (_cleanupError) { /* best effort */ }
      throw error;
    }
    let stat = await fs.promises.stat(resolved.absolutePath);
    if (current && Math.trunc(stat.mtimeMs) === Math.trunc(current.mtimeMs)) {
      const bumped = new Date(Math.trunc(current.mtimeMs) + 1);
      await fs.promises.utimes(resolved.absolutePath, bumped, bumped);
      stat = await fs.promises.stat(resolved.absolutePath);
    }
    return { path: resolved.relativePath, mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size, created: !current };
  }

  async withMutationLock(key, operation) {
    const previous = this.mutationLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.mutationLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(key) === current) this.mutationLocks.delete(key);
    }
  }

  async deleteFile(repo, relativePath, { hard = false } = {}) {
    const lockPath = normalizeRelativePath(relativePath);
    if (this.isInternalPath(repo, lockPath)) throw codedError('EACCES', 'Not found.');
    return this.withMutationLock(`${repo.id}:${lockPath}`, () => (
      this.deleteFileUnlocked(repo, lockPath, { hard })
    ));
  }

  async deleteFileUnlocked(repo, relativePath, { hard = false } = {}) {
    const resolved = this.resolvePath(repo, relativePath);
    const stat = await fs.promises.stat(resolved.absolutePath);
    if (!stat.isFile()) throw codedError('ENOENT', 'Not found.');
    if (hard || repo.policy.softDelete === false) {
      await fs.promises.unlink(resolved.absolutePath);
      return { path: resolved.relativePath, deleted: 'hard' };
    }

    const trashId = crypto.randomUUID();
    const trashRoot = this.resolvePath(repo, repo.policy.trashDirName, { allowMissing: true });
    const recordDir = path.join(trashRoot.absolutePath, trashId);
    await fs.promises.mkdir(recordDir, { recursive: true, mode: 0o700 });
    const payloadPath = path.join(recordDir, 'payload');
    await fs.promises.rename(resolved.absolutePath, payloadPath);
    const metadata = { version: 1, trashId, originalPath: resolved.relativePath, deletedAt: new Date().toISOString() };
    atomicWriteFileSync(path.join(recordDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return { path: resolved.relativePath, deleted: 'soft', trashId };
  }

  async restoreTrash(repo, trashId) {
    const { record, metadata } = await this.getTrashMetadata(repo, trashId);
    const destination = this.resolvePath(repo, metadata.originalPath, { allowMissing: true });
    try {
      await fs.promises.lstat(destination.absolutePath);
      throw codedError('ECONFLICT', 'Restore destination already exists.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    await fs.promises.mkdir(path.dirname(destination.absolutePath), { recursive: true });
    this.resolvePath(repo, path.posix.dirname(destination.relativePath) === '.' ? '' : path.posix.dirname(destination.relativePath), { allowEmpty: true });
    await fs.promises.rename(path.join(record.absolutePath, 'payload'), destination.absolutePath);
    await fs.promises.rm(record.absolutePath, { recursive: true });
    return { path: metadata.originalPath, restored: true };
  }

  async hardDeleteTrash(repo, trashId) {
    const { record } = await this.getTrashMetadata(repo, trashId);
    await fs.promises.rm(record.absolutePath, { recursive: true });
    return { trashId, deleted: 'hard' };
  }

  async getTrashMetadata(repo, trashId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(trashId || ''))) throw codedError('ENOENT', 'Not found.');
    const record = this.resolvePath(repo, `${repo.policy.trashDirName}/${trashId}`);
    const metadata = JSON.parse(await fs.promises.readFile(path.join(record.absolutePath, 'metadata.json'), 'utf8'));
    return { record, metadata };
  }

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
      const directoryHandle = await fs.promises.opendir(directory);
      for await (const dirent of directoryHandle) {
        if (visited >= maxEntries) { truncated = true; break; }
        visited += 1;
        if (!relativeDirectory && dirent.name === repo.policy.trashDirName) continue;
        if (dirent.isSymbolicLink()) continue;
        const entryRelative = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        const resolvedEntry = this.resolvePath(repo, entryRelative);
        const entryPath = resolvedEntry.absolutePath;
        const stat = await fs.promises.stat(entryPath);
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

module.exports = {
  ManagedRepoStore,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
};
