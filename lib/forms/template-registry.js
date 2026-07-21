'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { schemaDigest } = require('./canonical');
const { validateTemplate } = require('./schema');

const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isDefinitionId(value) {
  return typeof value === 'string' && value.length <= 64 && DEFINITION_ID.test(value);
}

function clone(value) {
  return structuredClone(value);
}

class TemplateRegistry {
  constructor(config) {
    const options = typeof config === 'string' ? { templatesPath: config } : config;
    if (!options || typeof options.templatesPath !== 'string' || !options.templatesPath.trim()) {
      throw new Error('templatesPath is required.');
    }
    this.templatesPath = path.resolve(options.templatesPath);
    this.logger = options.logger || console;
    this.destinationIds = options.destinationIds === undefined
      ? null
      : new Set(options.destinationIds);
    this.files = new Map();
    this.failureMessages = new Map();
    this.refreshPromise = null;
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
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
      let document;
      try {
        document = yaml.load(fsSync.readFileSync(path.join(this.templatesPath, entry.name), 'utf8'));
      } catch (_error) {
        continue;
      }
      if (!validateTemplate(document).valid) continue;
      const reason = this.destinationFailure(document);
      if (reason) throw new Error(`Form template ${entry.name} ${reason}.`);
    }
  }

  logFailure(fileName, reason) {
    const message = `${fileName}: ${reason}`;
    if (this.failureMessages.get(fileName) === message) return;
    this.failureMessages.set(fileName, message);
    this.logger.warn(`Skipping form template ${message}`);
  }

  async readCandidate(fileName) {
    const filePath = path.join(this.templatesPath, fileName);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.logFailure(fileName, 'not a regular file');
        return null;
      }
      const document = yaml.load(await fs.readFile(filePath, 'utf8'));
      const validation = validateTemplate(document);
      if (!validation.valid) {
        const reason = validation.errors
          .map((error) => `${error.path || 'template'} ${error.message}`)
          .join('; ');
        this.logFailure(fileName, reason);
        return null;
      }
      const destinationFailure = this.destinationFailure(document);
      if (destinationFailure) {
        this.logFailure(fileName, destinationFailure);
        return null;
      }
      const entry = {
        fileName,
        template: clone(document),
        schemaDigest: schemaDigest(document),
      };
      this.failureMessages.delete(fileName);
      return entry;
    } catch (error) {
      this.logFailure(fileName, error && error.message ? error.message : 'could not be read');
      return null;
    }
  }

  async refreshNow() {
    let entries;
    try {
      entries = await fs.readdir(this.templatesPath, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.logFailure('(registry)', 'template directory does not exist');
        return;
      }
      this.logFailure('(registry)', error && error.message ? error.message : 'template directory could not be read');
      return;
    }

    this.failureMessages.delete('(registry)');
    const fileNames = entries
      .filter((entry) => entry.name.endsWith('.yaml'))
      .map((entry) => entry.name)
      .sort();
    const nextFiles = new Map();
    for (const fileName of fileNames) {
      const candidate = await this.readCandidate(fileName);
      if (candidate) nextFiles.set(fileName, candidate);
      else if (this.files.has(fileName)) nextFiles.set(fileName, this.files.get(fileName));
    }

    const claimedIds = new Map();
    for (const [fileName, entry] of nextFiles) {
      const templateId = entry.template.templateId;
      if (claimedIds.has(templateId)) {
        this.logFailure(fileName, `duplicates templateId ${templateId}`);
        nextFiles.delete(fileName);
        continue;
      }
      claimedIds.set(templateId, fileName);
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

  async getTemplate(templateId) {
    if (!isDefinitionId(templateId)) return null;
    await this.refresh();
    for (const entry of this.files.values()) {
      if (entry.template.templateId === templateId) return this.publicEntry(entry);
    }
    return null;
  }

  async listTemplates() {
    await this.refresh();
    return [...this.files.values()]
      .map((entry) => this.publicEntry(entry))
      .sort((left, right) => left.templateId.localeCompare(right.templateId));
  }
}

module.exports = {
  TemplateRegistry,
  isDefinitionId,
};
