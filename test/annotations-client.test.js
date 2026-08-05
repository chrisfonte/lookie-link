'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { renderDocumentPage } = require('../lib/renderer');

const SCRIPT_PATH = path.join(__dirname, '..', 'public', 'annotations.js');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootDom({ body, bootstrap, fetchImpl }) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url: 'http://127.0.0.1:9876/view/docs/doc.md',
    runScripts: 'outside-only',
  });

  const { window } = dom;
  window.__lookieLinkAnnotations = bootstrap;
  window.fetch = fetchImpl;
  window.alert = () => {};
  window.prompt = () => '';
  window.confirm = () => false;
  if (!window.CSS) {
    window.CSS = {};
  }
  if (!window.CSS.escape) {
    window.CSS.escape = (value) => String(value).replace(/"/g, '\\"');
  }

  window.eval(SCRIPT_SOURCE);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flush();
  await flush();
  return dom;
}

test('annotation client renders stale annotations and toggles resolved visibility', async () => {
  let getCount = 0;
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content markdown" data-rendered-view>
          <h1 id="intro">
            Intro
            <a class="anchor-link" href="#intro" data-anchor-id="intro">🔗</a>
            <button type="button" data-annotate-trigger data-anchor-id="intro" data-anchor-kind="heading">💬 Annotate</button>
          </h1>
          <section data-annotations-mount data-anchor-id="intro" data-anchor-kind="heading"></section>
        </article>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'doc.md',
      queryToken: null,
      supportsLineRangeAnnotations: false,
      sourceLineCount: 3,
    },
    fetchImpl: async () => {
      getCount += 1;
      return {
        ok: true,
        async json() {
          return {
            schema: 1,
            file: 'docs/doc.md',
            mtimeMs: 42,
            annotations: [
              {
                id: '2026-06-09-001',
                anchor: '#intro',
                anchorKind: 'heading',
                body: 'Open note',
                author: 'builder',
                createdAt: '2026-06-09T10:00:00.000Z',
                state: 'open',
                claimedBy: null,
                claimedAt: null,
                resolvedAt: null,
                replies: [
                  {
                    author: 'reviewer',
                    body: 'Reply note',
                    createdAt: '2026-06-09T10:05:00.000Z',
                  },
                ],
              },
              {
                id: '2026-06-09-002',
                anchor: '#intro',
                anchorKind: 'heading',
                body: 'Resolved note',
                author: 'builder',
                createdAt: '2026-06-09T11:00:00.000Z',
                state: 'resolved',
                claimedBy: null,
                claimedAt: null,
                resolvedAt: '2026-06-09T11:30:00.000Z',
                replies: [],
              },
              {
                id: '2026-06-09-003',
                anchor: '#missing-anchor',
                anchorKind: 'heading',
                body: 'Stale note',
                author: 'builder',
                createdAt: '2026-06-09T12:00:00.000Z',
                state: 'open',
                claimedBy: null,
                claimedAt: null,
                resolvedAt: null,
                replies: [],
              },
            ],
          };
        },
      };
    },
  });

  const { document } = dom.window;
  assert.equal(getCount, 1);

  const mount = document.querySelector('[data-annotations-mount][data-anchor-id="intro"]');
  assert.ok(mount.textContent.includes('Open note'));
  assert.ok(!mount.textContent.includes('Resolved note'));
  const annotationItem = mount.querySelector('details.lookie-annotation-item');
  assert.ok(annotationItem);
  assert.equal(annotationItem.open, false);
  assert.equal(annotationItem.querySelector('summary.lookie-annotation-summary .lookie-annotation-preview').textContent, 'Open note');
  assert.equal(annotationItem.querySelector('summary.lookie-annotation-summary .lookie-annotation-reply-count').textContent, '1 reply');
  assert.equal(annotationItem.querySelector('.lookie-annotation-detail .lookie-annotation-body').textContent, 'Open note');
  assert.ok(annotationItem.querySelector('.lookie-annotation-detail').textContent.includes('Reply note'));

  const stale = document.querySelector('[data-annotations-stale]');
  assert.equal(stale.hidden, false);
  assert.ok(stale.textContent.includes('Stale anchors (1)'));
  assert.ok(stale.textContent.includes('Stale note'));

  const toggle = document.querySelector('[data-annotations-toggle]');
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent.trim(), '💬 3');

  toggle.click();
  await flush();

  assert.ok(mount.textContent.includes('Resolved note'));
  dom.window.close();
});

