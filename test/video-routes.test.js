'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');

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
