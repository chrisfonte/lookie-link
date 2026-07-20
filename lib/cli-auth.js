'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const AUTH_PATH = path.join(os.homedir(), '.config', 'lookie-link', 'auth.yaml');
const DEFAULT_BASE_URL = 'http://localhost:9876';

function normalizeBaseUrl(value) {
  const candidate = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Lookie-Link instance must be a valid http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Lookie-Link instance must be an http(s) URL without embedded credentials.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function readAuthFile() {
  try {
    const raw = await fs.readFile(AUTH_PATH, 'utf8');
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeAuthFile(data) {
  const serialized = yaml.dump(data, { noRefs: true, sortKeys: true });
  const directory = path.dirname(AUTH_PATH);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.writeFile(AUTH_PATH, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(AUTH_PATH, 0o600);
}

async function resolveAuth(overrides = {}) {
  const stored = await readAuthFile();
  const baseUrl = normalizeBaseUrl(
    overrides.baseUrl || stored.instance || process.env.LOOKIE_LINK_BASE_URL || DEFAULT_BASE_URL
  );
  const token = overrides.token !== undefined
    ? overrides.token
    : process.env.LOOKIE_LINK_TOKEN || stored.token || null;

  return {
    baseUrl,
    token: typeof token === 'string' && token.trim() ? token.trim() : null,
    authPath: AUTH_PATH,
  };
}

async function readTokenFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

module.exports = {
  AUTH_PATH,
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  readAuthFile,
  writeAuthFile,
  resolveAuth,
  readTokenFromStdin,
};