test('annotation toolbar toggles normal viewer annotation mode', () => {
  const html = renderDocumentPage({
    repo: 'docs',
    repoRoot: '/tmp/example-docs',
    relativePath: 'doc.md',
    source: '# Intro\n',
    parentHref: '/view/docs',
    mtime: 'just now',
    size: '8 B',
    annotationsEnabled: true,
  });
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:9876/view/docs/doc.md',
    runScripts: 'outside-only',
  });
  const themeScript = Array.from(dom.window.document.querySelectorAll('script'))
    .find((node) => node.textContent.includes('var annotationModeBtn'));
  assert.ok(themeScript);
  dom.window.eval(themeScript.textContent);

  const button = dom.window.document.querySelector('[data-annotation-mode-toggle]');
  assert.ok(button);
  assert.equal(dom.window.document.documentElement.classList.contains('lookie-annotations-active'), false);
  button.click();
  assert.equal(dom.window.document.documentElement.classList.contains('lookie-annotations-active'), true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  button.click();
  assert.equal(dom.window.document.documentElement.classList.contains('lookie-annotations-active'), false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  dom.window.close();
});

test('annotation client submits line-range annotations with anchorKind lineRange', async () => {
  const requests = [];
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content code" data-rendered-view>
          <pre><code>alpha
beta
gamma
delta</code></pre>
        </article>
        <section data-annotations-line-range-root hidden></section>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'notes.txt',
      queryToken: null,
      supportsLineRangeAnnotations: true,
      sourceLineCount: 4,
    },
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (method === 'GET') {
        const payload = requests.length > 1
          ? {
              schema: 1,
              file: 'docs/notes.txt',
              mtimeMs: 11,
              annotations: [
                {
                  id: '2026-06-09-001',
                  anchor: '#L2-L4',
                  anchorKind: 'lineRange',
                  body: 'Check these lines',
                  author: 'builder',
                  createdAt: '2026-06-09T10:00:00.000Z',
                  state: 'open',
                  claimedBy: null,
                  claimedAt: null,
                  resolvedAt: null,
                  replies: [],
                },
              ],
            }
          : {
              schema: 1,
              file: 'docs/notes.txt',
              mtimeMs: null,
              annotations: [],
            };
        return {
          ok: true,
          async json() {
            return payload;
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            mtimeMs: 11,
            annotation: {
              id: '2026-06-09-001',
            },
          };
        },
      };
    },
  });

  const { document } = dom.window;
  const form = document.querySelector('.lookie-line-range-form');
  assert.ok(form);

  form.querySelector('input[name="start"]').value = '2';
  form.querySelector('input[name="end"]').value = '4';
  form.querySelector('input[name="author"]').value = 'builder';
  form.querySelector('textarea[name="body"]').value = 'Check these lines';

  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();

  const post = requests.find((request) => request.method === 'POST');
  assert.ok(post);
  assert.equal(post.body.anchor, '#L2-L4');
  assert.equal(post.body.anchorKind, 'lineRange');
  assert.equal(post.body.author, 'builder');

  const lineRangeRoot = document.querySelector('[data-annotations-line-range-root]');
  assert.equal(lineRangeRoot.hidden, false);
  assert.ok(lineRangeRoot.textContent.includes('Lines 2-4'));
  assert.ok(lineRangeRoot.textContent.includes('Check these lines'));
  dom.window.close();
});

