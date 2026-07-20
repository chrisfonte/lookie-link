'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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
  assert.equal(document.documentElement.classList.contains('lookie-annotations-active'), false);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: dom.window.location.origin,
    data: {
      type: 'lookie-link:set-annotation-mode',
      enabled: true,
    },
  }));
  assert.equal(document.documentElement.classList.contains('lookie-annotations-active'), true);

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
