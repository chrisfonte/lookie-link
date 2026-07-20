'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { JSDOM } = require('jsdom');

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const URL_ATTRIBUTES = [
  ['img', 'src'],
  ['script', 'src'],
  ['link', 'href'],
  ['audio', 'src'],
  ['video', 'src'],
  ['source', 'src'],
  ['track', 'src'],
  ['iframe', 'src'],
  ['object', 'data'],
];

function encodeRoutePath(route, repo, relativePath) {
  const repoPart = encodeURIComponent(repo);
  const pathPart = relativePath
    ? `/${relativePath.split('/').map(encodeURIComponent).join('/')}`
    : '';
  return `/${route}/${repoPart}${pathPart}`;
}

function appendQueryToken(url, queryToken) {
  if (!queryToken || url.startsWith('#')) {
    return url;
  }
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}token=${encodeURIComponent(queryToken)}${hash}`;
}

function splitReference(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) {
    return null;
  }
  const match = raw.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) {
    return null;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(match[1] || '');
  } catch (_error) {
    return null;
  }
  return { raw, pathname, query: match[2] || '', hash: match[3] || '' };
}

function isWithinRoot(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function repoEntries(options) {
  return Object.entries(options.mappings || {})
    .filter(([repo, rootPath]) => repo && typeof rootPath === 'string' && rootPath)
    .map(([repo, rootPath]) => ({ repo, rootPath: path.resolve(rootPath) }))
    .sort((left, right) => right.rootPath.length - left.rootPath.length);
}

function canResolve(options, repo, relativePath, isDirectory = false) {
  return typeof options.canAccess !== 'function' || options.canAccess(repo, relativePath, isDirectory);
}

function resolveReference(value, options) {
  const parsed = splitReference(value);
  if (!parsed) {
    return null;
  }
  if (!parsed.pathname) {
    return parsed.hash
      ? `${encodeRoutePath('view', options.repo, options.relativePath)}${parsed.hash}`
      : null;
  }

  const entries = repoEntries(options);
  const currentRoot = path.resolve(options.rootPath);
  const sourceDir = path.dirname(path.join(currentRoot, options.relativePath));
  let absoluteTarget;

  if (parsed.pathname.startsWith('~/') || parsed.pathname.startsWith('$HOME/')) {
    const portablePath = parsed.pathname.replace(/^(?:~\/|\$HOME\/)/, '');
    const [repoName, ...parts] = portablePath.split('/');
    const explicitRepo = entries.find((entry) => entry.repo === repoName);
    if (explicitRepo) {
      absoluteTarget = path.resolve(explicitRepo.rootPath, parts.join('/'));
    } else {
      absoluteTarget = path.resolve(os.homedir(), portablePath);
    }
  } else if (path.isAbsolute(parsed.pathname)) {
    absoluteTarget = path.resolve(parsed.pathname);
  } else {
    absoluteTarget = path.resolve(sourceDir, parsed.pathname);
  }

  let targetRepo = entries.find((entry) => isWithinRoot(absoluteTarget, entry.rootPath));
  if (!targetRepo && parsed.pathname.startsWith('/') && !/^\/(?:home|Users)\//.test(parsed.pathname)) {
    targetRepo = entries.find((entry) => entry.repo === options.repo);
    absoluteTarget = path.resolve(currentRoot, parsed.pathname.replace(/^\/+/, ''));
  }
  if (!targetRepo || !isWithinRoot(absoluteTarget, targetRepo.rootPath)) {
    return /^\/(?:home|Users)\//.test(parsed.pathname) || /^(?:~|\$HOME)(?:\/|$)/.test(parsed.pathname)
      ? '#unresolved-portable-link'
      : null;
  }

  const relativePath = path.relative(targetRepo.rootPath, absoluteTarget).split(path.sep).join('/');
  const normalizedPath = relativePath === '.' ? '' : relativePath;
  const isDirectory = parsed.pathname.endsWith('/');
  if (!canResolve(options, targetRepo.repo, normalizedPath, isDirectory)) {
    return '#unavailable-link';
  }

  return {
    repo: targetRepo.repo,
    relativePath: normalizedPath,
    query: parsed.query,
    hash: parsed.hash,
    isDirectory,
  };
}

function slugKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[^.\/]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function wikiKeys(relativePath, isDirectory) {
  const base = path.posix.basename(String(relativePath || '').replace(/\/$/, ''));
  const extension = isDirectory ? '' : path.posix.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  return [...new Set([base.toLowerCase(), stem.toLowerCase(), slugKey(base), slugKey(stem)].filter(Boolean))];
}

function buildWikiIndex(options, limit = 5000) {
  const index = new Map();
  let count = 0;
  function add(entry) {
    for (const key of wikiKeys(entry.relativePath, entry.isDirectory)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(entry);
    }
  }
  function walk(repo, rootPath, absoluteDir, relativeDir) {
    if (count >= limit) return;
    let dirents;
    try {
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const dirent of dirents) {
      if (count >= limit) break;
      if (dirent.name.startsWith('.')) continue;
      count += 1;
      const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (canResolve(options, repo, relativePath, true)) add({ repo, relativePath, isDirectory: true });
        walk(repo, rootPath, path.join(absoluteDir, dirent.name), relativePath);
      } else if (dirent.isFile() && canResolve(options, repo, relativePath, false)) {
        add({ repo, relativePath, isDirectory: false });
      }
    }
  }
  for (const entry of repoEntries(options)) {
    walk(entry.repo, entry.rootPath, entry.rootPath, '');
  }
  return index;
}

function resolveWikiReference(value, options, wikiIndex) {
  const match = String(value || '').trim().match(/^\[\[([^\[\]]+)\]\]$/);
  if (!match) return null;
  const targetPart = match[1].split('|', 1)[0];
  const hashIndex = targetPart.indexOf('#');
  const name = (hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex)).trim();
  const hash = hashIndex === -1 ? '' : targetPart.slice(hashIndex);
  const candidates = wikiIndex.get(slugKey(name)) || [];
  const sameRepo = candidates.filter((entry) => entry.repo === options.repo);
  const scoped = sameRepo.length ? sameRepo : candidates;
  if (scoped.length !== 1) return '#unresolved-wiki-link';
  return `${encodeRoutePath('view', scoped[0].repo, scoped[0].relativePath)}${hash}`;
}

function resolvedRoute(reference, route, queryToken) {
  if (typeof reference === 'string') return appendQueryToken(reference, queryToken);
  const authoredQuery = new URLSearchParams(reference.query.replace(/^\?/, ''));
  authoredQuery.delete('token');
  const safeQuery = authoredQuery.toString();
  const href = `${encodeRoutePath(route, reference.repo, reference.relativePath)}${safeQuery ? `?${safeQuery}` : ''}${reference.hash}`;
  return appendQueryToken(href, queryToken);
}

function rewriteDocumentUrls(document, options) {
  const wikiIndex = buildWikiIndex(options);
  for (const link of document.querySelectorAll('a[href]')) {
    const original = link.getAttribute('href');
    const wikiHref = resolveWikiReference(original, options, wikiIndex);
    const reference = wikiHref || resolveReference(original, options);
    if (!reference) continue;
    const href = wikiHref
      ? appendQueryToken(wikiHref, options.queryToken)
      : resolvedRoute(reference, 'view', options.queryToken);
    link.setAttribute('href', href);
    if (!href.startsWith('#')) link.setAttribute('target', '_top');
  }

  for (const [selector, attribute] of URL_ATTRIBUTES) {
    for (const element of document.querySelectorAll(`${selector}[${attribute}]`)) {
      if (selector === 'link' && !/stylesheet|icon/i.test(element.getAttribute('rel') || '')) continue;
      const reference = resolveReference(element.getAttribute(attribute), options);
      if (!reference || typeof reference === 'string') continue;
      element.setAttribute(attribute, resolvedRoute(reference, 'asset', options.queryToken));
    }
  }

  for (const element of document.querySelectorAll('[srcset]')) {
    const rewritten = element.getAttribute('srcset').split(',').map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const reference = resolveReference(parts[0], options);
      if (reference && typeof reference !== 'string') parts[0] = resolvedRoute(reference, 'asset', options.queryToken);
      return parts.join(' ');
    }).join(', ');
    element.setAttribute('srcset', rewritten);
  }
}

function ensureHeadingIds(document) {
  const used = new Set(Array.from(document.querySelectorAll('[id]')).map((node) => node.id).filter(Boolean));
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!heading.id) {
      const base = slugKey(heading.textContent) || 'section';
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) candidate = `${base}-${suffix++}`;
      heading.id = candidate;
      used.add(candidate);
    }
    if (!heading.querySelector('.anchor-link')) {
      const anchor = document.createElement('a');
      anchor.className = 'anchor-link';
      anchor.href = `#${heading.id}`;
      anchor.dataset.anchorId = heading.id;
      anchor.setAttribute('aria-label', 'Copy section link');
      anchor.textContent = '🔗';
      heading.appendChild(anchor);
    }
  }
}

