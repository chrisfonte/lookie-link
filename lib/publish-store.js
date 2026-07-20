'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { safeResolve, toPosixPath } = require('./path-utils');

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 2 * 1024 * 1024,
  maxRevisionBytes: 10 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxRevisions: 20,
});

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, name) {
  if (value == null) {
    return fallback;
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return normalized;
}

function normalizeRepoId(rawRepoId) {
  const value = String(rawRepoId || 'published').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('publish.repoId is invalid.');
  }
  return value;
}

function normalizeSlug(rawSlug) {
  const value = String(rawSlug || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error('slug is invalid. Use 1-64 lowercase letters, digits, or internal hyphens.');
  }
  return value;
}

function normalizeRelativePath(rawPath, fieldName = 'path', allowEmpty = false) {
  if (typeof rawPath !== 'string' || rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new Error(`${fieldName} is invalid.`);
  }
  if (rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`${fieldName} is invalid.`);
  }

  const normalized = toPosixPath(rawPath).replace(/\/$/, '');
  if (!normalized) {
    if (allowEmpty) {
      return '';
    }
    throw new Error(`${fieldName} is required.`);
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return normalized;
}

function cloneJsonValue(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function containsAbsoluteFilesystemPath(value) {
  if (typeof value === 'string') {
    return value.startsWith('/') || value.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsAbsoluteFilesystemPath);
  }
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsAbsoluteFilesystemPath));
}

