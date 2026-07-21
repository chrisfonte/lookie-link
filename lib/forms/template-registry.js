'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { canonicalize, schemaDigest } = require('./canonical');
const { validateTemplate, validateTemplateVersion } = require('./schema');

const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MUTABLE_TEMPLATE_KEYS = [
  'grammarVersion', 'destinationId', 'title', 'description', 'tags', 'lineage',
  'presentation', 'fields',
];

function isDefinitionId(value) {
  return typeof value === 'string' && value.length <= 64 && DEFINITION_ID.test(value);
}

function clone(value) {
  return structuredClone(value);
}

function codedError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function validationError(details) {
  return codedError('EVALIDATION', 'Template validation failed.', details);
}

function versionMetadata(version) {
  return {
    templateVersion: version.templateVersion,
    sourceRevision: version.sourceRevision,
    publishedAt: version.publishedAt,
    publishedBy: clone(version.publishedBy),
    schemaDigest: version.schemaDigest,
  };
}

class TemplateRegistry {
  constructor(config) {
    const options = typeof config === 'string' ? { templatesPath: config } : config;
    if (!options || typeof options.templatesPath !== 'string' || !options.templatesPath.trim()) {
      throw new Error('templatesPath is required.');
    }
    this.templatesPath = path.resolve(options.templatesPath);
    this.logger = options.logger || console;
    this.clock = options.clock || (() => new Date());
    this.destinationIds = options.destinationIds === undefined
      ? null
      : new Set(options.destinationIds);
    this.files = new Map();
    this.failureMessages = new Map();
    this.refreshPromise = null;
    this.mutationLocks = new Map();
    this.assertConfiguredDestinationsAtStartup();
  }

  destinationFailure(template) {
    if (!this.destinationIds) return null;
    const destinationId = template.destinationId || 'default';
    return this.destinationIds.has(destinationId)
      ? null
      : `references unknown destinationId ${destinationId}`;
  }

  assertConfiguredDestinationsAtStartup() {
    if (!this.destinationIds) return;
    let entries;
    try {
      entries = fsSync.readdirSync(this.templatesPath, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      let filePath = null;
      if (entry.isFile() && /\.(?:yaml|yml|json)$/.test(entry.name)) {
        filePath = path.join(this.templatesPath, entry.name);
      } else if (entry.isDirectory() && isDefinitionId(entry.name)) {
        filePath = path.join(this.templatesPath, entry.name, 'draft.json');
        if (!fsSync.existsSync(filePath)) continue;
      }
      if (!filePath) continue;
      let document;
      try {
        document = yaml.load(fsSync.readFileSync(filePath, 'utf8'), {schema: yaml.JSON_SCHEMA});
      } catch (_error) {
        continue;
      }
      if (!validateTemplate(document).valid) continue;
      const reason = this.destinationFailure(document);
      if (reason) throw new Error(`Form template ${path.relative(this.templatesPath, filePath)} ${reason}.`);
    }
  }

  logFailure(fileName, reason) {
    const message = `${fileName}: ${reason}`;
    if (this.failureMessages.get(fileName) === message) return;
    this.failureMessages.set(fileName, message);
    this.logger.warn(`Skipping form template ${message}`);
  }

  async descriptors() {
    const entries = await fs.readdir(this.templatesPath, { withFileTypes: true });
    const descriptors = [];
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:yaml|yml|json)$/.test(entry.name)) {
        descriptors.push({
          key: `file:${entry.name}`,
          fileName: entry.name,
          draftPath: path.join(this.templatesPath, entry.name),
          managedId: null,
        });
      } else if (entry.isDirectory() && isDefinitionId(entry.name)) {
        const draftPath = path.join(this.templatesPath, entry.name, 'draft.json');
        try {
          const stat = await fs.lstat(draftPath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          descriptors.push({
            key: `managed:${entry.name}`,
            fileName: `${entry.name}/draft.json`,
            draftPath,
            managedId: entry.name,
          });
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      }
    }
    return descriptors.sort((left, right) => left.key.localeCompare(right.key));
  }