function addThemeInjection(document, options) {
  const mode = options.themeMode === 'light' ? 'light' : 'dark';
  const scheme = /^[a-z0-9-]+$/.test(options.themeScheme || '') ? options.themeScheme : 'slate';
  document.documentElement.setAttribute('data-lookie-link-theme', mode);
  document.documentElement.setAttribute('data-lookie-link-scheme', scheme);

  const base = document.createElement('base');
  const currentDir = path.posix.dirname(options.relativePath);
  base.href = `${encodeRoutePath('asset', options.repo, currentDir === '.' ? '' : currentDir)}/`;
  document.head.prepend(base);

  const style = document.createElement('style');
  style.id = 'lookie-link-embed-theme';
  style.textContent = `:root { color-scheme: ${mode}; --lookie-bg: #111827; --lookie-bg-elev: #1f2937; --lookie-bg-code: #0f172a; --lookie-text: #e5e7eb; --lookie-text-soft: #9ca3af; --lookie-accent: #22c55e; --lookie-border: #374151; --lookie-link: #38bdf8; }\n${options.customThemeCss || ''}`;
  document.head.appendChild(style);

  const script = document.createElement('script');
  script.id = 'lookie-link-embed-runtime';
  script.textContent = `(function () {\n  window.addEventListener('message', function (event) {\n    if (event.origin !== window.location.origin || !event.data) return;\n    if (event.data.type === 'lookie-link:set-theme') {\n      document.documentElement.setAttribute('data-lookie-link-theme', event.data.mode === 'light' ? 'light' : 'dark');\n      if (/^[a-z0-9-]+$/.test(event.data.scheme || '')) document.documentElement.setAttribute('data-lookie-link-scheme', event.data.scheme);\n    }\n    if (event.data.type === 'lookie-link:set-annotation-mode') {\n      document.documentElement.classList.toggle('lookie-annotations-active', Boolean(event.data.enabled));\n    }\n  });\n}());`;
  document.head.appendChild(script);
}

