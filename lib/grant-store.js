'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { toPosixPath } = require('./path-utils');

const DEFAULT_STORE = {
  version: 1,
  grants: [],
  auditEvents: [],
};

const ISSUER_ROLES = new Set([
  'board_user',
  'ceo_agent',
  'manager_agent',
  'trusted_ops_agent',
]);

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isYamlPath(filePath) {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

function cloneStore(store) {
  return {
    version: store.version,
    grants: store.grants.map((grant) => ({ ...grant })),
    auditEvents: store.auditEvents.map((event) => ({ ...event })),
  };
}

function readStoreFromDisk(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = isYamlPath(storePath) ? yaml.load(raw) : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return cloneStore(DEFAULT_STORE);
    }

    return {
      version: Number.isInteger(parsed.version) ? parsed.version : 1,
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
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
  fs.writeFileSync(tempPath, serialized, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function writeStoreToDisk(storePath, store) {
  const serialized = isYamlPath(storePath)
    ? yaml.dump(store, { noRefs: true, sortKeys: true })
    : `${JSON.stringify(store, null, 2)}\n`;
  writeSerializedFile(storePath, serialized, 'lookie-link-grants');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function normalizePermissions(rawPermissions) {
  const permissions = rawPermissions && typeof rawPermissions === 'object' ? rawPermissions : {};
  const edit = permissions.edit === true;
  const view = permissions.view !== false || edit;

  if (!view && !edit) {
    throw new Error('Grant must allow at least one permission.');
  }

  return { view, edit };
}

function normalizePaths(rawPaths) {
  if (rawPaths == null) {
    return [];
  }

  if (!Array.isArray(rawPaths)) {
    throw new Error('Grant paths must be an array.');
  }

  const normalized = [];
  for (const rawPath of rawPaths) {
    const normalizedPath = toPosixPath(rawPath);
    if (!normalizedPath || normalizedPath === '*') {
      continue;
    }

    const segments = normalizedPath.split('/');
    if (segments.includes('..')) {
      throw new Error(`Grant path is invalid: ${rawPath}`);
    }

    normalized.push(normalizedPath);
  }

  return Array.from(new Set(normalized)).sort();
}

function normalizeSubject(rawSubject, targetCompanyId) {
  const subject = rawSubject && typeof rawSubject === 'object' ? rawSubject : {};
  const subjectCompanyId = String(subject.companyId || targetCompanyId || '').trim();
  if (!subjectCompanyId) {
    throw new Error('Grant subject.companyId is required.');
  }

  const agentIds = Array.isArray(subject.agentIds)
    ? Array.from(new Set(subject.agentIds.map((value) => String(value || '').trim()).filter(Boolean))).sort()
    : [];
  const userIds = Array.isArray(subject.userIds)
    ? Array.from(new Set(subject.userIds.map((value) => String(value || '').trim()).filter(Boolean))).sort()
    : [];
  const agents = subject.agents === 'all' ? 'all' : null;

  if (agents !== 'all' && agentIds.length === 0 && userIds.length === 0) {
    throw new Error('Grant subject must target named agents, users, or agents=all.');
  }

  return {
    companyId: subjectCompanyId,
    agentIds,
    userIds,
    agents,
  };
}

function normalizeIssuer(rawIssuer) {
  const issuer = rawIssuer && typeof rawIssuer === 'object' ? rawIssuer : {};
  const role = String(issuer.role || '').trim();
  if (!ISSUER_ROLES.has(role)) {
    throw new Error('Issuer role must be one of board_user, ceo_agent, manager_agent, or trusted_ops_agent.');
  }

  const companyId = String(issuer.companyId || '').trim();
  if (!companyId) {
    throw new Error('Issuer companyId is required.');
  }

  const agentId = issuer.agentId == null ? null : String(issuer.agentId).trim() || null;
  const userId = issuer.userId == null ? null : String(issuer.userId).trim() || null;
  if (!agentId && !userId) {
    throw new Error('Issuer must include agentId or userId.');
  }

  return { role, companyId, agentId, userId };
}

function parseIsoDate(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${fieldName} is required.`);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO timestamp.`);
  }

  return parsed.toISOString();
}

function computeGrantState(grant, now = Date.now()) {
  if (grant.revokedAt) {
    return 'revoked';
  }
  if (Date.parse(grant.expiresAt) <= now) {
    return 'expired';
  }
  return 'active';
}

function serializeGrant(grant, now = Date.now()) {
  return {
    ...grant,
    state: computeGrantState(grant, now),
  };
}

function serializeGrantProjection(grant) {
  return {
    id: grant.id,
    sourceCompanyId: grant.sourceCompanyId,
    targetCompanyId: grant.targetCompanyId,
    subject: { ...grant.subject },
    repoId: grant.repoId,
    paths: Array.isArray(grant.paths) ? [...grant.paths] : [],
    permissions: { ...grant.permissions },
    expiresAt: grant.expiresAt,
    tokenHash: grant.tokenHash,
  };
}

function grantAllowsRepo(grant, repoId) {
  return grant.repoId === repoId;
}

function scopesFromPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return [{ type: 'all', path: '' }];
  }

  return paths.map((entry) => {
    if (entry.endsWith('/')) {
      return { type: 'directory', path: entry.slice(0, -1) };
    }
    return { type: 'file', path: entry };
  });
}

