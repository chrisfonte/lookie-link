'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { canonicalize, schemaDigest } = require('./canonical');
const { validateTemplate, validateTemplateVersion } = require('./schema');

const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// #245: child fields resolve against the parent at serve time — a child field
// whose id matches a parent field overrides it in place; other child fields
// append after. Live inheritance: edit the parent once, every child updates.
function resolveInheritedFields(parentFields, childFields, inherit) {
  // #313: inherit.exclude drops parent fields for THIS child only — selection,
  // not deletion; receipts stay safe via capture-time snapshots.
  const excluded = new Set((inherit && Array.isArray(inherit.exclude)) ? inherit.exclude : []);
  const parent = (Array.isArray(parentFields) ? parentFields : []).filter((field) => !excluded.has(field.id));
  const own = Array.isArray(childFields) ? childFields : [];
  const overrides = new Map(own.map((field) => [field.id, field]));
  const used = new Set();
  const merged = parent.map((field) => {
    if (overrides.has(field.id)) {
      used.add(field.id);
      return overrides.get(field.id);
    }
    return field;
  });
  for (const field of own) if (!used.has(field.id)) merged.push(field);
  return merged;
}

const MUTABLE_TEMPLATE_KEYS = [
  'grammarVersion', 'destinationId', 'title', 'description', 'tags', 'lineage',
  'presentation', 'fields', 'containerId', 'memberOrder', 'parentId', 'related', 'inherit',
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
    const template = clone(entry.template);
    let digest = entry.schemaDigest;
    if (template.parentId) {
      // #245: serve resolved fields; the digest is of the RESOLVED schema so it
      // honestly changes when the parent changes. Parent existence is enforced
      // at write time (assertParentReference); if it drifted, own fields serve.
      const parent = this.entrySync(template.parentId);
      if (parent) {
        template.fields = clone(resolveInheritedFields(parent.template.fields, template.fields, template.inherit));
        digest = schemaDigest(template);
      }
    }
    return {
      ...template,
      schemaDigest: digest,
    };
  }

  entrySync(templateId) {
    for (const entry of this.files.values()) {
      if (entry.template.templateId === templateId) return entry;
    }
    return null;
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

  async assertContainerReference(template) {
    // #234 fail-closed: a containerId must identify an existing, unarchived
    // container-kind template — same alias-indirection posture as destinationId.
    if (!template.containerId) return;
    const target = await this.entryFor(template.containerId);
    const ok = target && target.template && target.template.kind === 'container' && target.template.archived !== true;
    if (!ok) {
      throw validationError([{path: 'containerId', message: 'must identify an existing container'}]);
    }
  }

  async assertParentReference(template) {
    // #245 fail-closed: parentId must identify an existing, unarchived form-kind
    // template that itself has no parent (single-level inheritance).
    if (!template.parentId) return;
    const target = await this.entryFor(template.parentId);
    const ok = target && target.template
      && target.template.kind !== 'container'
      && target.template.archived !== true
      && !target.template.parentId;
    if (!ok) {
      throw validationError([{path: 'parentId', message: 'must identify an existing top-level form'}]);
    }
  }

  childrenOf(templateId) {
    return [...this.files.values()]
      .filter((entry) => entry.template.parentId === templateId && entry.template.archived !== true)
      .map((entry) => entry.template.templateId);
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
      await this.assertContainerReference(template);
      await this.assertParentReference(template);
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
      // #245: detaching (parentId: null) materializes the resolved fields onto the
      // child so nothing it served disappears — unless the patch supplies fields.
      if (changes.parentId === null && entry.template.parentId) {
        if (!Object.prototype.hasOwnProperty.call(changes, 'fields')) {
          const parent = await this.entryFor(entry.template.parentId);
          if (parent) {
            revised.fields = clone(resolveInheritedFields(parent.template.fields, entry.template.fields, entry.template.inherit));
          }
        }
        // #313: inherit config is meaningless without a parent — exclusions are
        // already honored in the materialized fields above.
        delete revised.inherit;
      }
      const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
      for (const key of MUTABLE_TEMPLATE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
        if (changes[key] === null && ['description', 'destinationId', 'tags', 'lineage', 'presentation', 'containerId', 'memberOrder', 'parentId', 'related', 'inherit'].includes(key)) {
          delete revised[key];
        } else if (key === 'presentation' && isPlainObject(changes.presentation) && isPlainObject(revised.presentation)) {
          // #225: merge presentation patches instead of replacing wholesale — a patch
          // stating only `theme` must not silently drop `submitLabel`. A null value
          // inside the patch unsets that single key; top-level null still clears all.
          const merged = { ...revised.presentation };
          for (const [presentationKey, presentationValue] of Object.entries(changes.presentation)) {
            if (presentationValue === null) delete merged[presentationKey];
            else merged[presentationKey] = clone(presentationValue);
          }
          if (Object.keys(merged).length === 0) delete revised.presentation;
          else revised.presentation = merged;
        } else {
          revised[key] = clone(changes[key]);
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'fields')) {
        const revisedIds = new Set((revised.fields || []).map((field) => field.id));
        // #245: with a parent, dropping an own field whose id the parent defines is
        // deduplication, not deletion — the field survives in the resolved schema.
        let inherited = new Set();
        if (revised.parentId) {
          const parent = await this.entryFor(revised.parentId);
          if (parent) inherited = new Set(parent.template.fields.map((field) => field.id));
        }
        const removed = (entry.template.fields || []).filter((field) => !revisedIds.has(field.id) && !inherited.has(field.id));
        if (removed.length) {
          throw validationError(removed.map((field) => ({
            path: 'fields',
            message: `field ${field.id} must be retained and marked isDestroyed instead of being removed`,
          })));
        }
      }
      revised.revision += 1;
      this.validateDraft(revised);
      await this.assertContainerReference(revised);
      await this.assertParentReference(revised);
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
      if (archived) {
        // #245 fail-closed: children resolve against this template — re-parent or
        // archive them first.
        const children = this.childrenOf(templateId);
        if (children.length) {
          throw validationError([{path: 'archived', message: `template has child forms (${children.join(', ')}) — detach or archive them first`}]);
        }
      }
      const revised = clone(entry.template);
      if (archived) revised.archived = true;
      else delete revised.archived;
      revised.revision += 1;
      this.validateDraft(revised);
      await this.assertContainerReference(revised);
      await this.assertParentReference(revised);
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
        // #257: version docs carry the structural keys too — kind (containers were
        // unpublishable without it), membership, and inheritance provenance.
        ...(Object.prototype.hasOwnProperty.call(draft, 'kind') ? {kind: draft.kind} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'containerId') ? {containerId: draft.containerId} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'memberOrder') ? {memberOrder: clone(draft.memberOrder)} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'parentId') ? {parentId: draft.parentId} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'related') ? {related: clone(draft.related)} : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'inherit') ? {inherit: clone(draft.inherit)} : {}),
        ...(draft.kind === 'container' ? {} : {fields: Array.isArray(draft.fields) ? clone(draft.fields) : []}),
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
