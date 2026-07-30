'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDocumentPage } = require("../lib/renderer");

const OPTIONS = {
  repo: 'alpha',
  relativePath: 'docs/guide.md',
  source: '# Guide\n\nBody text.\n',
  size: '4.1 KB',
  mtime: '2026-07-21',
  parentHref: '/view/alpha/docs',
};

function render(extra = {}) {
  return renderDocumentPage({ ...OPTIONS, ...extra });
}

test('the header no longer repeats the location three times', () => {
  const html = render();

  // Breadcrumbs are the one context line. The duplicate subtitle path and the
  // separate "Back to directory" link both said the same thing.
  assert.match(html, /<nav class="breadcrumbs">/);
  assert.doesNotMatch(html, /<p class="subtitle">/);
  assert.doesNotMatch(html, /Back to directory/);
});

test('file facts live in the toolbar Properties control, not the header', () => {
  const html = render();

  // The old meta line is gone...
  assert.doesNotMatch(html, /<p class="doc-meta">/);
  // ...and the same facts are available, collapsed, in Properties.
  assert.match(html, /<details class="doc-properties toolbar-properties" name="lookie-toolbar">/);
  assert.match(html, /<summary class="toolbar-btn">Properties<\/summary>/);
  assert.match(html, /<dt>Size<\/dt><dd>4\.1 KB<\/dd>/);
  assert.match(html, /<dt>Modified<\/dt><dd>2026-07-21<\/dd>/);
  assert.match(html, /<dt>File<\/dt><dd>guide\.md<\/dd>/);
});

test('Properties renders repo and folder as links, not printed paths', () => {
  const html = render();
  assert.match(html, /<dd><a href="\/view\/alpha">alpha<\/a><\/dd>/);
  assert.match(html, /<dd><a href="\/view\/alpha\/docs">docs<\/a><\/dd>/);
});

test('Properties links carry the query token when one is in play', () => {
  // A tokenised session must not drop the token on these links, or following one
  // silently downgrades the caller.
  const html = render({ queryToken: 'read-only' });
  assert.match(html, /href="\/view\/alpha\?token=read-only"/);
  assert.match(html, /href="\/view\/alpha\/docs\?token=read-only"/);
});

test('Properties escapes hostile path and repo values', () => {
  const html = render({
    repo: 'alpha',
    relativePath: 'docs/<script>alert(1)</script>.md',
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>\.md/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\.md/);
});

test('Properties is collapsed by default so it costs no vertical space', () => {
  const html = render();
  // <details> without an `open` attribute renders collapsed.
  assert.doesNotMatch(html, /<details class="doc-properties" open/);
});

test('static assets revalidate instead of being cached blind', async () => {
  // A stylesheet fix must be visible on the next load, not up to an hour later.
  // Regression guard: this was `maxAge: '1h'`, which stopped the browser asking at
  // all, so deployed CSS changes appeared not to have worked when the server was
  // already serving the corrected file.
  const http = require('node:http');
  const {createApp} = require('../server');

  const app = createApp({mappings: {}, accessConfig: {humanDefault: 'full'}});
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const {port} = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/public/style.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-cache/);
    assert.ok(response.headers.get('etag'), 'an ETag makes revalidation cheap');
    assert.doesNotMatch(response.headers.get('cache-control'), /max-age=[1-9]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