test('heading compose form persists across saves for rapid capture', async () => {
  const requests = [];
  const savedAnnotations = [];
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content markdown" data-rendered-view>
          <h1 id="board">
            Board
            <button type="button" data-annotate-trigger data-anchor-id="board" data-anchor-kind="heading">💬 Annotate</button>
          </h1>
          <section data-annotations-mount data-anchor-id="board" data-anchor-kind="heading"></section>
        </article>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'doc.md',
      queryToken: null,
      supportsLineRangeAnnotations: false,
      sourceLineCount: 3,
    },
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      requests.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        savedAnnotations.push({
          id: `2026-08-05-${String(savedAnnotations.length + 1).padStart(3, '0')}`,
          anchor: body.anchor,
          anchorKind: body.anchorKind,
          body: body.body,
          author: body.author,
          createdAt: '2026-08-05T13:00:00.000Z',
          state: 'open',
          claimedBy: null,
          claimedAt: null,
          resolvedAt: null,
          replies: [],
        });
        return {
          ok: true,
          async json() {
            return { ok: true, mtimeMs: savedAnnotations.length, annotation: savedAnnotations[savedAnnotations.length - 1] };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            schema: 1,
            file: 'docs/doc.md',
            mtimeMs: savedAnnotations.length,
            annotations: [...savedAnnotations],
          };
        },
      };
    },
  });

  const { document } = dom.window;
  const mount = document.querySelector('[data-annotations-mount][data-anchor-id="board"]');
  document.querySelector('[data-annotate-trigger]').click();

  const form = mount.querySelector('.lookie-annotate-form');
  assert.ok(form);
  const authorInput = form.querySelector('input[name="author"]');
  const bodyInput = form.querySelector('textarea[name="body"]');

  authorInput.value = 'capturer';
  bodyInput.value = 'First rapid note';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();

  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.ok(mount.contains(form), 'compose form must survive the save');
  assert.equal(bodyInput.value, '', 'body clears for the next note');
  assert.equal(authorInput.value, 'capturer', 'author is retained');
  assert.equal(mount.hidden, false);
  assert.equal(document.activeElement, bodyInput, 'focus returns to the body for the next note');
  assert.ok(mount.textContent.includes('First rapid note'), 'saved note renders without reopening the form');

  bodyInput.value = 'Second rapid note';
  bodyInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }));
  await flush();
  await flush();

  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 2, 'Ctrl+Enter submits without touching the Save button');
  assert.equal(posts[1].body.body, 'Second rapid note');
  assert.equal(posts[1].body.anchor, '#board');
  assert.ok(mount.contains(form));
  assert.equal(bodyInput.value, '');

  document.querySelector('[data-annotate-trigger]').click();
  assert.equal(mount.querySelectorAll('.lookie-annotate-form').length, 1, 'reopening focuses the existing form instead of duplicating it');

  dom.window.close();
});

test('annotation form inputs hold the 16px mobile font floor', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const annotateBlock = css.match(/\.lookie-annotate-form input[^{]*\{[^}]*\}/);
  const lineRangeBlock = css.match(/\.lookie-line-range-form input[^{]*\{[^}]*\}/);
  assert.ok(annotateBlock, 'annotate form input rule exists');
  assert.ok(lineRangeBlock, 'line-range form input rule exists');
  assert.match(annotateBlock[0], /font-size:\s*16px/, 'annotate inputs declare the 16px floor (font: inherit alone re-zooms iOS)');
  assert.match(lineRangeBlock[0], /font-size:\s*16px/, 'line-range inputs declare the 16px floor');
});

