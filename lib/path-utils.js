'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function toPosixPath(input) {
  return String(input || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function splitViewPath(viewPath) {
  const cleaned = toPosixPath(viewPath);
  if (!cleaned) {
    return null;
  }

  const slash = cleaned.indexOf('/');
  if (slash === -1) {
    return { repo: cleaned, relativePath: '' };
  }

  return {
    repo: cleaned.slice(0, slash),
    relativePath: cleaned.slice(slash + 1),
  };
}

async function safeResolve(rootPath, relativePath) {
  const absoluteRoot = await fs.realpath(rootPath);
  const normalized = toPosixPath(relativePath);
  const joined = path.resolve(absoluteRoot, normalized);
  let targetPath = joined;

  try {
    targetPath = await fs.realpath(joined);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const withSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
  const allowed = targetPath === absoluteRoot || targetPath.startsWith(withSep);

  if (!allowed) {
    const error = new Error('Path escapes root directory');
    error.code = 'EACCES';
    throw error;
  }

  return targetPath;
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

function buildHref(repo, relativePath) {
  const repoPart = encodePathSegment(repo);
  const rel = toPosixPath(relativePath);
  if (!rel) {
    return `/view/${repoPart}`;
  }

  return `/view/${repoPart}/${rel.split('/').map(encodePathSegment).join('/')}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) {
    return '-';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatMTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function compareEntries(a, b) {
  if (a.isDirectory && !b.isDirectory) {
    return -1;
  }

  if (!a.isDirectory && b.isDirectory) {
    return 1;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function parentPath(relativePath) {
  const cleaned = toPosixPath(relativePath);
  if (!cleaned) {
    return null;
  }

  const idx = cleaned.lastIndexOf('/');
  if (idx === -1) {
    return '';
  }

  return cleaned.slice(0, idx);
}

module.exports = {
  safeResolve,
  splitViewPath,
  toPosixPath,
  buildHref,
  escapeHtml,
  formatFileSize,
  formatMTime,
  compareEntries,
  parentPath,
};
