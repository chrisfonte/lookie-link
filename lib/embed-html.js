'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { JSDOM } = require('jsdom');

const { decorateRenderedHtmlForAnnotations } = require('./renderer');

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
  // Already viewer-routed absolute paths (authored /asset/..., /view/...,
  // /forms/..., etc.) must pass through untouched — re-resolving them against
  // the current repo double-prefixes the route (/asset/<repo>/asset/<repo>/...
  // → 404, or /forms → a nonexistent repo path).
  if (/^\/(?:asset|view|raw|embed|api|forms|public)\//.test(raw)) {
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

function markAnnotationTargets(document) {
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
    heading.setAttribute('data-lookie-annotation-anchor', heading.id);
  }
}

const DARK_THEME_TOKENS = '--lookie-bg: #111827; --lookie-bg-elev: #1f2937; --lookie-bg-code: #0f172a; --lookie-text: #e5e7eb; --lookie-text-soft: #9ca3af; --lookie-accent: #22c55e; --lookie-border: #374151; --lookie-link: #38bdf8;';
const LIGHT_THEME_TOKENS = '--lookie-bg: #f4f6f8; --lookie-bg-elev: #ffffff; --lookie-bg-code: #edf1f5; --lookie-text: #1a2630; --lookie-text-soft: #5a6b78; --lookie-accent: #3a7a92; --lookie-border: #d0dae3; --lookie-link: #1f6d8a;';

// The bridge tokens an authored page reads, mapped to the scheme variable each one
// mirrors. Aliasing (rather than copying values server-side) keeps public/style.css
// the single source of truth for built-in palettes and lets a runtime scheme change
// re-resolve in CSS with no reload.
const LOOKIE_TOKEN_ALIASES = [
  ['--lookie-bg', '--bg'],
  ['--lookie-bg-elev', '--bg-elev'],
  ['--lookie-bg-code', '--bg-code'],
  ['--lookie-text', '--text'],
  ['--lookie-text-soft', '--text-soft'],
  ['--lookie-accent', '--accent'],
  ['--lookie-border', '--border'],
  ['--lookie-link', '--link'],
];

// Only --lookie-* names may enter an authored document. A scheme block declares
// unprefixed names (--bg, --text, --accent, ...) at a selector specific enough to
// beat a page's own tokens, so the blocks are REWRITTEN rather than passed through:
// mapped properties are renamed, everything else (--page-bg, --toolbar-*,
// --heading-font, color-scheme) is dropped.
const SCHEME_TOKEN_RENAMES = new Map(LOOKIE_TOKEN_ALIASES.map(([token, source]) => [source, token]));
const SCHEME_BLOCK_PATTERN = /:root\[data-color-scheme="[a-z0-9-]+"\](?:\[data-theme="light"\])?\s*\{[^}]*\}/g;

function rewriteSchemeBlocks(cssText) {
  if (!cssText) return '';
  const blocks = [];
  for (const block of String(cssText).match(SCHEME_BLOCK_PATTERN) || []) {
    const open = block.indexOf('{');
    const selector = block.slice(0, open).trim();
    const declarations = [];
    for (const declaration of block.slice(open + 1, -1).split(';')) {
      const at = declaration.indexOf(':');
      if (at === -1) continue;
      const name = declaration.slice(0, at).trim();
      const value = declaration.slice(at + 1).trim();
      const renamed = SCHEME_TOKEN_RENAMES.get(name);
      if (renamed && value) declarations.push(`${renamed}: ${value};`);
    }
    if (declarations.length) blocks.push(`${selector} { ${declarations.join(' ')} }`);
  }
  return blocks.join('\n');
}

// Built-in scheme palettes live only as CSS in public/style.css, which the embedded
// document never loads. Lift out just the `:root[data-color-scheme=...]` blocks: they
// declare custom properties and style no elements, so they cannot leak into an
// authored page's own styling.
let builtInSchemeCssCache = null;
function builtInSchemeCss() {
  if (builtInSchemeCssCache !== null) return builtInSchemeCssCache;
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    builtInSchemeCssCache = rewriteSchemeBlocks(source);
  } catch (_error) {
    // A missing or unreadable stylesheet must not break rendering — the embed
    // falls back to the constant palettes below.
    builtInSchemeCssCache = '';
  }
  return builtInSchemeCssCache;
}

// The embedded document does not load the viewer's public/style.css, so the gate
// that hides annotate buttons until annotation mode is on never reached it and the
// buttons rendered unconditionally. Mirror the two rules that matter here.
const ANNOTATION_GATE_CSS = '.lookie-annotate-btn { display: none; }\n.lookie-annotations-active .lookie-annotate-btn { display: inline-flex; align-items: center; gap: 0.2rem; margin-left: 0.4rem; padding: 0.08rem 0.45rem; font-size: 0.76em; line-height: 1.4; background: transparent; border: 1px solid var(--lookie-border, #374151); border-radius: 999px; color: var(--lookie-text-soft, #9ca3af); cursor: pointer; opacity: 0.72; vertical-align: baseline; }\n.lookie-annotations-active .lookie-annotate-btn:hover, .lookie-annotations-active .lookie-annotate-btn:focus { opacity: 1; color: var(--lookie-accent, #22c55e); border-color: var(--lookie-accent, #22c55e); }';