function buildAccessContextForGrant(grant, source, queryToken) {
  return {
    mode: 'scoped',
    tokenName: `grant:${grant.id}`,
    grantId: grant.id,
    source,
    queryToken: source === 'query' ? queryToken : null,
    permissions: grant.permissions,
    allRepos: false,
    repos: {
      [grant.repoId]: scopesFromPaths(grant.paths),
    },
    denialStatus: 403,
    denialMessage: 'Access denied.',
  };
}

function roleAllowsIssuance(issuer, sourceCompanyId, context) {
  if (issuer.role === 'trusted_ops_agent') {
    return Boolean(
      context.sourceIssueId &&
      context.targetCompanyId &&
      context.reason &&
      context.expiresAt
    );
  }

  if (issuer.companyId !== sourceCompanyId) {
    return false;
  }

  if (issuer.role === 'board_user' || issuer.role === 'ceo_agent') {
    return true;
  }

  return issuer.role === 'manager_agent' && Boolean(context.sourceIssueId || context.approvalId);
}

function roleAllowsRevocation(issuer, grant) {
  const sameActor = (
    (issuer.agentId && issuer.agentId === grant.issuedByAgentId) ||
    (issuer.userId && issuer.userId === grant.issuedByUserId)
  );
  if (sameActor) {
    return true;
  }

  if (issuer.role === 'trusted_ops_agent') {
    return Boolean(grant.sourceIssueId);
  }

  return issuer.companyId === grant.sourceCompanyId
    && (issuer.role === 'board_user' || issuer.role === 'ceo_agent' || issuer.role === 'manager_agent');
}

function requiresApproval({ permissions, paths, subject, expiresAt, now }) {
  const durationMs = Date.parse(expiresAt) - now;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const broadSubject = subject.agents === 'all' || subject.userIds.length > 0;
  const wholeRepo = paths.length === 0;

  return permissions.edit || wholeRepo || durationMs > sevenDaysMs || broadSubject;
}

function createAuditEvent(grantId, type, actor, extra = {}) {
  return {
    id: crypto.randomUUID(),
    grantId,
    type,
    actorAgentId: actor && actor.agentId ? actor.agentId : null,
    actorUserId: actor && actor.userId ? actor.userId : null,
    actorCompanyId: actor && actor.companyId ? actor.companyId : null,
    createdAt: new Date().toISOString(),
    ...extra,
  };
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

function realpathOrResolved(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return path.resolve(targetPath);
    }
    throw error;
  }
}

function isWithinRoot(rootPath, targetPath) {
  if (targetPath === rootPath) {
    return true;
  }

  const withSep = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return targetPath.startsWith(withSep);
}

function normalizeAllowRoots(rawAllowRoots) {
  if (rawAllowRoots == null) {
    return [];
  }

  if (!Array.isArray(rawAllowRoots)) {
    throw new Error('adapterAllowRoots must be an array of absolute paths.');
  }

  const normalized = rawAllowRoots
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => {
      if (!path.isAbsolute(entry)) {
        throw new Error(`adapterAllowRoots entry must be absolute: ${entry}`);
      }

      return realpathOrResolved(entry);
    });

  return Array.from(new Set(normalized)).sort();
}

