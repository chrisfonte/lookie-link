'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { JSDOM } = require('jsdom');

const {
  loadRootMappings,
  getPort,
  getHostname,
  getEditingEnabled,
  getAnnotationsEnabled,
  getRawHtmlEnabled,
  getAccessConfig,
  getManagedReposConfig,
  getPublishConfig,
  getFormsConfig,
  loadCustomThemes,
  generateCustomThemeCss,
  BUILT_IN_THEMES,
} = require('./lib/config');
const {
  parseAccessConfig,
  canAccessPath,
  canAccessRepo,
  appendAccessToken,
  extractBearerToken,
  extractPresentedToken,
  mutationUsesQueryToken,
  resolveCredentialAccess,
} = require('./lib/access-control');
const {
  GrantStore,
  buildIssueComment,
} = require('./lib/grant-store');
const { ApiKeyStore } = require('./lib/api-key-store');
const { ManagedRepoStore } = require('./lib/managed-repo-store');
const { searchManagedRepos, suggestManagedRepos } = require('./lib/managed-repo-search');
const { PublishStore } = require('./lib/publish-store');
const {
  safeResolve,
  toPosixPath,
  splitViewPath,
  buildHref,
  buildAssetHref,
  buildEditHref,
  buildSaveHref,
  buildPreviewHref,
  buildRawHref,
  buildEmbedHref,
  formatFileSize,
  formatMTime,
  compareEntries,
  parentPath,
} = require('./lib/path-utils');
const {
  renderDocumentPage,
  renderDirectoryPage,
  renderImagePage,
  renderAudioPage,
  renderVideoPage,
  renderPdfPage,
  renderCsvPage,
  renderJsonPage,
  renderEditPage,
  renderPreviewHtml,
  renderAnnotationMarkdown,
  setThemeList,
  setNavLinks,
} = require('./lib/renderer');
const {
  readAnnotationDocument,
  filterAnnotationsByState,
  createAnnotation,
  updateAnnotation,
} = require('./lib/annotations');
const {
  decodeEmbedHtmlBuffer,
  transformEmbedHtml,
} = require('./lib/embed-html');
const {
  buildAgentDiscoveryDocument,
  buildWhoAmIDocument,
} = require('./lib/agent-discovery');
const { TemplateRegistry } = require('./lib/forms/template-registry');
const {
  DestinationAdapter,
  configuredDestinationRoots,
} = require('./lib/forms/destination-adapter');
const { SubmissionService } = require('./lib/forms/submission-service');
const { createFormsRouter } = require('./lib/forms/routes');

const { version: LOOKIE_LINK_VERSION } = require('./package.json');

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const AUDIO_MIME_TYPES = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

const PDF_MIME_TYPES = {
  '.pdf': 'application/pdf',
};


const SECONDARY_VIEW_EXTENSIONS = new Set(['.example', '.tmpl', '.template', '.dist', '.sample']);
function effectiveViewExtension(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (!SECONDARY_VIEW_EXTENSIONS.has(ext)) {
    return ext;
  }
  const stripped = relativePath.slice(0, -ext.length);
  return path.extname(stripped).toLowerCase() || ext;
}

const CSV_EXTENSIONS = new Set(['.csv']);
const JSON_VIEWER_EXTENSIONS = new Set(['.json']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const RAW_HTML_MIME_TYPE = 'text/html; charset=utf-8';

// Text/source asset mime allowlist. Served as raw bytes via /asset/ so agents
// (and curl) can fetch markdown, code, and config sources without scraping HTML.
// HTML-ish extensions are intentionally returned as text/plain to prevent the
// raw page from being auto-rendered by a browser hitting /asset/ directly.
const TEXT_PLAIN = 'text/plain; charset=utf-8';
const TEXT_MIME_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mdown': 'text/markdown; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': TEXT_PLAIN,
  '.toml': TEXT_PLAIN,
  '.ini': TEXT_PLAIN,
  '.conf': TEXT_PLAIN,
  '.env': TEXT_PLAIN,
  '.sh': TEXT_PLAIN,
  '.bash': TEXT_PLAIN,
  '.zsh': TEXT_PLAIN,
  '.py': TEXT_PLAIN,
  '.js': TEXT_PLAIN,
  '.mjs': TEXT_PLAIN,
  '.cjs': TEXT_PLAIN,
  '.ts': TEXT_PLAIN,
  '.tsx': TEXT_PLAIN,
  '.jsx': TEXT_PLAIN,
  '.css': TEXT_PLAIN,
  '.scss': TEXT_PLAIN,
  '.html': TEXT_PLAIN,
  '.htm': TEXT_PLAIN,
  '.sql': TEXT_PLAIN,
  '.go': TEXT_PLAIN,
  '.rs': TEXT_PLAIN,
  '.java': TEXT_PLAIN,
  '.c': TEXT_PLAIN,
  '.h': TEXT_PLAIN,
  '.cpp': TEXT_PLAIN,
  '.swift': TEXT_PLAIN,
  '.rb': TEXT_PLAIN,
  '.php': TEXT_PLAIN,
};

const ASSET_MIME_TYPES = {
  ...IMAGE_MIME_TYPES,
  ...AUDIO_MIME_TYPES,
  ...VIDEO_MIME_TYPES,
  ...PDF_MIME_TYPES,
  ...TEXT_MIME_TYPES,
};
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));
const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_TYPES));
const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_MIME_TYPES));
const PDF_EXTENSIONS = new Set(Object.keys(PDF_MIME_TYPES));
const EDITABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown',
  '.yaml', '.yml',
  '.txt', '.json', '.toml', '.ini', '.conf', '.env',
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.htm', '.xml', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.swift', '.rb', '.php', '.dockerignore', '.gitignore',
]);

function isBinaryBuffer(buffer) {
  const sampleSize = Math.min(buffer.length, 2048);
  if (sampleSize === 0) {
    return false;
  }

  let suspicious = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    if (byte === 0) {
      return true;
    }

    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedControl) {
      suspicious += 1;
    }
  }

  return suspicious / sampleSize > 0.3;
}

function isEditableFile(relativePath) {
  const normalized = toPosixPath(relativePath);
  const fileName = path.posix.basename(normalized).toLowerCase();
  const extension = path.extname(fileName);

  if (!fileName) {
    return false;
  }

  if (IMAGE_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension) || PDF_EXTENSIONS.has(extension)) {
    return false;
  }

  if (fileName === 'dockerfile' || fileName === 'makefile') {
    return true;
  }

  return EDITABLE_EXTENSIONS.has(extension);
}

async function resolveFromRequest(mappings, viewPath) {
  const split = splitViewPath(viewPath || '');
  if (!split) {
    return { error: { status: 400, message: 'Invalid path. Use /view/<repo>/<path>.' } };
  }

  const { repo, relativePath } = split;
  const rootPath = mappings[repo];
  if (!rootPath) {
    return { error: { status: 404, message: `Unknown repository: ${repo}` } };
  }

  let resolved;
  try {
    resolved = await safeResolve(rootPath, relativePath);
  } catch (error) {
    if (error && error.code === 'EACCES') {
      return { error: { status: 403, message: 'Invalid path.' } };
    }

    if (error && error.code === 'ENOENT') {
      return { error: { status: 500, message: `Repository root path is unavailable: ${repo}` } };
    }

    throw error;
  }

  return {
    repo,
    relativePath,
    rootPath,
    resolved,
  };
}

