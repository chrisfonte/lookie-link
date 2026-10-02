'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { isDefinitionId } = require('./template-registry');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const SECTION_KEYS = new Set(['id', 'title']);
const ITEM_KEYS = new Set(['id', 'text', 'sectionId', 'checked', 'owner']);
const CLIENT_KEYS = new Set(['revision', 'sections', 'items']);
const MAX_SECTIONS = 50;
const MAX_ITEMS = 500;

function codedError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function clone(value) {
  return structuredClone(value);
}

function normalizeText(value, name, { minimum = 0, maximum = 200 } = {}) {
  if (typeof value !== 'string') {
    throw codedError('EVALIDATION', `${name} must be a string.`, [{ path: name, message: 'must be a string', code: 'type', hint: 'Provide a UTF-8 string.' }]);
  }
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (CONTROL_CHARACTER.test(normalized)) {
    throw codedError('EVALIDATION', `${name} must not contain control characters.`, [{ path: name, message: 'must not contain control characters', code: 'charset', hint: 'Remove control characters.' }]);
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw codedError('EVALIDATION', `${name} length out of range.`, [{ path: name, message: `must be ${minimum}–${maximum} characters`, code: 'length', hint: `Use ${minimum} to ${maximum} characters.` }]);
  }
  return normalized;
}

function normalizeSection(section, index) {
  if (!isRecord(section)) {
    throw codedError('EVALIDATION', `sections[${index}] must be an object.`, [{ path: `sections[${index}]`, message: 'must be an object', code: 'type' }]);
  }
  for (const key of Object.keys(section)) {
    if (!SECTION_KEYS.has(key)) {
      throw codedError('EVALIDATION', `sections[${index}].${key} is not allowed.`, [{ path: `sections[${index}].${key}`, message: 'is not allowed', code: 'unknown_key' }]);
    }
  }
  if (!isDefinitionId(section.id)) {
    throw codedError('EVALIDATION', `sections[${index}].id invalid.`, [{ path: `sections[${index}].id`, message: 'must be a definition ID', code: 'format', hint: 'Use lowercase kebab-case starting with a letter.' }]);
  }
  return {
    id: section.id,
    title: normalizeText(section.title, `sections[${index}].title`, { minimum: 1, maximum: 80 }),
  };
}

function normalizeItem(item, index, sectionIds) {
  if (!isRecord(item)) {
    throw codedError('EVALIDATION', `items[${index}] must be an object.`, [{ path: `items[${index}]`, message: 'must be an object', code: 'type' }]);
  }
  for (const key of Object.keys(item)) {
    if (!ITEM_KEYS.has(key)) {
      throw codedError('EVALIDATION', `items[${index}].${key} is not allowed.`, [{ path: `items[${index}].${key}`, message: 'is not allowed', code: 'unknown_key', hint: 'Allowed keys: id, text, sectionId, checked, owner.' }]);
    }
  }
  if (typeof item.id !== 'string' || !UUID.test(item.id)) {
    throw codedError('EVALIDATION', `items[${index}].id invalid.`, [{ path: `items[${index}].id`, message: 'must be a UUID v4', code: 'format' }]);
  }
  if (!isDefinitionId(item.sectionId) || !sectionIds.has(item.sectionId)) {
    throw codedError('EVALIDATION', `items[${index}].sectionId unknown.`, [{ path: `items[${index}].sectionId`, message: 'must name a section on this list', code: 'reference', hint: 'sectionId must match one of sections[].id.' }]);
  }
  if (typeof item.checked !== 'boolean') {
    throw codedError('EVALIDATION', `items[${index}].checked invalid.`, [{ path: `items[${index}].checked`, message: 'must be a boolean', code: 'type' }]);
  }
  const normalized = {
    id: item.id,
    text: normalizeText(item.text, `items[${index}].text`, { minimum: 1, maximum: 500 }),
    sectionId: item.sectionId,
    checked: item.checked,
  };
  if (Object.prototype.hasOwnProperty.call(item, 'owner') && item.owner !== null && item.owner !== undefined) {
    normalized.owner = normalizeText(item.owner, `items[${index}].owner`, { minimum: 1, maximum: 80 });
  }
  return normalized;
}

