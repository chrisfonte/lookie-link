'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');

const { loadRootMappings, getPort, getHostname } = require('./lib/config');
const {
  safeResolve,
  toPosixPath,
  splitViewPath,
  buildHref,
  formatFileSize,
  formatMTime,
  compareEntries,
  parentPath,
} = require('./lib/path-utils');
const { renderDocumentPage, renderDirectoryPage } = require('./lib/renderer');

const app = express();
let mappings = null;

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

app.disable('x-powered-by');
app.set('trust proxy', true);

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
  });

  res.status(200).type('html').send(html);
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/view/*', async (req, res) => {
  const viewPath = req.params[0] || '';
  const split = splitViewPath(viewPath);

  if (!split) {
    res.status(400).type('text/plain').send('Invalid path. Use /view/<repo>/<path>.');
    return;
  }

  const { repo, relativePath } = split;
  const rootPath = mappings[repo];

  if (!rootPath) {
    res.status(404).type('text/plain').send(`Unknown repository: ${repo}`);
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
      res.status(500).type('text/plain').send(`Repository root path is unavailable: ${repo}`);
      return;
    }

    console.error('Failed to resolve path', { rootPath, relativePath, error });
    res.status(500).type('text/plain').send('Failed to resolve path.');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.status(404).type('text/plain').send('File or directory not found.');
      return;
    }

    console.error('Failed to stat path', { resolved, error });
    res.status(500).type('text/plain').send('Failed to read path metadata.');
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
    relativePath,
    source,
    parentHref: parentRel === null ? '/view' : buildHref(repo, parentRel),
    mtime: formatMTime(stat.mtime),
    size: formatFileSize(stat.size),
  });

  res.status(200).type('html').send(html);
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

try {
  const port = getPort();
  const hostname = getHostname();
  mappings = loadRootMappings();

  app.listen(port, '0.0.0.0', () => {
    console.log(`ops-file-viewer listening on http://${hostname}:${port}`);
    console.log('Configured repositories:');
    Object.entries(mappings).forEach(([repo, root]) => {
      console.log(`  /view/${repo} -> ${root}`);
    });
  });
} catch (error) {
  console.error('Failed to start server:', error.message);
  process.exit(1);
}
