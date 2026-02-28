'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');

const DEFAULT_PORT = 9876;
const DEFAULT_HOSTNAME = 'localhost';
const CONFIG_FILENAME = 'spyglass.yaml';

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

/**
 * Load spyglass.yaml from the project root (next to server.js).
 * Returns null if the file doesn't exist.
 */
function loadConfigFile() {
  // Check env override first, then project root
  const configPath = process.env.SPYGLASS_CONFIG
    ? path.resolve(expandHome(process.env.SPYGLASS_CONFIG))
    : path.resolve(__dirname, '..', CONFIG_FILENAME);

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object') {
      console.log(`Loaded config from ${configPath}`);
      return parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Warning: Failed to parse ${configPath}: ${error.message}`);
    }
  }

  return null;
}

/**
 * Parse ROOT_MAPPINGS env var (legacy support).
 */
function parseRootMappingsEnv(raw) {
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

const DEFAULT_REPOS = {
  // Configure your repos in spyglass.yaml or ROOT_MAPPINGS env var.
  // Example: { "my-docs": "~/Documents/docs", "notes": "~/notes" }
};

let _config = null;

function getConfig() {
  if (!_config) {
    _config = loadConfigFile() || {};
  }
  return _config;
}

function loadRootMappings() {
  // Priority: ROOT_MAPPINGS env > spyglass.yaml > defaults
  const envMappings = parseRootMappingsEnv(process.env.ROOT_MAPPINGS);
  if (envMappings && Object.keys(envMappings).length > 0) {
    return envMappings;
  }

  const config = getConfig();
  if (config.repositories && typeof config.repositories === 'object') {
    const output = {};
    for (const [repo, dir] of Object.entries(config.repositories)) {
      const key = normalizeRepoName(repo);
      if (!key || !dir) {
        continue;
      }
      output[key] = path.resolve(expandHome(String(dir)));
    }
    if (Object.keys(output).length > 0) {
      return output;
    }
  }

  return DEFAULT_REPOS;
}

function getPort() {
  // Priority: PORT env > spyglass.yaml > default
  const rawEnv = process.env.PORT;
  if (rawEnv) {
    const value = Number(rawEnv);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid PORT value: ${rawEnv}`);
    }
    return value;
  }

  const config = getConfig();
  if (config.server && config.server.port) {
    const value = Number(config.server.port);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      return value;
    }
  }

  return DEFAULT_PORT;
}

function getHostname() {
  const rawEnv = process.env.HOSTNAME;
  if (rawEnv && rawEnv.trim()) {
    return rawEnv.trim();
  }

  const config = getConfig();
  if (config.server && config.server.hostname) {
    return String(config.server.hostname).trim();
  }

  return DEFAULT_HOSTNAME;
}

module.exports = {
  loadRootMappings,
  getPort,
  getHostname,
};
