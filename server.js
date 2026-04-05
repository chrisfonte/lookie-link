'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');

const {
  loadRootMappings,
  getPort,
  getHostname,
  getEditingEnabled,
  loadCustomThemes,
  generateCustomThemeCss,
  BUILT_IN_THEMES,
} = require('./lib/config');
const {
  safeResolve,
  toPosixPath,
  splitViewPath,
  buildHref,
  buildAssetHref,
  buildEditHref,
  buildSaveHref,
  buildPreviewHref,
  formatFileSize,
  formatMTime,
  compareEntries,
  parentPath,
} = require('./lib/path-utils');
const {
  renderDocumentPage,
  renderDirectoryPage,
  renderImagePage,
  renderEditPage,
  renderPreviewHtml,
  setThemeList,
} = require('./lib/renderer');

const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const IMAGE_EXTENSIONS = new Set(Object.keys(ASSET_MIME_TYPES));
const EDITABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown',
  '.yaml', '.yml',
  '.txt', '.json', '.toml', '.ini', '.conf', '.env',
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.xml', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp',
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

  if (IMAGE_EXTENSIONS.has(extension)) {
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

function createApp(options = {}) {
  const app = express();
  const mappings = options.mappings || loadRootMappings();
  const editingEnabled = options.editingEnabled === undefined ? getEditingEnabled() : Boolean(options.editingEnabled);
  const customThemeCss = options.customThemeCss || '';

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use('/public', express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '1h',
  }));

  app.get('/', (_req, res) => {
    const entries = Object.entries(mappings).map(([repo, rootPath]) => ({ repo, rootPath }));
    const html = renderDirectoryPage({
      title: 'Available Repositories',
      repo: null,
      currentPath: '',
      parentHref: null,
      entries: entries.map((entry) => ({
        name: entry.repo,
        href: buildHref(entry.repo, ''),
        isDirectory: true,
        size: '-',
        mtime: '-',
      })),
      notice: 'Choose a repository to browse files.',
      customThemeCss,
    });

    res.status(200).type('html').send(html);
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', editingEnabled });
  });

  app.get('/view/*', async (req, res) => {
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
      try {
        const dirents = await fs.readdir(resolved, { withFileTypes: true });
        const rows = await Promise.all(dirents.map(async (dirent) => {
          const childRel = toPosixPath(path.posix.join(relativePath, dirent.name));
          const childAbs = path.join(resolved, dirent.name);
          let childStat = null;

          try {
            childStat = await fs.stat(childAbs);
          } catch (_error) {
            // Keep listing resilient; inaccessible entries still render.
          }

          return {
            name: dirent.name,
            href: buildHref(repo, childRel),
            isDirectory: dirent.isDirectory(),
            size: childStat && !dirent.isDirectory() ? formatFileSize(childStat.size) : '-',
            mtime: childStat ? formatMTime(childStat.mtime) : '-',
          };
        }));

        rows.sort(compareEntries);

        const parentRel = parentPath(relativePath);
        const html = renderDirectoryPage({
          title: `${repo}/${relativePath || ''}`,
          repo,
          currentPath: relativePath,
          parentHref: parentRel === null ? '/view' : buildHref(repo, parentRel),
          entries: rows,
          notice: rows.length === 0 ? 'Directory is empty.' : null,
          customThemeCss,
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

    const extension = path.extname(relativePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      const parentRel = parentPath(relativePath);
      const html = renderImagePage({
        repo,
        relativePath,
        parentHref: parentRel === null ? '/view' : buildHref(repo, parentRel),
        imageHref: buildAssetHref(repo, relativePath),
        mtime: formatMTime(stat.mtime),
        size: formatFileSize(stat.size),
        customThemeCss,
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
    const html = renderDocumentPage({
      repo,
      repoRoot: rootPath,
      relativePath,
      source,
      parentHref: parentRel === null ? '/view' : buildHref(repo, parentRel),
      mtime: formatMTime(stat.mtime),
      size: formatFileSize(stat.size),
      editHref: editingEnabled ? buildEditHref(repo, relativePath) : null,
      customThemeCss,
    });

    res.status(200).type('html').send(html);
  });

  app.get('/edit/*', async (req, res) => {
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
      source: sourceBuffer.toString('utf8'),
      mtimeMs: Math.trunc(stat.mtimeMs),
      mtime: formatMTime(stat.mtime),
      size: formatFileSize(stat.size),
      viewHref: buildHref(repo, relativePath),
      saveHref: buildSaveHref(repo, relativePath),
      previewHref: buildPreviewHref(repo, relativePath),
      customThemeCss,
    });

    res.status(200).type('html').send(html);
  });

  app.post('/api/save/*', async (req, res) => {
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
      relativePath,
      source: content,
    });

    res.status(200).json({ ok: true, html });
  });

  app.get('/asset/:repo/*', async (req, res) => {
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

  app.get('/view', (_req, res) => {
    res.redirect(302, '/');
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

  const customThemes = loadCustomThemes();
  const customThemeCss = generateCustomThemeCss(customThemes);

  const builtInThemes = BUILT_IN_THEMES.map((slug) => ({
    slug,
    label: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
  }));
  const allThemes = [...builtInThemes, ...customThemes.map((t) => ({ slug: t.slug, label: t.label }))];
  setThemeList(allThemes);

  const app = createApp({ mappings, editingEnabled, customThemeCss });

  app.listen(port, '0.0.0.0', () => {
    console.log(`Lookie Link listening on http://${hostname}:${port}`);
    console.log(`Editing mode: ${editingEnabled ? 'enabled' : 'disabled'}`);
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