function validateGrantTargetsWithinAllowRoots(repoId, repoRoot, grantPaths, adapterAllowRoots) {
  const normalizedAllowRoots = normalizeAllowRoots(adapterAllowRoots);
  if (normalizedAllowRoots.length === 0) {
    throw new Error('adapterAllowRoots is required for cross-company grants.');
  }

  if (!repoRoot) {
    throw new Error(`Repository root path is unavailable for repo ${repoId}.`);
  }

  const resolvedRepoRoot = fs.realpathSync(repoRoot);
  const targets = grantPaths.length === 0
    ? [{ label: repoId, absolutePath: resolvedRepoRoot }]
    : grantPaths.map((grantPath) => {
        const candidatePath = realpathOrResolved(path.join(resolvedRepoRoot, grantPath));
        if (!isWithinRoot(resolvedRepoRoot, candidatePath)) {
          throw new Error(`Grant path is invalid: ${grantPath}`);
        }

        return {
          label: grantPath,
          absolutePath: candidatePath,
        };
      });

  for (const target of targets) {
    const allowed = normalizedAllowRoots.some((root) => isWithinRoot(root, target.absolutePath));
    if (!allowed) {
      throw new Error(`Grant path ${target.label} is outside adapter allow roots.`);
    }
  }

  return normalizedAllowRoots;
}

class GrantStore {
  constructor(config) {
    this.storePath = config.storePath;
    this.projectionPath = config.projectionPath;
    this.repoOwners = config.repoOwners;
    this.adminTokens = config.adminTokens;
    this.repoRoots = config.repoRoots;
  }

  static fromAccessConfig(rawGrantsConfig) {
    const grantsConfig = rawGrantsConfig && typeof rawGrantsConfig === 'object' ? rawGrantsConfig : {};
    const storePath = typeof grantsConfig.storePath === 'string' && grantsConfig.storePath.trim()
      ? path.resolve(grantsConfig.storePath.trim())
      : null;
    const projectionPath = typeof grantsConfig.projectionPath === 'string' && grantsConfig.projectionPath.trim()
      ? path.resolve(grantsConfig.projectionPath.trim())
      : null;
    const repoOwners = grantsConfig.repoOwners && typeof grantsConfig.repoOwners === 'object'
      ? Object.fromEntries(
          Object.entries(grantsConfig.repoOwners)
            .map(([repoId, companyId]) => [String(repoId || '').trim(), String(companyId || '').trim()])
            .filter(([repoId, companyId]) => repoId && companyId)
        )
      : {};
    const adminTokens = parseAdminTokens(grantsConfig.adminTokens);

    if (!storePath) {
      return null;
    }

    return new GrantStore({
      storePath,
      projectionPath,
      repoOwners,
      adminTokens,
      repoRoots: grantsConfig.repoRoots && typeof grantsConfig.repoRoots === 'object' ? grantsConfig.repoRoots : {},
    });
  }

  isEnabled() {
    return Boolean(this.storePath);
  }

  getRepoOwner(repoId) {
    return this.repoOwners[repoId] || null;
  }

  getRepoRoot(repoId) {
    return this.repoRoots[repoId] || null;
  }

  readStore() {
    return readStoreFromDisk(this.storePath);
  }

  writeStore(store) {
    writeStoreToDisk(this.storePath, store);
    this.writeProjection(store);
  }

  writeProjection(store) {
    if (!this.projectionPath) {
      return;
    }

    const now = Date.now();
    const projection = {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      grants: store.grants
        .filter((grant) => computeGrantState(grant, now) === 'active')
        .map((grant) => serializeGrantProjection(grant)),
    };
    const serialized = isYamlPath(this.projectionPath)
      ? yaml.dump(projection, { noRefs: true, sortKeys: true })
      : `${JSON.stringify(projection, null, 2)}\n`;
    writeSerializedFile(this.projectionPath, serialized, 'lookie-link-grant-projection');
  }

  authenticateAdminToken(secret) {
    if (!secret) {
      return null;
    }

    return this.adminTokens.find((token) => constantTimeEqual(token.secret, secret)) || null;
  }

