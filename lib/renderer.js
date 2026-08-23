'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('./path-utils');

const SECONDARY_VIEW_EXTENSIONS = new Set(['.example', '.tmpl', '.template', '.dist', '.sample']);
function effectiveViewExtension(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (!SECONDARY_VIEW_EXTENSIONS.has(ext)) {
    return ext;
  }
  const stripped = relativePath.slice(0, -ext.length);
  return path.extname(stripped).toLowerCase() || ext;
}


const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(code, language) {
    const lang = language && hljs.getLanguage(language) ? language : null;

    try {
      if (lang) {
        return `<pre><code class="hljs language-${escapeHtml(lang)}">${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      }

      return `<pre><code class="hljs">${hljs.highlightAuto(code).value}</code></pre>`;
    } catch (_error) {
      return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
    }
  },
});

// Annotation bodies are user-authored API input, not trusted repo documents:
// html stays off so authored markup arrives escaped, never parsed.
const annotationMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

function renderAnnotationMarkdown(body) {
  return annotationMarkdown.render(String(body || ''));
}

const domPurifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(domPurifyWindow);
const YOUTUBE_EMBED_SRC_RE = /^https:\/\/(?:www\.)?youtube\.com\/embed\/[A-Za-z0-9_-]+(?:\?[^"\s]*)?$/i;


DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (/^on/i.test(data.attrName)) {
    data.keepAttr = false;
    return;
  }

  if (node.nodeName === 'IFRAME' && data.attrName === 'src') {
    const src = (data.attrValue || '').trim();
    if (!YOUTUBE_EMBED_SRC_RE.test(src)) {
      data.keepAttr = false;
    }
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'IFRAME') {
    return;
  }

  const src = (node.getAttribute('src') || '').trim();
  if (!YOUTUBE_EMBED_SRC_RE.test(src)) {
    node.remove();
    return;
  }

  node.setAttribute('sandbox', 'allow-scripts allow-same-origin');
});

// Add anchor IDs to markdown headings
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')       // strip HTML tags
    .replace(/[^\w\s-]/g, '')      // remove non-word chars except spaces and dashes
    .replace(/\s+/g, '-')          // spaces to dashes
    .replace(/-+/g, '-')           // collapse multiple dashes
    .replace(/^-|-$/g, '');        // trim leading/trailing dashes
}

const originalHeadingOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  // Get the text content from the inline token that follows the heading_open
  const contentToken = tokens[idx + 1];
  if (contentToken && contentToken.children) {
    const text = contentToken.children
      .filter(t => t.type === 'text' || t.type === 'code_inline')
      .map(t => t.content)
      .join('');
    const id = slugify(text);
    token.attrSet('id', id);
  }
  if (originalHeadingOpen) {
    return originalHeadingOpen(tokens, idx, options, env, self);
  }
  return self.renderToken(tokens, idx, options);
};

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const CODE_EXTENSIONS = new Set([
  '.yaml', '.yml', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.toml', '.ini', '.conf', '.env', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.swift', '.rb', '.php', '.css', '.scss', '.html', '.htm', '.xml', '.dockerfile', '.makefile', '.txt',
]);

function detectLanguage(extension, fileName) {
  const ext = extension.toLowerCase();
  const lowerName = fileName.toLowerCase();

  if (ext === '.yml' || ext === '.yaml') {
    return 'yaml';
  }

  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') {
    return 'bash';
  }

  if (ext === '.py') {
    return 'python';
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return 'javascript';
  }

  if (ext === '.ts' || ext === '.tsx') {
    return 'typescript';
  }

  if (ext === '.jsx') {
    return 'javascript';
  }

  if (ext === '.json') {
    return 'json';
  }

  if (ext === '.sql') {
    return 'sql';
  }

  if (ext === '.go') {
    return 'go';
  }

  if (ext === '.rs') {
    return 'rust';
  }

  if (ext === '.rb') {
    return 'ruby';
  }

  if (ext === '.php') {
    return 'php';
  }

  if (ext === '.css' || ext === '.scss') {
    return 'css';
  }

  if (ext === '.html' || ext === '.htm' || ext === '.xml') {
    return 'xml';
  }

  if (ext === '.toml') {
    return 'ini';
  }

  if (lowerName === 'dockerfile') {
    return 'dockerfile';
  }

  if (lowerName === 'makefile') {
    return 'makefile';
  }

  return null;
}

function renderCode(source, language) {
  try {
    if (language && hljs.getLanguage(language)) {
      let highlighted = hljs.highlight(source, { language }).value;
      // For YAML: wrap nested keys in anchor spans using dotted path IDs.
      if (language === 'yaml') {
        highlighted = addYamlAnchors(source, highlighted);
      }
      return `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`;
    }

    return `<pre><code class="hljs">${hljs.highlightAuto(source).value}</code></pre>`;
  } catch (_error) {
    return `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`;
  }
}

function parseYamlKeyLine(sourceLine) {
  const match = sourceLine.match(/^(\s*)(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([^\s][^:]*?))\s*:(?:\s|$)/);
  if (!match) {
    return null;
  }

  const [, indent, doubleQuoted, singleQuoted, plain] = match;
  const key = (doubleQuoted ?? singleQuoted ?? plain ?? '').trim();
  if (!key) {
    return null;
  }

  return {
    indent: indent.length,
    key,
  };
}

function wrapYamlAnchor(highlightedLine, id, isNested) {
  const classes = isNested ? 'yaml-anchor-wrap yaml-anchor-l2' : 'yaml-anchor-wrap';
  return highlightedLine.replace(
    /(<span class="hljs-attr">)([^<]+)(<\/span>)/,
    (match, open, key, close) => `<span id="${id}" class="${classes}">${open}${key}${close}</span>`
  );
}

function slugifyYamlPath(pathParts) {
  return slugify(pathParts.join('-'));
}

// Add anchor IDs to YAML keys using full nested path slugs, e.g. key-subkey-leaf.
function addYamlAnchors(source, highlightedHtml) {
  const sourceLines = source.split(/\r?\n/);
  const highlightedLines = highlightedHtml.split('\n');
  const stack = [];
  const usedIds = new Set();

  return highlightedLines.map((highlightedLine, index) => {
    const parsed = parseYamlKeyLine(sourceLines[index] || '');
    if (!parsed || !highlightedLine.includes('hljs-attr')) {
      return highlightedLine;
    }

    while (stack.length && parsed.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const pathParts = stack.map((entry) => entry.key);
    pathParts.push(parsed.key);
    stack.push(parsed);

    const baseId = slugifyYamlPath(pathParts);
    if (!baseId) {
      return highlightedLine;
    }

    let candidate = baseId;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);

    return wrapYamlAnchor(highlightedLine, candidate, pathParts.length > 1);
  }).join('\n');
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_MIME_BY_EXT = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};
const VIDEO_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

function splitByCodeBlocks(html) {
  return html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi);
}

function normalizeRepoAssetPath(input) {
  const cleaned = String(input || '').replace(/^~\//, '').replace(/^\/+/, '');
  if (!cleaned || cleaned.startsWith('<private-repo>') || cleaned.startsWith('&lt;private-repo&gt;')) {
    return null;
  }

  const slashIdx = cleaned.indexOf('/');
  if (slashIdx === -1) {
    return null;
  }

  const repo = cleaned.slice(0, slashIdx);
  const rel = cleaned.slice(slashIdx + 1);
  if (!repo || !rel) {
    return null;
  }

  return `/${repo}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function appendQueryToken(url, queryToken) {
  if (!queryToken) {
    return url;
  }

  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(queryToken)}${hash}`;
}

function splitHrefForResolution(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || value === '#' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
    return null;
  }

  const match = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) {
    return null;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(match[1] || '');
  } catch (_error) {
    return null;
  }

  return {
    pathname,
    query: match[2] || '',
    hash: match[3] || '',
  };
}

function isWithinRoot(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function encodeViewPath(repo, relativePath) {
  const pathPart = relativePath
    ? `/${relativePath.split('/').map(encodeURIComponent).join('/')}`
    : '';
  return `/view/${encodeURIComponent(repo)}${pathPart}`;
}

function buildRepoResolutionEntries(context = {}) {
  const mappings = {
    ...(context.repoMappings || {}),
  };
  if (context.repo && context.repoRoot && !mappings[context.repo]) {
    mappings[context.repo] = context.repoRoot;
  }

  return Object.entries(mappings)
    .filter(([repo, rootPath]) => repo && typeof rootPath === 'string' && rootPath)
    .map(([repo, rootPath]) => ({ repo, rootPath: path.resolve(rootPath) }))
    .sort((left, right) => right.rootPath.length - left.rootPath.length);
}

function redactHostPathsForBrowser(source, context = {}) {
  let output = String(source || '');
  for (const { repo, rootPath } of buildRepoResolutionEntries(context)) {
    output = output.split(rootPath).join(encodeViewPath(repo, ''));
  }

  const homePath = path.resolve(context.homePath || os.homedir());
  output = output.split(homePath).join('$HOME');
  return output.replace(
    /(^|[\s("'=])\/(?:home|Users)\/[^\s)"'<]+/gm,
    '$1[host-path]'
  );
}

function canResolveTarget(context, repo, relativePath, isDirectory = false) {
  return typeof context.canResolveLink !== 'function' || context.canResolveLink(repo, relativePath, isDirectory);
}

function resolvePortableViewHref(href, context = {}) {
  const parsed = splitHrefForResolution(href);
  if (!parsed || !parsed.pathname || !context.repo || !context.repoRoot) {
    return null;
  }
  if (parsed.pathname === '/view' || parsed.pathname.startsWith('/view/')) {
    return null;
  }

  const repoRoot = path.resolve(context.repoRoot);
  const homePath = path.resolve(context.homePath || os.homedir());
  const currentDir = context.currentDir || '';
  const sourceDir = path.join(repoRoot, currentDir);
  let absoluteTarget;

  if (parsed.pathname === '~' || parsed.pathname === '$HOME') {
    absoluteTarget = homePath;
  } else if (parsed.pathname.startsWith('~/')) {
    absoluteTarget = path.resolve(homePath, parsed.pathname.slice(2));
  } else if (parsed.pathname.startsWith('$HOME/')) {
    absoluteTarget = path.resolve(homePath, parsed.pathname.slice('$HOME/'.length));
  } else if (path.isAbsolute(parsed.pathname)) {
    absoluteTarget = path.resolve(parsed.pathname);
  } else {
    absoluteTarget = path.resolve(sourceDir, parsed.pathname);
  }

  const repoEntries = buildRepoResolutionEntries(context);
  let targetRepo = repoEntries.find((entry) => isWithinRoot(absoluteTarget, entry.rootPath));
  if (!targetRepo && /^(?:~|\$HOME)\//.test(parsed.pathname)) {
    const portableParts = parsed.pathname.replace(/^(?:~|\$HOME)\//, '').split('/');
    const explicitRepo = repoEntries.find((entry) => entry.repo === portableParts[0]);
    if (explicitRepo) {
      targetRepo = explicitRepo;
      absoluteTarget = path.resolve(explicitRepo.rootPath, portableParts.slice(1).join('/'));
    }
  }
  if (!targetRepo && path.isAbsolute(parsed.pathname)) {
    if (/^\/(?:home|Users)\//.test(parsed.pathname)) {
      return '#unresolved-portable-link';
    }
    targetRepo = { repo: context.repo, rootPath: repoRoot };
    absoluteTarget = path.resolve(repoRoot, parsed.pathname.replace(/^\/+/, ''));
  }
  if (!targetRepo || !isWithinRoot(absoluteTarget, targetRepo.rootPath)) {
    return null;
  }

  const relativePath = path.relative(targetRepo.rootPath, absoluteTarget).split(path.sep).join('/');
  const normalizedRelativePath = relativePath === '.' ? '' : relativePath;
  if (!canResolveTarget(context, targetRepo.repo, normalizedRelativePath, false)) {
    return '#unresolved-portable-link';
  }

  const viewHref = encodeViewPath(targetRepo.repo, normalizedRelativePath);
  return `${viewHref}${escapeHtml(parsed.query)}${escapeHtml(parsed.hash)}`;
}

function slugKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[^.\/]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function wikiKeysForPath(relativePath, isDirectory = false) {
  const base = path.posix.basename(String(relativePath || '').replace(/\/$/, ''));
  const ext = isDirectory ? '' : path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return [...new Set([
    base.toLowerCase(),
    stem.toLowerCase(),
    slugKey(base),
    slugKey(stem),
  ].filter(Boolean))];
}

function parseWikiTarget(value, { allowBare = false } = {}) {
  const raw = String(value || '').trim();
  const wrapped = raw.match(/^\[\[([^\[\]]+)\]\]$/);
  if (!wrapped && !allowBare) {
    return null;
  }

  const inner = wrapped ? wrapped[1] : raw;
  if (!inner || /[<>]/.test(inner)) {
    return null;
  }

  const [targetPart, aliasPart] = inner.split('|', 2);
  const hashIndex = targetPart.indexOf('#');
  const name = (hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex)).trim();
  if (!name) {
    return null;
  }

  return {
    name,
    key: slugKey(name),
    hash: hashIndex === -1 ? '' : targetPart.slice(hashIndex),
    alias: aliasPart ? aliasPart.trim() : '',
  };
}

function walkRepoForWikiIndex(repo, rootPath, context, output, maxEntries = 5000) {
  let count = 0;
  function walk(absoluteDir, relativeDir) {
    if (count >= maxEntries) {
      return;
    }

    let dirents;
    try {
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (_error) {
      return;
    }

    for (const dirent of dirents) {
      if (count >= maxEntries || dirent.name.startsWith('.')) {
        continue;
      }

      const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (canResolveTarget(context, repo, relativePath, true)) {
          output.push({ repo, relativePath: `${relativePath}/`, isDirectory: true });
        }
        count += 1;
        walk(path.join(absoluteDir, dirent.name), relativePath);
      } else if (dirent.isFile()) {
        if (canResolveTarget(context, repo, relativePath, false)) {
          output.push({ repo, relativePath, isDirectory: false });
        }
        count += 1;
      }
    }
  }

  walk(rootPath, '');
}

function buildWikiLinkIndex(context = {}) {
  const entries = [];
  for (const { repo, rootPath } of buildRepoResolutionEntries(context)) {
    walkRepoForWikiIndex(repo, rootPath, context, entries);
  }

  const byKey = new Map();
  for (const entry of entries) {
    for (const key of wikiKeysForPath(entry.relativePath, entry.isDirectory)) {
      if (!byKey.has(key)) {
        byKey.set(key, []);
      }
      byKey.get(key).push(entry);
    }
  }
  return byKey;
}

function commonPrefixLength(left, right) {
  let count = 0;
  while (count < Math.min(left.length, right.length) && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

function chooseWikiTarget(candidates, context = {}) {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const scoped = candidates.some((entry) => entry.repo === context.repo)
    ? candidates.filter((entry) => entry.repo === context.repo)
    : candidates;
  const sourceDirParts = (context.currentDir || '').split('/').filter(Boolean);
  let best = [];
  let bestScore = -1;

  for (const entry of scoped) {
    const entryDir = entry.isDirectory
      ? entry.relativePath.replace(/\/$/, '')
      : path.posix.dirname(entry.relativePath);
    const entryDirParts = (entryDir === '.' ? '' : entryDir).split('/').filter(Boolean);
    const score = commonPrefixLength(sourceDirParts, entryDirParts);
    if (score > bestScore) {
      bestScore = score;
      best = [entry];
    } else if (score === bestScore) {
      best.push(entry);
    }
  }

  return best.length === 1 ? best[0] : null;
}

function resolveWikiViewHref(value, context = {}) {
  const parsed = parseWikiTarget(value, { allowBare: Boolean(context.allowBareWikiTarget) });
  if (!parsed) {
    return null;
  }

  const index = context.wikiLinkIndex || buildWikiLinkIndex(context);
  const target = chooseWikiTarget(index.get(parsed.key), context);
  if (!target) {
    return null;
  }

  return `${encodeViewPath(target.repo, target.relativePath)}${escapeHtml(parsed.hash)}`;
}

function rewriteWikiTextLinks(html, options = {}) {
  if (!html.includes('[[')) {
    return html;
  }

  const parts = splitByCodeBlocks(html);
  const wikiLinkIndex = options.wikiLinkIndex || buildWikiLinkIndex(options);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    const tagParts = parts[i].split(/(<[^>]+>)/g);
    for (let j = 0; j < tagParts.length; j += 1) {
      if (tagParts[j].startsWith('<')) {
        continue;
      }
      tagParts[j] = tagParts[j].replace(/\[\[([^\[\]]+)\]\]/g, (match, inner) => {
        const parsed = parseWikiTarget(inner, { allowBare: true });
        const href = parsed && resolveWikiViewHref(inner, {
          ...options,
          wikiLinkIndex,
          allowBareWikiTarget: true,
        });
        if (!href) {
          return match;
        }
        return `<a href="${appendQueryToken(href, options.queryToken)}" class="cross-link">${escapeHtml(parsed.alias || parsed.name)}</a>`;
      });
    }
    parts[i] = tagParts.join('');
  }

  return parts.join('');
}

function rewriteHybridCrossLinks(html, options = {}) {
  // Split only by <pre> blocks — NOT <code>.  The cross-link regex spans
  // across inline <code> tags (markdown-it wraps backtick paths in <code>
  // before this post-processing runs), so splitting by <code> would break
  // the match.  Issue #17.
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/gi);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<pre\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /\[\[([^[\]]+)\]\]\s+\((?:`|<code>)?(~\/[^)\s`<]+(?:#[^)`\s<]+)?)(?:`|<\/code>)?(?:,\s*[^)]*)?\)/g,
      (match, wikiText, rawPath, offset) => {
        // Skip if the [[ is inside a <code> block (literal example).
        // Look back for the nearest <code> or </code> before the match.
        const before = parts[i].slice(0, offset);
        const lastCodeOpen = before.lastIndexOf('<code>');
        const lastCodeClose = before.lastIndexOf('</code>');
        if (lastCodeOpen > lastCodeClose) {
          return match; // inside a <code> span — leave as literal
        }

        const portableHref = resolvePortableViewHref(rawPath, options);
        const hashIndex = rawPath.indexOf('#');
        const pathPart = hashIndex === -1 ? rawPath : rawPath.slice(0, hashIndex);
        const mappedPath = portableHref ? null : normalizeRepoAssetPath(pathPart);
        if (!portableHref && !mappedPath) {
          return match;
        }

        const hash = hashIndex === -1 ? '' : rawPath.slice(hashIndex);
        const href = appendQueryToken(portableHref || `/view${mappedPath}${escapeHtml(hash)}`, options.queryToken);
        return `<a href="${href}" class="cross-link">${escapeHtml(wikiText.trim())}</a>`;
      }
    );
  }

  return parts.join('');
}

function rewritePortableNavigationLinks(html, options = {}) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<a\b([^>]*?)href="([^"]+)"([^>]*)>/gi,
      (match, before, href, after) => {
        const rewrittenHref = resolveWikiViewHref(href, options) || resolvePortableViewHref(href, options);
        if (!rewrittenHref) {
          return match;
        }
        return `<a${before}href="${appendQueryToken(rewrittenHref, options.queryToken)}"${after}>`;
      }
    );
  }

  return parts.join('');
}

function resolveLocalAssetHref(src, context, allowedExtensions) {
  if (!src || /^https?:\/\//i.test(src) || src.startsWith('data:')) {
    return null;
  }

  const qIndex = src.indexOf('?');
  const hIndex = src.indexOf('#');
  const splitIndex = Math.min(
    qIndex === -1 ? Number.POSITIVE_INFINITY : qIndex,
    hIndex === -1 ? Number.POSITIVE_INFINITY : hIndex
  );
  const pathPart = splitIndex === Number.POSITIVE_INFINITY ? src : src.slice(0, splitIndex);
  const suffix = splitIndex === Number.POSITIVE_INFINITY ? '' : src.slice(splitIndex);
  const ext = path.extname(pathPart).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    return null;
  }

  let rewritten = null;

  if (src.startsWith('~/')) {
    const mapped = normalizeRepoAssetPath(pathPart);
    rewritten = mapped ? `/view${mapped}` : null;
  } else if (src.startsWith('/')) {
    rewritten = `/view/${encodeURIComponent(context.repo)}${src.split('/').map(encodeURIComponent).join('/')}`;
  } else {
    const cleaned = pathPart.replace(/^\.\//, '');
    const joined = context.currentDir
      ? path.posix.join(context.currentDir, cleaned)
      : cleaned;

    let finalJoined = joined;
    if (context.repoRoot) {
      const candidate = path.join(context.repoRoot, joined);
      if (!fs.existsSync(candidate)) {
        const tailMatch = cleaned.match(/(?:\.\.\/)*(.+)/);
        if (tailMatch) {
          const tail = tailMatch[1];
          let dir = context.currentDir || '';
          for (let attempts = 0; attempts < 10 && dir; attempts++) {
            dir = path.posix.dirname(dir);
            if (dir === '.') dir = '';
            const tryPath = dir ? path.posix.join(dir, tail) : tail;
            const tryFull = path.join(context.repoRoot, tryPath);
            if (fs.existsSync(tryFull)) {
              finalJoined = tryPath;
              break;
            }
          }
        }
      }
    }

    rewritten = `/view/${encodeURIComponent(context.repo)}/${finalJoined.split('/').map(encodeURIComponent).join('/')}`;
  }

  if (!rewritten) {
    return null;
  }

  return `${rewritten}${escapeHtml(suffix)}`;
}

function resolveLocalImageHref(src, context) {
  return resolveLocalAssetHref(src, context, IMAGE_EXTENSIONS);
}

function resolveLocalAudioHref(src, context) {
  return resolveLocalAssetHref(src, context, AUDIO_EXTENSIONS);
}

function resolveLocalVideoHref(src, context) {
  return resolveLocalAssetHref(src, context, VIDEO_EXTENSIONS);
}

// Recognise absolute URLs that point back at our own /view/<repo>/<path>.<audio-ext>
// route, regardless of host. The user routinely pastes fully-qualified Tailscale
// URLs into markdown; we want those to inline-embed like relative paths do.
function resolveAbsoluteViewAudioHref(href) {
  if (!/^https?:\/\//i.test(href)) {
    return null;
  }

  let url;
  try {
    url = new URL(href);
  } catch (_error) {
    return null;
  }

  if (!url.pathname.startsWith('/view/')) {
    return null;
  }

  const ext = path.extname(url.pathname).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function resolveAbsoluteViewVideoHref(href) {
  if (!/^https?:\/\//i.test(href)) {
    return null;
  }

  let url;
  try {
    url = new URL(href);
  } catch (_error) {
    return null;
  }

  if (!url.pathname.startsWith('/view/')) {
    return null;
  }

  const ext = path.extname(url.pathname).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function rewriteAudioLinks(html, context) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
      (match, before, href, after, inner) => {
        const rewrittenViewHref =
          resolveLocalAudioHref(href, context) || resolveAbsoluteViewAudioHref(href);
        if (!rewrittenViewHref) {
          return match;
        }

        const assetHref = appendQueryToken(
          rewrittenViewHref.replace(/^\/view\//, '/asset/'),
          context.queryToken
        );
        const viewHref = appendQueryToken(rewrittenViewHref, context.queryToken);
        const pathOnly = rewrittenViewHref.split(/[?#]/)[0];
        const ext = path.extname(pathOnly).toLowerCase();
        const mime = AUDIO_MIME_BY_EXT[ext] || 'audio/mpeg';
        return `<div class="audio-embed">
  <audio controls preload="metadata" src="${assetHref}" type="${mime}">
    Your browser does not support the audio element. <a href="${viewHref}">Open file</a>
  </audio>
  <a class="audio-embed-link" href="${viewHref}">${inner}</a>
</div>`;
      }
    );
  }

  return parts.join('');
}

function rewriteVideoLinks(html, context) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
      (match, before, href, after, inner) => {
        const rewrittenViewHref =
          resolveLocalVideoHref(href, context) || resolveAbsoluteViewVideoHref(href);
        if (!rewrittenViewHref) {
          return match;
        }

        const assetHref = appendQueryToken(
          rewrittenViewHref.replace(/^\/view\//, '/asset/'),
          context.queryToken
        );
        const viewHref = appendQueryToken(rewrittenViewHref, context.queryToken);
        const pathOnly = rewrittenViewHref.split(/[?#]/)[0];
        const ext = path.extname(pathOnly).toLowerCase();
        const mime = VIDEO_MIME_BY_EXT[ext] || 'video/mp4';
        return `<div class="video-embed">
  <video controls preload="metadata" src="${assetHref}" type="${mime}">
    Your browser does not support the video element. <a href="${viewHref}">Open file</a>
  </video>
  <a class="video-embed-link" href="${viewHref}">${inner}</a>
</div>`;
      }
    );
  }

  return parts.join('');
}

function rewriteInlineVideoSources(html, context) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<video\b[\s\S]*?<\/video>/gi,
      (videoHtml) => videoHtml.replace(
        /<(video|source)\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/gi,
        (match, tagName, before, src, after) => {
          if (src.startsWith('/asset/')) {
            return match;
          }

          const rewrittenViewHref = resolveLocalVideoHref(src, context);
          if (!rewrittenViewHref) {
            return match;
          }

          const assetHref = appendQueryToken(
            rewrittenViewHref.replace(/^\/view\//, '/asset/'),
            context.queryToken
          );
          return `<${tagName}${before} src="${assetHref}"${after}>`;
        }
      )
    );
    parts[i] = parts[i].replace(
      /<video\b([^>]*?)\ssrc="([^"]+)"([^>]*)\/>/gi,
      (match, before, src, after) => {
        if (src.startsWith('/asset/')) {
          return match;
        }

        const rewrittenViewHref = resolveLocalVideoHref(src, context);
        if (!rewrittenViewHref) {
          return match;
        }

        const assetHref = appendQueryToken(
          rewrittenViewHref.replace(/^\/view\//, '/asset/'),
          context.queryToken
        );
        return `<video${before} src="${assetHref}"${after}/>`;
      }
    );
  }

  return parts.join('');
}

function rewriteImageSources(html, context) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<img\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/gi,
      (match, before, src, after) => {
        const rewrittenViewHref = resolveLocalImageHref(src, context);
        if (!rewrittenViewHref) {
          if (!src || /^https?:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('/asset/')) {
            return match;
          }
          return match;
        }

        const assetHref = appendQueryToken(
          rewrittenViewHref.replace(/^\/view\//, '/asset/'),
          context.queryToken
        );
        return `<img${before} src="${assetHref}"${after}>`;
      }
    );

    parts[i] = parts[i].replace(
      /<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
      (match, before, href, after, inner) => {
        const rewrittenHref = resolveLocalImageHref(href, context);
        if (!rewrittenHref) {
          return match;
        }

        return `<a${before}href="${appendQueryToken(rewrittenHref, context.queryToken)}"${after}>${inner}</a>`;
      }
    );
  }

  return parts.join('');
}

function addHeadingAnchorLinks(html) {
  return html.replace(
    /<(h[1-6])\b([^>]*)\sid="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/gi,
    (match, tag, before, id, after, inner) => {
      if (inner.includes('class="anchor-link"')) {
        return match;
      }

      return `<${tag}${before} id="${id}"${after}>${inner}<a class="anchor-link" href="#${escapeHtml(id)}" data-anchor-id="${escapeHtml(id)}" aria-label="Copy section link">🔗</a></${tag}>`;
    }
  );
}

function addMissingHeadingIds(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const { document } = dom.window;
  const usedIds = new Set(
    Array.from(document.querySelectorAll('[id]'))
      .map((node) => node.getAttribute('id'))
      .filter(Boolean)
  );

  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) {
      continue;
    }

    const baseId = slugify(heading.textContent || '');
    if (!baseId) {
      continue;
    }

    let candidate = baseId;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }

    heading.id = candidate;
    usedIds.add(candidate);
  }

  return document.body.innerHTML;
}

function addYamlAnchorLinks(html) {
  return html.replace(
    /<span id="([^"]+)"(?: class="([^"]*)")?>([\s\S]*?)<\/span>/g,
    (match, id, cls, inner) => {
      const classes = cls || 'yaml-anchor-wrap';
      return `<span id="${id}" class="${classes}">${inner}<a class="anchor-link yaml-anchor-link" href="#${escapeHtml(id)}" data-anchor-id="${escapeHtml(id)}" aria-label="Copy section link">🔗</a></span>`;
    }
  );
}

function buildAnnotateButton(anchorId, anchorKind) {
  return `<button type="button" class="lookie-annotate-btn" data-annotate-trigger data-anchor-id="${escapeHtml(anchorId)}" data-anchor-kind="${escapeHtml(anchorKind)}" aria-label="Annotate ${escapeHtml(anchorId)}" title="Annotate this section">💬</button>`;
}

function annotationMountMarkup(anchorId, anchorKind) {
  return `<section class="lookie-annotations-mount" data-annotations-mount data-anchor-id="${escapeHtml(anchorId)}" data-anchor-kind="${escapeHtml(anchorKind)}"></section>`;
}

function hasAnnotationMount(document, anchorId) {
  return Boolean(document.querySelector(`[data-annotations-mount][data-anchor-id="${anchorId}"]`));
}

function decorateRenderedHtmlForAnnotations(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const { document } = dom.window;
  const handledYamlPre = new WeakMap();

  for (const link of document.querySelectorAll('.anchor-link[data-anchor-id]')) {
    const anchorId = link.getAttribute('data-anchor-id');
    if (!anchorId) {
      continue;
    }

    const target = link.closest('h1, h2, h3, h4, h5, h6, .yaml-anchor-wrap');
    if (!target) {
      continue;
    }

    const anchorKind = /^H[1-6]$/.test(target.tagName) ? 'heading' : 'yamlKey';
    if (!target.querySelector('[data-annotate-trigger]')) {
      link.insertAdjacentHTML('afterend', buildAnnotateButton(anchorId, anchorKind));
    }

    if (hasAnnotationMount(document, anchorId)) {
      continue;
    }

    const mountMarkup = annotationMountMarkup(anchorId, anchorKind);
    if (target.classList.contains('yaml-anchor-wrap')) {
      const pre = target.closest('pre');
      if (!pre || !pre.parentNode) {
        continue;
      }
      const prior = handledYamlPre.get(pre) || pre;
      prior.insertAdjacentHTML('afterend', mountMarkup);
      handledYamlPre.set(pre, prior.nextElementSibling || prior);
      continue;
    }

    target.insertAdjacentHTML('afterend', mountMarkup);
  }

  for (const target of document.querySelectorAll('[data-lookie-annotation-anchor]')) {
    const declaredAnchor = (target.getAttribute('data-lookie-annotation-anchor') || '').trim();
    const anchorId = declaredAnchor || target.id || slugify(target.textContent || '');
    if (!anchorId) {
      continue;
    }

    target.id = anchorId;
    target.setAttribute('data-lookie-annotation-anchor', anchorId);
    const anchorKind = 'heading';
    const hasTargetButton = Array.from(target.querySelectorAll('[data-annotate-trigger]'))
      .some((button) => button.getAttribute('data-anchor-id') === anchorId);
    if (!hasTargetButton) {
      const heading = target.matches('h1, h2, h3, h4, h5, h6')
        ? target
        : target.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        heading.insertAdjacentHTML('beforeend', buildAnnotateButton(anchorId, anchorKind));
      } else {
        target.insertAdjacentHTML('beforeend', buildAnnotateButton(anchorId, anchorKind));
      }
    }

    if (!hasAnnotationMount(document, anchorId)) {
      target.insertAdjacentHTML('afterend', annotationMountMarkup(anchorId, anchorKind));
    }
  }

  return document.body.innerHTML;
}

function extractFrontmatter(markdownSource) {
  // Allow leading HTML comments, blank lines, or whitespace before ---
  const match = markdownSource.match(/^(?:\s*<!--[\s\S]*?-->\s*)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!match) {
    return {
      frontmatter: null,
      content: markdownSource,
    };
  }

  return {
    frontmatter: match[1],
    content: markdownSource.slice(match[0].length),
  };
}

function renderFrontmatterPanel(frontmatterSource) {
  try {
    const highlighted = hljs.highlight(frontmatterSource, { language: 'yaml' }).value;
    return `<details class="frontmatter-panel"><summary>📋 Frontmatter</summary><pre><code class="hljs language-yaml">${highlighted}</code></pre></details>`;
  } catch (_error) {
    return `<details class="frontmatter-panel"><summary>📋 Frontmatter</summary><pre><code class="hljs language-yaml">${escapeHtml(frontmatterSource)}</code></pre></details>`;
  }
}


function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe', 'video', 'source', 'track'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'controls', 'frameborder', 'height', 'kind', 'label', 'loading', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'referrerpolicy', 'sandbox', 'src', 'srclang', 'style', 'title', 'type', 'width'],
    FORBID_TAGS: ['script', 'object', 'embed', 'form'],
  });
}

function postProcessHtml(html, options) {
  const processingOptions = html.includes('[[')
    ? { ...options, wikiLinkIndex: buildWikiLinkIndex(options) }
    : options;
  let output = html;
  output = rewriteHybridCrossLinks(output, processingOptions);
  output = rewriteWikiTextLinks(output, processingOptions);
  output = rewriteAudioLinks(output, processingOptions);
  output = rewriteVideoLinks(output, processingOptions);
  output = rewritePortableNavigationLinks(output, processingOptions);
  output = rewriteImageSources(output, processingOptions);
  output = rewriteInlineVideoSources(output, processingOptions);
  output = addMissingHeadingIds(output);
  output = addHeadingAnchorLinks(output);
  output = addYamlAnchorLinks(output);
  output = sanitizeHtml(output);
  return output;
}

function extractHtmlDocumentContent(source) {
  if (!/<(?:!doctype|html|body)\b/i.test(source)) {
    return source;
  }

  try {
    const dom = new JSDOM(source);
    const bodyHtml = dom.window.document.body ? dom.window.document.body.innerHTML : '';
    return bodyHtml && bodyHtml.trim() ? bodyHtml : source;
  } catch (_error) {
    return source;
  }
}

function renderContent(filePath, source, options = {}) {
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    const { frontmatter, content } = extractFrontmatter(source);
    const frontmatterPanel = frontmatter !== null ? renderFrontmatterPanel(frontmatter) : '';
    return {
      kind: 'markdown',
      html: postProcessHtml(`${frontmatterPanel}${markdown.render(content)}`, options),
    };
  }

  if (HTML_EXTENSIONS.has(extension)) {
    return {
      kind: 'html',
      html: postProcessHtml(extractHtmlDocumentContent(source), options),
    };
  }

  if (CODE_EXTENSIONS.has(extension) || fileName.toLowerCase() === 'dockerfile' || fileName.toLowerCase() === 'makefile') {
    return {
      kind: 'code',
      html: postProcessHtml(renderCode(source, detectLanguage(extension, fileName)), options),
    };
  }

  return {
    kind: 'text',
    html: `<pre><code>${escapeHtml(source)}</code></pre>`,
  };
}

function renderPreviewHtml({
  repo,
  repoRoot,
  repoMappings = null,
  canResolveLink = null,
  relativePath,
  source,
  queryToken = null,
  homePath = null,
}) {
  const rendered = renderContent(relativePath, source, {
    repo,
    repoRoot: repoRoot || null,
    repoMappings: repoMappings || null,
    canResolveLink,
    currentDir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
    queryToken,
    homePath: homePath || null,
  });
  return rendered.html;
}

let _navLinks = [];

// Top-level destinations for the toolbar's Go menu. Registered once at app
// construction from config, the same way the theme list is, so the 18 toolbar
// call sites do not each have to thread navigation state through.
function setNavLinks(links) {
  _navLinks = Array.isArray(links) ? links.filter((link) => link && link.href && link.label) : [];
}

function getNavLinks() {
  return _navLinks;
}

let _themeList = null;

function setThemeList(themes) {
  _themeList = themes;
}

function getThemeList() {
  return _themeList || [
    { slug: 'slate', label: 'Slate' },
    { slug: 'teal', label: 'Teal' },
    { slug: 'nord', label: 'Nord' },
    { slug: 'rose-pine', label: 'Rose Pine' },
    { slug: 'monokai', label: 'Monokai' },
    { slug: 'solarized', label: 'Solarized' },
    { slug: 'github', label: 'GitHub' },
    { slug: 'ember', label: 'Ember' },
    { slug: 'noir', label: 'Noir' },
    { slug: 'indigo', label: 'Indigo' },
    { slug: 'codex', label: 'Codex' },
  ];
}

function toolbarHtml(extraButtons = '', options = {}) {
  const themes = getThemeList();
  // Every theme name is rendered; CSS reveals the one matching the root's
  // data-color-scheme, which the head script sets before the page paints. A
  // script-assigned label flashed a placeholder first -- the page rendered before
  // it knew which theme was active.
  const themeNames = themes.map((theme) =>
    `<span data-theme-name="${escapeHtml(theme.slug)}">${escapeHtml(theme.label)}</span>`
  ).join('');
  const themeItems = themes.map((theme) =>
    `<button type="button" role="menuitem" data-theme-item value="${escapeHtml(theme.slug)}">${escapeHtml(theme.label)}</button>`
  ).join('');
  const annotationChip = options.annotationsEnabled
    ? '<button type="button" class="toolbar-btn toolbar-btn-annotation-count" data-annotations-toggle aria-label="Show or hide resolved annotations" aria-pressed="false" hidden>💬 0</button>'
    : '';
  const annotationModeButton = options.annotationModeAvailable
    ? '<button type="button" class="toolbar-btn" data-annotation-mode-toggle aria-label="Show annotation targets" aria-pressed="false" title="Show annotation targets">💬 Annotate</button>'
    : '';
  const navLinks = getNavLinks();
  // Custom disclosures rather than <select>: a native select's popup is drawn by the
  // operating system, so it cannot take the toolbar's translucency and blur. These
  // match Properties and the contents menu instead.
  const navMenu = navLinks.length > 1
    ? `<details class="doc-properties toolbar-menu" name="lookie-toolbar" data-nav-menu>
      <summary class="toolbar-btn" data-nav-label aria-label="Go to section">${escapeHtml(navLinks[0].label)}</summary>
      <div class="toolbar-menu-list" role="menu">${navLinks.map((link) =>
        `<a role="menuitem" data-nav-item href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('')}</div>
    </details>`
    : '';
  return `<div class="viewer-toolbar" role="toolbar" aria-label="Viewer controls">
    ${navMenu}
    ${extraButtons}
    ${annotationModeButton}
    ${annotationChip}
    <details class="doc-properties toolbar-menu" name="lookie-toolbar" data-theme-menu>
      <summary class="toolbar-btn" data-theme-label aria-label="Select color theme">${themeNames}</summary>
      <div class="toolbar-menu-list" role="menu">${themeItems}</div>
    </details>
    <button type="button" class="toolbar-btn" data-theme-toggle aria-label="Toggle light and dark mode">☀</button>
  </div>`;
}

function nonceAttribute(cspNonce) {
  return cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : '';
}

function themeScript(cspNonce = null, defaults = {}) {
  // A page may declare its own theme (form templates do). It wins over the stored
  // preference on this page only, and never overwrites the viewer's global choice.
  const pageScheme = typeof defaults.scheme === 'string' && /^[a-z0-9-]+$/.test(defaults.scheme)
    ? defaults.scheme
    : null;
  const pageMode = defaults.mode === 'light' || defaults.mode === 'dark' ? defaults.mode : null;
  return `
  <script${nonceAttribute(cspNonce)}>
    (function () {
      var rootEl = document.documentElement;
      var themeToggleBtn = document.querySelector('[data-theme-toggle]');
      var themeMenuEl = document.querySelector('[data-theme-menu]');

      function applyColorScheme(slug) {
        rootEl.setAttribute('data-color-scheme', slug);
      }

      function applyTheme(mode) {
        if (mode === 'light') {
          rootEl.setAttribute('data-theme', 'light');
        } else {
          rootEl.removeAttribute('data-theme');
        }
        if (themeToggleBtn) {
          themeToggleBtn.textContent = mode === 'light' ? '\\u263E' : '\\u2600';
        }
      }

      var pageScheme = ${pageScheme ? JSON.stringify(pageScheme) : 'null'};
      var pageMode = ${pageMode ? JSON.stringify(pageMode) : 'null'};
      var savedScheme = pageScheme || localStorage.getItem('lookie-link-color-scheme') || 'slate';
      var savedTheme = pageMode || localStorage.getItem('lookie-link-theme') || 'dark';
      applyColorScheme(savedScheme);
      applyTheme(savedTheme);

      var toolbarEl = document.querySelector('.viewer-toolbar');
      if (toolbarEl) {
        var syncToolbarHeight = function () {
          rootEl.style.setProperty('--toolbar-height', toolbarEl.offsetHeight + 'px');
        };
        syncToolbarHeight();
        window.addEventListener('resize', syncToolbarHeight);
        if (window.ResizeObserver) new ResizeObserver(syncToolbarHeight).observe(toolbarEl);
      }

      var navMenuEl = document.querySelector('[data-nav-menu]');
      if (navMenuEl) {
        // Label the control with the section whose href is the longest prefix of the
        // current path, so /forms/gym-strength-entry/entries still reads as "Forms".
        var here = window.location.pathname;
        var navItems = navMenuEl.querySelectorAll('[data-nav-item]');
        var bestItem = null;
        for (var i = 0; i < navItems.length; i += 1) {
          var candidate = navItems[i].getAttribute('href');
          var matches = candidate === '/' ? true : (here === candidate || here.indexOf(candidate + '/') === 0);
          if (matches && (!bestItem || candidate.length > bestItem.getAttribute('href').length)) bestItem = navItems[i];
        }
        if (bestItem) {
          var navLabelEl = navMenuEl.querySelector('[data-nav-label]');
          if (navLabelEl) navLabelEl.textContent = bestItem.textContent;
          bestItem.setAttribute('aria-current', 'page');
        }
      }

      if (themeMenuEl) {
        var themeLabelEl = themeMenuEl.querySelector('[data-theme-label]');
        var themeItems = themeMenuEl.querySelectorAll('[data-theme-item]');

        function labelTheme(slug) {
          // Only the active marker needs setting; the visible label is CSS-driven
          // off :root[data-color-scheme], so it updates the moment the theme does.
          for (var i = 0; i < themeItems.length; i += 1) {
            themeItems[i].setAttribute('aria-current', themeItems[i].value === slug ? 'true' : 'false');
          }
        }

        labelTheme(rootEl.getAttribute('data-color-scheme') || 'slate');

        themeMenuEl.addEventListener('click', function (event) {
          var item = event.target.closest('[data-theme-item]');
          if (!item) return;
          applyColorScheme(item.value);
          localStorage.setItem('lookie-link-color-scheme', item.value);
          labelTheme(item.value);
          themeMenuEl.open = false;
        });
      }

      if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', function () {
          var isLight = rootEl.getAttribute('data-theme') === 'light';
          var next = isLight ? 'dark' : 'light';
          applyTheme(next);
          localStorage.setItem('lookie-link-theme', next);
        });
      }

      var annotationModeBtn = document.querySelector('[data-annotation-mode-toggle]');
      if (annotationModeBtn) {
        function setAnnotationMode(enabled) {
          rootEl.classList.toggle('lookie-annotations-active', enabled);
          annotationModeBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
          annotationModeBtn.title = enabled ? 'Hide annotation targets' : 'Show annotation targets';
          annotationModeBtn.setAttribute('aria-label', annotationModeBtn.title);
        }

        annotationModeBtn.addEventListener('click', function () {
          setAnnotationMode(!rootEl.classList.contains('lookie-annotations-active'));
        });
      }
    }());
  </script>`;
}

function baseHtml({ title, body, customThemeCss, cspNonce = null, defaultScheme = null, defaultMode = null }) {
  const headScheme = typeof defaultScheme === 'string' && /^[a-z0-9-]+$/.test(defaultScheme) ? defaultScheme : null;
  const headMode = defaultMode === 'light' || defaultMode === 'dark' ? defaultMode : null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" />
  <link rel="stylesheet" href="/public/style.css" />
  ${customThemeCss ? `<style${nonceAttribute(cspNonce)}>${customThemeCss}</style>` : ''}
  <script${nonceAttribute(cspNonce)}>
    (function () {
      var root = document.documentElement;
      var pageScheme = ${headScheme ? JSON.stringify(headScheme) : 'null'};
      var pageMode = ${headMode ? JSON.stringify(headMode) : 'null'};
      root.setAttribute('data-color-scheme', pageScheme || localStorage.getItem('lookie-link-color-scheme') || 'slate');
      if ((pageMode || localStorage.getItem('lookie-link-theme')) === 'light') root.setAttribute('data-theme', 'light');
    }());
  </script>
</head>
<body>
  ${body}
  <div class="lightbox-overlay" data-lightbox aria-hidden="true">
    <div class="lightbox-box">
      <button type="button" class="lightbox-close" aria-label="Close">&times;</button>
      <img src="" alt="" />
    </div>
  </div>
  <script${nonceAttribute(cspNonce)}>
    (function () {
      var overlay = document.querySelector('[data-lightbox]');
      var box = overlay.querySelector('.lightbox-box');
      var overlayImg = box.querySelector('img');
      var closeBtn = overlay.querySelector('.lightbox-close');
      function closeLightbox() {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
      }
      document.addEventListener('click', function (e) {
        var img = e.target.closest('.content img');
        if (!img) return;
        e.preventDefault();
        overlayImg.src = img.src;
        overlayImg.alt = img.alt || '';
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
      });
      closeBtn.addEventListener('click', closeLightbox);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeLightbox();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeLightbox();
      });
    }());
  </script>
</body>
</html>`;
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// File FACTS, as distinct from the frontmatter panel's CLAIMS. The two may disagree
// -- a document declaring "Last Updated: 2026-07-21" beside a file modified today is
// telling you something -- so this deliberately does not deduplicate against it.
// Shared shell for the toolbar Properties menu. Callers supply their own rows,
// because what counts as a "fact" differs by surface: a document has size and
// mtime, a form has a revision and a destination.
function propertiesMenu(rows) {
  if (!rows.length) return '';
  return `<details class="doc-properties toolbar-properties" name="lookie-toolbar">
      <summary class="toolbar-btn">Properties</summary>
      <dl class="doc-properties-grid">${rows
        .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
        .join('')}</dl>
    </details>`;
}

function propertiesPanel({ repo, relativePath, size, mtime, kind, queryToken }) {
  const parent = path.posix.dirname(relativePath);
  const encodeRel = (rel) => rel.split('/').map(encodeURIComponent).join('/');
  const repoHref = appendQueryToken(`/view/${encodeURIComponent(repo)}`, queryToken);
  const dirHref = parent === '.'
    ? repoHref
    : appendQueryToken(`/view/${encodeURIComponent(repo)}/${encodeRel(parent)}`, queryToken);
  const rows = [
    ['File', escapeHtml(path.basename(relativePath))],
    ['Size', escapeHtml(String(size))],
    ['Modified', escapeHtml(String(mtime))],
    ['Type', escapeHtml(String(kind))],
    ['Repo', `<a href="${escapeHtml(repoHref)}">${escapeHtml(repo)}</a>`],
    ['Folder', `<a href="${escapeHtml(dirHref)}">${escapeHtml(parent === '.' ? '/' : parent)}</a>`],
  ];
  return propertiesMenu(rows);
}

function documentHeader(options) {
  return `<header class="topbar">
      ${breadcrumbs(options.repo, options.relativePath, options.queryToken)}
      ${options.extra || ''}
    </header>`;
}

function breadcrumbs(repo, relativePath, queryToken) {
  const segments = relativePath ? relativePath.split('/') : [];
  const items = [
    `<a href="${appendQueryToken('/', queryToken)}">home</a>`,
    `<a href="${appendQueryToken(`/view/${encodeURIComponent(repo)}`, queryToken)}">${escapeHtml(repo)}</a>`,
  ];

  segments.forEach((segment, idx) => {
    const rel = segments.slice(0, idx + 1).join('/');
    const href = appendQueryToken(
      `/view/${encodeURIComponent(repo)}/${rel.split('/').map(encodeURIComponent).join('/')}`,
      queryToken
    );
    const isLast = idx === segments.length - 1;
    // The last segment is the document's name. It carries the heading role here so
    // the filename is not printed a second time on its own line -- it is already in
    // the path. Styled large and bold, it reads as the title while staying in place.
    items.push(isLast
      ? `<h1 class="crumb-title"><a href="${href}" aria-current="page">${escapeHtml(segment)}</a></h1>`
      : `<a href="${href}">${escapeHtml(segment)}</a>`);
  });

  return `<nav class="breadcrumbs">${items.join('<span class="sep">/</span>')}</nav>`;
}

function renderDirectoryPage({ title, repo, currentPath, parentHref, entries, notice, customThemeCss, queryToken = null }) {
  const rows = entries.map((entry) => {
    const icon = entry.isDirectory ? 'dir' : 'file';
    return `<tr>
      <td class="name"><a href="${entry.href}"><span class="tag">${icon}</span>${escapeHtml(entry.name)}</a></td>
      <td class="meta">${escapeHtml(entry.size)}</td>
      <td class="meta">${escapeHtml(entry.mtime)}</td>
    </tr>`;
  }).join('');

  const body = `${toolbarHtml()}
  <main class="layout">
    <header class="topbar">
      <h1>Lookie Link</h1>
      <p class="subtitle">${repo ? escapeHtml(`${repo}/${currentPath}`) : 'repository index'}</p>
      ${repo ? breadcrumbs(repo, currentPath, queryToken) : ''}
      ${parentHref ? `<p><a class="back" href="${parentHref}">Back</a></p>` : ''}
    </header>

    ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  </main>
  ${themeScript()}`;

  return baseHtml({ title, body, customThemeCss });
}

// Render mode is DECLARED by the authored page, never guessed. 'viewport' opts the
// doc into a real scrolling frame (native position:sticky/fixed, :target, viewport
// lightbox); absence of the hint keeps today's content-height seamless reader.
// Detection must read the REAL root element, not any text occurrence — a doc that
// merely mentions the hint (a code sample, an HTML comment, prose documenting this
// feature) MUST NOT be silently flipped into viewport hosting. So: a fast-reject
// regex skips the parse for the overwhelming majority of docs that never mention
// it, and only a doc that could plausibly declare it is parsed, where a commented
// or quoted `<html …>`/`<meta>` is not a real node. Accepts
// `<html data-lookie-render="viewport">` and `<meta name="lookie-render"
// content="viewport">`; the value must be exactly `viewport` (not `viewport-x`).
function detectRenderMode(source) {
  const text = String(source || '');
  if (!/lookie-render/i.test(text)) return 'default';
  try {
    const { document } = new JSDOM(text).window;
    const root = document.documentElement;
    if (root && (root.getAttribute('data-lookie-render') || '').trim().toLowerCase() === 'viewport') {
      return 'viewport';
    }
    const meta = document.querySelector('meta[name="lookie-render"]');
    if (meta && (meta.getAttribute('content') || '').trim().toLowerCase() === 'viewport') {
      return 'viewport';
    }
  } catch (_error) {
    // Unparseable source falls back to the safe default (content-height reader).
  }
  return 'default';
}

function embeddedHtmlSyncScript(embedHtmlHref, renderMode = 'default') {
  if (!embedHtmlHref) {
    return '';
  }
  const isViewport = renderMode === 'viewport';

  const safeEmbedHref = JSON.stringify(embedHtmlHref).replace(/</g, '\\u003c');
  return `<script>
    (function () {
      var frame = document.querySelector('[data-embedded-html]');
      if (!frame) return;

      // Outer-chrome TOC for the embedded HTML. Headings live inside a sandboxed
      // (no allow-same-origin) iframe, so the embed runtime enumerates them and
      // posts a 'lookie-link:toc' message; this side renders the panel and drives
      // scroll via 'lookie-link:scroll-to-id' (embed replies with scroll-to).
      var tocListEl = document.querySelector('[data-toc-list]');
      var tocMenuEl = document.querySelector('[data-toc-menu]');
      var tocEnabled = Boolean(tocListEl);
      var tocItemOffsets = [];
      var tocCachedIds = '';

      function setEmbeddedTocActive(id) {
        if (!tocListEl) return;
        var prior = tocListEl.querySelector('.toc-item.is-active');
        if (prior && prior.getAttribute('data-toc-id') === id) return;
        if (prior) {
          prior.classList.remove('is-active');
          prior.removeAttribute('aria-current');
        }
        var items = tocListEl.querySelectorAll('.toc-item');
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].getAttribute('data-toc-id') === id) {
            items[i].classList.add('is-active');
            items[i].setAttribute('aria-current', 'true');
            break;
          }
        }
      }

      function updateEmbeddedTocActive() {${isViewport ? '\n        // Viewport mode: the parent cannot observe the frame\'s internal scroll, so\n        // active is driven by the embed\'s own `lookie-link:toc-active` message.\n        return;' : ''}
        if (!tocListEl || !tocItemOffsets.length) return;
        // A heading's document-space position is the frame's top plus the
        // embed-reported in-frame offset; active = the last one at/above the
        // reading line (matches the markdown builder's scrollY + 140 threshold).
        var frameTop = frame.getBoundingClientRect().top + window.pageYOffset;
        var threshold = window.scrollY + 140;
        var activeId = tocItemOffsets[0].id;
        for (var i = 0; i < tocItemOffsets.length; i += 1) {
          if (frameTop + tocItemOffsets[i].y <= threshold) {
            activeId = tocItemOffsets[i].id;
          } else {
            break;
          }
        }
        setEmbeddedTocActive(activeId);
      }

      function buildEmbeddedToc(items) {
        if (!tocListEl || !Array.isArray(items)) return;
        var clean = [];
        for (var i = 0; i < items.length; i += 1) {
          if (clean.length >= 500) break; // bound work: a large/forged embed cannot freeze the tab
          var raw = items[i];
          // Be permissive on the id charset (authored ids can carry more than a
          // slug), but the id only ever reaches the DOM through setAttribute and
          // postMessage, and the label only through textContent — never innerHTML.
          if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
          var level = 2;
          if (typeof raw.level === 'string' && raw.level.charAt(0).toUpperCase() === 'H') {
            var lv = Number(raw.level.slice(1));
            if (lv >= 1 && lv <= 4) level = lv;
          }
          var y = Number(raw.y);
          if (!isFinite(y) || y < 0) y = 0;
          clean.push({
            id: raw.id,
            text: typeof raw.text === 'string' ? raw.text : '',
            level: level,
            y: y
          });
        }
        // Offsets are refreshed on every post (they shift when the frame reflows).
        tocItemOffsets = clean.map(function (item) { return { id: item.id, y: item.y }; });
        var idKey = JSON.stringify(clean.map(function (item) { return item.id; }));
        if (idKey === tocCachedIds) {
          updateEmbeddedTocActive();
          return;
        }
        tocCachedIds = idKey;
        while (tocListEl.firstChild) tocListEl.removeChild(tocListEl.firstChild);
        clean.forEach(function (item) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'toc-item toc-level-' + item.level;
          btn.setAttribute('data-toc-id', item.id);
          btn.textContent = item.text;
          tocListEl.appendChild(btn);
        });
        updateEmbeddedTocActive();
      }

      if (tocEnabled) {
        tocListEl.addEventListener('click', function (event) {
          var item = event.target && event.target.closest ? event.target.closest('.toc-item') : null;
          if (!item) return;
          var id = item.getAttribute('data-toc-id');
          if (!id) return;
          setEmbeddedTocActive(id);
          if (tocMenuEl) tocMenuEl.open = false;
          if (frame.contentWindow) {
            frame.contentWindow.postMessage({ type: 'lookie-link:scroll-to-id', id: id }, '*');
          }
        });
        var tocScrollTick = false;
        window.addEventListener('scroll', function () {
          if (tocScrollTick) return;
          tocScrollTick = true;
          window.requestAnimationFrame(function () { tocScrollTick = false; updateEmbeddedTocActive(); });
        }, { passive: true });
        window.addEventListener('resize', updateEmbeddedTocActive);
        if (tocMenuEl) {
          tocMenuEl.addEventListener('toggle', function () {
            if (!tocMenuEl.open) return;
            updateEmbeddedTocActive();
            var active = tocListEl.querySelector('.toc-item.is-active');
            if (active) active.scrollIntoView({ block: 'nearest' });
          });
        }
      }

      function themeState() {
        return {
          mode: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
          scheme: document.documentElement.getAttribute('data-color-scheme') || 'slate'
        };
      }

      function frameUrl() {
        var url = new URL(${safeEmbedHref}, window.location.origin);
        var state = themeState();
        url.searchParams.set('lookie-theme', state.mode);
        url.searchParams.set('lookie-scheme', state.scheme);
        if (window.location.hash) url.hash = window.location.hash;
        return url.toString();
      }

      function postTheme() {
        if (!frame.contentWindow) return;
        var state = themeState();
        // The embed frame is sandboxed WITHOUT allow-same-origin, so its origin is
        // opaque and a concrete targetOrigin can never match. '*' is safe here: the
        // payload is only a theme mode/scheme pair, nothing sensitive.
        frame.contentWindow.postMessage({
          type: 'lookie-link:set-theme',
          mode: state.mode,
          scheme: state.scheme
        }, '*');
      }

      // The sandboxed embed cannot be measured from here (contentDocument is
      // inaccessible without allow-same-origin), so the embed runtime reports its
      // own height. Only trust messages from our frame, and clamp to sane bounds.
      window.addEventListener('message', function (event) {
        if (event.source !== frame.contentWindow || !event.data) return;
${isViewport ? `        // Viewport mode: the frame owns its height (100% of the flex cell) and
        // scrolls internally, so the parent neither sizes it from content-height nor
        // translates anchor offsets. Active TOC state instead arrives from the embed,
        // which watches its OWN scroll and posts the current heading id.
        if (event.data.type === 'lookie-link:toc-active' && tocEnabled) {
          var activeTocId = event.data.id;
          if (typeof activeTocId === 'string' && activeTocId) setEmbeddedTocActive(activeTocId);
        }` : `        if (event.data.type === 'lookie-link:content-height') {
          var height = Number(event.data.height);
          if (!isFinite(height) || height <= 0) return;
          frame.style.height = Math.min(Math.max(480, Math.ceil(height)), 500000) + 'px';
        }
        if (event.data.type === 'lookie-link:scroll-to') {
          // A content-height frame cannot scroll to its own anchors — translate the
          // embed-reported document offset into a top-window scroll.
          var y = Number(event.data.y);
          if (!isFinite(y) || y < 0) return;
          var top = frame.getBoundingClientRect().top + window.pageYOffset + Math.min(y, 500000);
          window.scrollTo(0, Math.max(0, top - 12));
        }`}
        if (event.data.type === 'lookie-link:set-hash') {
          // Escape-to-close from the embed: same-document fragment navigation only.
          var hash = event.data.hash;
          if (typeof hash === 'string' && /^#[A-Za-z0-9_-]*$/.test(hash)) {
            window.location.hash = hash;
          }
        }
        // Headings enumerated inside the embed (the parent cannot read them across
        // the opaque-origin sandbox). event.source is already gated above.
        if (event.data.type === 'lookie-link:toc' && tocEnabled) {
          buildEmbeddedToc(event.data.items);
        }
        // Image zoom from the embed drives THIS page's own lightbox overlay — the
        // exact surface markdown files use, so behavior (viewport-centered, click
        // or Escape or × to close) is identical.
        var overlay = document.querySelector('[data-lightbox]');
        if (event.data.type === 'lookie-link:open-image' && overlay) {
          // NOTE: this block lives in a JS template literal — escaped slashes in a
          // regex would collapse (\\/ -> /), so validate with string prefixes.
          // Root-relative means '/', with neither '/' nor '\\' as the second char:
          // browsers treat both //host and /\\host as protocol-relative URLs.
          var src = String(event.data.src || '');
          var second = src.charAt(1);
          var srcOk = src.indexOf('https://') === 0 || src.indexOf('http://') === 0
            || (src.charAt(0) === '/' && second !== '/' && second !== String.fromCharCode(92));
          if (!srcOk) return;
          var overlayImg = overlay.querySelector('img');
          overlayImg.src = src;
          overlayImg.alt = String(event.data.alt || '');
          overlay.classList.add('is-open');
          overlay.setAttribute('aria-hidden', 'false');
        }
        if (event.data.type === 'lookie-link:close-image' && overlay) {
          overlay.classList.remove('is-open');
          overlay.setAttribute('aria-hidden', 'true');
        }
      });

      function resizeFrame() {
        // Legacy direct measurement — only works if the frame is ever same-origin
        // again; kept as a harmless fallback behind the postMessage protocol above.
        try {
          var doc = frame.contentDocument;
          if (!doc || !doc.documentElement) return;
          var body = doc.body;
          frame.style.height = Math.max(
            480,
            doc.documentElement.scrollHeight || 0,
            body ? body.scrollHeight : 0
          ) + 'px';
        } catch (_error) {}
      }

      frame.addEventListener('load', function () {
        postTheme();
        resizeFrame();
        window.setTimeout(resizeFrame, 100);
        window.setTimeout(resizeFrame, 500);
      });
      // Single themed navigation, registered after the load handler (#139): the
      // iframe carries no static src, so the themed URL is the only load ever
      // issued and a warm cache cannot resurrect an unthemed first paint.
      frame.src = frameUrl();
      new MutationObserver(postTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-color-scheme']
      });
      window.addEventListener('hashchange', function () { frame.src = frameUrl(); });
      window.addEventListener('resize', resizeFrame);
    }());
  </script>`;
}

function renderDocumentPage({ repo, repoRoot, repoMappings = null, canResolveLink = null, relativePath, source, parentHref, mtime, size, editHref = null, rawHtmlHref = null, embedHtmlHref = null, customThemeCss, queryToken = null, annotationsEnabled = false, homePath = null }) {

  const extension = effectiveViewExtension(relativePath);
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isHtmlDocument = HTML_EXTENSIONS.has(extension);
  const isYaml = ['.yaml', '.yml'].includes(extension);
  const usesEmbeddedHtml = Boolean(isHtmlDocument && embedHtmlHref);
  const pageAnnotationsEnabled = Boolean(annotationsEnabled && !usesEmbeddedHtml);
  const hasToc = isMarkdown || isHtmlDocument || isYaml;
  const supportsRawToggle = isMarkdown || isHtmlDocument || isYaml;
  const rendered = renderContent(relativePath, source, {
    repo,
    repoRoot: repoRoot || null,
    repoMappings: repoMappings || null,
    canResolveLink,
    currentDir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
    queryToken,
    homePath: homePath || null,
  });
  if (annotationsEnabled) {
    rendered.html = decorateRenderedHtmlForAnnotations(rendered.html);
  }
  const heading = `${repo}/${relativePath}`;
  const rawSourceJson = supportsRawToggle ? jsonForInlineScript(redactHostPathsForBrowser(source, {
    repo,
    repoRoot: repoRoot || null,
    repoMappings: repoMappings || null,
    homePath: homePath || null,
  })) : null;
  const rawLanguage = isMarkdown ? 'markdown' : isHtmlDocument ? 'xml' : isYaml ? 'yaml' : null;
  const supportsLineRangeAnnotations = rendered.kind === 'code' || rendered.kind === 'text';

  if (usesEmbeddedHtml) {
    // Declared render mode. 'viewport' hosts the doc in a viewport-height frame that
    // scrolls internally, so the author's own position:sticky/fixed/:target/lightbox
    // work natively. No hint → the default content-height seamless reader, byte-for-
    // byte unchanged (nothing below this comment fires unless embedIsViewport).
    const embedRenderMode = detectRenderMode(source);
    const embedIsViewport = embedRenderMode === 'viewport';
    // Only in viewport mode: turn the layout into a full-viewport flex column so the
    // toolbar/header sit at the top and the iframe fills the rest, scrolling itself.
    // The outer page must NOT scroll (that is the seamless reader's job); here the
    // frame's own document owns the scrollbar. 100dvh first (mobile URL-bar safe)
    // with a 100vh fallback for engines without dvh.
    const viewportModeStyle = embedIsViewport ? `<style id="lookie-link-viewport-mode">
    body:has(main.layout[data-render-mode="viewport"]) { overflow: hidden; margin: 0; }
    main.layout[data-render-mode="viewport"] {
      max-width: none;
      margin: 0;
      padding: 0;
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    main.layout[data-render-mode="viewport"] > .topbar {
      flex: 0 0 auto;
      margin: 0;
      padding: calc(var(--toolbar-height, 3.1rem) + 0.5rem) 1rem 0.4rem;
    }
    main.layout[data-render-mode="viewport"] > .html-embed-view {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
    }
    main.layout[data-render-mode="viewport"] .embedded-html-frame {
      flex: 1 1 auto;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
  </style>` : '';
    const contentHtml = `<article class="content html-embed-view">
      <iframe
        class="embedded-html-frame"
        title="${escapeHtml(relativePath)}"
        data-embedded-html
        sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
      ></iframe>
      <!-- No static src: the sync script performs a SINGLE themed navigation after
           registering its load handler. An eager unthemed src raced the themed one
           and could win from a warm cache (#139). -->
    </article>`;
    const extraButtons = [
      // The embed is a content-height iframe (outer frame scrolls, the document
      // never does), so an authored in-document sticky nav cannot pin — this
      // outer-chrome TOC is the only nav that stays put. It is populated from the
      // embed runtime's `lookie-link:toc` postMessage (the sandbox has no
      // allow-same-origin, so the parent cannot read the iframe's headings).
      '<details class="doc-properties toolbar-toc" name="lookie-toolbar" data-toc-menu><summary class="toolbar-btn" data-toc-toggle aria-label="Table of contents">☰</summary><nav class="toc-list" data-toc-list aria-label="Table of contents"></nav></details>',
      `<a class="toolbar-btn" href="${escapeHtml(embedHtmlHref)}" target="_blank" rel="noopener" aria-label="Open embedded HTML in new tab">Open embedded</a>`,
      rawHtmlHref ? `<a class="toolbar-btn" href="${escapeHtml(rawHtmlHref)}" target="_blank" rel="noopener" aria-label="Open byte-preserving raw HTML in new tab">Open raw</a>` : '',
      editHref ? `<a class="toolbar-btn" href="${escapeHtml(editHref)}" aria-label="Edit file">Edit</a>` : '',
    ].filter(Boolean).join('\n    ');
    const body = `${toolbarHtml(extraButtons)}${viewportModeStyle}
  <main class="layout"${embedIsViewport ? ' data-render-mode="viewport"' : ''}>
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: 'embedded html',
    })}

    ${contentHtml}
  </main>`;

    return baseHtml({
      title: heading,
      customThemeCss,
      body: `${body}
  ${themeScript()}
  ${embeddedHtmlSyncScript(embedHtmlHref, embedRenderMode)}`,
    });
  }

  const renderedClass = isMarkdown ? 'markdown' : rendered.kind;
  const contentHtml = `<article class="content ${renderedClass}" data-rendered-view${isYaml ? ' hidden aria-hidden="true"' : ''}>
      ${rendered.html}
    </article>
    ${supportsRawToggle ? `<article class="content raw" data-raw-view${isYaml ? '' : ' hidden aria-hidden="true"'}>
      <pre><code class="hljs language-${escapeHtml(rawLanguage)}" data-raw-code></code></pre>
    </article>` : ''}`;

  const extraButtons = [
    hasToc ? '<details class="doc-properties toolbar-toc" name="lookie-toolbar" data-toc-menu><summary class="toolbar-btn" data-toc-toggle aria-label="Table of contents">☰</summary><nav class="toc-list" data-toc-list aria-label="Table of contents"></nav></details>' : '',
    supportsRawToggle ? `<button type="button" class="toolbar-btn" data-raw-toggle aria-label="Toggle raw and rendered views" data-pretty-label="${isYaml ? 'Pretty' : 'Rendered'}">${isYaml ? 'Pretty' : 'Raw'}</button>` : '',
    rawHtmlHref ? `<a class="toolbar-btn" href="${escapeHtml(rawHtmlHref)}" target="_blank" rel="noopener" aria-label="Open raw HTML in new tab">Open raw</a>` : '',
    editHref ? `<a class="toolbar-btn" href="${escapeHtml(editHref)}" aria-label="Edit file">Edit</a>` : '',
  ].filter(Boolean).join('\n    ');

  const propertiesControl = propertiesPanel({
    repo, relativePath, queryToken, size, mtime, kind: rendered.kind,
  });
  const body = `${toolbarHtml([propertiesControl, extraButtons].filter(Boolean).join('\n    '), {
    annotationsEnabled,
    annotationModeAvailable: annotationsEnabled,
  })}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime,
      kind: rendered.kind,
    })}

    ${contentHtml}
    ${annotationsEnabled ? '<section class="lookie-line-range-root" data-annotations-line-range-root hidden></section>' : ''}
    ${annotationsEnabled ? '<aside class="lookie-annotations-stale" data-annotations-stale hidden></aside>' : ''}
  </main>`;

  const annotationsBootstrap = pageAnnotationsEnabled
    ? `<script id="lookie-link-annotations-bootstrap" type="application/json">${jsonForInlineScript({
        repo,
        relativePath,
        queryToken,
        supportsLineRangeAnnotations,
        sourceLineCount: source.split(/\r?\n/).length,
      })}</script>
  <script>
    (function () {
      try {
        var node = document.getElementById('lookie-link-annotations-bootstrap');
        if (node) {
          window.__lookieLinkAnnotations = JSON.parse(node.textContent || '{}');
        }
      } catch (_error) {
        window.__lookieLinkAnnotations = null;
      }
    })();
  </script>
  <script src="/public/annotations.js" defer></script>`
    : '';

  return baseHtml({
    title: heading,
    customThemeCss,
    body: `${body}
  ${themeScript()}
  ${annotationsBootstrap}
  ${supportsRawToggle ? `<script id="raw-document-source" type="application/json">${rawSourceJson}</script>` : ''}
  <script>
    (function () {
      var rawToggleBtn = document.querySelector('[data-raw-toggle]');
      var renderedView = document.querySelector('[data-rendered-view]');
      var rawView = document.querySelector('[data-raw-view]');
      var tocToggleBtn = document.querySelector('[data-toc-toggle]');
      var tocView = document.querySelector('[data-toc-menu]');
      var tocList = document.querySelector('[data-toc-list]');
      var currentBaseView = rawView && !rawView.hidden ? 'raw' : 'rendered';

      if (rawView) {
        var rawSourceScript = document.getElementById('raw-document-source');
        var rawCode = rawView.querySelector('[data-raw-code]');
        if (rawSourceScript && rawCode) {
          try {
            rawCode.textContent = JSON.parse(rawSourceScript.textContent || '""');
            if (window.hljs && window.hljs.highlightElement) {
              window.hljs.highlightElement(rawCode);
            }
          } catch (_error) {
            rawCode.textContent = '';
          }
        }
      }

      function setViewVisibility(view, visible) {
        if (!view) {
          return;
        }
        view.hidden = !visible;
        view.setAttribute('aria-hidden', visible ? 'false' : 'true');
      }

      function updateRawToggleLabel() {
        if (!rawToggleBtn || !rawView) {
          return;
        }
        var prettyLabel = (rawToggleBtn && rawToggleBtn.dataset && rawToggleBtn.dataset.prettyLabel) || 'Rendered';
        rawToggleBtn.textContent = currentBaseView === 'raw' ? prettyLabel : 'Raw';
      }

      function applyBaseView() {
        setViewVisibility(renderedView, currentBaseView === 'rendered');
        if (rawView) {
          setViewVisibility(rawView, currentBaseView === 'raw');
        }
      }

      function scrollActiveItemIntoView() {
        if (!tocList) {
          return;
        }
        var activeItem = tocList.querySelector('.toc-item.is-active');
        if (activeItem) {
          activeItem.scrollIntoView({ block: 'nearest' });
        }
      }

      function closeTocMenu() {
        if (tocView) {
          tocView.open = false;
        }
      }

      function showDocumentView(targetView) {
        if (targetView === 'raw' && rawView) {
          currentBaseView = 'raw';
        } else {
          currentBaseView = 'rendered';
        }
        applyBaseView();
        closeTocMenu();
        updateRawToggleLabel();
      }

      if (rawToggleBtn && renderedView && rawView) {
        rawToggleBtn.addEventListener('click', function () {
          currentBaseView = currentBaseView === 'raw' ? 'rendered' : 'raw';
          updateRawToggleLabel();

          applyBaseView();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }

      // Scroll to anchor on page load (handles cross-link navigation)
      if (window.location.hash) {
        var hash = decodeURIComponent(window.location.hash.slice(1));
        var el = document.getElementById(hash);
        // Fuzzy fallback: normalize case and unicode dashes
        if (!el) {
          var normalized = hash.toLowerCase().replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
          el = document.getElementById(normalized);
        }
        if (el) {
          setTimeout(function () { el.scrollIntoView({ behavior: 'smooth' }); }, 100);
        }
      }

      updateRawToggleLabel();

      const root = renderedView || document.querySelector('.content');
      if (!root) return;

      var tocContainer = renderedView || document.querySelector('article.content');
      if (tocToggleBtn && tocView && tocList && tocContainer) {
        // For markdown: headings. For YAML: anchored spans for key paths.
        var tocHeadings = Array.prototype.slice.call(
          tocContainer.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')
        );
        if (tocHeadings.length === 0) {
          // YAML files use <span id="key.path" class="yaml-anchor-wrap ..."> inside <pre>
          tocHeadings = Array.prototype.slice.call(
            tocContainer.querySelectorAll('span.yaml-anchor-wrap[id]')
          );
        }

        if (tocHeadings.length >= 3) {
          var activeHeadingId = '';
          var observerEntries = new Map();

          function getHeadingLabel(heading) {
            var clone = heading.cloneNode(true);
            var anchors = clone.querySelectorAll('.anchor-link');
            Array.prototype.forEach.call(anchors, function (anchor) {
              anchor.remove();
            });
            return (clone.textContent || '').trim();
          }

          function setActiveHeading(id) {
            if (!id || id === activeHeadingId) {
              return;
            }

            activeHeadingId = id;

            var prior = tocList.querySelector('.toc-item.is-active');
            if (prior) {
              prior.classList.remove('is-active');
              prior.removeAttribute('aria-current');
            }

            var items = tocList.querySelectorAll('.toc-item');
            for (var i = 0; i < items.length; i += 1) {
              if (items[i].getAttribute('data-toc-id') === id) {
                items[i].classList.add('is-active');
                items[i].setAttribute('aria-current', 'true');
                break;
              }
            }
          }

          function getDocumentTop(el) {
            var top = 0;
            while (el) {
              top += el.offsetTop;
              el = el.offsetParent;
            }
            return top;
          }

          function deriveActiveFromScroll() {
            // Don't recalculate when document is hidden (offsets are 0)
            if (tocView && !tocView.hidden) {
              return;
            }
            var scrollProbe = window.scrollY + 140;
            var candidate = tocHeadings[0];

            for (var i = 0; i < tocHeadings.length; i += 1) {
              if (getDocumentTop(tocHeadings[i]) <= scrollProbe) {
                candidate = tocHeadings[i];
              } else {
                break;
              }
            }

            setActiveHeading(candidate.id);
          }

          tocHeadings.forEach(function (heading) {
            var item = document.createElement('button');
            var level;
            if (heading.tagName.match(/^H[1-4]$/i)) {
              level = Number(heading.tagName.slice(1));
            } else {
              var yamlDepth = 1;
              Array.prototype.forEach.call(heading.classList, function (className) {
                var match = className.match(/^yaml-anchor-l(\d+)$/);
                if (match) {
                  yamlDepth = Number(match[1]);
                }
              });
              level = Math.min(yamlDepth + 1, 4);
            }
            item.type = 'button';
            item.className = 'toc-item toc-level-' + level;
            item.setAttribute('data-toc-id', heading.id);
            item.textContent = getHeadingLabel(heading);
            tocList.appendChild(item);
          });

          tocList.addEventListener('click', function (event) {
            var item = event.target.closest('.toc-item');
            if (!item) {
              return;
            }

            var id = item.getAttribute('data-toc-id');
            if (!id) {
              return;
            }

            var targetHeading = document.getElementById(id);
            if (!targetHeading) {
              return;
            }

            setActiveHeading(id);
            showDocumentView('rendered');
            closeTocMenu();
            setTimeout(function () {
              targetHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 0);
          });

          tocView.addEventListener('toggle', function () {
            if (tocView.open) {
              deriveActiveFromScroll();
              scrollActiveItemIntoView();
            }
          });

          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && tocView && tocView.open) {
              closeTocMenu();
            }
          });

          if (window.location.hash) {
            var hashId = decodeURIComponent(window.location.hash.slice(1));
            var hashHeading = document.getElementById(hashId);
            if (hashHeading) {
              setActiveHeading(hashHeading.id);
            }
          }

          deriveActiveFromScroll();

          var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) {
                observerEntries.set(entry.target.id, entry.boundingClientRect.top);
              } else {
                observerEntries.delete(entry.target.id);
              }
            });

            if (observerEntries.size > 0) {
              var nearestId = '';
              var nearestTop = Number.POSITIVE_INFINITY;
              observerEntries.forEach(function (top, id) {
                var score = Math.abs(top);
                if (score < nearestTop) {
                  nearestTop = score;
                  nearestId = id;
                }
              });
              if (nearestId) {
                setActiveHeading(nearestId);
              }
            } else {
              deriveActiveFromScroll();
            }
          }, {
            root: null,
            rootMargin: '-22% 0px -62% 0px',
            threshold: [0, 1],
          });

          tocHeadings.forEach(function (heading) {
            observer.observe(heading);
          });

          window.addEventListener('scroll', deriveActiveFromScroll, { passive: true });
          window.addEventListener('resize', deriveActiveFromScroll);
        } else {
          tocToggleBtn.hidden = true;
          tocView.hidden = true;
          tocView.setAttribute('aria-hidden', 'true');
        }
      }

      root.addEventListener('click', async function (event) {
        const link = event.target.closest('.anchor-link');
        if (!link) return;

        event.preventDefault();
        const anchorId = link.getAttribute('data-anchor-id');
        if (!anchorId) return;

        const fullUrl = window.location.origin + window.location.pathname + '#' + anchorId;
        function showCopied() {
          var original = link.textContent;
          link.textContent = '✓';
          setTimeout(function () { link.textContent = original || '🔗'; }, 1400);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(fullUrl).then(showCopied).catch(fallback);
        } else {
          fallback();
        }

        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = fullUrl;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); showCopied(); }
          catch (_e) { window.location.hash = anchorId; }
          document.body.removeChild(ta);
        }
      });
    }());
  </script>`,
  });
}

function renderImagePage({ repo, relativePath, parentHref, imageHref, mtime, size, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: 'image' });
  const body = `${toolbarHtml(propertiesControl)}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: 'image',
    })}

    <article class="content image-view">
      <img src="${escapeHtml(imageHref)}" alt="${escapeHtml(relativePath)}" />
    </article>
  </main>
  ${themeScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function renderAudioPage({ repo, relativePath, parentHref, audioHref, mimeType, mtime, size, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  const safeMime = mimeType || 'audio/mpeg';
  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: 'audio' });
  const body = `${toolbarHtml(propertiesControl)}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: 'audio',
    })}

    <article class="content audio-view">
      <audio controls preload="metadata" src="${escapeHtml(audioHref)}" type="${escapeHtml(safeMime)}">
        Your browser does not support the audio element.
        <a href="${escapeHtml(audioHref)}">Download file</a>
      </audio>
      <p class="audio-download"><a href="${escapeHtml(audioHref)}" download>Download</a></p>
    </article>
  </main>
  ${themeScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function renderVideoPage({ repo, relativePath, parentHref, videoHref, mimeType, mtime, size, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  const safeMime = mimeType || 'video/mp4';
  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: 'video' });
  const body = `${toolbarHtml(propertiesControl)}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: 'video',
    })}

    <article class="content video-view">
      <video controls preload="metadata" src="${escapeHtml(videoHref)}" type="${escapeHtml(safeMime)}">
        Your browser does not support the video element.
        <a href="${escapeHtml(videoHref)}">Download file</a>
      </video>
      <p class="video-download"><a href="${escapeHtml(videoHref)}" download>Download</a></p>
    </article>
  </main>
  ${themeScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function renderPdfPage({ repo, relativePath, parentHref, pdfHref, mtime, size, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: 'pdf' });
  const body = `${toolbarHtml(propertiesControl)}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: 'pdf',
    })}

    <article class="content pdf-view">
      <iframe
        class="pdf-frame"
        src="${escapeHtml(pdfHref)}#view=FitH"
        title="${escapeHtml(relativePath)}"
      ></iframe>
      <p class="pdf-actions">
        <a href="${escapeHtml(pdfHref)}" target="_blank" rel="noopener noreferrer">Open in browser</a>
        <span class="sep">·</span>
        <a href="${escapeHtml(pdfHref)}" download>Download</a>
      </p>
    </article>
  </main>
  ${themeScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function parseCsv(source) {
  let text = source;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (i + 1 < len && text[i + 1] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  while (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ''
  ) {
    rows.pop();
  }

  return rows;
}

// Reusable client-side toggle for "Structured | Raw" viewers (CSV, JSON, YAML).
// Mirrors renderDocumentPage's raw-toggle pattern but without the TOC machinery.
function structuredToggleScript() {
  return `<script>
    (function () {
      var rawToggleBtn = document.querySelector('[data-raw-toggle]');
      var renderedView = document.querySelector('[data-rendered-view]');
      var rawView = document.querySelector('[data-raw-view]');
      if (!rawToggleBtn || !renderedView || !rawView) {
        return;
      }
      var rawSourceScriptEl = document.getElementById('raw-document-source');
      var rawCode = rawView.querySelector('[data-raw-code]');
      if (rawSourceScriptEl && rawCode) {
        try {
          rawCode.textContent = JSON.parse(rawSourceScriptEl.textContent || '""');
          if (window.hljs && window.hljs.highlightElement) {
            window.hljs.highlightElement(rawCode);
          }
        } catch (_error) {
          rawCode.textContent = '';
        }
      }
      var current = 'raw';
      function applyView() {
        var isStructured = current === 'structured';
        renderedView.hidden = !isStructured;
        renderedView.setAttribute('aria-hidden', isStructured ? 'false' : 'true');
        rawView.hidden = isStructured;
        rawView.setAttribute('aria-hidden', isStructured ? 'true' : 'false');
        rawToggleBtn.textContent = isStructured ? 'Raw' : 'Pretty';
        rawToggleBtn.setAttribute('aria-pressed', isStructured ? 'false' : 'true');
      }
      rawToggleBtn.addEventListener('click', function () {
        current = current === 'structured' ? 'raw' : 'structured';
        applyView();
      });
      applyView();
    })();
  </script>`;
}

function renderCsvPage({ repo, relativePath, source, parentHref, rawHref, mtime, size, editHref = null, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  const rows = parseCsv(source);
  const headerRow = rows[0] || [];
  const dataRows = rows.slice(1);
  const colCount = Math.max(headerRow.length, ...dataRows.map((r) => r.length), 0);

  let tableHtml;
  if (rows.length === 0) {
    tableHtml = '<p class="csv-empty">CSV file is empty.</p>';
  } else {
    const headerCells = [];
    for (let c = 0; c < colCount; c += 1) {
      headerCells.push(`<th>${escapeHtml(headerRow[c] ?? '')}</th>`);
    }
    const bodyRows = dataRows.map((r) => {
      const cells = [];
      for (let c = 0; c < colCount; c += 1) {
        cells.push(`<td>${escapeHtml(r[c] ?? '')}</td>`);
      }
      return `<tr>${cells.join('')}</tr>`;
    });
    tableHtml = `<div class="csv-table-wrap">
        <table class="csv-table">
          <thead><tr>${headerCells.join('')}</tr></thead>
          <tbody>
            ${bodyRows.join('\n            ')}
          </tbody>
        </table>
      </div>`;
  }

  const rowLabel = dataRows.length === 1 ? 'row' : 'rows';
  const colLabel = colCount === 1 ? 'column' : 'columns';
  const summary = rows.length === 0
    ? 'csv · empty'
    : `csv · ${dataRows.length} ${rowLabel} × ${colCount} ${colLabel}`;

  const extraButtons = [
    '<button type="button" class="toolbar-btn" data-raw-toggle aria-label="Toggle pretty and raw views" aria-pressed="true">Pretty</button>',
    editHref ? `<a class="toolbar-btn" href="${escapeHtml(editHref)}" aria-label="Edit file">Edit</a>` : '',
  ].filter(Boolean).join('\n    ');

  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: summary, extra: `<p class="csv-actions"><a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer">View raw asset</a> <span class="sep">·</span> <a href="${escapeHtml(rawHref)}" download>Download</a></p>` });
  const body = `${toolbarHtml([propertiesControl, extraButtons].filter(Boolean).join('\n    '))}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: summary,
      extra: `<p class="csv-actions"><a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer">View raw asset</a> <span class="sep">·</span> <a href="${escapeHtml(rawHref)}" download>Download</a></p>`,
    })}

    <article class="content csv-view" data-rendered-view hidden aria-hidden="true">
      ${tableHtml}
    </article>
    <article class="content raw" data-raw-view>
      <pre><code class="hljs language-csv" data-raw-code></code></pre>
    </article>
  </main>
  <script id="raw-document-source" type="application/json">${jsonForInlineScript(source)}</script>
  ${themeScript()}
  ${structuredToggleScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function renderJsonNode(value, depth) {
  if (value === null) {
    return '<span class="json-null">null</span>';
  }
  const t = typeof value;
  if (t === 'boolean') {
    return `<span class="json-bool">${value ? 'true' : 'false'}</span>`;
  }
  if (t === 'number') {
    return `<span class="json-num">${Number.isFinite(value) ? value : 'null'}</span>`;
  }
  if (t === 'string') {
    return `<span class="json-str">${escapeHtml(JSON.stringify(value))}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="json-empty">[]</span>';
    }
    const items = value.map((v, i) =>
      `<li class="json-item"><span class="json-idx">${i}</span><span class="json-sep">:</span> ${renderJsonNode(v, depth + 1)}</li>`
    ).join('');
    const openAttr = depth < 1 ? ' open' : '';
    return `<details class="json-node json-array-node"${openAttr}><summary class="json-summary"><span class="json-bracket">[</span><span class="json-meta">${value.length} item${value.length === 1 ? '' : 's'}</span><span class="json-bracket">]</span></summary><ol class="json-list">${items}</ol></details>`;
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return '<span class="json-empty">{}</span>';
    }
    const items = keys.map((k) =>
      `<li class="json-item"><span class="json-key">${escapeHtml(JSON.stringify(k))}</span><span class="json-sep">:</span> ${renderJsonNode(value[k], depth + 1)}</li>`
    ).join('');
    const openAttr = depth < 1 ? ' open' : '';
    return `<details class="json-node json-object-node"${openAttr}><summary class="json-summary"><span class="json-bracket">{</span><span class="json-meta">${keys.length} key${keys.length === 1 ? '' : 's'}</span><span class="json-bracket">}</span></summary><ul class="json-list">${items}</ul></details>`;
  }
  return '<span class="json-unknown">?</span>';
}

function renderJsonPage({ repo, relativePath, source, parentHref, rawHref, mtime, size, editHref = null, customThemeCss, queryToken = null }) {
  const heading = `${repo}/${relativePath}`;
  let parsed;
  let parseError = null;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    parseError = error && error.message ? error.message : String(error);
  }

  let treeHtml;
  let summary;
  if (parseError) {
    treeHtml = `<p class="json-parse-error"><strong>Could not parse JSON.</strong> ${escapeHtml(parseError)}</p>`;
    summary = 'json · parse error';
  } else {
    treeHtml = `<div class="json-tree">${renderJsonNode(parsed, 0)}</div>`;
    if (Array.isArray(parsed)) {
      summary = `json · array · ${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
    } else if (parsed && typeof parsed === 'object') {
      const k = Object.keys(parsed).length;
      summary = `json · object · ${k} key${k === 1 ? '' : 's'}`;
    } else {
      summary = `json · ${typeof parsed}`;
    }
  }

  const extraButtons = [
    '<button type="button" class="toolbar-btn" data-raw-toggle aria-label="Toggle pretty and raw views" aria-pressed="true">Pretty</button>',
    editHref ? `<a class="toolbar-btn" href="${escapeHtml(editHref)}" aria-label="Edit file">Edit</a>` : '',
  ].filter(Boolean).join('\n    ');

  const propertiesControl = propertiesPanel({ repo, relativePath, queryToken, size, mtime, kind: summary, extra: `<p class="csv-actions"><a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer">View raw asset</a> <span class="sep">·</span> <a href="${escapeHtml(rawHref)}" download>Download</a></p>` });
  const body = `${toolbarHtml([propertiesControl, extraButtons].filter(Boolean).join('\n    '))}
  <main class="layout">
    ${documentHeader({
      repo, relativePath, queryToken, size, mtime, kind: summary,
      extra: `<p class="csv-actions"><a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer">View raw asset</a> <span class="sep">·</span> <a href="${escapeHtml(rawHref)}" download>Download</a></p>`,
    })}

    <article class="content json-view" data-rendered-view hidden aria-hidden="true">
      ${treeHtml}
    </article>
    <article class="content raw" data-raw-view>
      <pre><code class="hljs language-json" data-raw-code></code></pre>
    </article>
  </main>
  <script id="raw-document-source" type="application/json">${jsonForInlineScript(source)}</script>
  ${themeScript()}
  ${structuredToggleScript()}`;

  return baseHtml({
    title: heading,
    body,
    customThemeCss,
  });
}

function renderEditPage({
  repo,
  relativePath,
  source,
  repoRoot,
  repoMappings = null,
  canResolveLink = null,
  mtimeMs,
  mtime,
  size,
  viewHref,
  saveHref,
  previewHref,
  customThemeCss,
  queryToken = null,
}) {
  const heading = `${repo}/${relativePath}`;
  const mode = path.extname(relativePath).toLowerCase();
  const initialPreviewHtml = renderPreviewHtml({
    repo,
    repoRoot,
    repoMappings,
    canResolveLink,
    relativePath,
    source,
    queryToken,
  });
  const editButtons = [
    `<a class="toolbar-btn" href="${escapeHtml(viewHref)}">View</a>`,
    '<button type="button" class="toolbar-btn is-active" data-tab-btn data-target="edit" role="tab" aria-selected="true">Edit</button>',
    '<button type="button" class="toolbar-btn" data-tab-btn data-target="preview" role="tab" aria-selected="false">Preview</button>',
    '<button type="button" class="toolbar-btn toolbar-btn-primary" data-save-btn>Save</button>',
  ].join('\n    ');

  const body = `${toolbarHtml(editButtons)}
  <p class="notice" data-save-status hidden></p>
  <main class="layout">
    <header class="topbar">
      <h1>Edit ${escapeHtml(path.basename(relativePath))}</h1>
      <p class="subtitle">${escapeHtml(heading)}</p>
      ${breadcrumbs(repo, relativePath, queryToken)}
      <p class="doc-meta">${escapeHtml(size)} · ${escapeHtml(mtime)} · editable</p>
    </header>

    <section class="content editor-shell" data-editor-shell data-file-mode="${escapeHtml(mode)}">
      <div class="editor-pane" data-pane="edit">
        <textarea class="editor-textarea" data-editor-input spellcheck="false">${escapeHtml(source)}</textarea>
      </div>
      <div class="editor-pane" data-pane="preview" hidden aria-hidden="true">
        <article class="content markdown editor-preview" data-preview-container>
          ${initialPreviewHtml}
        </article>
      </div>
    </section>
  </main>
  <script id="editor-bootstrap" type="application/json">${jsonForInlineScript({
    source,
    mtimeMs,
    saveHref,
    viewHref,
    previewHref,
  })}</script>
  ${themeScript()}
  <script src="/public/editor.js"></script>`;

  return baseHtml({
    title: `Edit ${heading}`,
    body,
    customThemeCss,
  });
}

module.exports = {
  baseHtml,
  decorateRenderedHtmlForAnnotations,
  detectRenderMode,
  renderDocumentPage,
  renderDirectoryPage,
  renderImagePage,
  renderAudioPage,
  renderVideoPage,
  renderPdfPage,
  renderCsvPage,
  renderJsonPage,
  parseCsv,
  renderEditPage,
  renderPreviewHtml,
  renderAnnotationMarkdown,
  setThemeList,
  setNavLinks,
  getNavLinks,
  getThemeList,
  themeScript,
  toolbarHtml,
  propertiesMenu,
};
