'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SubmissionStore } = require('./submission-store');
const { isDefinitionId } = require('./template-registry');

const DEFAULT_DESTINATION_ID = 'default';

function destinationError(destinationId) {
  const error = new Error(`Form destination "${destinationId}" is not configured.`);
  error.code = 'EDESTINATION';
  return error;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configuredDestinationRoots(config = {}) {
  let configured = config.destinations;
  if (configured === undefined && typeof config.submissionsPath === 'string') {
    configured = { [DEFAULT_DESTINATION_ID]: config.submissionsPath };
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('forms.destinations must be a map of destination aliases to storage roots.');
  }

  const roots = {};
  for (const [destinationId, configuredRoot] of Object.entries(configured)) {
    if (!isDefinitionId(destinationId)) {
      throw new Error('Each forms.destinations key must be a valid definition ID.');
    }
    if (typeof configuredRoot !== 'string' || !configuredRoot.trim()) {
      throw new Error(`Storage root for form destination "${destinationId}" must be a path.`);
    }
    roots[destinationId] = path.resolve(expandHome(configuredRoot));
  }
  if (Object.keys(roots).length === 0) {
    throw new Error('forms.destinations must configure at least one destination.');
  }
  return roots;
}

function prepareStorageRoot(destinationId, storageRoot) {
  try {
    fs.mkdirSync(storageRoot, { recursive: true });
    const stat = fs.lstatSync(storageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
  } catch (_error) {
    throw new Error(`Storage root for form destination "${destinationId}" is not a usable directory.`);
  }
}

function destinationIdFor(template) {
  return template && template.destinationId || DEFAULT_DESTINATION_ID;
}

function storeForTemplate(store, template) {
  const destinationId = destinationIdFor(template);
  if (store && typeof store.forDestination === 'function') {
    return store.forDestination(destinationId);
  }
  if (destinationId === DEFAULT_DESTINATION_ID) return store;
  throw destinationError(destinationId);
}

class DestinationAdapter {
  #stores;

  constructor(config = {}) {
    const roots = configuredDestinationRoots(config);
    this.#stores = new Map();
    for (const [destinationId, storageRoot] of Object.entries(roots)) {
      prepareStorageRoot(destinationId, storageRoot);
      this.#stores.set(destinationId, new SubmissionStore({
        storageRoot,
        ...(config.clock ? { clock: config.clock } : {}),
      }));
    }
  }

  destinationIds() {
    return [...this.#stores.keys()];
  }

  forDestination(destinationId) {
    if (!isDefinitionId(destinationId) || !this.#stores.has(destinationId)) {
      throw destinationError(destinationId);
    }
    return this.#stores.get(destinationId);
  }

  // SubmissionService accepts either this adapter or a legacy single-root
  // SubmissionStore, so retain the common method shape at the boundary.
  createSubmission(input, options) {
    return this.forDestination(DEFAULT_DESTINATION_ID).createSubmission(input, options);
  }
}

module.exports = {
  DEFAULT_DESTINATION_ID,
  DestinationAdapter,
  configuredDestinationRoots,
  destinationIdFor,
  storeForTemplate,
};