test('annotation bodies render server-provided markdown html and fall back to plain text', async () => {
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content markdown" data-rendered-view>
          <h1 id="board">Board</h1>
          <section data-annotations-mount data-anchor-id="board" data-anchor-kind="heading"></section>
        </article>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'doc.md',
      queryToken: null,
      supportsLineRangeAnnotations: false,
      sourceLineCount: 3,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          schema: 1,
          file: 'docs/doc.md',
          mtimeMs: 7,
          annotations: [
            {
              id: '2026-08-05-001',
              anchor: '#board',
              anchorKind: 'heading',
              body: '**bold note**',
              bodyHtml: '<p><strong>bold note</strong></p>\n',
              author: 'capturer',
              createdAt: '2026-08-05T13:00:00.000Z',
              state: 'open',
              claimedBy: null,
              claimedAt: null,
              resolvedAt: null,
              replies: [],
            },
            {
              id: '2026-08-05-002',
              anchor: '#board',
              anchorKind: 'heading',
              body: 'plain fallback **not rendered**',
              author: 'capturer',
              createdAt: '2026-08-05T13:01:00.000Z',
              state: 'open',
              claimedBy: null,
              claimedAt: null,
              resolvedAt: null,
              replies: [],
            },
          ],
        };
      },
    }),
  });

  const { document } = dom.window;
  const mount = document.querySelector('[data-annotations-mount][data-anchor-id="board"]');
  const bodies = mount.querySelectorAll('.lookie-annotation-detail .lookie-annotation-body');
  assert.equal(bodies.length, 2);

  const rich = bodies[0];
  assert.ok(rich.classList.contains('lookie-annotation-body-rich'));
  assert.ok(rich.querySelector('strong'));
  assert.equal(rich.querySelector('strong').textContent, 'bold note');

  const plain = bodies[1];
  assert.ok(!plain.classList.contains('lookie-annotation-body-rich'));
  assert.equal(plain.querySelector('strong'), null, 'no bodyHtml means no markup interpretation');
  assert.ok(plain.textContent.includes('plain fallback **not rendered**'));

  dom.window.close();
});

test('compose toolbar applies markdown to the body without submitting the form', async () => {
  const requests = [];
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content markdown" data-rendered-view>
          <h1 id="board">
            Board
            <button type="button" data-annotate-trigger data-anchor-id="board" data-anchor-kind="heading">💬 Annotate</button>
          </h1>
          <section data-annotations-mount data-anchor-id="board" data-anchor-kind="heading"></section>
        </article>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'doc.md',
      queryToken: null,
      supportsLineRangeAnnotations: false,
      sourceLineCount: 3,
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ method: init.method || 'GET' });
      return {
        ok: true,
        async json() {
          return { schema: 1, file: 'docs/doc.md', mtimeMs: null, annotations: [] };
        },
      };
    },
  });

  const { document } = dom.window;
  document.querySelector('[data-annotate-trigger]').click();
  const form = document.querySelector('.lookie-annotate-form');
  const bodyInput = form.querySelector('textarea[name="body"]');
  const tools = Object.fromEntries(
    Array.from(form.querySelectorAll('.lookie-compose-tool')).map((button) => [button.title, button])
  );
  assert.deepEqual(Object.keys(tools).sort(), ['Bold', 'Code', 'Italic', 'Link', 'List']);

  bodyInput.value = 'pick me';
  bodyInput.setSelectionRange(0, 4);
  tools.Bold.click();
  assert.equal(bodyInput.value, '**pick** me');
  assert.equal(bodyInput.value.slice(bodyInput.selectionStart, bodyInput.selectionEnd), 'pick');

  bodyInput.value = '';
  bodyInput.setSelectionRange(0, 0);
  tools.Italic.click();
  assert.equal(bodyInput.value, '*italic*');
  assert.equal(bodyInput.value.slice(bodyInput.selectionStart, bodyInput.selectionEnd), 'italic');

  bodyInput.value = 'one\ntwo';
  bodyInput.setSelectionRange(0, bodyInput.value.length);
  tools.List.click();
  assert.equal(bodyInput.value, '- one\n- two');

  bodyInput.value = 'Fast Track';
  bodyInput.setSelectionRange(0, 10);
  tools.Link.click();
  assert.equal(bodyInput.value, '[Fast Track](url)');
  assert.equal(bodyInput.value.slice(bodyInput.selectionStart, bodyInput.selectionEnd), 'url');

  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'toolbar clicks never submit');
  assert.ok(document.body.contains(form));

  dom.window.close();
});

