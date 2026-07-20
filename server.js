'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');

const {
  loadRootMappings,
  getPort,
  getHostname,
  getEditingEnabled,
  getAnnotationsEnabled,
  getRawHtmlEnabled,
  getAccessConfig,
  loadCustomThemes,
  generateCustomThemeCss,
  BUILT_IN_THEMES,
} = require('./lib/config');
const {
  parseAccessConfig,
  authenticateRequest,
  canAccessPath,
  appendAccessToken,
  extractPresentedToken,
} = require('./lib/access-control');
const {
  GrantStore,
  buildIssueComment,
} = require('./lib/grant-store');
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
  renderPdfPage,
  renderCsvPage,
  renderJsonPage,
  renderEditPage,
  renderPreviewHtml,
  setThemeList,
} = require('./lib/renderer');
const {
  readAnnotationDocument,
  filterAnnotationsByState,
  createAnnotation,
  updateAnnotation,
} = require('./lib/annotations');

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
  ...PDF_MIME_TYPES,
  ...TEXT_MIME_TYPES,
};
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));
const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_TYPES));
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

  if (IMAGE_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || PDF_EXTENSIONS.has(extension)) {
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

function parseBooleanQuery(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function sendGrantJsonError(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function createApp(options = {}) {
  const app = express();
  const mappings = options.mappings || loadRootMappings();
  const editingEnabled = options.editingEnabled === undefined ? getEditingEnabled() : Boolean(options.editingEnabled);
  const annotationsEnabled = options.annotationsEnabled === undefined ? getAnnotationsEnabled() : Boolean(options.annotationsEnabled);
  const rawHtmlEnabled = options.rawHtmlEnabled === undefined ? getRawHtmlEnabled() : Boolean(options.rawHtmlEnabled);
  const customThemeCss = options.customThemeCss || '';
  const rawAccessConfig = options.accessConfig === undefined ? getAccessConfig() : options.accessConfig;
  const accessConfig = parseAccessConfig(rawAccessConfig);
  const grantStore = options.grantStore === undefined
    ? GrantStore.fromAccessConfig(rawAccessConfig.grants)
    : options.grantStore;
  const resolveAccessContext = (req) => {
    if (req.accessContext) {
      return req.accessContext;
    }

    const accessContext = authenticateRequest(req, accessConfig);
    if (accessContext.mode === 'scoped' || !grantStore || !grantStore.isEnabled()) {
      return accessContext;
    }

    const presentedToken = extractPresentedToken(req);
    if (!presentedToken) {
      return accessContext;
    }

    const grantAccess = grantStore.authenticateGrantToken(
      presentedToken,
      accessContext.source || null,
      accessContext.queryToken || null
    );
    return grantAccess || accessContext;
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

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    req.accessContext = resolveAccessContext(req);
    next();
  });
  app.use('/public', express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '1h',
  }));

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

  app.get('/api/repos', (req, res) => {
    const accessContext = resolveAccessContext(req);
    if (accessContext.mode === 'denied') {
      sendAccessError(res, accessContext);
      return;
    }
    const repos = Object.entries(mappings)
      .filter(([repo]) => canAccessPath(accessContext, 'view', repo, '', 'directory'))
      .map(([repo]) => ({
        repo,
        viewUrl: `/view/${encodeURIComponent(repo)}/`,
        assetUrl: `/asset/${encodeURIComponent(repo)}/`,
      }));
    res.status(200).json({ repos, count: repos.length });
  });

  app.get('/view/*', async (req, res) => {
    const accessContext = resolveAccessContext(req);
    let resolvedInput;
    try {
      resolvedInput = await resolveFromRequest(mappings, req.params[0] || '');
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
      saveHref: appendAccessToken(buildSaveHref(repo, relativePath), accessContext),
      previewHref: appendAccessToken(buildPreviewHref(repo, relativePath), accessContext),
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

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      sendAccessError(res, accessContext, true);
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
      res.status(200).json(filtered);
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

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      sendAccessError(res, accessContext, true);
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

    if (!rootPath) {
      res.status(404).json({ ok: false, error: `Unknown repository: ${repo}` });
      return;
    }

    if (!relativePath) {
      res.status(400).json({ ok: false, error: 'Annotations require a file path.' });
      return;
    }

    if (!canAccessPath(accessContext, 'view', repo, relativePath, 'file')) {
      sendAccessError(res, accessContext, true);
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
    const rootPath = mappings[repo];

    if (!rootPath) {
      res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
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

    let resolved;
    try {
      resolved = await safeResolve(rootPath, relativePath);
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
    const rootPath = mappings[repo];

    if (!rootPath) {
      res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
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

    res.type(RAW_HTML_MIME_TYPE).sendFile(resolved, (error) => {
      if (!error) {
        return;
      }

      console.error('Failed to serve raw HTML', { resolved, error });
      if (!res.headersSent) {
        res.status(500).type('text/plain').send('Failed to read file.');
      }
    });
  });

  app.get('/view', (req, res) => {
    res.redirect(302, appendAccessToken('/', resolveAccessContext(req)));
  });

  app.use((req, res) => {
    res.status(404).type('text/plain').send(`Not found: ${req.path}`);
  });

  app.use((error, _req, res, _next) => {
    console.error('Unhandled error', error);
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

  const customThemes = loadCustomThemes();
  const customThemeCss = generateCustomThemeCss(customThemes);

  const builtInThemes = BUILT_IN_THEMES.map((slug) => ({
    slug,
    label: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  }));
  const allThemes = [...builtInThemes, ...customThemes.map((t) => ({ slug: t.slug, label: t.label }))];
  setThemeList(allThemes);

  const app = createApp({ mappings, editingEnabled, annotationsEnabled, rawHtmlEnabled, customThemeCss, accessConfig });

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
