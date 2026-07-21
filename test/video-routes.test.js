'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');
const { renderPreviewHtml, renderVideoPage } = require('../lib/renderer');

const HTML_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'html', 'render-demo.htm');

function routeHandler(app, routePath) {
  const layer = app._router.stack.find((candidate) => (
    candidate.route && candidate.route.path === routePath
  ));
  assert.ok(layer, `route ${routePath} is registered`);
  return layer.route.stack[0].handle;
}

function unrestrictedAccess() {
  return {
    mode: 'unrestricted',
    queryToken: null,
    permissions: { view: true, edit: true },
    allRepos: true,
    repos: {},
  };
}

function invokeHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      headersSent: false,
      contentType: null,
      body: null,
      filePath: null,
      headers: {},
      set(name, value) {
        this.headers[String(name).toLowerCase()] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      type(value) {
        this.contentType = value;
        return this;
      },
      send(value) {
        this.body = value;
        this.headersSent = true;
        resolve(this);
        return this;
      },
      sendFile(filePath, callback) {
        this.filePath = filePath;
        this.headersSent = true;
        callback(null);
        resolve(this);
      },
    };

    Promise.resolve(handler(req, response)).catch(reject);
  });
}

test('asset handler serves each allowed video extension with its MIME type', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-video-assets-'));
  const expectedTypes = new Map([
    ['clip.mp4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['clip.mov', 'video/quicktime'],
    ['clip.m4v', 'video/mp4'],
  ]);

  try {
    await Promise.all([...expectedTypes.keys()].map((fileName) => (
      fs.writeFile(path.join(root, fileName), 'video-bytes')
    )));
    const app = createApp({ mappings: { demo: root }, editingEnabled: false });
    const handler = routeHandler(app, '/asset/:repo/*');

    for (const [fileName, mimeType] of expectedTypes) {
      const response = await invokeHandler(handler, {
        params: { repo: 'demo', 0: fileName },
        accessContext: unrestrictedAccess(),
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.contentType, mimeType);
      assert.equal(response.filePath, path.join(root, fileName));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('asset handler rejects extensions outside the allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-video-assets-'));

  try {
    const app = createApp({ mappings: { demo: root }, editingEnabled: false });
    const handler = routeHandler(app, '/asset/:repo/*');
    const response = await invokeHandler(handler, {
      params: { repo: 'demo', 0: 'clip.exe' },
      accessContext: unrestrictedAccess(),
    });

    assert.equal(response.statusCode, 415);
    assert.equal(response.contentType, 'text/plain');
    assert.equal(response.body, 'Unsupported asset type.');
    assert.equal(response.filePath, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('video page renderer builds a dedicated player with escaped metadata', () => {
  const html = renderVideoPage({
    repo: 'demo',
    relativePath: 'media/demo<clip>.webm',
    parentHref: '/view/demo/media',
    videoHref: '/asset/demo/media/demo%3Cclip%3E.webm?token=read-only',
    mimeType: 'video/webm',
    mtime: '2026-07-20',
    size: '12 KB',
  });

  assert.match(html, /<article class="content video-view">/);
  assert.match(html, /<video controls preload="metadata" src="\/asset\/demo\/media\/demo%3Cclip%3E\.webm\?token=read-only" type="video\/webm">/);
  assert.match(html, /demo&lt;clip&gt;\.webm/);
  assert.match(html, /12 KB · 2026-07-20 · video/);
});

test('document renderer embeds linked and authored video with asset URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-video-renderer-'));

  try {
    await fs.writeFile(path.join(root, 'walkthrough.mp4'), 'mp4-bytes');
    const linkedHtml = renderPreviewHtml({
      repo: 'demo',
      repoRoot: root,
      relativePath: 'guide.md',
      source: '[Watch the walkthrough](./walkthrough.mp4)\n',
      queryToken: 'viewer-token',
    });
    assert.match(linkedHtml, /<div class="video-embed">/);
    assert.match(linkedHtml, /<video controls="" preload="metadata" src="\/asset\/demo\/walkthrough\.mp4\?token=viewer-token" type="video\/mp4">/);
    assert.match(linkedHtml, /class="video-embed-link" href="\/view\/demo\/walkthrough\.mp4\?token=viewer-token"/);

    const source = await fs.readFile(HTML_FIXTURE_PATH, 'utf8');
    const authoredHtml = renderPreviewHtml({
      repo: 'demo',
      repoRoot: root,
      relativePath: 'landing.htm',
      source,
    });
    assert.match(authoredHtml, /<video controls="" src="\/asset\/demo\/walkthrough\.mp4"><\/video>/);
    assert.doesNotMatch(authoredHtml, /<script>alert\(1\)<\/script>/);

    const sourceElementHtml = renderPreviewHtml({
      repo: 'demo',
      repoRoot: root,
      relativePath: 'landing.htm',
      source: '<video controls><source src="./walkthrough.mp4" type="video/mp4"></video>',
    });
    assert.match(sourceElementHtml, /<source src="\/asset\/demo\/walkthrough\.mp4" type="video\/mp4">/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('view handler renders a video file in the dedicated viewer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-video-view-'));

  try {
    await fs.writeFile(path.join(root, 'walkthrough.mp4'), 'mp4-bytes');
    const app = createApp({ mappings: { demo: root }, editingEnabled: true });
    const handler = routeHandler(app, '/view/*');
    const response = await invokeHandler(handler, {
      params: { 0: 'demo/walkthrough.mp4' },
      accessContext: unrestrictedAccess(),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.contentType, 'html');
    assert.match(response.body, /<article class="content video-view">/);
    assert.match(response.body, /<video controls preload="metadata" src="\/asset\/demo\/walkthrough\.mp4" type="video\/mp4">/);
    assert.doesNotMatch(response.body, />Edit</);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
