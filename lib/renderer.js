'use strict';

const path = require('node:path');
const fs = require('node:fs');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const { escapeHtml } = require('./path-utils');

const markdown = new MarkdownIt({
  html: true,
  linkify: false,
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
const CODE_EXTENSIONS = new Set([
  '.yaml', '.yml', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.toml', '.ini', '.conf', '.env', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.swift', '.rb', '.php', '.css', '.scss', '.html', '.xml', '.dockerfile', '.makefile', '.txt',
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

  if (ext === '.html' || ext === '.xml') {
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
      // For YAML: wrap top-level keys in anchor spans
      if (language === 'yaml') {
        highlighted = addYamlAnchors(highlighted);
      }
      return `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`;
    }

    return `<pre><code class="hljs">${hljs.highlightAuto(source).value}</code></pre>`;
  } catch (_error) {
    return `<pre><code class="hljs">${escapeHtml(source)}</code></pre>`;
  }
}

// Add anchor IDs to top-level YAML keys (lines starting at column 0 with key:)
function addYamlAnchors(highlightedHtml) {
  // Anchor top-level keys AND second-level keys (indented by 2 spaces)
  return highlightedHtml.replace(
    /^( {0,2})(<span class="hljs-attr">)([^<]+)(<\/span>)/gm,
    (match, indent, open, key, close) => {
      const level = indent.length === 0 ? 1 : 2;
      const slug = key.replace(/:/g, '').trim().toLowerCase().replace(/[^\w-]/g, '-');
      const cls = level === 1 ? 'yaml-anchor-wrap' : 'yaml-anchor-wrap yaml-anchor-l2';
      return `${indent}<span id="${slug}" class="${cls}">${open}${key}${close}</span>`;
    }
  );
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

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

function rewriteHybridCrossLinks(html) {
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
      /\[\[([^[\]]+)\]\]\s+\((?:`|<code>)?(~\/[^)\s`<]+(?:#[^)`\s<]+)?)(?:`|<\/code>)?\)/g,
      (match, wikiText, rawPath, offset) => {
        // Skip if the [[ is inside a <code> block (literal example).
        // Look back for the nearest <code> or </code> before the match.
        const before = parts[i].slice(0, offset);
        const lastCodeOpen = before.lastIndexOf('<code>');
        const lastCodeClose = before.lastIndexOf('</code>');
        if (lastCodeOpen > lastCodeClose) {
          return match; // inside a <code> span — leave as literal
        }

        const hashIndex = rawPath.indexOf('#');
        const pathPart = hashIndex === -1 ? rawPath : rawPath.slice(0, hashIndex);
        const mappedPath = normalizeRepoAssetPath(pathPart);
        if (!mappedPath) {
          return match;
        }

        const hash = hashIndex === -1 ? '' : rawPath.slice(hashIndex);
        return `<a href="/view${mappedPath}${escapeHtml(hash)}" class="cross-link">${escapeHtml(wikiText.trim())}</a>`;
      }
    );
  }

  return parts.join('');
}

function rewriteTildeLinks(html) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    // Rewrite <a href="~/repo/path#section"> → <a href="/view/repo/path#section">
    parts[i] = parts[i].replace(
      /<a\b([^>]*?)href="~\/([^"#]+)(#[^"]*)?([^>]*)"([^>]*)>/gi,
      (match, before, tilePath, hash, extra, after) => {
        const mapped = normalizeRepoAssetPath('~/' + tilePath);
        if (!mapped) {
          return match;
        }
        return `<a${before}href="/view${mapped}${hash || ''}${extra || ''}"${after}>`;
      }
    );
  }

  return parts.join('');
}

function resolveLocalImageHref(src, context) {
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
  if (!IMAGE_EXTENSIONS.has(ext)) {
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

        const assetHref = rewrittenViewHref.replace(/^\/view\//, '/asset/');
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

        return `<a${before}href="${rewrittenHref}"${after}>${inner}</a>`;
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

function addYamlAnchorLinks(html) {
  return html.replace(
    /<span id="([^"]+)"(?: class="([^"]*)")?>([\s\S]*?)<\/span>/g,
    (match, id, cls, inner) => {
      const classes = cls || 'yaml-anchor-wrap';
      return `<span id="${id}" class="${classes}">${inner}<a class="anchor-link yaml-anchor-link" href="#${escapeHtml(id)}" data-anchor-id="${escapeHtml(id)}" aria-label="Copy section link">🔗</a></span>`;
    }
  );
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
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'height', 'loading', 'referrerpolicy', 'sandbox', 'style', 'title', 'width'],
    FORBID_TAGS: ['script', 'object', 'embed', 'form'],
  });
}