  authenticateGrantToken(secret, source, queryToken) {
    if (!secret) {
      return null;
    }

    const store = this.readStore();
    const hash = hashSecret(secret);
    let changed = false;
    const now = Date.now();

    for (const grant of store.grants) {
      const state = computeGrantState(grant, now);
      if (state === 'expired' && !store.auditEvents.some((event) => event.grantId === grant.id && event.type === 'grant.expired')) {
        store.auditEvents.push(createAuditEvent(grant.id, 'grant.expired', null, { expiresAt: grant.expiresAt }));
        changed = true;
      }

      if (grant.tokenHash !== hash || state !== 'active') {
        continue;
      }

      grant.lastUsedAt = new Date().toISOString();
      changed = true;
      if (changed) {
        this.writeStore(store);
      }

      return buildAccessContextForGrant(grant, source, queryToken);
    }

    if (changed) {
      this.writeStore(store);
    }

    return null;
  }

  listGrants(filters = {}) {
    const store = this.readStore();
    const now = Date.now();
    let changed = false;

    for (const grant of store.grants) {
      if (computeGrantState(grant, now) === 'expired' && !store.auditEvents.some((event) => event.grantId === grant.id && event.type === 'grant.expired')) {
        store.auditEvents.push(createAuditEvent(grant.id, 'grant.expired', null, { expiresAt: grant.expiresAt }));
        changed = true;
      }
    }

    if (changed) {
      this.writeStore(store);
    }

    const grants = store.grants
      .filter((grant) => !filters.sourceCompanyId || grant.sourceCompanyId === filters.sourceCompanyId)
      .filter((grant) => !filters.targetCompanyId || grant.targetCompanyId === filters.targetCompanyId)
      .filter((grant) => !filters.repoId || grant.repoId === filters.repoId)
      .filter((grant) => !filters.state || computeGrantState(grant, now) === filters.state)
      .map((grant) => serializeGrant(grant, now));

    return {
      grants,
      auditEvents: filters.includeAudit === true ? store.auditEvents.map((event) => ({ ...event })) : undefined,
    };
  }

  createGrant(input) {
    const repoId = String(input.repoId || '').trim();
    if (!repoId) {
      throw new Error('repoId is required.');
    }

    const sourceCompanyId = String(input.sourceCompanyId || '').trim();
    const targetCompanyId = String(input.targetCompanyId || '').trim();
    if (!sourceCompanyId || !targetCompanyId) {
      throw new Error('sourceCompanyId and targetCompanyId are required.');
    }
    const crossCompany = sourceCompanyId !== targetCompanyId;

    const ownerCompanyId = this.getRepoOwner(repoId);
    if (!ownerCompanyId) {
      throw new Error(`No source company is configured for repo ${repoId}.`);
    }
    if (ownerCompanyId !== sourceCompanyId) {
      throw new Error(`Repo ${repoId} is owned by ${ownerCompanyId}, not ${sourceCompanyId}.`);
    }

    const issuer = normalizeIssuer(input.issuer);
    const subject = normalizeSubject(input.subject, targetCompanyId);
    const permissions = normalizePermissions(input.permissions);
    const paths = normalizePaths(input.paths);
    const reason = String(input.reason || '').trim();
    const sourceIssueId = String(input.sourceIssueId || '').trim();
    const approvalId = input.approvalId == null ? null : String(input.approvalId).trim() || null;
    if (!sourceIssueId) {
      throw new Error('sourceIssueId is required.');
    }
    if (!reason) {
      throw new Error('reason is required.');
    }

    const expiresAt = input.expiresAt
      ? parseIsoDate(input.expiresAt, 'expiresAt')
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const expiresAtMs = Date.parse(expiresAt);
    if (expiresAtMs <= Date.now()) {
      throw new Error('expiresAt must be in the future.');
    }

    if (!roleAllowsIssuance(issuer, sourceCompanyId, {
      sourceIssueId,
      approvalId,
      targetCompanyId,
      reason,
      expiresAt,
    })) {
      throw new Error('Issuer is not allowed to create a grant for this source company.');
    }

    if (requiresApproval({ permissions, paths, subject, expiresAt, now: Date.now() }) && !approvalId) {
      throw new Error('approvalId is required for edit access, whole-repo access, broad subjects, or expiry longer than 7 days.');
    }

    let validatedAdapterAllowRoots = [];
    if (crossCompany) {
      validatedAdapterAllowRoots = validateGrantTargetsWithinAllowRoots(
        repoId,
        this.getRepoRoot(repoId),
        paths,
        input.adapterAllowRoots
      );
    }

    const store = this.readStore();
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString('base64url');
    const grant = {
      id,
      sourceCompanyId,
      targetCompanyId,
      subject,
      repoId,
      paths,
      permissions,
      sourceIssueId,
      approvalId,
      reason,
      issuedByAgentId: issuer.agentId,
      issuedByUserId: issuer.userId,
      createdAt: new Date().toISOString(),
      expiresAt,
      revokedAt: null,
      revokedByAgentId: null,
      revokedByUserId: null,
      revocationReason: null,
      tokenHash: hashSecret(secret),
      lastUsedAt: null,
      adapterAllowRoots: validatedAdapterAllowRoots,
    };
    store.grants.push(grant);
    store.auditEvents.push(createAuditEvent(grant.id, 'grant.created', issuer, {
      sourceIssueId,
      approvalId,
      expiresAt,
      repoId,
    }));
    this.writeStore(store);

    return {
      grant: serializeGrant(grant),
      token: secret,
    };
  }