function addThemeInjection(document, options) {
  const mode = options.themeMode === 'light' ? 'light' : 'dark';
  const scheme = /^[a-z0-9-]+$/.test(options.themeScheme || '') ? options.themeScheme : 'slate';
  document.documentElement.setAttribute('data-lookie-link-theme', mode);
  document.documentElement.setAttribute('data-lookie-link-scheme', scheme);
  // The scheme blocks (built-in and custom alike) key on the viewer's own
  // attribute names, so the embed root has to carry them for any block to match.
  document.documentElement.setAttribute('data-color-scheme', scheme);
  if (mode === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');

  const base = document.createElement('base');
  const currentDir = path.posix.dirname(options.relativePath);
  base.href = `${encodeRoutePath('asset', options.repo, currentDir === '.' ? '' : currentDir)}/`;
  document.head.prepend(base);

  const style = document.createElement('style');
  style.id = 'lookie-link-embed-theme';
  // The token VALUES must track the mode, not just `color-scheme` — a page that
  // opts into theme-follow reads these via var(--lookie-*), so emitting one fixed
  // palette pinned every such page to dark no matter what the viewer toggle said.
  // Both palettes are keyed on the data attribute (not baked into a single :root)
  // so the runtime `lookie-link:set-theme` message re-themes without a reload.
  // Light values mirror the viewer's own slate-light chrome so embedded content
  // matches the frame it sits in.
  style.textContent = [
    `:root { color-scheme: ${mode}; }`,
    // Scheme palettes first, so the aliases below have --bg/--text/... to resolve
    // against. Built-in blocks are lifted from the viewer stylesheet; custom
    // themes arrive already keyed on the same attributes.
    // Constant fallbacks first: they keep a document readable when no scheme block
    // matches, and stay mode-correct via the attribute key.
    `:root, :root[data-lookie-link-theme="dark"] { ${DARK_THEME_TOKENS} }`,
    `:root[data-lookie-link-theme="light"] { color-scheme: light; ${LIGHT_THEME_TOKENS} }`,
    // Scheme tokens last and more specific, so the active scheme wins. Both
    // built-in and custom themes go through the same rename.
    builtInSchemeCss(),
    rewriteSchemeBlocks(options.customThemeCss || ''),
  ].join('\n');
  document.head.appendChild(style);

  const script = document.createElement('script');
  script.id = 'lookie-link-embed-runtime';
  // This document runs in a sandboxed frame WITHOUT allow-same-origin (opaque
  // origin). Two consequences shape the runtime below:
  // - inbound: accept messages only from the framing window (event.source check;
  //   an origin-string comparison is unreliable from an opaque origin). Payloads
  //   are cosmetic (theme attributes, annotation class) and strictly validated.
  // - outbound: the parent cannot measure this document (contentDocument is
  //   blocked), so the runtime reports its own scroll height. targetOrigin must
  //   be '*' because an opaque origin cannot name its parent; the payload is
  //   only a height number.
  script.textContent = `(function () {\n  var framed = window.parent !== window;\n  // Styling hook: the frame is content-height, so position:fixed overlays cover the\n  // whole document instead of the visible viewport — CSS (e.g. the kit's\n  // photo-lightbox) switches to in-flow variants under this class.\n  if (framed) document.documentElement.classList.add('lookie-embedded');\n  window.addEventListener('message', function (event) {\n    if (event.source !== window.parent || !event.data) return;\n    if (event.data.type === 'lookie-link:set-theme') {\n      var nextMode = event.data.mode === 'light' ? 'light' : 'dark';\n      document.documentElement.setAttribute('data-lookie-link-theme', nextMode);\n      if (nextMode === 'light') document.documentElement.setAttribute('data-theme', 'light');\n      else document.documentElement.removeAttribute('data-theme');\n      if (/^[a-z0-9-]+$/.test(event.data.scheme || '')) {\n        document.documentElement.setAttribute('data-lookie-link-scheme', event.data.scheme);\n        document.documentElement.setAttribute('data-color-scheme', event.data.scheme);\n      }\n    }\n    if (event.data.type === 'lookie-link:set-annotation-mode') {\n      document.documentElement.classList.toggle('lookie-annotations-active', Boolean(event.data.enabled));\n    }\n  });\n  var lastHeight = 0;\n  function reportHeight() {\n    if (!framed) return;\n    var height = Math.max(\n      document.documentElement ? document.documentElement.scrollHeight : 0,\n      document.body ? document.body.scrollHeight : 0\n    );\n    if (height > 0 && height !== lastHeight) {\n      lastHeight = height;\n      window.parent.postMessage({ type: 'lookie-link:content-height', height: height }, '*');\n    }\n  }\n  document.addEventListener('DOMContentLoaded', reportHeight);\n  window.addEventListener('load', reportHeight);\n  if (typeof ResizeObserver === 'function') {\n    new ResizeObserver(reportHeight).observe(document.documentElement);\n  }\n  window.setInterval(reportHeight, 1500);\n  // A content-height frame cannot scroll internally, so fragment targets would be\n  // dead: report the target's document offset and let the viewer scroll to it.\n  function reportAnchor() {\n    if (!framed || !location.hash) return;\n    var id;\n    try { id = decodeURIComponent(location.hash.slice(1)); } catch (_e) { id = location.hash.slice(1); }\n    var el = id && document.getElementById(id);\n    if (!el) return;\n    var y = el.getBoundingClientRect().top + (window.scrollY || 0);\n    window.parent.postMessage({ type: 'lookie-link:scroll-to', y: Math.max(0, y) }, '*');\n  }\n  window.addEventListener('load', reportAnchor);\n  window.addEventListener('hashchange', reportAnchor);\n  // Image zoom goes through the VIEWER's own lightbox overlay (the same one\n  // markdown files use) — an in-document overlay cannot center on the visible\n  // viewport from inside a content-height frame. Clicking a link that targets a\n  // .photo-lightbox stage is intercepted and forwarded as an open-image request.\n  document.addEventListener('click', function (event) {\n    if (!framed || event.defaultPrevented) return;\n    var anchor = event.target && event.target.closest ? event.target.closest('a') : null;\n    if (!anchor) return;\n    var href = anchor.getAttribute('href') || '';\n    var hashAt = href.indexOf('#');\n    if (hashAt < 0) return;\n    var id;\n    try { id = decodeURIComponent(href.slice(hashAt + 1)); } catch (_e) { id = href.slice(hashAt + 1); }\n    var stage = id && document.getElementById(id);\n    if (!stage || !stage.classList || !stage.classList.contains('photo-lightbox')) return;\n    var img = stage.querySelector('img');\n    var src = img && (img.currentSrc || img.src);\n    if (!src) return;\n    event.preventDefault();\n    window.parent.postMessage({\n      type: 'lookie-link:open-image',\n      src: src,\n      alt: (img.getAttribute('alt') || anchor.getAttribute('aria-label') || '')\n    }, '*');\n  }, true);\n  // Escape closes the viewer lightbox (focus usually lives inside this frame), and\n  // still releases any fragment-targeted overlay by navigating to its close link.\n  window.addEventListener('keydown', function (event) {\n    if (event.key !== 'Escape' || !framed) return;\n    window.parent.postMessage({ type: 'lookie-link:close-image' }, '*');\n    var target = null;\n    try { target = document.querySelector(':target'); } catch (_e) {}\n    if (!target || target.tagName !== 'A') return;\n    var href = target.getAttribute('href') || '';\n    var hash = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#')) : '';\n    if (!/^#[A-Za-z0-9_-]*$/.test(hash)) return;\n    window.parent.postMessage({ type: 'lookie-link:set-hash', hash: hash }, '*');\n  });\n}());`;
  document.head.appendChild(script);
}

function addAnnotations(document, options) {
  if (!options.annotationsEnabled) return;
  markAnnotationTargets(document);
  document.body.innerHTML = decorateRenderedHtmlForAnnotations(document.body.innerHTML);
  document.body.setAttribute('data-rendered-view', '');

  const gate = document.createElement('style');
  gate.id = 'lookie-link-embed-annotation-gate';
  gate.textContent = ANNOTATION_GATE_CSS;
  document.head.appendChild(gate);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toolbar-btn toolbar-btn-annotation-count';
  toggle.setAttribute('data-annotations-toggle', '');
  toggle.setAttribute('aria-label', 'Show or hide resolved annotations');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.hidden = true;
  toggle.textContent = '💬 0';
  document.body.prepend(toggle);

  const stale = document.createElement('aside');
  stale.className = 'lookie-annotations-stale';
  stale.setAttribute('data-annotations-stale', '');
  stale.hidden = true;
  document.body.appendChild(stale);

  const bootstrap = document.createElement('script');
  bootstrap.id = 'lookie-link-annotations-bootstrap';
  bootstrap.type = 'application/json';
  bootstrap.textContent = JSON.stringify({
    repo: options.repo,
    relativePath: options.relativePath,
    queryToken: options.queryToken || null,
    supportsLineRangeAnnotations: false,
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