  versionsPath(templateId) {
    return path.join(this.templatesPath, templateId, 'versions');
  }

  async readVersions(templateId, previousVersions = []) {
    let entries;
    try {
      entries = await fs.readdir(this.versionsPath(templateId), { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && /^[1-9]\d*\.json$/.test(entry.name))
      .sort((left, right) => Number(left.name.slice(0, -5)) - Number(right.name.slice(0, -5)));
    const versions = [];
    try {
      for (const entry of files) {
        const version = JSON.parse(await fs.readFile(path.join(this.versionsPath(templateId), entry.name), 'utf8'));
        const validation = validateTemplateVersion(version);
        const expectedVersion = versions.length + 1;
        if (!validation.valid) {
          throw new Error(validation.errors.map((item) => `${item.path || 'version'} ${item.message}`).join('; '));
        }
        if (version.templateId !== templateId || version.templateVersion !== expectedVersion
            || entry.name !== `${expectedVersion}.json`) {
          throw new Error('version identity or sequence does not match its directory');
        }
        if (version.schemaDigest !== `sha256:${schemaDigest(version)}`) {
          throw new Error('schemaDigest does not match the canonical field schema');
        }
        versions.push(version);
      }
      return versions;
    } catch (error) {
      this.logFailure(`${templateId}/versions`, error && error.message ? error.message : 'could not be read');
      return clone(previousVersions);
    }
  }

  async readCandidate(descriptor) {
    const previous = this.files.get(descriptor.key);
    try {
      const stat = await fs.lstat(descriptor.draftPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.logFailure(descriptor.fileName, 'not a regular file');
        return null;
      }
      const document = yaml.load(await fs.readFile(descriptor.draftPath, 'utf8'), {schema: yaml.JSON_SCHEMA});
      const validation = validateTemplate(document);
      if (!validation.valid) {
        const reason = validation.errors
          .map((error) => `${error.path || 'template'} ${error.message}`)
          .join('; ');
        this.logFailure(descriptor.fileName, reason);
        return null;
      }
      if (descriptor.managedId && document.templateId !== descriptor.managedId) {
        this.logFailure(descriptor.fileName, 'templateId does not match its directory');
        return null;
      }
      const destinationFailure = this.destinationFailure(document);
      if (destinationFailure) {
        this.logFailure(descriptor.fileName, destinationFailure);
        return null;
      }
      const versions = await this.readVersions(document.templateId, previous && previous.versions);
      const entry = {
        ...descriptor,
        template: clone(document),
        schemaDigest: schemaDigest(document),
        versions,
      };
      this.failureMessages.delete(descriptor.fileName);
      return entry;
    } catch (error) {
      this.logFailure(descriptor.fileName, error && error.message ? error.message : 'could not be read');
      return null;
    }
  }

  async refreshNow() {
    let descriptors;
    try {
      descriptors = await this.descriptors();
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.logFailure('(registry)', 'template directory does not exist');
        return;
      }
      this.logFailure('(registry)', error && error.message ? error.message : 'template directory could not be read');
      return;
    }

    this.failureMessages.delete('(registry)');
    const nextFiles = new Map();
    for (const descriptor of descriptors) {
      const candidate = await this.readCandidate(descriptor);
      if (candidate) nextFiles.set(descriptor.key, candidate);
      else if (this.files.has(descriptor.key)) nextFiles.set(descriptor.key, this.files.get(descriptor.key));
    }

    const claimedIds = new Map();
    for (const [key, entry] of nextFiles) {
      const templateId = entry.template.templateId;
      if (claimedIds.has(templateId)) {
        this.logFailure(entry.fileName, `duplicates templateId ${templateId}`);
        nextFiles.delete(key);
        continue;
      }
      claimedIds.set(templateId, key);
    }
    this.files = nextFiles;
  }

  async refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshNow().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  publicEntry(entry) {
    return {
      ...clone(entry.template),
      schemaDigest: entry.schemaDigest,
    };
  }

  managementEntry(entry) {
    const publishedVersions = entry.versions.map(versionMetadata);
    return {
      draft: clone(entry.template),
      state: entry.template.archived === true
        ? 'archived'
        : publishedVersions.length ? 'published' : 'draft',
      publishedVersion: publishedVersions.length ? clone(publishedVersions.at(-1)) : null,
      publishedVersions,
    };
  }

  async entryFor(templateId) {
    if (!isDefinitionId(templateId)) return null;
    await this.refresh();
    for (const entry of this.files.values()) {
      if (entry.template.templateId === templateId) return entry;
    }
    return null;
  }

  async getTemplate(templateId) {
    const entry = await this.entryFor(templateId);
    return entry ? this.publicEntry(entry) : null;
  }

  async listTemplates() {
    await this.refresh();
    return [...this.files.values()]
      .map((entry) => this.publicEntry(entry))
      .sort((left, right) => left.templateId.localeCompare(right.templateId));
  }

  async getManagementTemplate(templateId) {
    const entry = await this.entryFor(templateId);
    return entry ? this.managementEntry(entry) : null;
  }

  async getTemplateVersion(templateId, templateVersion) {
    if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) return null;
    const entry = await this.entryFor(templateId);
    const version = entry && entry.versions[templateVersion - 1];
    return version && version.templateVersion === templateVersion ? clone(version) : null;
  }