function normalizeMetadata(rawMetadata, fieldName, maxBytes) {
  if (rawMetadata == null) {
    return null;
  }
  if (typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
    throw new Error(`${fieldName} must be an object when provided.`);
  }

  let serialized;
  try {
    serialized = JSON.stringify(rawMetadata);
  } catch (_error) {
    throw new Error(`${fieldName} must be JSON-serializable.`);
  }
  if (serialized === undefined) {
    throw new Error(`${fieldName} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw codedError(`${fieldName} exceeds the ${maxBytes}-byte limit.`, 'ELIMIT');
  }
  const normalized = JSON.parse(serialized);
  if (fieldName === 'metadata' && containsAbsoluteFilesystemPath(normalized)) {
    throw new Error('metadata must not contain absolute filesystem paths; use privateMetadata instead.');
  }
  return normalized;
}

function decodeBase64(content, fieldName) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error(`${fieldName} is not valid base64.`);
  }
  return Buffer.from(content, 'base64');
}

function normalizeFiles(rawFiles, limits) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('files must be a non-empty array.');
  }
  if (rawFiles.length > limits.maxFiles) {
    throw codedError(`files exceeds the ${limits.maxFiles}-file limit.`, 'ELIMIT');
  }

  const seenPaths = new Set();
  const files = rawFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`files[${index}] must be an object.`);
    }
    const filePath = normalizeRelativePath(entry.path, `files[${index}].path`);
    if (seenPaths.has(filePath)) {
      throw new Error(`Duplicate publish file path: ${filePath}`);
    }
    seenPaths.add(filePath);

    if (typeof entry.content !== 'string') {
      throw new Error(`files[${index}].content must be a string.`);
    }
    const encoding = entry.encoding == null ? 'utf8' : String(entry.encoding).trim().toLowerCase();
    let buffer;
    if (encoding === 'utf8' || encoding === 'utf-8') {
      buffer = Buffer.from(entry.content, 'utf8');
    } else if (encoding === 'base64') {
      buffer = decodeBase64(entry.content, `files[${index}].content`);
    } else {
      throw new Error(`Unsupported encoding for files[${index}]: ${encoding}`);
    }
    if (buffer.length > limits.maxFileBytes) {
      throw codedError(`files[${index}] exceeds the ${limits.maxFileBytes}-byte limit.`, 'ELIMIT');
    }
    return { path: filePath, buffer };
  });

  const sortedPaths = [...seenPaths].sort();
  for (let index = 1; index < sortedPaths.length; index += 1) {
    if (sortedPaths[index].startsWith(`${sortedPaths[index - 1]}/`)) {
      throw new Error(`Publish paths cannot be both a file and a directory: ${sortedPaths[index - 1]}`);
    }
  }
  const sizeBytes = files.reduce((total, file) => total + file.buffer.length, 0);
  if (sizeBytes > limits.maxRevisionBytes) {
    throw codedError(`revision exceeds the ${limits.maxRevisionBytes}-byte limit.`, 'ELIMIT');
  }
  return { files, sizeBytes };
}

function inferEntryPath(files) {
  const preferred = ['index.html', 'index.htm', 'index.md', 'README.md'];
  return preferred.find((candidate) => files.some((file) => file.path === candidate))
    || (files.length === 1 ? files[0].path : null);
}

function normalizeEntryPath(rawEntryPath, files) {
  const entryPath = rawEntryPath == null || rawEntryPath === ''
    ? inferEntryPath(files)
    : normalizeRelativePath(rawEntryPath, 'entryPath');
  if (entryPath && !files.some((file) => file.path === entryPath)) {
    throw new Error('entryPath must reference a file included in the publish payload.');
  }
  return entryPath;
}

async function assertNoSymlinkComponents(targetPath) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw codedError('Publish storage paths must not contain symbolic links.', 'EACCES');
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function createPublicationProjection(repoId, publication) {
  const current = publication.revisions.find((entry) => entry.revision === publication.currentRevision) || null;
  const entryPath = current ? current.entryPath : null;
  const entrySuffix = entryPath ? `/${entryPath.split('/').map(encodeURIComponent).join('/')}` : '';
  const base = `/view/${encodeURIComponent(repoId)}/${encodeURIComponent(publication.slug)}`;
  return {
    slug: publication.slug,
    repoId,
    state: publication.revokedAt ? 'revoked' : 'active',
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
    currentRevision: publication.currentRevision,
    entryPath,
    metadata: cloneJsonValue(publication.metadata),
    revokedAt: publication.revokedAt || null,
    revokedReason: publication.revokedReason || null,
    viewUrl: `${base}${entrySuffix}`,
    rootViewUrl: base,
    revisions: publication.revisions.map((revision) => ({
      revision: revision.revision,
      createdAt: revision.createdAt,
      entryPath: revision.entryPath,
      fileCount: revision.fileCount,
      sizeBytes: revision.sizeBytes,
      metadata: cloneJsonValue(revision.metadata),
      viewUrl: `${base}${revision.entryPath ? `/${revision.entryPath.split('/').map(encodeURIComponent).join('/')}` : ''}?version=${revision.revision}`,
    })),
  };
}

class PublishStore {
  static fromConfig(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'object' || rawConfig.enabled === false) {
      return null;
    }
    const areaPath = typeof rawConfig.areaPath === 'string' && rawConfig.areaPath.trim()
      ? path.resolve(rawConfig.areaPath.trim())
      : null;
    return areaPath ? new PublishStore({ ...rawConfig, areaPath }) : null;
  }

  constructor(config) {
    if (!config || typeof config.areaPath !== 'string' || !config.areaPath.trim()) {
      throw new Error('publish.areaPath is required.');
    }
    this.areaPath = path.resolve(config.areaPath);
    this.repoId = normalizeRepoId(config.repoId);
    this.limits = {
      maxFiles: positiveInteger(config.maxFiles, DEFAULT_LIMITS.maxFiles, 'publish.maxFiles'),
      maxFileBytes: positiveInteger(config.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 'publish.maxFileBytes'),
      maxRevisionBytes: positiveInteger(config.maxRevisionBytes, DEFAULT_LIMITS.maxRevisionBytes, 'publish.maxRevisionBytes'),
      maxMetadataBytes: positiveInteger(config.maxMetadataBytes, DEFAULT_LIMITS.maxMetadataBytes, 'publish.maxMetadataBytes'),
      maxRevisions: positiveInteger(config.maxRevisions, DEFAULT_LIMITS.maxRevisions, 'publish.maxRevisions'),
    };
    this.slugLocks = new Map();
  }

  isEnabled() { return true; }
  getRepoId() { return this.repoId; }
  getRuntimeRoot() { return this.areaPath; }
  getLimits() { return { ...this.limits }; }
  publicationDir(slug) { return path.join(this.areaPath, slug); }
  publicationMetadataPath(slug) { return path.join(this.publicationDir(slug), 'publication.json'); }
  revisionDir(slug, revision) { return path.join(this.publicationDir(slug), 'revisions', String(revision)); }

  async ensureAreaPath() {
    await assertNoSymlinkComponents(this.areaPath);
    await fs.mkdir(this.areaPath, { recursive: true });
    await assertNoSymlinkComponents(this.areaPath);
  }

  async withSlugLock(slug, operation) {
    const previous = this.slugLocks.get(slug) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.slugLocks.set(slug, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.slugLocks.get(slug) === queued) {
        this.slugLocks.delete(slug);
      }
    }
  }

  async generateSlug() {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const candidate = crypto.randomBytes(9).toString('hex');
      try {
        await fs.lstat(this.publicationDir(candidate));
      } catch (error) {
        if (error && error.code === 'ENOENT') return candidate;
        throw error;
      }
    }
    throw new Error('Failed to allocate a unique slug.');
  }

  async readPublication(slug) {
    const normalizedSlug = normalizeSlug(slug);
    await this.ensureAreaPath();
    await assertNoSymlinkComponents(this.publicationDir(normalizedSlug));
    try {
      const parsed = JSON.parse(await fs.readFile(this.publicationMetadataPath(normalizedSlug), 'utf8'));
      return { ...parsed, slug: normalizedSlug };
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  serializePublication(publication) {
    return createPublicationProjection(this.repoId, publication);
  }

  async writeJsonFile(targetPath, value) {
    const tempPath = path.join(path.dirname(targetPath), `.publish-metadata-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  async writeRevisionFiles(rootPath, files) {
    for (const file of files) {
      const targetPath = path.join(rootPath, file.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await assertNoSymlinkComponents(path.dirname(targetPath));
      await fs.writeFile(targetPath, file.buffer, { flag: 'wx', mode: 0o600 });
    }
  }

  buildInput(input) {
    const normalized = normalizeFiles(input && input.files, this.limits);
    return {
      ...normalized,
      entryPath: normalizeEntryPath(input && input.entryPath, normalized.files),
      metadata: normalizeMetadata(input && input.metadata, 'metadata', this.limits.maxMetadataBytes),
      privateMetadata: normalizeMetadata(input && input.privateMetadata, 'privateMetadata', this.limits.maxMetadataBytes),
    };
  }

  async createPublication(input) {
    await this.ensureAreaPath();
    const bundle = this.buildInput(input);
    const slug = input && input.slug != null ? normalizeSlug(input.slug) : await this.generateSlug();
    return this.withSlugLock(slug, async () => {
      await assertNoSymlinkComponents(this.publicationDir(slug));
      if (await this.readPublication(slug)) {
        const conflict = codedError('Published slug already exists.', 'ECONFLICT');
        conflict.current = await this.readPublication(slug);
        throw conflict;
      }

      const now = new Date().toISOString();
      const revisionRecord = {
        revision: 1, createdAt: now, entryPath: bundle.entryPath,
        fileCount: bundle.files.length, sizeBytes: bundle.sizeBytes, metadata: bundle.metadata,
      };
      const publication = {
        slug, createdAt: now, updatedAt: now, currentRevision: 1,
        metadata: bundle.metadata, privateMetadata: bundle.privateMetadata,
        revokedAt: null, revokedReason: null, revisions: [revisionRecord],
      };
      const tempDir = path.join(this.areaPath, `.publish-${slug}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      try {
        await fs.mkdir(path.join(tempDir, 'revisions', '1'), { recursive: true });
        await this.writeRevisionFiles(path.join(tempDir, 'revisions', '1'), bundle.files);
        await this.writeJsonFile(path.join(tempDir, 'publication.json'), publication);
        await fs.rename(tempDir, this.publicationDir(slug));
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (['EEXIST', 'ENOTEMPTY'].includes(error && error.code)) {
          const conflict = codedError('Published slug already exists.', 'ECONFLICT');
          conflict.current = await this.readPublication(slug);
          throw conflict;
        }
        throw error;
      }
      return { publication: this.serializePublication(publication) };
    });
  }

  async updatePublication(slug, input) {
    const normalizedSlug = normalizeSlug(slug);
    const expectedRevision = Number(input && input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('expectedRevision is required and must be a positive integer.');
    }
    const bundle = this.buildInput(input);
    return this.withSlugLock(normalizedSlug, async () => {
      const publication = await this.readPublication(normalizedSlug);
      if (!publication) throw codedError('Published artifact not found.', 'ENOENT');
      if (publication.revokedAt) {
        const error = codedError('Published artifact has been revoked.', 'EREVOKED');
        error.current = publication;
        throw error;
      }
      if (publication.currentRevision !== expectedRevision) {
        const error = codedError('Conflict detected.', 'ECONFLICT');
        error.current = publication;
        throw error;
      }
      if (publication.revisions.length >= this.limits.maxRevisions) {
        throw codedError(`Published artifact reached the ${this.limits.maxRevisions}-revision limit.`, 'ELIMIT');
      }

      const nextRevision = publication.currentRevision + 1;
      const now = new Date().toISOString();
      const revisionRecord = {
        revision: nextRevision, createdAt: now, entryPath: bundle.entryPath,
        fileCount: bundle.files.length, sizeBytes: bundle.sizeBytes, metadata: bundle.metadata,
      };
      const nextPublication = {
        ...publication,
        updatedAt: now,
        currentRevision: nextRevision,
        metadata: bundle.metadata,
        privateMetadata: bundle.privateMetadata == null ? publication.privateMetadata || null : bundle.privateMetadata,
        revisions: [...publication.revisions, revisionRecord],
      };
      const finalDir = this.revisionDir(normalizedSlug, nextRevision);
      const tempDir = path.join(path.dirname(finalDir), `.publish-revision-${nextRevision}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      let revisionCommitted = false;
      try {
        // A process can stop after the revision rename but before metadata advances.
        // Such an unreferenced next revision was never published and is safe to
        // remove before retrying the same expectedRevision transaction.
        await assertNoSymlinkComponents(finalDir);
        await fs.rm(finalDir, { recursive: true, force: true });
        await fs.mkdir(tempDir, { recursive: false });
        await this.writeRevisionFiles(tempDir, bundle.files);
        await fs.rename(tempDir, finalDir);
        revisionCommitted = true;
        await this.writeJsonFile(this.publicationMetadataPath(normalizedSlug), nextPublication);
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (revisionCommitted) {
          await fs.rm(finalDir, { recursive: true, force: true });
        }
        throw error;
      }
      return { publication: this.serializePublication(nextPublication) };
    });
  }

  async revokePublication(slug, input) {
    const normalizedSlug = normalizeSlug(slug);
    const reason = String(input && input.reason || '').trim();
    if (!reason) throw new Error('reason is required.');
    if (Buffer.byteLength(reason, 'utf8') > 1000) throw codedError('reason exceeds the 1000-byte limit.', 'ELIMIT');
    return this.withSlugLock(normalizedSlug, async () => {
      const publication = await this.readPublication(normalizedSlug);
      if (!publication) throw codedError('Published artifact not found.', 'ENOENT');
      if (publication.revokedAt) throw codedError('Published artifact is already revoked.', 'EREVOKED');
      const revokedAt = new Date().toISOString();
      const nextPublication = { ...publication, revokedAt, revokedReason: reason, updatedAt: revokedAt };
      await this.writeJsonFile(this.publicationMetadataPath(normalizedSlug), nextPublication);
      return { publication: this.serializePublication(nextPublication) };
    });
  }

  async resolvePath(slug, relativePath = '', revision = null) {
    const normalizedSlug = normalizeSlug(slug);
    const publication = await this.readPublication(normalizedSlug);
    if (!publication) throw codedError('Published artifact not found.', 'ENOENT');
    const targetRevision = revision == null ? publication.currentRevision : Number(revision);
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) {
      throw codedError('version must be a positive integer.', 'EINVAL');
    }
    const revisionRecord = publication.revisions.find((entry) => entry.revision === targetRevision);
    if (!revisionRecord) throw codedError('Published revision not found.', 'ENOENT');
    const normalizedPath = normalizeRelativePath(relativePath || '', 'path', true);
    const rootPath = this.revisionDir(normalizedSlug, targetRevision);
    await assertNoSymlinkComponents(path.join(rootPath, normalizedPath));
    return {
      publication,
      revision: revisionRecord,
      rootPath,
      relativePath: normalizedPath,
      resolved: await safeResolve(rootPath, normalizedPath),
    };
  }
}

module.exports = {
  DEFAULT_LIMITS,
  PublishStore,
};