test('saved notes reveal rendered and previews strip markdown sigils', async () => {
  const savedAnnotations = [{
    id: '2026-08-05-001',
    anchor: '#board',
    anchorKind: 'heading',
    body: 'existing **note**',
    bodyHtml: '<p>existing <strong>note</strong></p>\n',
    author: 'capturer',
    createdAt: '2026-08-05T13:00:00.000Z',
    state: 'open',
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    replies: [],
  }];
  const dom = await bootDom({
    body: `
      <button type="button" data-annotations-toggle hidden></button>
      <main>
        <article class="content markdown" data-rendered-view>
          <h1 id="board">
            Board
            <button type="button" data-annotate-trigger data-anchor-id="board" data-anchor-kind="heading">💬 Annotate</button>
          </h1>
          <section data-annotations-mount data-anchor-id="board" data-anchor-kind="heading"></section>
        </article>
        <aside data-annotations-stale hidden></aside>
      </main>
    `,
    bootstrap: {
      repo: 'docs',
      relativePath: 'doc.md',
      queryToken: null,
      supportsLineRangeAnnotations: false,
      sourceLineCount: 3,
    },
    fetchImpl: async (url, init = {}) => {
      const method = init.method || 'GET';
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        savedAnnotations.push({
          id: '2026-08-05-002',
          anchor: body.anchor,
          anchorKind: body.anchorKind,
          body: body.body,
          bodyHtml: '<p><strong>fresh</strong> note</p>\n',
          author: body.author,
          createdAt: '2026-08-05T13:05:00.000Z',
          state: 'open',
          claimedBy: null,
          claimedAt: null,
          resolvedAt: null,
          replies: [],
        });
        return {
          ok: true,
          async json() {
            return { ok: true, mtimeMs: 2, annotation: { id: '2026-08-05-002' } };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { schema: 1, file: 'docs/doc.md', mtimeMs: savedAnnotations.length, annotations: [...savedAnnotations] };
        },
      };
    },
  });

  const { document } = dom.window;
  const mount = document.querySelector('[data-annotations-mount][data-anchor-id="board"]');

  const existingPreview = mount.querySelector('details[data-annotation-id="2026-08-05-001"] .lookie-annotation-preview');
  assert.equal(existingPreview.textContent, 'existing note', 'preview strips markdown sigils via bodyHtml');

  document.querySelector('[data-annotate-trigger]').click();
  const form = mount.querySelector('.lookie-annotate-form');
  form.querySelector('input[name="author"]').value = 'capturer';
  form.querySelector('textarea[name="body"]').value = '**fresh** note';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();
  await flush();

  const fresh = mount.querySelector('details[data-annotation-id="2026-08-05-002"]');
  assert.ok(fresh, 'saved note re-rendered from refresh');
  assert.equal(fresh.open, true, 'just-saved note reveals its rendered body');
  assert.ok(fresh.querySelector('.lookie-annotation-detail strong'));
  assert.equal(fresh.querySelector('.lookie-annotation-preview').textContent, 'fresh note');

  const existing = mount.querySelector('details[data-annotation-id="2026-08-05-001"]');
  assert.equal(existing.open, false, 'other cards keep their collapsed default');

  dom.window.close();
});

test('open annotation cards hide the plain preview line', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const rule = css.match(/\.lookie-annotation-item\[open\][^{]*\.lookie-annotation-preview[^{]*\{[^}]*\}/);
  assert.ok(rule, 'open-card preview rule exists');
  assert.match(rule[0], /display:\s*none/, 'preview hides while the rendered body is visible');
  const collapsedRule = css.match(/^\.lookie-annotation-preview\s*\{[^}]*\}/m);
  assert.ok(collapsedRule, 'base preview rule still present for collapsed cards');
  assert.doesNotMatch(collapsedRule[0], /display:\s*none/, 'collapsed cards keep their one-line preview');
});