function addAnnotations(document, options) {
  if (!options.annotationsEnabled) return;
  ensureHeadingIds(document);
  const bootstrap = document.createElement('script');
  bootstrap.id = 'lookie-link-annotations-bootstrap';
  bootstrap.type = 'application/json';
  bootstrap.textContent = JSON.stringify({
    repo: options.repo,
    relativePath: options.relativePath,
    queryToken: options.queryToken || null,
  }).replace(/</g, '\\u003c');
  document.body.appendChild(bootstrap);

  const initializer = document.createElement('script');
  initializer.textContent = `(function () {\n  var node = document.getElementById('lookie-link-annotations-bootstrap');\n  try { window.__lookieLinkAnnotations = JSON.parse(node.textContent || '{}'); } catch (_error) { window.__lookieLinkAnnotations = null; }\n}());`;
  document.body.appendChild(initializer);
  const client = document.createElement('script');
  client.src = '/public/annotations.js';
  client.defer = true;
  document.body.appendChild(client);
}

function redactPrivatePaths(html, options) {
  let output = html;
  for (const entry of repoEntries(options)) {
    output = output.split(entry.rootPath).join(encodeRoutePath('view', entry.repo, ''));
  }
  const homePath = path.resolve(os.homedir());
  output = output.split(homePath).join('[host-home]');
  for (const secret of options.sensitiveValues || []) {
    if (secret) output = output.split(String(secret)).join('[credential-redacted]');
  }
  return output.replace(/\/(?:home|Users)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g, '[host-path]');
}

function redactSensitiveDom(document, sensitiveValues) {
  const secrets = (sensitiveValues || []).map(String).filter(Boolean);
  if (!secrets.length) return;
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      let value = attribute.value;
      for (const secret of secrets) value = value.split(secret).join('[credential-redacted]');
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      let value = node.nodeValue;
      for (const secret of secrets) value = value.split(secret).join('[credential-redacted]');
      node.nodeValue = value;
    }
  }
}

function transformEmbedHtml(source, options) {
  let redactedSource = source;
  for (const secret of options.sensitiveValues || []) {
    if (secret) redactedSource = redactedSource.split(String(secret)).join('[credential-redacted]');
  }
  const authoredFullDocument = /<(?:!doctype|html|head|body)\b/i.test(redactedSource);
  const dom = new JSDOM(authoredFullDocument ? redactedSource : `<body>${redactedSource}</body>`);
  const { document } = dom.window;
  redactSensitiveDom(document, options.sensitiveValues);
  rewriteDocumentUrls(document, options);
  addThemeInjection(document, options);
  addAnnotations(document, options);
  const serialized = dom.serialize();
  const withDoctype = /^<!doctype/i.test(serialized) ? serialized : `<!doctype html>\n${serialized}`;
  return redactPrivatePaths(withDoctype, options);
}

function looksBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 2048);
  for (let index = 0; index < sampleSize; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function decodeEmbedHtmlBuffer(buffer) {
  if (looksBinary(buffer)) {
    const error = new Error('Embedded HTML must be text, not binary data.');
    error.code = 'EINVALIDHTML';
    throw error;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    const error = new Error('Embedded HTML must be valid UTF-8.');
    error.code = 'EINVALIDHTML';
    throw error;
  }
}

module.exports = {
  decodeEmbedHtmlBuffer,
  transformEmbedHtml,
};