function normalizeStateBody(body) {
  if (!isRecord(body)) {
    throw codedError('EVALIDATION', 'List state must be an object.', [{ path: '', message: 'must be an object', code: 'type' }]);
  }
  for (const key of Object.keys(body)) {
    if (!CLIENT_KEYS.has(key)) {
      throw codedError('EVALIDATION', `${key} is not allowed.`, [{ path: key, message: 'is not allowed', code: 'unknown_key', hint: 'Accepted keys: revision, sections, items.' }]);
    }
  }
  if (!Array.isArray(body.sections) || body.sections.length < 1 || body.sections.length > MAX_SECTIONS) {
    throw codedError('EVALIDATION', 'sections invalid.', [{ path: 'sections', message: `must be an array of 1–${MAX_SECTIONS} sections`, code: 'range' }]);
  }
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
    throw codedError('EVALIDATION', 'items invalid.', [{ path: 'items', message: `must be an array of at most ${MAX_ITEMS} items`, code: 'range' }]);
  }
  const sections = body.sections.map((section, index) => normalizeSection(section, index));
  const sectionIds = new Set();
  for (let index = 0; index < sections.length; index += 1) {
    if (sectionIds.has(sections[index].id)) {
      throw codedError('EVALIDATION', 'duplicate section id.', [{ path: `sections[${index}].id`, message: 'must be unique', code: 'unique' }]);
    }
    sectionIds.add(sections[index].id);
  }
  const items = body.items.map((item, index) => normalizeItem(item, index, sectionIds));
  const itemIds = new Set();
  for (let index = 0; index < items.length; index += 1) {
    if (itemIds.has(items[index].id)) {
      throw codedError('EVALIDATION', 'duplicate item id.', [{ path: `items[${index}].id`, message: 'must be unique', code: 'unique' }]);
    }
    itemIds.add(items[index].id);
  }
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
    throw codedError('EVALIDATION', 'revision invalid.', [{ path: 'revision', message: 'must be an integer ≥ 0', code: 'type', hint: 'Use 0 when no list-state file exists yet.' }]);
  }
  return {
    sections,
    items,
    revision: body.revision,
  };
}

function virtualEmptyState(templateId) {
  return {
    contractVersion: 1,
    resourceKind: 'form-list-state',
    templateId,
    revision: 0,
    updatedAt: null,
    sections: [{ id: 'general', title: 'General' }],
    items: [],
    persisted: false,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

class ListStateStore {
  constructor(config = {}) {
    if (!config || typeof config.templatesPath !== 'string' || !config.templatesPath.trim()) {
      throw new Error('templatesPath is required.');
    }
    this.templatesPath = path.resolve(config.templatesPath);
    this.clock = config.clock || (() => new Date());
    this.mutationLocks = new Map();
  }

  statePath(templateId) {
    if (!isDefinitionId(templateId)) {
      throw codedError('EVALIDATION', 'templateId invalid.', [{ path: 'templateId', message: 'must be a definition ID', code: 'format' }]);
    }
    return path.join(this.templatesPath, templateId, 'list-state.json');
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

  async syncDirectory(directoryPath) {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async durableReplace(targetPath, bytes) {
    // Same-directory fsync-and-rename pattern as TemplateRegistry.durableReplace.
    const directoryPath = path.dirname(targetPath);
    const createdDirectory = await fs.mkdir(directoryPath, { recursive: true });
    if (createdDirectory) await this.syncDirectory(path.dirname(createdDirectory));
    const realDirectory = await fs.realpath(directoryPath);
    const expectedParent = await fs.realpath(path.join(this.templatesPath, path.basename(directoryPath)));
    if (realDirectory !== expectedParent) {
      throw codedError('EBOUNDARY', 'List state path escaped its template directory.');
    }
    const tempPath = path.join(directoryPath, `.list-state.${crypto.randomUUID()}.tmp`);
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

  async readFile(templateId) {
    const filePath = this.statePath(templateId);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw codedError('EBOUNDARY', 'List state must be a regular file.');
      }
      const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!isRecord(document)
          || document.contractVersion !== 1
          || document.resourceKind !== 'form-list-state'
          || document.templateId !== templateId
          || !Number.isSafeInteger(document.revision)
          || document.revision < 1) {
        throw codedError('EINTEGRITY', 'List state document is corrupt.');
      }
      const normalized = normalizeStateBody({
        revision: document.revision,
        sections: document.sections,
        items: document.items,
      });
      return {
        contractVersion: 1,
        resourceKind: 'form-list-state',
        templateId,
        revision: document.revision,
        updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
        sections: normalized.sections,
        items: normalized.items,
        persisted: true,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // Read-only: never creates a file. Absent state is a virtual revision 0.
  async getState(templateId) {
    if (!isDefinitionId(templateId)) {
      throw codedError('EVALIDATION', 'templateId invalid.', [{ path: 'templateId', message: 'must be a definition ID', code: 'format' }]);
    }
    const existing = await this.readFile(templateId);
    return clone(existing || virtualEmptyState(templateId));
  }

  // Same validator as PUT; no filesystem write.
  validateCandidate(body) {
    try {
      const normalized = normalizeStateBody(body);
      return { valid: true, errors: [], normalized };
    } catch (error) {
      if (error && error.code === 'EVALIDATION') {
        return { valid: false, errors: error.details || [{ path: '', message: error.message, code: 'invalid' }] };
      }
      throw error;
    }
  }

  async putState(templateId, body) {
    return this.withMutationLock(templateId, async () => {
      const normalized = normalizeStateBody(body);
      const current = await this.readFile(templateId);
      const currentRevision = current ? current.revision : 0;
      if (normalized.revision !== currentRevision) {
        const stale = codedError('ESTALE', 'List revision is stale.');
        stale.current = clone(current || virtualEmptyState(templateId));
        throw stale;
      }
      const now = this.clock();
      const next = {
        contractVersion: 1,
        resourceKind: 'form-list-state',
        templateId,
        revision: currentRevision + 1,
        updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        sections: normalized.sections,
        items: normalized.items,
      };
      await this.durableReplace(this.statePath(templateId), stableJson(next));
      return { ...clone(next), persisted: true };
    });
  }
}

module.exports = {
  ListStateStore,
  virtualEmptyState,
  normalizeStateBody,
};