  renewGrant(grantId, input) {
    const issuer = normalizeIssuer(input.issuer);
    const reason = String(input.reason || '').trim();
    if (!reason) {
      throw new Error('reason is required.');
    }

    const store = this.readStore();
    const grant = store.grants.find((candidate) => candidate.id === grantId);
    if (!grant) {
      throw new Error('Grant not found.');
    }
    if (grant.revokedAt) {
      throw new Error('Revoked grants cannot be renewed.');
    }
    if (!roleAllowsRevocation(issuer, grant)) {
      throw new Error('Issuer is not allowed to renew this grant.');
    }

    const expiresAt = input.expiresAt
      ? parseIsoDate(input.expiresAt, 'expiresAt')
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    if (requiresApproval({
      permissions: grant.permissions,
      paths: grant.paths,
      subject: grant.subject,
      expiresAt,
      now: Date.now(),
    }) && !grant.approvalId && !(input.approvalId && String(input.approvalId).trim())) {
      throw new Error('approvalId is required to renew this grant with the requested scope or expiry.');
    }

    if (Date.parse(expiresAt) <= Date.now()) {
      throw new Error('expiresAt must be in the future.');
    }

    const nextApprovalId = input.approvalId == null ? grant.approvalId : String(input.approvalId).trim() || null;
    grant.expiresAt = expiresAt;
    grant.approvalId = nextApprovalId;

    let rotatedToken = null;
    const rotateToken = input.rotateToken !== false;
    if (rotateToken) {
      rotatedToken = crypto.randomBytes(24).toString('base64url');
      grant.tokenHash = hashSecret(rotatedToken);
      store.auditEvents.push(createAuditEvent(grant.id, 'grant.token.rotated', issuer, {
        reason,
      }));
    }

    store.auditEvents.push(createAuditEvent(grant.id, 'grant.renewed', issuer, {
      reason,
      approvalId: nextApprovalId,
      expiresAt,
    }));
    this.writeStore(store);

    return {
      grant: serializeGrant(grant),
      token: rotatedToken,
    };
  }

  revokeGrant(grantId, input) {
    const issuer = normalizeIssuer(input.issuer);
    const reason = String(input.reason || '').trim();
    if (!reason) {
      throw new Error('reason is required.');
    }

    const store = this.readStore();
    const grant = store.grants.find((candidate) => candidate.id === grantId);
    if (!grant) {
      throw new Error('Grant not found.');
    }
    if (grant.revokedAt) {
      throw new Error('Grant is already revoked.');
    }
    if (!roleAllowsRevocation(issuer, grant)) {
      throw new Error('Issuer is not allowed to revoke this grant.');
    }

    grant.revokedAt = new Date().toISOString();
    grant.revokedByAgentId = issuer.agentId;
    grant.revokedByUserId = issuer.userId;
    grant.revocationReason = reason;
    store.auditEvents.push(createAuditEvent(grant.id, 'grant.revoked', issuer, {
      reason,
    }));
    this.writeStore(store);

    return {
      grant: serializeGrant(grant),
    };
  }
}

module.exports = {
  GrantStore,
};
