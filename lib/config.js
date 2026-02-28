'use strict';

const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 9876;
const DEFAULT_HOSTNAME = 'mac-mini-2.bobcat-tetra.ts.net';

function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function normalizeRepoName(name) {
  return String(name || '').trim().replace(/^\/+|\/+$/g, '');
}

function parseRootMappings(raw) {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid ROOT_MAPPINGS JSON: ${error.message}`);
    }
    const output = {};

    for (const [repo, dir] of Object.entries(parsed)) {
      const key = normalizeRepoName(repo);
      if (!key || !dir) {
        continue;
      }

      output[key] = path.resolve(expandHome(String(dir)));
    }

    return output;
  }

  const output = {};
  const pairs = trimmed.split(',');

  for (const pair of pairs) {
    const [rawRepo, ...dirParts] = pair.split('=');
    const repo = normalizeRepoName(rawRepo);
    const dir = dirParts.join('=').trim();

    if (!repo || !dir) {
      continue;
    }

    output[repo] = path.resolve(expandHome(dir));
  }

  return output;
}

function loadRootMappings() {
  const custom = parseRootMappings(process.env.ROOT_MAPPINGS);

  if (custom && Object.keys(custom).length > 0) {
    return custom;
  }

  return {
    operations: path.resolve(expandHome('~/operations')),
    'operations-fontastic': path.resolve(expandHome('~/operations-fontastic')),
    'operations-chris-fonte': path.resolve(expandHome('~/operations-chris-fonte')),
    clawd: path.resolve(expandHome('~/clawd')),
  };
}

function getPort() {
  const raw = process.env.PORT;

  if (!raw) {
    return DEFAULT_PORT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }

  return value;
}

function getHostname() {
  const raw = process.env.HOSTNAME;
  return raw && raw.trim() ? raw.trim() : DEFAULT_HOSTNAME;
}

module.exports = {
  loadRootMappings,
  getPort,
  getHostname,
};