function postProcessHtml(html, options) {
  let output = html;
  output = rewriteHybridCrossLinks(output);
  output = rewriteTildeLinks(output);
  output = rewriteImageSources(output, options);
  output = addHeadingAnchorLinks(output);
  output = addYamlAnchorLinks(output);
  output = sanitizeHtml(output);
  return output;
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

function renderPreviewHtml({ repo, repoRoot, relativePath, source }) {
  const rendered = renderContent(relativePath, source, {
    repo,
    repoRoot: repoRoot || null,
    currentDir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
  });
  return rendered.html;
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
  ];
}

function toolbarHtml(extraButtons = '') {
  return `<div class="viewer-toolbar" role="toolbar" aria-label="Viewer controls">
    ${extraButtons}
    <button type="button" class="toolbar-btn" data-scheme-cycle aria-label="Cycle color theme">Slate</button>
    <button type="button" class="toolbar-btn" data-theme-toggle aria-label="Toggle light and dark mode">☀</button>
  </div>`;
}

function themeScript() {
  const themes = getThemeList();
  const themesJson = JSON.stringify(themes);
  return `
  <script>
    (function () {
      var rootEl = document.documentElement;
      var themeToggleBtn = document.querySelector('[data-theme-toggle]');
      var schemeCycleBtn = document.querySelector('[data-scheme-cycle]');
      var themes = ${themesJson};

      function findThemeIndex(slug) {
        for (var i = 0; i < themes.length; i++) {
          if (themes[i].slug === slug) return i;
        }
        return 0;
      }

      function applyColorScheme(slug) {
        rootEl.setAttribute('data-color-scheme', slug);
        var idx = findThemeIndex(slug);
        if (schemeCycleBtn) schemeCycleBtn.textContent = themes[idx].label;
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

      var savedScheme = localStorage.getItem('lookie-link-color-scheme') || 'slate';
      var savedTheme = localStorage.getItem('lookie-link-theme') || 'dark';
      applyColorScheme(savedScheme);
      applyTheme(savedTheme);

      if (schemeCycleBtn) {
        schemeCycleBtn.addEventListener('click', function () {
          var current = rootEl.getAttribute('data-color-scheme') || 'slate';
          var idx = findThemeIndex(current);
          var next = themes[(idx + 1) % themes.length];
          applyColorScheme(next.slug);
          localStorage.setItem('lookie-link-color-scheme', next.slug);
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
    }());
  </script>`;
}