async function statResolvedPath(resolved) {
  try {
    return await fs.stat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function sendPathError(res, error) {
  res.status(error.status).type('text/plain').send(error.message);
}

function sendPathJsonError(res, error) {
  res.status(error.status).json({ ok: false, error: error.message });
}

function sendAccessError(res, accessContext, asJson = false) {
  if (asJson) {
    res.status(accessContext.denialStatus).json({ ok: false, error: accessContext.denialMessage });
    return;
  }

  res.status(accessContext.denialStatus).type('text/plain').send(accessContext.denialMessage);
}

// Artifact HTML (/raw, /embed) executes author-supplied scripts. Serving it
// same-origin lets those scripts drive first-party mutations (save, annotations,
// forms) with the viewer's own credentials. The CSP sandbox forces an opaque
// origin; allow-same-origin must never be added (ADR-92 B1 + operator decision).
const ARTIFACT_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';

// The /embed document additionally gets click-gated top navigation so the link
// rewriter's target="_top" links actually work inside the /view frame (#232).
// This does NOT weaken the opaque-origin boundary: no allow-same-origin, and
// navigation requires a real user gesture. /raw and scriptable assets keep the
// stricter ARTIFACT_SANDBOX.
const EMBED_SANDBOX = `${ARTIFACT_SANDBOX} allow-top-navigation-by-user-activation`;

// Asset MIME types a browser will execute as a document when navigated to
// directly (SVG carries <script>; HTML/XHTML/XML can execute inline or via
// XSLT). Served same-origin these are the same write primitive as /embed was,
// so they get the identical opaque-origin sandbox.
const SCRIPTABLE_ASSET_TYPES = /^(?:image\/svg\+xml|text\/html|application\/xhtml\+xml|(?:text|application)\/xml)\b/i;

function isScriptableAssetType(mimeType) {
  return typeof mimeType === 'string' && SCRIPTABLE_ASSET_TYPES.test(mimeType);
}

function sendRawHtmlResponse(res, sourceBuffer) {
  res.set('Content-Security-Policy', ARTIFACT_SANDBOX);
  res.status(200).type(RAW_HTML_MIME_TYPE).send(sourceBuffer);
}

function parseBooleanQuery(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function managedNotFound(res) {
  res.status(404).json({ ok: false, error: 'Not found.' });
}

function publicManagedRepo(repo) {
  return {
    id: repo.id,
    label: repo.label,
    policy: repo.policy,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    viewUrl: buildHref(repo.id, ''),
  };
}

function managedErrorStatus(error) {
  if (error && error.code === 'ECONFLICT') return 409;
  if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return 404;
  if (error && error.code === 'EINVAL') return 400;
  return 500;
}

function buildAssetBaseHref(repo, relativePath, accessContext) {
  const normalized = toPosixPath(relativePath);
  const currentDir = path.posix.dirname(normalized) === '.' ? '' : path.posix.dirname(normalized);
  const repoPart = encodeURIComponent(repo);
  const dirPart = currentDir ? `${currentDir.split('/').map(encodeURIComponent).join('/')}/` : '';
  return appendAccessToken(`/asset/${repoPart}/${dirPart}`, accessContext);
}

function isExternalOrSpecialHref(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(value || '').trim());
}

function splitSrcset(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function normalizeLocalReference(relativePath, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || isExternalOrSpecialHref(value)) {
    return null;
  }

  const match = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) {
    return null;
  }

  const rawPath = match[1] || '';
  const query = match[2] || '';
  const hash = match[3] || '';
  const currentDir = path.posix.dirname(toPosixPath(relativePath)) === '.'
    ? ''
    : path.posix.dirname(toPosixPath(relativePath));
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch (_error) {
    return null;
  }
  if (!pathname || pathname === '/') {
    return null;
  }

  const referencePath = pathname.replace(/^\/+/, '');
  const resolvedPath = value.startsWith('/')
    ? referencePath
    : path.posix.join(currentDir, referencePath);
  const normalized = toPosixPath(path.posix.normalize(resolvedPath));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }

  return {
    original: value,
    path: normalized,
    query,
    hash,
    directoryHint: /\/(?:[?#].*)?$/.test(value),
  };
}

function buildReferenceDescription({ repo, normalized, tag, attr, kind, accessContext }) {
  const extension = effectiveViewExtension(normalized.path);
  const contentType = ASSET_MIME_TYPES[extension] || null;
  const viewUrl = appendAccessToken(buildHref(repo, normalized.path), accessContext);
  const assetUrl = appendAccessToken(buildAssetHref(repo, normalized.path), accessContext);
  const entry = {
    tag,
    attr,
    kind,
    href: normalized.original,
    resolvedPath: normalized.path,
    query: normalized.query,
    hash: normalized.hash,
    assetUrl,
    viewUrl,
    contentType,
    exists: false,
    bytes: null,
    isDirectory: false,
    supportedAsset: Boolean(contentType),
  };

  if (kind === 'document') {
    entry.rewrittenViewUrl = viewUrl + normalized.query + normalized.hash;
    entry.rewriteTarget = '_top';
  }

  return entry;
}

async function describeLocalReference({ repo, rootPath, sourceRelativePath, tag, attr, value, kind, accessContext }) {
  const normalized = normalizeLocalReference(sourceRelativePath, value);
  if (!normalized) {
    return null;
  }

  const entry = buildReferenceDescription({ repo, normalized, tag, attr, kind, accessContext });
  let stat;
  try {
    const absolutePath = await safeResolve(rootPath, normalized.path);
    stat = await fs.stat(absolutePath);
  } catch (_error) {
    entry.error = 'not_found';
    return entry;
  }

  const pathType = stat.isDirectory() ? 'directory' : 'file';
  if (!canAccessPath(accessContext, 'view', repo, normalized.path, pathType)) {
    entry.error = 'not_found';
    return entry;
  }

  entry.exists = true;
  entry.isDirectory = stat.isDirectory();
  entry.bytes = stat.isFile() ? stat.size : null;
  if (entry.isDirectory) {
    entry.contentType = 'text/html; charset=utf-8';
    entry.supportedAsset = false;
  }
  return entry;
}

async function buildHtmlRenderValidation({ repo, rootPath, relativePath, stat, source, rawHtmlEnabled, accessContext }) {
  const dom = new JSDOM(source);
  const { document } = dom.window;
  const assetRefs = [];
  const documentRefs = [];

  function pushAsset(selector, attr) {
    document.querySelectorAll(selector).forEach((node) => {
      const raw = node.getAttribute(attr);
      if (!raw) {
        return;
      }
      const values = attr === 'srcset' ? splitSrcset(raw) : [raw];
      values.forEach((value) => {
        assetRefs.push({ tag: node.tagName.toLowerCase(), attr, value, kind: 'asset' });
      });
    });
  }

  pushAsset('link[href]', 'href');
  pushAsset('script[src]', 'src');
  pushAsset('img[src]', 'src');
  pushAsset('img[srcset]', 'srcset');
  pushAsset('source[src]', 'src');
  pushAsset('source[srcset]', 'srcset');

  document.querySelectorAll('a[href]').forEach((node) => {
    const href = node.getAttribute('href');
    const normalized = normalizeLocalReference(relativePath, href);
    if (!normalized) {
      return;
    }
    if (HTML_EXTENSIONS.has(effectiveViewExtension(normalized.path)) || normalized.directoryHint) {
      documentRefs.push({ tag: 'a', attr: 'href', value: href, kind: 'document' });
    }
  });

  const localAssets = (await Promise.all(assetRefs.map((ref) => describeLocalReference({
    repo,
    rootPath,
    sourceRelativePath: relativePath,
    accessContext,
    ...ref,
  })))).filter(Boolean);
  const navigationLinks = (await Promise.all(documentRefs.map((ref) => describeLocalReference({
    repo,
    rootPath,
    sourceRelativePath: relativePath,
    accessContext,
    ...ref,
  })))).filter(Boolean);

  return {
    ok: true,
    kind: 'html-render-validation',
    repo,
    relativePath,
    renderMode: rawHtmlEnabled ? 'raw-html-iframe' : 'sanitized-html',
    source: {
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      contentType: RAW_HTML_MIME_TYPE,
    },
    urls: {
      view: appendAccessToken(buildHref(repo, relativePath), accessContext),
      raw: rawHtmlEnabled ? appendAccessToken(buildRawHref(repo, relativePath), accessContext) : null,
      asset: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
      assetBase: buildAssetBaseHref(repo, relativePath, accessContext),
    },
    localAssets,
    navigationLinks,
    summary: {
      localAssetCount: localAssets.length,
      missingLocalAssetCount: localAssets.filter((entry) => !entry.exists).length,
      unsupportedLocalAssetCount: localAssets.filter((entry) => !entry.supportedAsset).length,
      navigationLinkCount: navigationLinks.length,
      missingNavigationTargetCount: navigationLinks.filter((entry) => !entry.exists).length,
    },
  };
}

function sendGrantJsonError(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function sendApiKeyJsonError(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function inferBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function getRouteAvailability(app) {
  const routes = app._router && Array.isArray(app._router.stack)
    ? app._router.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: layer.route.methods || {},
      }))
    : [];
  const has = (method, routePath) => routes.some((route) => (
    route.path === routePath && route.methods[method] === true
  ));

  return {
    agentDiscovery: has('get', '/.well-known/agent.json'),
    whoami: has('get', '/api/whoami'),
    repos: has('get', '/api/repos'),
    view: has('get', '/view/*'),
    assetRead: has('get', '/asset/:repo/*'),
    edit: has('get', '/edit/*'),
    save: has('post', '/api/save/*'),
    preview: has('post', '/api/preview/*'),
    annotationRead: has('get', '/api/annotations/:repo/*'),
    annotationCreate: has('post', '/api/annotations/:repo/*'),
    annotationUpdate: has('patch', '/api/annotations/:repo/*'),
    rawHtml: has('get', '/raw/:repo/*'),
    embeddedHtml: has('get', '/embed/:repo/*'),
    managedRepoList: has('get', '/api/managed-repos'),
    managedFileRead: has('get', '/api/managed-repos/:repo/files/*'),
    managedFileWrite: has('put', '/api/managed-repos/:repo/files/*'),
    managedTree: has('get', '/api/managed-repos/:repo/tree'),
    managedChanges: has('get', '/api/managed-repos/:repo/changes'),
    search: has('get', '/api/search'),
    searchSuggest: has('get', '/api/search/suggest'),
    publishCreate: has('post', '/api/publish'),
    publishUpdate: has('post', '/api/publish/:slug'),
    publishRevoke: has('post', '/api/publish/:slug/revoke'),
  };
}

function createApp(options = {}) {
  const app = express();
  const logger = options.logger || console;
  const mappings = { ...(options.mappings || loadRootMappings()) };
  const editingEnabled = options.editingEnabled === undefined ? getEditingEnabled() : Boolean(options.editingEnabled);
  const annotationsEnabled = options.annotationsEnabled === undefined ? getAnnotationsEnabled() : Boolean(options.annotationsEnabled);
  const rawHtmlEnabled = options.rawHtmlEnabled === undefined ? getRawHtmlEnabled() : Boolean(options.rawHtmlEnabled);
  const customThemeCss = options.customThemeCss || '';
  const rawAccessConfig = options.accessConfig === undefined ? getAccessConfig() : options.accessConfig;
  const rawManagedReposConfig = options.managedReposConfig === undefined ? getManagedReposConfig() : options.managedReposConfig;
  const rawPublishConfig = options.publishConfig === undefined ? getPublishConfig() : options.publishConfig;
  const formsConfig = options.formsConfig === undefined ? getFormsConfig() : options.formsConfig;
  // Forms only appears when the deployment actually serves them.
  setNavLinks([
    { href: '/', label: 'Files' },
    ...(formsConfig && formsConfig.enabled === true ? [{ href: '/forms', label: 'Trackers' }] : []),
  ]);
  const accessConfig = parseAccessConfig(rawAccessConfig);
  const apiKeyStore = options.apiKeyStore === undefined
    ? ApiKeyStore.fromAccessConfig(rawAccessConfig.apiKeys)
    : options.apiKeyStore;
  const grantStore = options.grantStore === undefined
    ? GrantStore.fromAccessConfig(rawAccessConfig.grants)
    : options.grantStore;
  const managedRepoStore = options.managedRepoStore === undefined
    ? ManagedRepoStore.fromConfig(rawManagedReposConfig)
    : options.managedRepoStore;
  if (managedRepoStore && managedRepoStore.isEnabled()) {
    for (const repo of managedRepoStore.listRepos().repos) {
      if (!mappings[repo.id]) mappings[repo.id] = repo.rootPath;
    }
  }
  const getManagedRepo = (repoId) => managedRepoStore && managedRepoStore.isEnabled()
    ? managedRepoStore.getRepo(repoId)
    : null;
  const isManagedInternalPath = (repoId, relativePath) => {
    const repo = getManagedRepo(repoId);
    return Boolean(repo && managedRepoStore.isInternalPath(repo, relativePath));
  };
  const publishStore = options.publishStore === undefined
    ? PublishStore.fromConfig(rawPublishConfig)
    : options.publishStore;
  const resolveAccessContext = (req) => {
    if (req.accessContext) {
      return req.accessContext;
    }

    return resolveCredentialAccess(req, accessConfig, apiKeyStore, grantStore);
  };
  const linkResolutionContext = (accessContext) => ({
    repoMappings: mappings,
    canResolveLink: (repo, relativePath, isDirectory) => canAccessPath(
      accessContext,
      'view',
      repo,
      relativePath,
      isDirectory ? 'directory' : 'file'
    ),
  });

  const authenticateGrantAdmin = (req) => {
    if (!grantStore || !grantStore.isEnabled()) {
      return { ok: false, status: 404, error: 'Managed grants are not configured.' };
    }

    const secret = extractPresentedToken(req);
    if (!secret) {
      return { ok: false, status: 401, error: 'Grant admin authentication required.' };
    }

    const admin = grantStore.authenticateAdminToken(secret);
    if (!admin) {
      return { ok: false, status: 403, error: 'Invalid grant admin token.' };
    }

    return { ok: true, admin };
  };

  const authenticateApiKeyAdmin = (req) => {
    if (!apiKeyStore || !apiKeyStore.isEnabled()) {
      return { ok: false, status: 404, error: 'Agent API keys are not configured.' };
    }

    const secret = extractBearerToken(req);
    if (!secret) {
      return { ok: false, status: 401, error: 'Agent API key admin authentication required.' };
    }

    const admin = apiKeyStore.authenticateAdminToken(secret);
    if (!admin) {
      return { ok: false, status: 403, error: 'Invalid agent API key admin token.' };
    }

    return { ok: true, admin };
  };

  const authenticateManagedRepoAdmin = (req) => {
    if (!managedRepoStore || !managedRepoStore.isEnabled()) {
      return { ok: false, status: 404, error: 'Managed repos are not configured.' };
    }
    const secret = extractBearerToken(req);
    if (!secret) return { ok: false, status: 401, error: 'Managed repo admin authentication required.' };
    const admin = managedRepoStore.authenticateAdminToken(secret);
    return admin
      ? { ok: true, admin }
      : { ok: false, status: 403, error: 'Invalid managed repo admin token.' };
  };

  const recordApiKeyAuditEvent = (type, accessContext, target, metadata) => {
    if (!apiKeyStore || !apiKeyStore.isEnabled()) {
      return null;
    }
    return apiKeyStore.recordAuditEvent(type, accessContext, target, metadata);
  };

  const publishedRepo = publishStore ? publishStore.getRepoId() : 'published';
  if (publishStore && publishStore.isEnabled()
      && Object.prototype.hasOwnProperty.call(mappings, publishedRepo)) {
    throw new Error(`publish.repoId "${publishedRepo}" conflicts with a configured repository mapping.`);
  }
  const canPublishTarget = (accessContext) => canAccessRepo(accessContext, 'publish', publishedRepo);
  const resolvePublishedTarget = async (repo, relativePath, version) => {
    if (!publishStore || !publishStore.isEnabled() || repo !== publishedRepo) {
      return null;
    }
    const parts = toPosixPath(relativePath).split('/').filter(Boolean);
    if (parts.length === 0) {
      return { error: { status: 404, message: 'Published artifact not found.' } };
    }
    const slug = parts.shift();
    try {
      const published = await publishStore.resolvePath(slug, parts.join('/'), version);
      if (published.publication.revokedAt) {
        return { error: { status: 410, message: 'Published artifact has been revoked.' } };
      }
      return {
        repo,
        relativePath,
        rootPath: published.rootPath,
        resolved: published.resolved,
        published,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { error: { status: 404, message: 'Published artifact not found.' } };
      }
      if (error && error.code === 'EINVAL') {
        return { error: { status: 400, message: error.message } };
      }
      if (error && error.code === 'EACCES') {
        return { error: { status: 403, message: 'Invalid path.' } };
      }
      throw error;
    }
  };

  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy === undefined ? false : options.trustProxy);

  if (publishStore && publishStore.isEnabled()) {
    const limits = publishStore.getLimits();
    const encodedContentBudget = Math.ceil(limits.maxRevisionBytes * 4 / 3);
    const manifestBudget = limits.maxMetadataBytes * 2 + limits.maxFiles * 1024 + 64 * 1024;
    app.use('/api/publish', express.json({ limit: encodedContentBudget + manifestBudget }));
  }
  app.use((req, res, next) => {
    if (mutationUsesQueryToken(req)) {
      res.status(400).json({ ok: false, error: 'Mutation credentials must use the Authorization header.' });
      return;
    }
    next();
  });
  app.use((req, _res, next) => {
    req.accessContext = resolveAccessContext(req);
    next();
  });
  if (formsConfig && formsConfig.enabled === true) {
    if (!formsConfig.templatesPath) {
      throw new Error('forms.templatesPath is required when forms are enabled.');
    }
    const destinationRoots = configuredDestinationRoots(formsConfig);
    const formsRegistry = options.formsRegistry || new TemplateRegistry({
      templatesPath: formsConfig.templatesPath,
      destinationIds: Object.keys(destinationRoots),
      logger,
    });
    const formsStore = options.formsStore || new DestinationAdapter({ destinations: destinationRoots });
    const formsService = options.formsService || new SubmissionService({ registry: formsRegistry, store: formsStore });
    const formsAudit = typeof options.formsAudit === 'function'
      ? options.formsAudit
      : (event, req) => {
        const persisted = recordApiKeyAuditEvent(event.type, req.accessContext, {
          resourceKind: 'form',
          resourceId: event.templateId || null,
        }, {
          outcome: event.outcome,
          requestId: event.requestId,
          byteCount: event.byteCount,
          submissionId: event.submissionId,
          templateVersion: event.templateVersion,
          schemaDigest: event.schemaDigest,
        });
        if (!persisted) logger.info('Forms audit', event);
      };
    app.use(createFormsRouter({
      registry: formsRegistry,
      store: formsStore,
      service: formsService,
      destinationIds: Object.keys(destinationRoots),
      authorize: options.formsAuthorize,
      publicOrigin: options.formsPublicOrigin === undefined
        ? formsConfig.publicOrigins
        : options.formsPublicOrigin,
      timezone: options.formsTimezone === undefined ? formsConfig.timezone : options.formsTimezone,
      clock: options.formsClock,
      contexts: options.formsCsrfContexts,
      audit: formsAudit,
      logger,
      customThemeCss,
    }));
  }
  app.use(express.json({ limit: '2mb' }));
  app.use('/public', express.static(path.join(__dirname, 'public'), {
    etag: true,
    // `no-cache` means "revalidate before using", not "do not store". Paired with
    // the ETag above, an unchanged file costs a 304 and no body.
    //
    // This replaced `maxAge: '1h'`, under which the browser would not even ASK for
    // up to an hour, so the ETag never got a chance to work. A deployed stylesheet
    // fix stayed invisible until the cache expired, which repeatedly read as "the
    // fix did not work" when the server was already serving the corrected file.
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.get('/api/managed-repos', (req, res) => {
    if (!managedRepoStore || !managedRepoStore.isEnabled()) {
      managedNotFound(res);
      return;
    }
    const accessContext = resolveAccessContext(req);
    const repos = managedRepoStore.listRepos().repos
      .filter((repo) => canAccessPath(accessContext, 'view', repo.id, '', 'directory'))
      .map(publicManagedRepo);
    res.status(200).json({ ok: true, repos, count: repos.length });
  });

  app.post('/api/managed-repos', (req, res) => {
    const auth = authenticateManagedRepoAdmin(req);
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, error: auth.error });
      return;
    }
    try {
      if (req.body && mappings[String(req.body.repoId || '').trim().toLowerCase()]) {
        res.status(409).json({ ok: false, error: 'Repository id already exists.' });
        return;
      }
      const result = managedRepoStore.createRepo(req.body || {}, auth.admin);
      mappings[result.repo.id] = result.repo.rootPath;
      res.status(201).json({ ok: true, repo: publicManagedRepo(result.repo) });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.get('/api/managed-repos/:repo/tree', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (
      !repo
      || isManagedInternalPath(repo.id, relativePath)
      || !canAccessPath(accessContext, 'view', repo.id, relativePath, 'directory')
    ) {
      managedNotFound(res);
      return;
    }
    try {
      const tree = await managedRepoStore.listTree(repo, relativePath, {
        maxDepth: req.query.maxDepth,
        maxEntries: req.query.maxEntries,
        includeEntry: (entry) => canAccessPath(
          accessContext,
          'view',
          repo.id,
          entry.path,
          entry.type === 'directory' ? 'directory' : 'file'
        ),
        shouldDescend: (entry) => canAccessPath(accessContext, 'view', repo.id, entry.path, 'directory'),
      });
      const entries = tree.entries;
      res.status(200).json({
        ok: true,
        repo: repo.id,
        path: toPosixPath(relativePath),
        entries,
        count: entries.length,
        truncated: tree.truncated,
        limits: { maxDepth: tree.maxDepth, maxEntries: tree.maxEntries },
      });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.get('/api/managed-repos/:repo/changes', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    if (!repo || !canAccessPath(accessContext, 'view', repo.id, '', 'directory')) {
      managedNotFound(res);
      return;
    }
    const since = req.query.since == null || req.query.since === '' ? null : Number(req.query.since);
    if (since !== null && !Number.isFinite(since)) {
      res.status(400).json({ ok: false, error: 'since must be a unix timestamp.' });
      return;
    }
    try {
      const tree = await managedRepoStore.listTree(repo, '', {
        maxDepth: 10,
        maxEntries: req.query.maxEntries,
        includeEntry: (entry) => entry.type === 'file' && canAccessPath(accessContext, 'view', repo.id, entry.path, 'file'),
        shouldDescend: (entry) => canAccessPath(accessContext, 'view', repo.id, entry.path, 'directory'),
      });
      const entries = tree.entries
        .filter((entry) => since === null || entry.mtimeMs >= since)
        .map((entry) => ({ path: entry.path, mtimeMs: entry.mtimeMs, size: entry.size, change: 'modified' }));
      res.status(200).json({ ok: true, repo: repo.id, entries, count: entries.length, truncated: tree.truncated });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.get('/api/managed-repos/:repo/files/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    const relativePath = req.params[0] || '';
    if (!repo || !canAccessPath(accessContext, 'view', repo.id, relativePath, 'file')) {
      managedNotFound(res);
      return;
    }
    try {
      const result = await managedRepoStore.readFile(repo, relativePath);
      res.status(200).json({ ok: true, repo: repo.id, ...result, viewUrl: buildHref(repo.id, result.path) });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.put('/api/managed-repos/:repo/files/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    const relativePath = req.params[0] || '';
    if (!repo || !canAccessPath(accessContext, 'write', repo.id, relativePath, 'file')) {
      managedNotFound(res);
      return;
    }
    if (!req.body || typeof req.body.content !== 'string') {
      res.status(400).json({ ok: false, error: 'content is required.' });
      return;
    }
    try {
      const result = await managedRepoStore.writeFile(repo, relativePath, req.body.content, req.body.expectedMtimeMs);
      recordApiKeyAuditEvent('content.write', accessContext, { repo: repo.id, relativePath: result.path }, {
        outcome: 'accepted',
        byteCount: Buffer.byteLength(req.body.content, 'utf8'),
      });
      res.status(result.created ? 201 : 200).json({ ok: true, repo: repo.id, ...result });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({
        ok: false,
        error: status === 404 ? 'Not found.' : error.message,
        ...(status === 409 ? { current: error.current } : {}),
      });
    }
  });

  app.post('/api/publish', async (req, res) => {
    if (!publishStore || !publishStore.isEnabled()) {
      sendPathJsonError(res, { status: 404, message: 'Publishing is not configured.' });
      return;
    }
    const accessContext = resolveAccessContext(req);
    if (!canPublishTarget(accessContext)) {
      sendAccessError(res, accessContext, true);
      return;
    }
    try {
      const result = await publishStore.createPublication(req.body || {});
      const revision = result.publication.revisions.at(-1);
      recordApiKeyAuditEvent('publish.create', accessContext, {
        repo: publishedRepo,
        relativePath: result.publication.slug,
      }, { byteCount: revision.sizeBytes });
      res.status(201).json({
        ok: true,
        slug: result.publication.slug,
        revision: result.publication.currentRevision,
        created: true,
        publication: result.publication,
        viewUrl: result.publication.viewUrl,
      });
    } catch (error) {
      const status = error.code === 'ECONFLICT' ? 409 : 400;
      res.status(status).json({
        ok: false,
        error: error.message,
        current: error.current ? publishStore.serializePublication(error.current) : null,
      });
    }
  });

  app.delete('/api/managed-repos/:repo/files/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    const relativePath = req.params[0] || '';
    if (!repo || !canAccessPath(accessContext, 'write', repo.id, relativePath, 'file')) {
      managedNotFound(res);
      return;
    }
    try {
      const result = await managedRepoStore.deleteFile(repo, relativePath, { hard: parseBooleanQuery(req.query.hard) });
      recordApiKeyAuditEvent('content.delete', accessContext, { repo: repo.id, relativePath: result.path }, { mode: result.deleted });
      res.status(200).json({ ok: true, repo: repo.id, ...result });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.post('/api/managed-repos/:repo/trash/:trashId/restore', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    if (!repo || !canAccessPath(accessContext, 'write', repo.id, '', 'directory')) {
      managedNotFound(res);
      return;
    }
    try {
      const { metadata } = await managedRepoStore.getTrashMetadata(repo, req.params.trashId);
      if (!canAccessPath(accessContext, 'write', repo.id, metadata.originalPath, 'file')) {
        managedNotFound(res);
        return;
      }
      const result = await managedRepoStore.restoreTrash(repo, req.params.trashId);
      res.status(200).json({ ok: true, repo: repo.id, ...result });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.delete('/api/managed-repos/:repo/trash/:trashId', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = managedRepoStore && managedRepoStore.getRepo(req.params.repo);
    if (!repo || !canAccessPath(accessContext, 'write', repo.id, '', 'directory')) {
      managedNotFound(res);
      return;
    }
    try {
      const { metadata } = await managedRepoStore.getTrashMetadata(repo, req.params.trashId);
      if (!canAccessPath(accessContext, 'write', repo.id, metadata.originalPath, 'file')) {
        managedNotFound(res);
        return;
      }
      const result = await managedRepoStore.hardDeleteTrash(repo, req.params.trashId);
      res.status(200).json({ ok: true, repo: repo.id, ...result });
    } catch (error) {
      const status = managedErrorStatus(error);
      res.status(status).json({ ok: false, error: status === 404 ? 'Not found.' : error.message });
    }
  });

  app.get('/api/search', async (req, res) => {
    if (!managedRepoStore || !managedRepoStore.isEnabled()) {
      managedNotFound(res);
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ ok: false, error: 'q is required.' });
      return;
    }
    if (query.length > 256) {
      res.status(400).json({ ok: false, error: 'q must be at most 256 characters.' });
      return;
    }
    const accessContext = resolveAccessContext(req);
    try {
      const result = await searchManagedRepos({
        store: managedRepoStore,
        repos: managedRepoStore.listRepos().repos,
        query,
        scope: req.query.scope,
        limit: req.query.limit,
        maxEntries: req.query.maxEntries,
        canView: (repo, relativePath, type) => canAccessPath(accessContext, 'view', repo, relativePath, type),
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: 'Search failed.' });
    }
  });

  app.get('/api/search/suggest', async (req, res) => {
    if (!managedRepoStore || !managedRepoStore.isEnabled()) {
      managedNotFound(res);
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ ok: false, error: 'q is required.' });
      return;
    }
    if (query.length > 256) {
      res.status(400).json({ ok: false, error: 'q must be at most 256 characters.' });
      return;
    }
    const accessContext = resolveAccessContext(req);
    try {
      const result = await suggestManagedRepos({
        store: managedRepoStore,
        repos: managedRepoStore.listRepos().repos,
        query,
        scope: req.query.scope,
        limit: req.query.limit,
        maxEntries: req.query.maxEntries,
        canView: (repo, relativePath, type) => canAccessPath(accessContext, 'view', repo, relativePath, type),
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: 'Suggestion lookup failed.' });
    }
  });

  app.post('/api/publish/:slug', async (req, res) => {
    if (!publishStore || !publishStore.isEnabled()) {
      sendPathJsonError(res, { status: 404, message: 'Publishing is not configured.' });
      return;
    }
    const accessContext = resolveAccessContext(req);
    if (!canPublishTarget(accessContext)) {
      sendAccessError(res, accessContext, true);
      return;
    }
    try {
      const result = await publishStore.updatePublication(req.params.slug, req.body || {});
      const revision = result.publication.revisions.at(-1);
      recordApiKeyAuditEvent('publish.update', accessContext, {
        repo: publishedRepo,
        relativePath: result.publication.slug,
      }, { byteCount: revision.sizeBytes });
      res.status(200).json({
        ok: true,
        slug: result.publication.slug,
        revision: result.publication.currentRevision,
        created: false,
        publication: result.publication,
        viewUrl: result.publication.viewUrl,
      });
    } catch (error) {
      if (error.code === 'ECONFLICT') {
        res.status(409).json({
          ok: false,
          error: error.message,
          currentRevision: error.current ? error.current.currentRevision : null,
          current: error.current ? publishStore.serializePublication(error.current) : null,
        });
        return;
      }
      const status = error.code === 'ENOENT' ? 404 : error.code === 'EREVOKED' ? 410 : 400;
      sendPathJsonError(res, { status, message: error.message });
    }
  });

  app.post('/api/publish/:slug/revoke', async (req, res) => {
    if (!publishStore || !publishStore.isEnabled()) {
      sendPathJsonError(res, { status: 404, message: 'Publishing is not configured.' });
      return;
    }
    const accessContext = resolveAccessContext(req);
    if (!canPublishTarget(accessContext)) {
      sendAccessError(res, accessContext, true);
      return;
    }
    try {
      const result = await publishStore.revokePublication(req.params.slug, req.body || {});
      recordApiKeyAuditEvent('publish.revoke', accessContext, {
        repo: publishedRepo,
        relativePath: result.publication.slug,
      });
      res.status(200).json({
        ok: true,
        slug: result.publication.slug,
        revokedAt: result.publication.revokedAt,
      });
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error.code === 'EREVOKED' ? 410 : 400;
      sendPathJsonError(res, { status, message: error.message });
    }
  });

  app.get('/api/agent-keys', (req, res) => {
    const auth = authenticateApiKeyAdmin(req);
    if (!auth.ok) {
      sendApiKeyJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = apiKeyStore.listKeys({
        state: typeof req.query.state === 'string' ? req.query.state.trim() : undefined,
        agentId: typeof req.query.agentId === 'string' ? req.query.agentId.trim() : undefined,
        includeAudit: parseBooleanQuery(req.query.includeAudit),
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      sendApiKeyJsonError(res, 400, error.message);
    }
  });

  app.post('/api/agent-keys', (req, res) => {
    const auth = authenticateApiKeyAdmin(req);
    if (!auth.ok) {
      sendApiKeyJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = apiKeyStore.createKey(req.body || {}, auth.admin);
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      sendApiKeyJsonError(res, 400, error.message);
    }
  });

  app.post('/api/agent-keys/:keyId/rotate', (req, res) => {
    const auth = authenticateApiKeyAdmin(req);
    if (!auth.ok) {
      sendApiKeyJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = apiKeyStore.rotateKey(req.params.keyId, req.body || {}, auth.admin);
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const status = error.code === 'ENOTFOUND' ? 404 : 400;
      sendApiKeyJsonError(res, status, error.code === 'ENOTFOUND' ? 'Agent API key not found.' : error.message);
    }
  });

  app.post('/api/agent-keys/:keyId/revoke', (req, res) => {
    const auth = authenticateApiKeyAdmin(req);
    if (!auth.ok) {
      sendApiKeyJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = apiKeyStore.revokeKey(req.params.keyId, req.body || {}, auth.admin);
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      const status = error.code === 'ENOTFOUND' ? 404 : 400;
      sendApiKeyJsonError(res, status, error.code === 'ENOTFOUND' ? 'Agent API key not found.' : error.message);
    }
  });

  app.get('/api/grants', (req, res) => {
    const auth = authenticateGrantAdmin(req);
    if (!auth.ok) {
      sendGrantJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = grantStore.listGrants({
        sourceCompanyId: typeof req.query.sourceCompanyId === 'string' ? req.query.sourceCompanyId.trim() : undefined,
        targetCompanyId: typeof req.query.targetCompanyId === 'string' ? req.query.targetCompanyId.trim() : undefined,
        repoId: typeof req.query.repoId === 'string' ? req.query.repoId.trim() : undefined,
        state: typeof req.query.state === 'string' ? req.query.state.trim() : undefined,
        includeAudit: parseBooleanQuery(req.query.includeAudit),
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      sendGrantJsonError(res, 400, error.message);
    }
  });

  app.post('/api/grants', (req, res) => {
    const auth = authenticateGrantAdmin(req);
    if (!auth.ok) {
      sendGrantJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = grantStore.createGrant(req.body || {});
      res.status(201).json({
        ok: true,
        ...result,
        issueComment: buildIssueComment('created', result.grant),
      });
    } catch (error) {
      sendGrantJsonError(res, 400, error.message);
    }
  });

  app.post('/api/grants/:grantId/renew', (req, res) => {
    const auth = authenticateGrantAdmin(req);
    if (!auth.ok) {
      sendGrantJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = grantStore.renewGrant(req.params.grantId, req.body || {});
      res.status(200).json({
        ok: true,
        ...result,
        issueComment: buildIssueComment('renewed', result.grant),
      });
    } catch (error) {
      const status = error.message === 'Grant not found.' ? 404 : 400;
      sendGrantJsonError(res, status, error.message);
    }
  });

  app.post('/api/grants/:grantId/revoke', (req, res) => {
    const auth = authenticateGrantAdmin(req);
    if (!auth.ok) {
      sendGrantJsonError(res, auth.status, auth.error);
      return;
    }

    try {
      const result = grantStore.revokeGrant(req.params.grantId, req.body || {});
      res.status(200).json({
        ok: true,
        ...result,
        issueComment: buildIssueComment('revoked', result.grant),
      });
    } catch (error) {
      const status = error.message === 'Grant not found.' ? 404 : 400;
      sendGrantJsonError(res, status, error.message);
    }
  });

  app.get('/', (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (accessContext.mode === 'denied') {
      sendAccessError(res, accessContext);
      return;
    }

    const entries = Object.entries(mappings)
      .filter(([repo]) => canAccessPath(accessContext, 'view', repo, '', 'directory'))
      .map(([repo, rootPath]) => ({ repo, rootPath }));
    const html = renderDirectoryPage({
      title: 'Available Repositories',
      repo: null,
      currentPath: '',
      parentHref: null,
      entries: entries.map((entry) => ({
        name: entry.repo,
        href: appendAccessToken(buildHref(entry.repo, ''), accessContext),
        isDirectory: true,
        size: '-',
        mtime: '-',
      })),
      notice: entries.length > 0 ? 'Choose a repository to browse files.' : 'No repositories are authorized for this token.',
      customThemeCss,
      queryToken: accessContext.queryToken,
    });

    res.status(200).type('html').send(html);
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', editingEnabled, annotationsEnabled, rawHtmlEnabled });
  });

  const buildDiscoveryOptions = (req) => ({
    accessContext: resolveAccessContext(req),
    mappings,
    version: LOOKIE_LINK_VERSION,
    baseUrl: inferBaseUrl(req),
    editingEnabled,
    annotationsEnabled,
    rawHtmlEnabled,
    managedRepoStore,
    publishStore,
    publishedRepo,
    routeAvailability: getRouteAvailability(app),
  });

  app.get('/.well-known/agent.json', (req, res) => {
    const optionsForCaller = buildDiscoveryOptions(req);
    if (optionsForCaller.accessContext.mode === 'denied') {
      sendAccessError(res, optionsForCaller.accessContext, true);
      return;
    }
    res.status(200).json(buildAgentDiscoveryDocument(optionsForCaller));
  });

  app.get('/api/whoami', (req, res) => {
    const optionsForCaller = buildDiscoveryOptions(req);
    if (optionsForCaller.accessContext.mode === 'denied') {
      sendAccessError(res, optionsForCaller.accessContext, true);
      return;
    }
    res.status(200).json(buildWhoAmIDocument(optionsForCaller));
  });

  app.get('/api/repos', (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (accessContext.mode === 'denied') {
      sendAccessError(res, accessContext, true);
      return;
    }
    const repos = Object.keys(mappings)
      .filter((repo) => canAccessPath(accessContext, 'view', repo, '', 'directory'))
      .map((repo) => ({
        repo,
        viewUrl: `/view/${encodeURIComponent(repo)}/`,
        assetUrl: `/asset/${encodeURIComponent(repo)}/`,
      }));
    res.status(200).json({ repos, count: repos.length });
  });

  app.get('/view/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const requestedVersion = req.query && Object.prototype.hasOwnProperty.call(req.query, 'version')
      ? req.query.version
      : null;
    const requestedPath = splitViewPath(req.params[0] || '');
    if (requestedPath && getManagedRepo(requestedPath.repo)
      && !canAccessPath(accessContext, 'view', requestedPath.repo, requestedPath.relativePath, 'file')
      && !canAccessPath(accessContext, 'view', requestedPath.repo, requestedPath.relativePath, 'directory')) {
      res.status(404).type('text/plain').send('File or directory not found.');
      return;
    }
    let resolvedInput;
    try {
      resolvedInput = requestedPath
        ? await resolvePublishedTarget(requestedPath.repo, requestedPath.relativePath, requestedVersion)
        : null;
      if (!resolvedInput) {
        resolvedInput = await resolveFromRequest(mappings, req.params[0] || '');
      }
    } catch (error) {
      console.error('Failed to resolve path', { error });
      res.status(500).type('text/plain').send('Failed to resolve path.');
      return;
    }

    if (resolvedInput.error) {
      sendPathError(res, resolvedInput.error);
      return;
    }

    const { repo, relativePath, rootPath, resolved } = resolvedInput;
    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).type('text/plain').send('File or directory not found.');
      return;
    }

    let stat;
    try {
      stat = await statResolvedPath(resolved);
    } catch (error) {
      console.error('Failed to stat path', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read path metadata.');
      return;
    }

    if (!stat) {
      res.status(404).type('text/plain').send('File or directory not found.');
      return;
    }

    if (stat.isDirectory()) {
      if (!canAccessPath(accessContext, 'view', repo, relativePath, 'directory')) {
        res.status(403).type('text/plain').send('Access denied.');
        return;
      }

      try {
        const dirents = await fs.readdir(resolved, { withFileTypes: true });
        const rows = (await Promise.all(dirents.map(async (dirent) => {
          const childRel = toPosixPath(path.posix.join(relativePath, dirent.name));
          const childAbs = path.join(resolved, dirent.name);
          const isVisible = dirent.isDirectory()
            ? canAccessPath(accessContext, 'view', repo, childRel, 'directory')
            : canAccessPath(accessContext, 'view', repo, childRel, 'file');

          if (!isVisible) {
            return null;
          }

          let childStat = null;

          try {
            childStat = await fs.stat(childAbs);
          } catch (_error) {
            // Keep listing resilient; inaccessible entries still render.
          }

          return {
            name: dirent.name,
            href: appendAccessToken(buildHref(repo, childRel), accessContext),
            isDirectory: dirent.isDirectory(),
            size: childStat && !dirent.isDirectory() ? formatFileSize(childStat.size) : '-',
            mtime: childStat ? formatMTime(childStat.mtime) : '-',
          };
        }))).filter(Boolean);

        rows.sort(compareEntries);

        const parentRel = parentPath(relativePath);
        const html = renderDirectoryPage({
          title: `${repo}/${relativePath || ''}`,
          repo,
          currentPath: relativePath,
          parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
          entries: rows,
          notice: rows.length === 0 ? 'Directory is empty or no entries are authorized.' : null,
          customThemeCss,
          queryToken: accessContext.queryToken,
        });

        res.status(200).type('html').send(html);
        return;
      } catch (error) {
        console.error('Failed to read directory', { resolved, error });
        res.status(500).type('text/plain').send('Failed to list directory.');
        return;
      }
    }

    if (!stat.isFile()) {
      res.status(415).type('text/plain').send('Unsupported path type.');
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(403).type('text/plain').send('Access denied.');
      return;
    }

    const extension = effectiveViewExtension(relativePath);
    if (parseBooleanQuery(req.query && req.query.validate) && HTML_EXTENSIONS.has(extension)) {
      let sourceBuffer;
      try {
        sourceBuffer = await fs.readFile(resolved);
      } catch (error) {
        console.error('Failed to read HTML file for validation', { resolved, error });
        res.status(500).json({ ok: false, error: 'Failed to read file.' });
        return;
      }

      if (isBinaryBuffer(sourceBuffer)) {
        res.status(415).json({ ok: false, error: 'Binary files are not supported.' });
        return;
      }

      try {
        const validation = await buildHtmlRenderValidation({
          repo,
          rootPath,
          relativePath,
          stat,
          source: sourceBuffer.toString('utf8'),
          rawHtmlEnabled,
          accessContext,
        });
        res.status(200).json(validation);
        return;
      } catch (error) {
        console.error('Failed to validate HTML render', { resolved, error });
        res.status(500).json({ ok: false, error: 'Failed to validate HTML render.' });
        return;
      }
    }

    if (IMAGE_EXTENSIONS.has(extension)) {
      const parentRel = parentPath(relativePath);
      const html = renderImagePage({
        repo,
        relativePath,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        imageHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    if (AUDIO_EXTENSIONS.has(extension)) {
      const parentRel = parentPath(relativePath);
      const html = renderAudioPage({
        repo,
        relativePath,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        audioHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mimeType: AUDIO_MIME_TYPES[extension],
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    if (VIDEO_EXTENSIONS.has(extension)) {
      const parentRel = parentPath(relativePath);
      const html = renderVideoPage({
        repo,
        relativePath,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        videoHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mimeType: VIDEO_MIME_TYPES[extension],
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    if (PDF_EXTENSIONS.has(extension)) {
      const parentRel = parentPath(relativePath);
      const html = renderPdfPage({
        repo,
        relativePath,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        pdfHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    if (JSON_VIEWER_EXTENSIONS.has(extension)) {
      let jsonSource;
      try {
        jsonSource = await fs.readFile(resolved, 'utf8');
      } catch (error) {
        console.error('Failed to read JSON file', { resolved, error });
        res.status(500).type('text/plain').send('Failed to read file.');
        return;
      }

      const parentRel = parentPath(relativePath);
      const html = renderJsonPage({
        repo,
        relativePath,
        source: jsonSource,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        rawHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        editHref: editingEnabled && canAccessPath(accessContext, 'edit', repo, relativePath, 'file')
          ? appendAccessToken(buildEditHref(repo, relativePath), accessContext)
          : null,
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    if (CSV_EXTENSIONS.has(extension)) {
      let csvSource;
      try {
        csvSource = await fs.readFile(resolved, 'utf8');
      } catch (error) {
        console.error('Failed to read CSV file', { resolved, error });
        res.status(500).type('text/plain').send('Failed to read file.');
        return;
      }

      const parentRel = parentPath(relativePath);
      const html = renderCsvPage({
        repo,
        relativePath,
        source: csvSource,
        parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
        rawHref: appendAccessToken(buildAssetHref(repo, relativePath), accessContext),
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        editHref: editingEnabled && canAccessPath(accessContext, 'edit', repo, relativePath, 'file')
          ? appendAccessToken(buildEditHref(repo, relativePath), accessContext)
          : null,
        customThemeCss,
        queryToken: accessContext.queryToken,
      });

      res.status(200).type('html').send(html);
      return;
    }

    let sourceBuffer;
    try {
      sourceBuffer = await fs.readFile(resolved);
    } catch (error) {
      if (error && error.code === 'EISDIR') {
        res.status(400).type('text/plain').send('Path points to a directory.');
        return;
      }

      console.error('Failed to read file', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file.');
      return;
    }

    if (isBinaryBuffer(sourceBuffer)) {
      res.status(415).type('text/plain').send('Binary files are not supported.');
      return;
    }

    const source = sourceBuffer.toString('utf8');
    const parentRel = parentPath(relativePath);
    const isHtmlFile = HTML_EXTENSIONS.has(extension);
    const html = renderDocumentPage({
      repo,
      repoRoot: rootPath,
      ...linkResolutionContext(accessContext),
      relativePath,
      source,
      parentHref: appendAccessToken(parentRel === null ? '/view' : buildHref(repo, parentRel), accessContext),
      mtime: formatMTime(stat.mtime),
      size: formatFileSize(stat.size),
      editHref: editingEnabled && canAccessPath(accessContext, 'edit', repo, relativePath, 'file')
        ? appendAccessToken(buildEditHref(repo, relativePath), accessContext)
        : null,
      rawHtmlHref: rawHtmlEnabled && isHtmlFile
        ? appendAccessToken(buildRawHref(repo, relativePath), accessContext)
        : null,
      embedHtmlHref: rawHtmlEnabled && isHtmlFile
        ? appendAccessToken(buildEmbedHref(repo, relativePath), accessContext)
        : null,
      customThemeCss,
      queryToken: accessContext.queryToken,
      annotationsEnabled: annotationsEnabled && canAccessPath(accessContext, 'view', repo, relativePath, 'file'),
    });

    res.status(200).type('html').send(html);
  });

  app.get('/edit/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (!editingEnabled) {
      res.status(404).type('text/plain').send('Editing mode is disabled.');
      return;
    }

    const requested = splitViewPath(req.params[0] || '');
    if (requested && getManagedRepo(requested.repo)
      && !canAccessPath(accessContext, 'write', requested.repo, requested.relativePath, 'file')) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    let resolvedInput;
    try {
      resolvedInput = await resolveFromRequest(mappings, req.params[0] || '');
    } catch (error) {
      console.error('Failed to resolve edit path', { error });
      res.status(500).type('text/plain').send('Failed to resolve path.');
      return;
    }

    if (resolvedInput.error) {
      sendPathError(res, resolvedInput.error);
      return;
    }

    const { repo, relativePath, rootPath, resolved } = resolvedInput;
    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }
    if (!relativePath) {
      res.status(400).type('text/plain').send('Edit requires a file path.');
      return;
    }

    if (!canAccessPath(accessContext, 'edit', repo, relativePath, 'file')) {
      res.status(403).type('text/plain').send('Access denied.');
      return;
    }

    let stat;
    try {
      stat = await statResolvedPath(resolved);
    } catch (error) {
      console.error('Failed to stat edit path', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read path metadata.');
      return;
    }

    if (!stat) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    if (stat.isDirectory()) {
      res.status(400).type('text/plain').send('Directories are not editable.');
      return;
    }

    if (!stat.isFile()) {
      res.status(415).type('text/plain').send('Unsupported path type.');
      return;
    }

    let sourceBuffer;
    try {
      sourceBuffer = await fs.readFile(resolved);
    } catch (error) {
      console.error('Failed to read edit file', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file.');
      return;
    }

    if (isBinaryBuffer(sourceBuffer)) {
      res.status(415).type('text/plain').send('Binary files are not editable.');
      return;
    }

    const html = renderEditPage({
      repo,
      relativePath,
      repoRoot: rootPath,
      ...linkResolutionContext(accessContext),
      source: sourceBuffer.toString('utf8'),
      mtimeMs: Math.trunc(stat.mtimeMs),
      mtime: formatMTime(stat.mtime),
      size: formatFileSize(stat.size),
      viewHref: appendAccessToken(buildHref(repo, relativePath), accessContext),
      saveHref: buildSaveHref(repo, relativePath),
      previewHref: buildPreviewHref(repo, relativePath),
      customThemeCss,
      queryToken: accessContext.queryToken,
    });

    res.status(200).type('html').send(html);
  });

  app.post('/api/save/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (!editingEnabled) {
      res.status(404).json({ ok: false, error: 'Editing mode is disabled.' });
      return;
    }

    const requested = splitViewPath(req.params[0] || '');
    if (requested && getManagedRepo(requested.repo)
      && !canAccessPath(accessContext, 'write', requested.repo, requested.relativePath, 'file')) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    let resolvedInput;
    try {
      resolvedInput = await resolveFromRequest(mappings, req.params[0] || '');
    } catch (error) {
      console.error('Failed to resolve save path', { error });
      res.status(500).json({ ok: false, error: 'Failed to resolve path.' });
      return;
    }

    if (resolvedInput.error) {
      sendPathJsonError(res, resolvedInput.error);
      return;
    }

    const { repo, relativePath, resolved } = resolvedInput;
    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }
    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Save requires a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'edit', repo, relativePath, 'file')) {
      res.status(403).json({ ok: false, error: 'Access denied.' });
      return;
    }

    const content = req.body && req.body.content;
    if (typeof content !== 'string') {
      res.status(400).json({ ok: false, error: 'Invalid payload. Expected JSON body with string content.' });
      return;
    }

    let stat;
    try {
      stat = await statResolvedPath(resolved);
    } catch (error) {
      console.error('Failed to stat save path', { resolved, error });
      res.status(500).json({ ok: false, error: 'Failed to read file metadata.' });
      return;
    }

    if (!stat) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    if (stat.isDirectory()) {
      res.status(400).json({ ok: false, error: 'Directories are not editable.' });
      return;
    }

    if (!stat.isFile()) {
      res.status(415).json({ ok: false, error: 'Unsupported path type.' });
      return;
    }

    let currentBuffer;
    try {
      currentBuffer = await fs.readFile(resolved);
    } catch (error) {
      console.error('Failed to read existing file for save', { resolved, error });
      res.status(500).json({ ok: false, error: 'Failed to read existing file.' });
      return;
    }

    if (isBinaryBuffer(currentBuffer)) {
      res.status(415).json({ ok: false, error: 'Binary files are not editable.' });
      return;
    }

    const expectedRaw = req.body && req.body.expectedMtimeMs;
    if (expectedRaw !== undefined) {
      const expected = Math.trunc(Number(expectedRaw));
      const current = Math.trunc(stat.mtimeMs);

      if (!Number.isFinite(expected)) {
        res.status(400).json({ ok: false, error: 'Invalid expectedMtimeMs value.' });
        return;
      }

      if (expected !== current) {
        res.status(409).json({
          ok: false,
          error: 'File changed on disk since you opened it. Refresh before saving.',
          currentMtimeMs: current,
        });
        return;
      }
    }

    const tempPath = path.join(
      path.dirname(resolved),
      `.lookie-link-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, resolved);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch (_cleanupError) {
        // best effort cleanup
      }

      console.error('Failed to save file', { resolved, error });
      res.status(500).json({ ok: false, error: 'Failed to save file.' });
      return;
    }

    let updatedStat;
    try {
      updatedStat = await fs.stat(resolved);
    } catch (error) {
      console.error('Failed to stat updated file', { resolved, error });
      res.status(500).json({ ok: false, error: 'Saved file but failed to fetch metadata.' });
      return;
    }

    recordApiKeyAuditEvent('content.write', accessContext, { repo, relativePath }, {
      outcome: 'accepted',
      byteCount: Buffer.byteLength(content, 'utf8'),
    });

    res.status(200).json({
      ok: true,
      repo,
      relativePath,
      mtimeMs: Math.trunc(updatedStat.mtimeMs),
      size: updatedStat.size,
    });
  });

  app.post('/api/preview/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (!editingEnabled) {
      res.status(404).json({ ok: false, error: 'Editing mode is disabled.' });
      return;
    }

    const requested = splitViewPath(req.params[0] || '');
    if (requested && getManagedRepo(requested.repo)
      && !canAccessPath(accessContext, 'view', requested.repo, requested.relativePath, 'file')) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    let resolvedInput;
    try {
      resolvedInput = await resolveFromRequest(mappings, req.params[0] || '');
    } catch (error) {
      console.error('Failed to resolve preview path', { error });
      res.status(500).json({ ok: false, error: 'Failed to resolve path.' });
      return;
    }

    if (resolvedInput.error) {
      sendPathJsonError(res, resolvedInput.error);
      return;
    }

    const { repo, relativePath, rootPath, resolved } = resolvedInput;
    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }
    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Preview requires a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(403).json({ ok: false, error: 'Access denied.' });
      return;
    }

    const content = req.body && req.body.content;
    if (typeof content !== 'string') {
      res.status(400).json({ ok: false, error: 'Invalid payload. Expected JSON body with string content.' });
      return;
    }

    let stat;
    try {
      stat = await statResolvedPath(resolved);
    } catch (error) {
      console.error('Failed to stat preview path', { resolved, error });
      res.status(500).json({ ok: false, error: 'Failed to read path metadata.' });
      return;
    }

    if (!stat) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    if (stat.isDirectory()) {
      res.status(400).json({ ok: false, error: 'Directories are not editable.' });
      return;
    }

    if (!stat.isFile()) {
      res.status(415).json({ ok: false, error: 'Unsupported path type.' });
      return;
    }

    const html = renderPreviewHtml({
      repo,
      repoRoot: rootPath,
      ...linkResolutionContext(accessContext),
      relativePath,
      source: content,
      queryToken: accessContext.queryToken,
    });

    res.status(200).json({ ok: true, html });
  });

  app.get('/api/annotations/:repo/*', async (req, res) => {
    if (!annotationsEnabled) {
      res.status(404).json({ ok: false, error: 'Annotations are disabled.' });
      return;
    }

    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    const rootPath = mappings[repo];
    const accessContext = resolveAccessContext(req);

    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      if (getManagedRepo(repo)) managedNotFound(res);
      else sendAccessError(res, accessContext, true);
      return;
    }

    let resolved;
    try {
      resolved = await safeResolve(rootPath, relativePath);
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).json({ ok: false, error: 'Invalid path.' });
        return;
      }

      if (error && error.code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'File not found.' });
        return;
      }

      console.error('Failed to resolve annotation path', { rootPath, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to resolve file path.' });
      return;
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'File not found.' });
        return;
      }

      console.error('Failed to stat annotation file', { resolved, error });
      res.status(500).json({ ok: false, error: 'Failed to read file metadata.' });
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ ok: false, error: 'Annotations only apply to files.' });
      return;
    }

    try {
      const result = await readAnnotationDocument(rootPath, repo, relativePath);
      const states = Array.isArray(req.query.state)
        ? req.query.state
        : req.query.state !== undefined
          ? [req.query.state]
          : [];
      const filtered = filterAnnotationsByState(result.document, states);
      // bodyHtml is a response-only projection; the stored sidecar stays plain text.
      res.status(200).json({
        ...filtered,
        annotations: filtered.annotations.map((annotation) => ({
          ...annotation,
          bodyHtml: renderAnnotationMarkdown(annotation.body),
          replies: Array.isArray(annotation.replies)
            ? annotation.replies.map((reply) => ({
                ...reply,
                bodyHtml: renderAnnotationMarkdown(reply.body),
              }))
            : annotation.replies,
        })),
        mtimeMs: result.mtimeMs,
      });
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.status(500).json({ ok: false, error: 'Annotation sidecar contains invalid JSON.' });
        return;
      }

      if (error.message.startsWith('Unsupported state filter:')) {
        res.status(400).json({ ok: false, error: error.message });
        return;
      }

      console.error('Failed to read annotations', { repo, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to read annotations.' });
    }
  });

  app.post('/api/annotations/:repo/*', async (req, res) => {
    if (!annotationsEnabled) {
      res.status(404).json({ ok: false, error: 'Annotations are disabled.' });
      return;
    }

    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    const rootPath = mappings[repo];
    const accessContext = resolveAccessContext(req);

    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'write', repo, relativePath, 'file')) {
      if (getManagedRepo(repo)) managedNotFound(res);
      else sendAccessError(res, accessContext, true);
      return;
    }

    let sourceStat;
    try {
      sourceStat = await fs.stat(await safeResolve(rootPath, relativePath));
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).json({ ok: false, error: 'Invalid path.' });
        return;
      }

      if (error && error.code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'File not found.' });
        return;
      }

      console.error('Failed to stat source file for annotations', { repo, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to read file metadata.' });
      return;
    }

    if (!sourceStat.isFile()) {
      res.status(400).json({ ok: false, error: 'Annotations only apply to files.' });
      return;
    }

    try {
      const result = await createAnnotation(rootPath, repo, relativePath, req.body || {});
      res.status(201).json({
        ok: true,
        annotation: result.annotation,
        mtimeMs: result.mtimeMs,
      });
    } catch (error) {
      if (
        error.message === 'Anchor is required.' ||
        error.message === 'anchorKind is required.' ||
        error.message === 'body is required.' ||
        error.message === 'author is required.' ||
        error.message.startsWith('Unsupported anchorKind') ||
        error.message.startsWith('Anchor must start') ||
        error.message.startsWith('lineRange anchors must') ||
        error.message.startsWith('lineRange anchor end')
      ) {
        res.status(400).json({ ok: false, error: error.message });
        return;
      }

      if (error instanceof SyntaxError) {
        res.status(500).json({ ok: false, error: 'Annotation sidecar contains invalid JSON.' });
        return;
      }

      console.error('Failed to create annotation', { repo, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to create annotation.' });
    }
  });

  app.patch('/api/annotations/:repo/*', async (req, res) => {
    if (!annotationsEnabled) {
      res.status(404).json({ ok: false, error: 'Annotations are disabled.' });
      return;
    }

    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    const rootPath = mappings[repo];
    const accessContext = resolveAccessContext(req);

    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).json({ ok: false, error: 'File not found.' });
      return;
    }

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'write', repo, relativePath, 'file')) {
      if (getManagedRepo(repo)) managedNotFound(res);
      else sendAccessError(res, accessContext, true);
      return;
    }

    let sourceStat;
    try {
      sourceStat = await fs.stat(await safeResolve(rootPath, relativePath));
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).json({ ok: false, error: 'Invalid path.' });
        return;
      }

      if (error && error.code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'File not found.' });
        return;
      }

      console.error('Failed to stat source file for annotation update', { repo, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to read file metadata.' });
      return;
    }

    if (!sourceStat.isFile()) {
      res.status(400).json({ ok: false, error: 'Annotations only apply to files.' });
      return;
    }

    try {
      const result = await updateAnnotation(rootPath, repo, relativePath, req.body || {});
      res.status(200).json({
        ok: true,
        annotation: result.annotation,
        mtimeMs: result.mtimeMs,
      });
    } catch (error) {
      if (error.code === 'ESTALE') {
        const current = await readAnnotationDocument(rootPath, repo, relativePath);
        res.status(409).json({
          ok: false,
          error: error.message,
          currentMtimeMs: error.currentMtimeMs,
          current: current.document,
        });
        return;
      }

      if (
        error.message === 'id is required.' ||
        error.message === 'op is required.' ||
        error.message === 'Annotation not found.' ||
        error.message.startsWith('Unsupported op') ||
        error.message === 'payload.claimedBy is required.' ||
        error.message === 'payload.author is required.' ||
        error.message === 'payload.body is required.' ||
        error.message === 'payload.redactedBy is required.' ||
        error.message === 'Invalid expectedMtimeMs value.'
      ) {
        const status = error.message === 'Annotation not found.' ? 404 : 400;
        res.status(status).json({ ok: false, error: error.message });
        return;
      }

      if (error instanceof SyntaxError) {
        res.status(500).json({ ok: false, error: 'Annotation sidecar contains invalid JSON.' });
        return;
      }

      console.error('Failed to update annotation', { repo, relativePath, error });
      res.status(500).json({ ok: false, error: 'Failed to update annotation.' });
    }
  });

  app.get('/asset/:repo/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    let rootPath = mappings[repo];
    let resolved;

    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).type('text/plain').send('Asset not found.');
      return;
    }

    if (!rootPath && repo !== publishedRepo) {
      res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
      return;
    }

    if (getManagedRepo(repo) && !canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(404).type('text/plain').send('Asset not found.');
      return;
    }

    const extension = path.extname(relativePath).toLowerCase();
    const mimeType = ASSET_MIME_TYPES[extension];
    if (!mimeType) {
      res.status(415).type('text/plain').send('Unsupported asset type.');
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(403).type('text/plain').send('Access denied.');
      return;
    }

    try {
      const published = await resolvePublishedTarget(repo, relativePath, req.query && req.query.version);
      if (published && published.error) {
        sendPathError(res, published.error);
        return;
      }
      if (published) {
        rootPath = published.rootPath;
        resolved = published.resolved;
      } else {
        resolved = await safeResolve(rootPath, relativePath);
      }
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).type('text/plain').send('Invalid path.');
        return;
      }

      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('Asset not found.');
        return;
      }

      console.error('Failed to resolve asset path', { rootPath, relativePath, error });
      res.status(500).type('text/plain').send('Failed to resolve asset path.');
      return;
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('Asset not found.');
        return;
      }

      console.error('Failed to stat asset path', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read asset metadata.');
      return;
    }

    if (!stat.isFile()) {
      res.status(404).type('text/plain').send('Asset not found.');
      return;
    }

    res.set('X-Content-Type-Options', 'nosniff');
    if (isScriptableAssetType(mimeType)) {
      res.set('Content-Security-Policy', ARTIFACT_SANDBOX);
    }
    res.type(mimeType).sendFile(resolved, (error) => {
      if (!error) {
        return;
      }

      console.error('Failed to serve asset', { resolved, error });
      if (!res.headersSent) {
        res.status(500).type('text/plain').send('Failed to read asset.');
      }
    });
  });

  app.get('/embed/:repo/*', async (req, res) => {
    if (!rawHtmlEnabled) {
      res.status(404).type('text/plain').send('Embedded HTML serving is disabled.');
      return;
    }

    const accessContext = resolveAccessContext(req);
    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    const rootPath = mappings[repo];

    if (!rootPath) {
      res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
      return;
    }
    if (!relativePath) {
      res.status(400).type('text/plain').send('Embedded serving requires a file path.');
      return;
    }
    if (!HTML_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      res.status(415).type('text/plain').send('Embedded mode only supports .html and .htm files.');
      return;
    }
    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(403).type('text/plain').send('Access denied.');
      return;
    }

    let resolved;
    try {
      resolved = await safeResolve(rootPath, relativePath);
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).type('text/plain').send('Invalid path.');
        return;
      }
      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('File not found.');
        return;
      }
      console.error('Failed to resolve embed path', { rootPath, relativePath, error });
      res.status(500).type('text/plain').send('Failed to resolve embedded path.');
      return;
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('File not found.');
        return;
      }
      console.error('Failed to stat embed path', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file metadata.');
      return;
    }
    if (!stat.isFile()) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    let sourceBuffer;
    try {
      sourceBuffer = await fs.readFile(resolved);
    } catch (error) {
      console.error('Failed to read embed HTML', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file.');
      return;
    }

    let source;
    try {
      source = decodeEmbedHtmlBuffer(sourceBuffer);
    } catch (error) {
      if (error && error.code === 'EINVALIDHTML') {
        res.status(415).type('text/plain').send(error.message);
        return;
      }
      throw error;
    }

    try {
      const html = transformEmbedHtml(source, {
        repo,
        rootPath,
        relativePath,
        mappings,
        queryToken: accessContext.queryToken,
        sensitiveValues: accessContext.source === 'header' ? [extractPresentedToken(req)] : [],
        annotationsEnabled: annotationsEnabled && canAccessPath(accessContext, 'view', repo, relativePath, 'file'),
        themeMode: typeof req.query['lookie-theme'] === 'string' ? req.query['lookie-theme'] : 'dark',
        themeScheme: typeof req.query['lookie-scheme'] === 'string' ? req.query['lookie-scheme'] : 'slate',
        customThemeCss,
        canAccess: (targetRepo, targetPath, isDirectory) => canAccessPath(
          accessContext,
          'view',
          targetRepo,
          targetPath,
          isDirectory ? 'directory' : 'file'
        ),
      });
      res.set('X-Lookie-Content-Mode', 'transformed-embed');
      res.set('Content-Security-Policy', EMBED_SANDBOX);
      res.status(200).type(RAW_HTML_MIME_TYPE).send(html);
    } catch (error) {
      console.error('Failed to transform embed HTML', { repo, relativePath, error });
      res.status(500).type('text/plain').send('Failed to transform embedded HTML.');
    }
  });

  // Serve trusted HTML files verbatim. See lib/config.js
  // `getRawHtmlEnabled` for the trust assumption — only HTML extensions, only
  // when enabled, only inside the configured roots. Inline <script> tags
  // execute because we do not run them through DOMPurify on this path.
  app.get('/raw/:repo/*', async (req, res) => {
    if (!rawHtmlEnabled) {
      res.status(404).type('text/plain').send('Raw HTML serving is disabled.');
      return;
    }

    const accessContext = resolveAccessContext(req);
    const repo = req.params.repo;
    const relativePath = req.params[0] || '';
    let rootPath = mappings[repo];
    let resolved;

    if (isManagedInternalPath(repo, relativePath)) {
      res.status(404).type('text/plain').send('Raw HTML file not found.');
      return;
    }

    if (!rootPath && repo !== publishedRepo) {
      res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
      return;
    }

    if (getManagedRepo(repo) && !canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(404).type('text/plain').send('Raw HTML file not found.');
      return;
    }

    if (!relativePath) {
      res.status(400).type('text/plain').send('Raw serving requires a file path.');
      return;
    }

    const extension = path.extname(relativePath).toLowerCase();
    if (!HTML_EXTENSIONS.has(extension)) {
      res.status(415).type('text/plain').send('Raw mode only supports .html and .htm files.');
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      res.status(403).type('text/plain').send('Access denied.');
      return;
    }

    try {
      const published = await resolvePublishedTarget(repo, relativePath, req.query && req.query.version);
      if (published && published.error) {
        sendPathError(res, published.error);
        return;
      }
      if (published) {
        rootPath = published.rootPath;
        resolved = published.resolved;
      } else {
        resolved = await safeResolve(rootPath, relativePath);
      }
    } catch (error) {
      if (error && error.code === 'EACCES') {
        res.status(403).type('text/plain').send('Invalid path.');
        return;
      }

      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('File not found.');
        return;
      }

      console.error('Failed to resolve raw path', { rootPath, relativePath, error });
      res.status(500).type('text/plain').send('Failed to resolve raw path.');
      return;
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).type('text/plain').send('File not found.');
        return;
      }

      console.error('Failed to stat raw path', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file metadata.');
      return;
    }

    if (!stat.isFile()) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    let sourceBuffer;
    try {
      sourceBuffer = await fs.readFile(resolved);
    } catch (error) {
      console.error('Failed to read raw HTML', { resolved, error });
      res.status(500).type('text/plain').send('Failed to read file.');
      return;
    }

    sendRawHtmlResponse(res, sourceBuffer);
  });

  app.get('/view', (req, res) => {
    res.redirect(302, appendAccessToken('/', resolveAccessContext(req)));
  });

  app.use((req, res) => {
    res.status(404).type('text/plain').send(`Not found: ${req.path}`);
  });

  app.use((error, _req, res, _next) => {
    if (error && (error.status === 413 || error.type === 'entity.too.large')) {
      res.status(413).type('text/plain').send('Request body is too large.');
      return;
    }
    logger.error('Unhandled request error.', {
      name: error && error.name || 'Error',
      code: error && error.code || 'EUNHANDLED',
    });
    res.status(500).type('text/plain').send('Internal server error.');
  });

  return app;
}

function startServer() {
  const port = getPort();
  const hostname = getHostname();
  const mappings = loadRootMappings();
  const editingEnabled = getEditingEnabled();
  const annotationsEnabled = getAnnotationsEnabled();
  const rawHtmlEnabled = getRawHtmlEnabled();
  const accessConfig = getAccessConfig();
  const managedReposConfig = getManagedReposConfig();
  const formsConfig = getFormsConfig();

  const customThemes = loadCustomThemes();
  const customThemeCss = generateCustomThemeCss(customThemes);

  const builtInThemes = BUILT_IN_THEMES.map((slug) => ({
    slug,
    label: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  }));
  const allThemes = [...builtInThemes, ...customThemes.map((t) => ({ slug: t.slug, label: t.label }))];
  setThemeList(allThemes);

  const app = createApp({ mappings, editingEnabled, annotationsEnabled, rawHtmlEnabled, customThemeCss, accessConfig, managedReposConfig, formsConfig });

  app.listen(port, '0.0.0.0', () => {
    console.log(`Lookie Link listening on http://${hostname}:${port}`);
    console.log(`Editing mode: ${editingEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Annotations: ${annotationsEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Raw HTML serving: ${rawHtmlEnabled ? 'enabled' : 'disabled'}`);
    if (customThemes.length > 0) {
      console.log(`Custom themes: ${customThemes.map((t) => t.label).join(', ')}`);
    }
    console.log('Configured repositories:');
    Object.entries(mappings).forEach(([repo, root]) => {
      console.log(`  /view/${repo} -> ${root}`);
    });
  });

  return app;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

module.exports = {
  createApp,
  startServer,
  isBinaryBuffer,
  isEditableFile,
};
