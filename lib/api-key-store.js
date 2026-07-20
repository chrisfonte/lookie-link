'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const { toPosixPath } = require('./path-utils');

const DEFAULT_STORE = {
  version: 1,
  keys: [],
  auditEvents: [],
};

function constantTimeEqual(left, right) {
  const leftBuffer = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightBuffer = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isYamlPath(filePath) {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

function cloneStore(store) {
  return {
    version: store.version,
    keys: store.keys.map((entry) => ({
      ...entry,
      subject: { ...entry.subject },
      permissions: { ...entry.permissions },
      repos: JSON.parse(JSON.stringify(entry.repos || {})),
    })),
    auditEvents: store.auditEvents.map((event) => ({ ...event })),
  };
}

function readStoreFromDisk(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    fs.chmodSync(storePath, 0o600);
    const parsed = isYamlPath(storePath) ? yaml.load(raw) : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return cloneStore(DEFAULT_STORE);
    }

    return {
      version: Number.isInteger(parsed.version) ? parsed.version : 1,
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return cloneStore(DEFAULT_STORE);
    }
    throw error;
  }
}

function writeSerializedFile(targetPath, serialized, prefix) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, targetPath);
    fs.chmodSync(targetPath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (_cleanupError) {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function writeStoreToDisk(storePath, store) {
  const serialized = isYamlPath(storePath)
    ? yaml.dump(store, { noRefs: true, sortKeys: true })
    : `${JSON.stringify(store, null, 2)}\n`;
  writeSerializedFile(storePath, serialized, 'lookie-link-api-keys');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function normalizePermissions(rawPermissions) {
  const permissions = rawPermissions && typeof rawPermissions === 'object' ? rawPermissions : {};
  const write = permissions.write === true || permissions.edit === true;
  const publish = permissions.publish === true;
  const view = permissions.view !== false || write || publish;

  if (!view && !write && !publish) {
    throw new Error('API key must allow at least one permission.');
  }

  return {
    view,
    write,
    edit: write,
    publish,
  };
}

function normalizeScopeEntry(rawScope) {
  const normalized = toPosixPath(rawScope);
  if (!normalized || normalized === '*') {
    return { type: 'all', path: '' };
  }

  if (normalized.endsWith('/')) {
    return {
      type: 'directory',
      path: normalized.slice(0, -1),
    };
  }

  return {
    type: 'file',
    path: normalized,
  };
}

function normalizeRepoScopes(rawRepos) {
  const normalized = {
    allRepos: false,
    repos: {},
  };

  if (rawRepos === 'all') {
    normalized.allRepos = true;
    return normalized;
  }

  if (Array.isArray(rawRepos)) {
    for (const repoName of rawRepos) {
      const repo = String(repoName || '').trim();
      if (!repo) {
        continue;
      }
      normalized.repos[repo] = [{ type: 'all', path: '' }];
    }
    return normalized;
  }

  if (!rawRepos || typeof rawRepos !== 'object') {
    return normalized;
  }

  for (const [repoName, rawScopeConfig] of Object.entries(rawRepos)) {
    const repo = String(repoName || '').trim();
    if (!repo) {
      continue;
    }

    if (rawScopeConfig === 'all' || rawScopeConfig === true || rawScopeConfig === null) {
      normalized.repos[repo] = [{ type: 'all', path: '' }];
      continue;
    }

    const rawPaths = Array.isArray(rawScopeConfig)
      ? rawScopeConfig
      : Array.isArray(rawScopeConfig && rawScopeConfig.paths)
        ? rawScopeConfig.paths
        : null;

    if (!rawPaths || rawPaths.length === 0) {
      normalized.repos[repo] = [{ type: 'all', path: '' }];
      continue;
    }

    const scopes = rawPaths
      .map(normalizeScopeEntry)
      .filter(Boolean);

    if (scopes.length > 0) {
      normalized.repos[repo] = scopes;
    }
  }

  return normalized;
}

function normalizeSubject(rawSubject) {
  const subject = rawSubject && typeof rawSubject === 'object' ? rawSubject : {};
  const agentId = String(subject.agentId || '').trim();
  const companyId = String(subject.companyId || '').trim();
  const label = subject.label == null ? null : String(subject.label).trim() || null;

  if (!agentId) {
    throw new Error('subject.agentId is required.');
  }
  if (!companyId) {
    throw new Error('subject.companyId is required.');
  }

  return { agentId, companyId, label };
}

function normalizeIssuer(rawIssuer, adminTokenName) {
  const issuer = rawIssuer && typeof rawIssuer === 'object' ? rawIssuer : {};

  return {
    adminTokenName: adminTokenName || null,
    actorType: issuer.actorType == null ? null : String(issuer.actorType).trim() || null,
    actorId: issuer.actorId == null ? null : String(issuer.actorId).trim() || null,
  };
}

function expandHome(input) {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveSecret(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }

  if (typeof config.secretEnv === 'string' && config.secretEnv.trim()) {
    const value = process.env[config.secretEnv.trim()];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (typeof config.secret === 'string' && config.secret.trim()) {
    return config.secret.trim();
  }

  return null;
}

function parseAdminTokens(rawAdminTokens) {
  if (!rawAdminTokens || typeof rawAdminTokens !== 'object') {
    return [];
  }

  return Object.entries(rawAdminTokens)
    .map(([name, config]) => {
      const secret = resolveSecret(config);
      if (!secret) {
        return null;
      }
      return { name, secret };
    })
    .filter(Boolean);
}

function computeKeyState(apiKey) {
  if (apiKey.revokedAt) {
    return 'revoked';
  }
  return 'active';
}

function serializeApiKey(apiKey) {
  return {
    id: apiKey.id,
    label: apiKey.label,
    subject: { ...apiKey.subject },
    permissions: { ...apiKey.permissions },
    allRepos: apiKey.allRepos,
    repos: JSON.parse(JSON.stringify(apiKey.repos || {})),
    createdAt: apiKey.createdAt,
    rotatedAt: apiKey.rotatedAt,
    lastUsedAt: apiKey.lastUsedAt,
    revokedAt: apiKey.revokedAt,
    revokedReason: apiKey.revokedReason,
    state: computeKeyState(apiKey),
  };
}

function createAuditEvent(type, payload = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    createdAt: new Date().toISOString(),
    ...payload,
  };
}

function buildAccessContextForKey(apiKey, source, queryToken) {
  return {
    mode: 'scoped',
    authType: 'api_key',
    tokenName: `api-key:${apiKey.id}`,
    keyId: apiKey.id,
    subject: { ...apiKey.subject },
    principal: {
      kind: 'agent',
      id: apiKey.subject.agentId,
      credentialKind: 'api_key',
      credentialId: apiKey.id,
    },
    source,
    queryToken: source === 'query' ? queryToken : null,
    permissions: { ...apiKey.permissions },
    allRepos: apiKey.allRepos,
    repos: JSON.parse(JSON.stringify(apiKey.repos || {})),
    denialStatus: 403,
    denialMessage: 'Access denied.',
  };
}

class ApiKeyStore {
  constructor(config) {
    this.storePath = config.storePath;
    this.adminTokens = config.adminTokens;
  }

  static fromAccessConfig(rawApiKeysConfig) {
    const apiKeysConfig = rawApiKeysConfig && typeof rawApiKeysConfig === 'object' ? rawApiKeysConfig : {};
    const storePath = typeof apiKeysConfig.storePath === 'string' && apiKeysConfig.storePath.trim()
      ? path.resolve(expandHome(apiKeysConfig.storePath.trim()))
      : null;

    if (!storePath) {
      return null;
    }

    return new ApiKeyStore({
      storePath,
      adminTokens: parseAdminTokens(apiKeysConfig.adminTokens),
    });
  }

  isEnabled() {
    return Boolean(this.storePath);
  }

  readStore() {
    return readStoreFromDisk(this.storePath);
  }

  writeStore(store) {
    writeStoreToDisk(this.storePath, store);
  }

  authenticateAdminToken(secret) {
    if (!secret) {
      return null;
    }

    return this.adminTokens.find((token) => constantTimeEqual(token.secret, secret)) || null;
  }

  authenticateKey(secret, source, queryToken) {
    if (!secret) {
      return null;
    }

    const store = this.readStore();
    const hash = hashSecret(secret);

    let matchedKey = null;
    for (const apiKey of store.keys) {
      const secretMatches = constantTimeEqual(apiKey.secretHash, hash);
      if (secretMatches && computeKeyState(apiKey) === 'active') {
        matchedKey = apiKey;
      }
    }

    if (matchedKey) {
      matchedKey.lastUsedAt = new Date().toISOString();
      this.writeStore(store);
      return buildAccessContextForKey(matchedKey, source, queryToken);
    }

    return null;
  }

  listKeys(filters = {}) {
    const store = this.readStore();
    const keys = store.keys
      .filter((apiKey) => !filters.state || computeKeyState(apiKey) === filters.state)
      .filter((apiKey) => !filters.agentId || apiKey.subject.agentId === filters.agentId)
      .map((apiKey) => serializeApiKey(apiKey));

    return {
      keys,
      auditEvents: filters.includeAudit === true ? store.auditEvents.map((event) => ({ ...event })) : undefined,
    };
  }

  createKey(input, admin) {
    const label = String(input.label || '').trim();
    if (!label) {
      throw new Error('label is required.');
    }

    const subject = normalizeSubject(input.subject);
    const permissions = normalizePermissions(input.permissions);
    const repoScopes = normalizeRepoScopes(input.repos);
    const issuer = normalizeIssuer(input.issuer, admin && admin.name);
    const store = this.readStore();
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString('base64url');
    const apiKey = {
      id,
      label,
      subject,
      permissions,
      allRepos: repoScopes.allRepos,
      repos: repoScopes.repos,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
      secretHash: hashSecret(secret),
    };

    store.keys.push(apiKey);
    store.auditEvents.push(createAuditEvent('api_key.created', {
      keyId: apiKey.id,
      subjectAgentId: apiKey.subject.agentId,
      subjectCompanyId: apiKey.subject.companyId,
      issuer,
      permissions: { ...apiKey.permissions },
    }));
    this.writeStore(store);

    return {
      key: serializeApiKey(apiKey),
      token: secret,
    };
  }

  rotateKey(keyId, input, admin) {
    const reason = String(input.reason || '').trim();
    const issuer = normalizeIssuer(input.issuer, admin && admin.name);
    const store = this.readStore();
    const apiKey = store.keys.find((entry) => entry.id === keyId);
    if (!apiKey || computeKeyState(apiKey) !== 'active') {
      const error = new Error('Agent API key not found.');
      error.code = 'ENOTFOUND';
      throw error;
    }

    const secret = crypto.randomBytes(24).toString('base64url');
    apiKey.secretHash = hashSecret(secret);
    apiKey.rotatedAt = new Date().toISOString();
    store.auditEvents.push(createAuditEvent('api_key.rotated', {
      keyId: apiKey.id,
      subjectAgentId: apiKey.subject.agentId,
      subjectCompanyId: apiKey.subject.companyId,
      issuer,
      reasonProvided: Boolean(reason),
    }));
    this.writeStore(store);

    return {
      key: serializeApiKey(apiKey),
      token: secret,
    };
  }

  revokeKey(keyId, input, admin) {
    const reason = String(input.reason || '').trim();
    if (!reason) {
      throw new Error('reason is required.');
    }

    const issuer = normalizeIssuer(input.issuer, admin && admin.name);
    const store = this.readStore();
    const apiKey = store.keys.find((entry) => entry.id === keyId);
    if (!apiKey || computeKeyState(apiKey) !== 'active') {
      const error = new Error('Agent API key not found.');
      error.code = 'ENOTFOUND';
      throw error;
    }

    apiKey.revokedAt = new Date().toISOString();
    apiKey.revokedReason = reason;
    store.auditEvents.push(createAuditEvent('api_key.revoked', {
      keyId: apiKey.id,
      subjectAgentId: apiKey.subject.agentId,
      subjectCompanyId: apiKey.subject.companyId,
      issuer,
      reasonProvided: true,
    }));
    this.writeStore(store);

    return {
      key: serializeApiKey(apiKey),
    };
  }

  recordAuditEvent(type, accessContext, target, metadata = {}) {
    if (!accessContext || accessContext.authType !== 'api_key' || !accessContext.keyId) {
      return null;
    }

    const store = this.readStore();
    const event = createAuditEvent(type, {
      keyId: accessContext.keyId,
      actorAgentId: accessContext.subject && accessContext.subject.agentId ? accessContext.subject.agentId : null,
      actorCompanyId: accessContext.subject && accessContext.subject.companyId ? accessContext.subject.companyId : null,
      resourceKind: target && target.repo ? 'repo' : null,
      resourceId: target && target.repo ? String(target.repo) : null,
      outcome: typeof metadata.outcome === 'string' ? metadata.outcome : null,
      requestId: typeof metadata.requestId === 'string' ? metadata.requestId : null,
      byteCount: Number.isSafeInteger(metadata.byteCount) && metadata.byteCount >= 0 ? metadata.byteCount : null,
    });
    store.auditEvents.push(event);
    this.writeStore(store);
    return event;
  }
}

module.exports = {
  ApiKeyStore,
};