function baseHtml({ title, body, customThemeCss }) {
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
  ${customThemeCss ? `<style>${customThemeCss}</style>` : ''}
  <script>
    (function () {
      var root = document.documentElement;
      root.setAttribute('data-color-scheme', localStorage.getItem('lookie-link-color-scheme') || 'slate');
      if (localStorage.getItem('lookie-link-theme') === 'light') root.setAttribute('data-theme', 'light');
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
  <script>
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

function breadcrumbs(repo, relativePath) {
  const segments = relativePath ? relativePath.split('/') : [];
  const items = [`<a href="/">home</a>`, `<a href="/view/${encodeURIComponent(repo)}">${escapeHtml(repo)}</a>`];

  segments.forEach((segment, idx) => {
    const rel = segments.slice(0, idx + 1).join('/');
    items.push(`<a href="/view/${encodeURIComponent(repo)}/${rel.split('/').map(encodeURIComponent).join('/')}">${escapeHtml(segment)}</a>`);
  });

  return `<nav class="breadcrumbs">${items.join('<span class="sep">/</span>')}</nav>`;
}

function renderDirectoryPage({ title, repo, currentPath, parentHref, entries, notice, customThemeCss }) {
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
      ${repo ? breadcrumbs(repo, currentPath) : ''}
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

function renderDocumentPage({ repo, repoRoot, relativePath, source, parentHref, mtime, size, editHref = null, customThemeCss }) {
  const extension = path.extname(relativePath).toLowerCase();
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const hasToc = isMarkdown || ['.yaml', '.yml'].includes(extension);
  const rendered = renderContent(relativePath, source, {
    repo,
    repoRoot: repoRoot || null,
    currentDir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
  });
  const heading = `${repo}/${relativePath}`;
  const rawSourceJson = isMarkdown ? jsonForInlineScript(source) : null;

  const renderedClass = isMarkdown ? 'markdown' : rendered.kind;
  const contentHtml = `${hasToc ? `<article class="content toc-view" id="toc-view" data-toc-view hidden aria-hidden="true">
      <h2 class="toc-view-title">Contents</h2>
      <nav class="toc-list" data-toc-list aria-label="Table of contents"></nav>
    </article>` : ''}
    <article class="content ${renderedClass}" data-rendered-view>
      ${rendered.html}
    </article>
    ${isMarkdown ? `<article class="content raw" data-raw-view hidden aria-hidden="true">
      <pre><code class="hljs language-markdown" data-raw-code></code></pre>
    </article>` : ''}`;

  const extraButtons = [
    hasToc ? '<button type="button" class="toolbar-btn" data-toc-toggle aria-label="Toggle table of contents" aria-expanded="false" aria-controls="toc-view">☰</button>' : '',
    isMarkdown ? '<button type="button" class="toolbar-btn" data-raw-toggle aria-label="Toggle markdown raw and rendered views">Raw</button>' : '',
    editHref ? `<a class="toolbar-btn" href="${escapeHtml(editHref)}" aria-label="Edit file">Edit</a>` : '',
  ].filter(Boolean).join('\n    ');

  const body = `${toolbarHtml(extraButtons)}
  <main class="layout">
    <header class="topbar">
      <h1>${escapeHtml(path.basename(relativePath))}</h1>
      <p class="subtitle">${escapeHtml(heading)}</p>
      ${breadcrumbs(repo, relativePath)}
      <p class="doc-meta">${escapeHtml(size)} · ${escapeHtml(mtime)} · ${escapeHtml(rendered.kind)}</p>
      ${parentHref ? `<p><a class="back" href="${parentHref}">Back to directory</a></p>` : ''}
    </header>

    ${contentHtml}
  </main>`;

  return baseHtml({
    title: heading,
    customThemeCss,
    body: `${body}
  ${themeScript()}
  ${isMarkdown ? `<script id="raw-markdown-source" type="application/json">${rawSourceJson}</script>` : ''}
  <script>
    (function () {
      var rawToggleBtn = document.querySelector('[data-raw-toggle]');
      var renderedView = document.querySelector('[data-rendered-view]');
      var rawView = document.querySelector('[data-raw-view]');
      var tocToggleBtn = document.querySelector('[data-toc-toggle]');
      var tocView = document.querySelector('[data-toc-view]');
      var tocList = document.querySelector('[data-toc-list]');
      var currentBaseView = rawView && !rawView.hidden ? 'raw' : 'rendered';
      var tocReturnView = currentBaseView;

      if (rawView) {
        var rawSourceScript = document.getElementById('raw-markdown-source');
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
        rawToggleBtn.textContent = currentBaseView === 'raw' ? 'Rendered' : 'Raw';
      }

      function applyBaseView() {
        setViewVisibility(renderedView, currentBaseView === 'rendered');
        if (rawView) {
          setViewVisibility(rawView, currentBaseView === 'raw');
        }
      }

      function setTocButtonState(showingToc) {
        if (!tocToggleBtn) {
          return;
        }
        tocToggleBtn.textContent = showingToc ? 'Doc' : '☰';
        tocToggleBtn.setAttribute('aria-expanded', showingToc ? 'true' : 'false');
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

      function showTocView() {
        if (!tocView) {
          return;
        }
        // Capture active heading BEFORE hiding the document (offsetTop becomes 0 when hidden)
        deriveActiveFromScroll();
        tocReturnView = currentBaseView;
        setViewVisibility(renderedView, false);
        if (rawView) {
          setViewVisibility(rawView, false);
        }
        setViewVisibility(tocView, true);
        setTocButtonState(true);
        scrollActiveItemIntoView();
      }

      function showDocumentView(targetView) {
        if (targetView === 'raw' && rawView) {
          currentBaseView = 'raw';
        } else {
          currentBaseView = 'rendered';
        }
        applyBaseView();
        if (tocView) {
          setViewVisibility(tocView, false);
        }
        setTocButtonState(false);
        updateRawToggleLabel();
      }

      if (rawToggleBtn && renderedView && rawView) {
        rawToggleBtn.addEventListener('click', function () {
          currentBaseView = currentBaseView === 'raw' ? 'rendered' : 'raw';
          updateRawToggleLabel();

          if (tocView && !tocView.hidden) {
            tocReturnView = currentBaseView;
            return;
          }

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

      setTocButtonState(false);
      updateRawToggleLabel();

      const root = renderedView || document.querySelector('.content');
      if (!root) return;

      var tocContainer = renderedView || document.querySelector('article.content');
      if (tocToggleBtn && tocView && tocList && tocContainer) {
        // For markdown: headings. For YAML: anchored spans (top-level keys)
        var tocHeadings = Array.prototype.slice.call(
          tocContainer.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')
        );
        if (tocHeadings.length === 0) {
          // YAML files use <span id="key" class="yaml-anchor-wrap"> inside <pre>
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
            } else if (heading.classList.contains('yaml-anchor-l2')) {
              level = 3;
            } else {
              level = 2;
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
            setTimeout(function () {
              targetHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 0);
          });

          tocToggleBtn.addEventListener('click', function () {
            if (!tocView.hidden) {
              showDocumentView(tocReturnView);
            } else {
              showTocView();
            }
          });

          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && tocView && !tocView.hidden) {
              showDocumentView(tocReturnView);
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

function renderImagePage({ repo, relativePath, parentHref, imageHref, mtime, size, customThemeCss }) {
  const heading = `${repo}/${relativePath}`;
  const body = `${toolbarHtml()}
  <main class="layout">
    <header class="topbar">
      <h1>${escapeHtml(path.basename(relativePath))}</h1>
      <p class="subtitle">${escapeHtml(heading)}</p>
      ${breadcrumbs(repo, relativePath)}
      <p class="doc-meta">${escapeHtml(size)} · ${escapeHtml(mtime)} · image</p>
      ${parentHref ? `<p><a class="back" href="${parentHref}">Back to directory</a></p>` : ''}
    </header>

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

function renderEditPage({
  repo,
  relativePath,
  source,
  repoRoot,
  mtimeMs,
  mtime,
  size,
  viewHref,
  saveHref,
  previewHref,
  customThemeCss,
}) {
  const heading = `${repo}/${relativePath}`;
  const mode = path.extname(relativePath).toLowerCase();
  const initialPreviewHtml = renderPreviewHtml({
    repo,
    repoRoot,
    relativePath,
    source,
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
      ${breadcrumbs(repo, relativePath)}
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
  renderDocumentPage,
  renderDirectoryPage,
  renderImagePage,
  renderEditPage,
  renderPreviewHtml,
  setThemeList,
};
