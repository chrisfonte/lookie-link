'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { toPosixPath } = require('./path-utils');

function constantTimeEqual(left, right) {
  const leftBuffer = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightBuffer = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeHumanDefault(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'restricted' || normalized === 'none') {
    return normalized;
  }
  return 'full';
}

function normalizePermissions(tokenConfig) {
  const permissions = tokenConfig && typeof tokenConfig === 'object' && tokenConfig.permissions && typeof tokenConfig.permissions === 'object'
    ? tokenConfig.permissions
    : {};
  const write = permissions.write === true || permissions.edit === true || tokenConfig.allowEditing === true;
  const publish = permissions.publish === true;
  const view = permissions.view !== false || write || publish;

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

function resolveTokenSecret(tokenConfig) {
  if (!tokenConfig || typeof tokenConfig !== 'object') {
    return null;
  }

  if (typeof tokenConfig.secretEnv === 'string' && tokenConfig.secretEnv.trim()) {
    const envValue = process.env[tokenConfig.secretEnv.trim()];
    if (typeof envValue === 'string' && envValue.trim()) {
      return envValue.trim();
    }
  }

  if (typeof tokenConfig.secret === 'string' && tokenConfig.secret.trim()) {
    return tokenConfig.secret.trim();
  }

  return null;
}

function parseAccessConfig(rawConfig) {
  const rawAccess = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const tokens = [];

  if (rawAccess.tokens && typeof rawAccess.tokens === 'object') {
    for (const [name, tokenConfig] of Object.entries(rawAccess.tokens)) {
      const secret = resolveTokenSecret(tokenConfig);
      if (!secret) {
        continue;
      }

      const permissions = normalizePermissions(tokenConfig);
      const repoScopes = normalizeRepoScopes(tokenConfig.repos);

      tokens.push({
        name,
        secret,
        secretSource: typeof tokenConfig.secretEnv === 'string' && tokenConfig.secretEnv.trim()
          ? { type: 'env', value: tokenConfig.secretEnv.trim() }
          : typeof tokenConfig.secret === 'string' && tokenConfig.secret.trim()
            ? { type: 'inline' }
            : null,
        permissions,
        allRepos: repoScopes.allRepos,
        repos: repoScopes.repos,
        subject: tokenConfig.subject || null,
        issuer: tokenConfig.issuer || null,
        audit: tokenConfig.audit || null,
      });
    }
  }

  return {
    humanDefault: normalizeHumanDefault(rawAccess.humanDefault),
    tokens,
  };
}

function extractBearerToken(req) {
  const header = typeof req.get === 'function'
    ? req.get('authorization')
    : (req.headers && (req.headers.authorization || req.headers.Authorization));
  if (typeof header !== 'string') {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token || null;
}

function extractQueryToken(req) {
  if (!req.query || typeof req.query.token !== 'string') {
    return null;
  }

  const token = req.query.token.trim();
  return token || null;
}

function extractPresentedToken(req) {
  return extractBearerToken(req) || extractQueryToken(req);
}

function authenticateRequest(req, accessConfig) {
  const headerToken = extractBearerToken(req);
  const queryToken = extractQueryToken(req);
  const presentedToken = headerToken || queryToken;

  if (!presentedToken) {
    return {
      mode: accessConfig.humanDefault === 'full' ? 'unrestricted' : 'denied',
      authType: accessConfig.humanDefault === 'full' ? 'human' : 'none',
      source: null,
      queryToken: null,
      permissions: {
        view: true,
        write: true,
        edit: true,
        publish: true,
      },
      allRepos: true,
      repos: {},
      denialStatus: 401,
      denialMessage: 'Authentication required.',
    };
  }

  const token = accessConfig.tokens.find((candidate) => constantTimeEqual(candidate.secret, presentedToken));
  if (!token) {
    return {
      mode: 'denied',
      authType: 'none',
      source: headerToken ? 'header' : 'query',
      queryToken: queryToken || null,
      permissions: {
        view: false,
        write: false,
        edit: false,
        publish: false,
      },
      allRepos: false,
      repos: {},
      denialStatus: 403,
      denialMessage: 'Invalid access token.',
    };
  }

  return {
    mode: 'scoped',
    authType: 'static_token',
    tokenName: token.name,
    source: headerToken ? 'header' : 'query',
    queryToken: headerToken ? null : queryToken,
    secretSource: token.secretSource,
    permissions: token.permissions,
    allRepos: token.allRepos,
    repos: token.repos,
    subject: token.subject,
    issuer: token.issuer,
    audit: token.audit,
    denialStatus: 403,
    denialMessage: 'Access denied.',
  };
}

function storeIsEnabled(store) {
  return Boolean(store && typeof store.isEnabled === 'function' && store.isEnabled());
}

function resolveCredentialAccess(req, accessConfig, apiKeyStore, grantStore) {
  const staticAccess = authenticateRequest(req, accessConfig);
  if (staticAccess.mode === 'scoped') {
    return staticAccess;
  }

  const headerToken = extractBearerToken(req);
  const queryToken = extractQueryToken(req);
  const presentedToken = headerToken || queryToken;
  if (!presentedToken) {
    return staticAccess;
  }

  const source = headerToken ? 'header' : 'query';
  const propagatedQueryToken = headerToken ? null : queryToken;
  if (storeIsEnabled(apiKeyStore)) {
    const apiKeyAccess = apiKeyStore.authenticateKey(presentedToken, source, propagatedQueryToken);
    if (apiKeyAccess) {
      return apiKeyAccess;
    }
  }

  if (storeIsEnabled(grantStore)) {
    const grantAccess = grantStore.authenticateGrantToken(presentedToken, source, propagatedQueryToken);
    if (grantAccess) {
      return grantAccess;
    }
  }

  return staticAccess;
}

function mutationUsesQueryToken(req) {
  if (!req.query || !Object.prototype.hasOwnProperty.call(req.query, 'token')) {
    return false;
  }

  const method = String(req.method || '').toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

function isAncestorPath(ancestor, value) {
  if (!ancestor) {
    return true;
  }

  return value === ancestor || value.startsWith(`${ancestor}/`);
}

function scopeAllowsFile(scope, relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  if (scope.type === 'all') {
    return true;
  }

  if (scope.type === 'directory') {
    return isAncestorPath(scope.path, normalizedPath);
  }

  return scope.path === normalizedPath;
}

function scopeIntersectsDirectory(scope, relativePath) {
  const normalizedPath = toPosixPath(relativePath).replace(/\/$/, '');
  if (scope.type === 'all') {
    return true;
  }

  if (scope.type === 'directory') {
    return isAncestorPath(normalizedPath, scope.path) || isAncestorPath(scope.path, normalizedPath);
  }

  const parentDir = path.posix.dirname(scope.path);
  const normalizedParent = parentDir === '.' ? '' : parentDir;
  return isAncestorPath(normalizedPath, normalizedParent);
}

function getRepoScopes(accessContext, repo) {
  if (accessContext.mode === 'unrestricted' || accessContext.allRepos) {
    return [{ type: 'all', path: '' }];
  }

  return accessContext.repos[repo] || [];
}

function canAccessPath(accessContext, action, repo, relativePath, pathType = 'file') {
  if (accessContext.mode === 'denied') {
    return false;
  }

  const permission = action === 'edit' ? 'write' : action;
  const allowed = permission === 'write'
    ? accessContext.permissions.write === true || accessContext.permissions.edit === true
    : accessContext.permissions[permission] === true;
  if (!allowed) {
    return false;
  }

  if (accessContext.mode === 'unrestricted') {
    return true;
  }

  const scopes = getRepoScopes(accessContext, repo);
  if (scopes.length === 0) {
    return false;
  }

  if (pathType === 'directory') {
    return scopes.some((scope) => scopeIntersectsDirectory(scope, relativePath));
  }

  return scopes.some((scope) => scopeAllowsFile(scope, relativePath));
}

function appendAccessToken(url, accessContext) {
  if (!accessContext || !accessContext.queryToken) {
    return url;
  }

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(accessContext.queryToken)}`;
}

module.exports = {
  parseAccessConfig,
  authenticateRequest,
  canAccessPath,
  appendAccessToken,
  extractBearerToken,
  extractQueryToken,
  extractPresentedToken,
  mutationUsesQueryToken,
  resolveCredentialAccess,
};
