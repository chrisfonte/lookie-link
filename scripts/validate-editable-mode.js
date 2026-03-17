'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

function getRouteHandler(app, method, routePath) {
  const layer = app._router.stack.find((entry) => entry.route && entry.route.path === routePath && entry.route.methods[method]);
  assert(layer, `Missing route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    contentType: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(code, location) { this.statusCode = code; this.redirectedTo = location; return this; },
  };
}

async function run() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-editable-validate-'));
  await fs.mkdir(path.join(repoDir, 'images'));

  await fs.writeFile(path.join(repoDir, 'doc.md'), '# Hello\n\nInitial\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'config.yaml'), 'name: before\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'bin.bin'), Buffer.from([0, 159, 146, 150, 0]));
  await fs.writeFile(path.join(repoDir, 'images', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Zx7kAAAAASUVORK5CYII=',
    'base64'
  ));

  const appDisabled = createApp({ mappings: { docs: repoDir }, editingEnabled: false });
  const appEnabled = createApp({ mappings: { docs: repoDir }, editingEnabled: true });

  const view = getRouteHandler(appEnabled, 'get', '/view/*');
  const edit = getRouteHandler(appEnabled, 'get', '/edit/*');
  const editDisabled = getRouteHandler(appDisabled, 'get', '/edit/*');
  const save = getRouteHandler(appEnabled, 'post', '/api/save/*');
  const preview = getRouteHandler(appEnabled, 'post', '/api/preview/*');

  {
    const res = createMockRes();
    await view({ params: { 0: 'docs/doc.md' } }, res);
    assert.equal(res.statusCode, 200, 'existing view mode failed');
    assert.equal(typeof res.body, 'string');
    assert(res.body.includes('Hello'), 'markdown content not rendered');
  }

  {
    const res = createMockRes();
    await view({ params: { 0: 'docs/images/pixel.png' } }, res);
    assert.equal(res.statusCode, 200, 'direct image view failed');
    assert.equal(typeof res.body, 'string');
    assert(res.body.includes('/asset/docs/images/pixel.png'), 'image view did not reference asset route');
  }

  {
    const res = createMockRes();
    await editDisabled({ params: { 0: 'docs/doc.md' } }, res);
    assert.equal(res.statusCode, 404, 'editing-disabled gate failed');
  }

  let markdownMtime;
  {
    const res = createMockRes();
    await edit({ params: { 0: 'docs/doc.md' } }, res);
    assert.equal(res.statusCode, 200, 'edit route failed for markdown');
    assert.equal(typeof res.body, 'string');
    assert(res.body.includes('data-tab-btn'), 'edit/preview UX missing');

    const match = res.body.match(/"mtimeMs":(\d+)/);
    assert(match, 'missing mtime bootstrap data');
    markdownMtime = Number(match[1]);
  }

  {
    const res = createMockRes();
    await preview({
      params: { 0: 'docs/doc.md' },
      body: { content: '# Updated\n\n![img](./images/pixel.png)\n' },
    }, res);

    assert.equal(res.statusCode, 200, 'preview endpoint failed');
    assert(res.body && res.body.ok, 'preview response missing ok');
    assert(typeof res.body.html === 'string');
    assert(res.body.html.includes('/asset/docs/images/pixel.png'), 'preview image rewrite failed');
  }

  {
    const res = createMockRes();
    await save({
      params: { 0: 'docs/doc.md' },
      body: { content: '# Changed\n\nSaved\n', expectedMtimeMs: markdownMtime },
    }, res);

    const updated = await fs.readFile(path.join(repoDir, 'doc.md'), 'utf8');
    assert.equal(res.statusCode, 200, 'markdown save failed');
    assert(res.body && res.body.ok, 'markdown save response missing ok');
    assert(updated.includes('Changed'), 'markdown save did not update file');
  }

  {
    const stat = await fs.stat(path.join(repoDir, 'config.yaml'));
    const res = createMockRes();
    await save({
      params: { 0: 'docs/config.yaml' },
      body: { content: 'name: after\nenabled: true\n', expectedMtimeMs: Math.trunc(stat.mtimeMs) },
    }, res);

    const updated = await fs.readFile(path.join(repoDir, 'config.yaml'), 'utf8');
    assert.equal(res.statusCode, 200, 'yaml save failed');
    assert(res.body && res.body.ok, 'yaml save response missing ok');
    assert(updated.includes('after'), 'yaml save did not update file');
  }

  {
    const res = createMockRes();
    await save({ params: { 0: 'docs/images' }, body: { content: 'x' } }, res);
    assert.equal(res.statusCode, 400, 'directory rejection failed');
  }

  {
    const res = createMockRes();
    await save({ params: { 0: 'docs/bin.bin' }, body: { content: 'x' } }, res);
    assert.equal(res.statusCode, 415, 'binary rejection failed');
  }

  {
    const res = createMockRes();
    await save({ params: { 0: 'docs/../../etc/passwd' }, body: { content: 'x' } }, res);
    assert.equal(res.statusCode, 403, 'path traversal should be blocked');
  }

  {
    const stat = await fs.stat(path.join(repoDir, 'doc.md'));
    await fs.writeFile(path.join(repoDir, 'doc.md'), '# External write\n', 'utf8');

    const res = createMockRes();
    await save({
      params: { 0: 'docs/doc.md' },
      body: { content: '# local\n', expectedMtimeMs: Math.trunc(stat.mtimeMs) },
    }, res);

    assert.equal(res.statusCode, 409, 'stale mtime conflict failed');
  }

  console.log('editable mode validation passed');
}

run().catch((error) => {
  console.error('editable mode validation failed:', error.message);
  process.exit(1);
});
