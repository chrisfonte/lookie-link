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
  // Split into lines, find top-level keys from the highlighted output
  return highlightedHtml.replace(
    /^(<span class="hljs-attr">)([^<]+)(<\/span>)/gm,
    (match, open, key, close) => {
      // Only anchor top-level keys (line starts with the span, no leading whitespace)
      const slug = key.replace(/:/g, '').trim().toLowerCase().replace(/[^\w-]/g, '-');
      return `<span id="${slug}">${open}${key}${close}</span>`;
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

function rewriteImageSources(html, context) {
  const parts = splitByCodeBlocks(html);
  for (let i = 0; i < parts.length; i += 1) {
    if (/^<(pre|code)\b/i.test(parts[i])) {
      continue;
    }

    parts[i] = parts[i].replace(
      /<img\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/gi,
      (match, before, src, after) => {
        if (!src || /^https?:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('/asset/')) {
          return match;
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
          return match;
        }

        let rewritten = null;

        if (src.startsWith('~/')) {
          const mapped = normalizeRepoAssetPath(pathPart);
          rewritten = mapped ? `/asset${mapped}` : null;
        } else if (src.startsWith('/')) {
          rewritten = `/asset/${encodeURIComponent(context.repo)}${src.split('/').map(encodeURIComponent).join('/')}`;
        } else {
          const cleaned = pathPart.replace(/^\.\//, '');
          const joined = context.currentDir
            ? path.posix.join(context.currentDir, cleaned)
            : cleaned;

          // Check if resolved path exists; if not, walk up parents (handles Obsidian-style fuzzy relative paths)
          let finalJoined = joined;
          if (context.repoRoot) {
            const candidate = path.join(context.repoRoot, joined);
            if (!fs.existsSync(candidate)) {
              // Extract the non-../ tail (e.g., "artifacts/2026-02-21/foo.jpg")
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

          rewritten = `/asset/${encodeURIComponent(context.repo)}/${finalJoined.split('/').map(encodeURIComponent).join('/')}`;
        }

        if (!rewritten) {
          return match;
        }

        return `<img${before} src="${rewritten}${escapeHtml(suffix)}"${after}>`;
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
    /<span id="([^"]+)">([\s\S]*?)<\/span>/g,
    (match, id, inner) => `<span id="${id}" class="yaml-anchor-wrap">${inner}<a class="anchor-link yaml-anchor-link" href="#${escapeHtml(id)}" data-anchor-id="${escapeHtml(id)}" aria-label="Copy section link">🔗</a></span>`
  );
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
    return {
      kind: 'markdown',
      html: postProcessHtml(markdown.render(source), options),
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

function baseHtml({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/public/style.css" />
</head>
<body>
  ${body}
</body>
</html>`;
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

function renderDirectoryPage({ title, repo, currentPath, parentHref, entries, notice }) {
  const rows = entries.map((entry) => {
    const icon = entry.isDirectory ? 'dir' : 'file';
    return `<tr>
      <td class="name"><a href="${entry.href}"><span class="tag">${icon}</span>${escapeHtml(entry.name)}</a></td>
      <td class="meta">${escapeHtml(entry.size)}</td>
      <td class="meta">${escapeHtml(entry.mtime)}</td>
    </tr>`;
  }).join('');

  const body = `<main class="layout">
    <header class="topbar">
      <h1>ops-file-viewer</h1>
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
  </main>`;

  return baseHtml({ title, body });
}

function renderDocumentPage({ repo, repoRoot, relativePath, source, parentHref, mtime, size }) {
  const rendered = renderContent(relativePath, source, {
    repo,
    repoRoot: repoRoot || null,
    currentDir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
  });
  const heading = `${repo}/${relativePath}`;

  const body = `<main class="layout">
    <header class="topbar">
      <h1>${escapeHtml(path.basename(relativePath))}</h1>
      <p class="subtitle">${escapeHtml(heading)}</p>
      ${breadcrumbs(repo, relativePath)}
      <p class="doc-meta">${escapeHtml(size)} · ${escapeHtml(mtime)} · ${escapeHtml(rendered.kind)}</p>
      ${parentHref ? `<p><a class="back" href="${parentHref}">Back to directory</a></p>` : ''}
    </header>

    <article class="content ${rendered.kind}">
      ${rendered.html}
    </article>
  </main>`;

  return baseHtml({
    title: heading,
    body: `${body}
  <script>
    (function () {
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

      const root = document.querySelector('.content');
      if (!root) return;

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

module.exports = {
  renderDocumentPage,
  renderDirectoryPage,
};