  async listManagementTemplates() {
    await this.refresh();
    return [...this.files.values()]
      .map((entry) => this.managementEntry(entry))
      .sort((left, right) => left.draft.templateId.localeCompare(right.draft.templateId));
  }

  async syncDirectory(directoryPath) {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async durableReplace(targetPath, bytes) {
    const directoryPath = path.dirname(targetPath);
    const createdDirectory = await fs.mkdir(directoryPath, {recursive: true});
    if (createdDirectory) await this.syncDirectory(path.dirname(createdDirectory));
    const tempPath = path.join(directoryPath, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tempPath, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tempPath, targetPath);
      await this.syncDirectory(directoryPath);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async withMutationLock(templateId, operation) {
    const predecessor = this.mutationLocks.get(templateId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.mutationLocks.set(templateId, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(templateId) === current) this.mutationLocks.delete(templateId);
    }
  }

  validateDraft(template) {
    const validation = validateTemplate(template);
    if (!validation.valid) throw validationError(validation.errors);
    const destinationFailure = this.destinationFailure(template);
    if (destinationFailure) {
      throw validationError([{path: 'destinationId', message: destinationFailure}]);
    }
  }

  async createDraft(template) {
    if (!template || !isDefinitionId(template.templateId)) {
      throw validationError([{path: 'templateId', message: 'must be a definition ID'}]);
    }
    this.validateDraft(template);
    return this.withMutationLock(template.templateId, async () => {
      if (await this.entryFor(template.templateId)) throw codedError('ECONFLICT', 'Template already exists.');
      await fs.mkdir(this.templatesPath, {recursive: true});
      const templateDirectory = path.join(this.templatesPath, template.templateId);
      try {
        await fs.mkdir(templateDirectory);
      } catch (error) {
        if (error && error.code === 'EEXIST') throw codedError('ECONFLICT', 'Template already exists.');
        throw error;
      }
      await this.syncDirectory(this.templatesPath);
      const descriptor = {
        key: `managed:${template.templateId}`,
        fileName: `${template.templateId}/draft.json`,
        draftPath: path.join(templateDirectory, 'draft.json'),
        managedId: template.templateId,
      };
      await this.durableReplace(descriptor.draftPath, canonicalize(template));
      const entry = {
        ...descriptor,
        template: clone(template),
        schemaDigest: schemaDigest(template),
        versions: [],
      };
      this.files.set(descriptor.key, entry);
      return this.managementEntry(entry);
    });
  }

  async reviseDraft(templateId, expectedRevision, changes) {
    return this.withMutationLock(templateId, async () => {
      const entry = await this.entryFor(templateId);
      if (!entry) throw codedError('ENOTFOUND', 'Template not found.');
      if (entry.template.revision !== expectedRevision) {
        throw codedError('ESTALE', 'Template revision is stale.');
      }
      const revised = clone(entry.template);
      for (const key of MUTABLE_TEMPLATE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
        if (changes[key] === null && ['description', 'destinationId', 'tags', 'lineage', 'presentation'].includes(key)) {
          delete revised[key];
        } else {
          revised[key] = clone(changes[key]);
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'fields')) {
        const revisedIds = new Set(revised.fields.map((field) => field.id));
        const removed = entry.template.fields.filter((field) => !revisedIds.has(field.id));
        if (removed.length) {
          throw validationError(removed.map((field) => ({
            path: 'fields',
            message: `field ${field.id} must be retained and marked isDestroyed instead of being removed`,
          })));
        }
      }
      revised.revision += 1;
      this.validateDraft(revised);
      await this.durableReplace(entry.draftPath, canonicalize(revised));
      entry.template = revised;
      entry.schemaDigest = schemaDigest(revised);
      this.files.set(entry.key, entry);
      return this.managementEntry(entry);
    });
  }

  async setArchived(templateId, expectedRevision, archived) {
    if (typeof archived !== 'boolean') {
      throw validationError([{path: 'archived', message: 'must be a boolean'}]);
    }
    return this.withMutationLock(templateId, async () => {
      const entry = await this.entryFor(templateId);
      if (!entry) throw codedError('ENOTFOUND', 'Template not found.');
      if (entry.template.revision !== expectedRevision) {
        throw codedError('ESTALE', 'Template revision is stale.');
      }
      const currentlyArchived = entry.template.archived === true;
      if (currentlyArchived === archived) {
        throw codedError('ECONFLICT', archived ? 'Template is already archived.' : 'Template is already active.');
      }
      const revised = clone(entry.template);
      if (archived) revised.archived = true;
      else delete revised.archived;
      revised.revision += 1;
      this.validateDraft(revised);
      await this.durableReplace(entry.draftPath, canonicalize(revised));
      entry.template = revised;
      entry.schemaDigest = schemaDigest(revised);
      this.files.set(entry.key, entry);
      return this.managementEntry(entry);
    });
  }

  async publishDraft(templateId, principal, expectedRevision) {
    return this.withMutationLock(templateId, async () => {
      const entry = await this.entryFor(templateId);
      if (!entry) throw codedError('ENOTFOUND', 'Template not found.');
      if (expectedRevision !== undefined && entry.template.revision !== expectedRevision) {
        throw codedError('ESTALE', 'Template revision is stale.');
      }
      const templateVersion = entry.versions.length + 1;
      const draft = entry.template;
      const version = {
        contractVersion: 1,
        resourceKind: 'form-template-version',
        templateId: draft.templateId,
        ownerId: draft.ownerId,
        templateVersion,
        sourceRevision: draft.revision,
        grammarVersion: draft.grammarVersion,
        publishedAt: this.clock().toISOString(),
        publishedBy: clone(principal),
        title: draft.title,
        ...(Object.prototype.hasOwnProperty.call(draft, 'description') ? {description: clone(draft.description)} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'tags') ? {tags: clone(draft.tags)} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'lineage') ? {lineage: clone(draft.lineage)} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'presentation') ? {presentation: clone(draft.presentation)} : {}),
        fields: clone(draft.fields),
        schemaDigest: `sha256:${schemaDigest(draft)}`,
      };
      const validation = validateTemplateVersion(version);
      if (!validation.valid) throw validationError(validation.errors);
      const versionPath = path.join(this.versionsPath(templateId), `${templateVersion}.json`);
      try {
        await fs.lstat(versionPath);
        throw codedError('ECONFLICT', 'Template version already exists.');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      await this.durableReplace(versionPath, canonicalize(version));
      entry.versions.push(version);
      this.files.set(entry.key, entry);
      return clone(version);
    });
  }
}

module.exports = {
  TemplateRegistry,
  isDefinitionId,
};
