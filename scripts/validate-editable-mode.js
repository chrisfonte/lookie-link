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

function buildScopedAccessConfig() {
  return {
    humanDefault: 'restricted',
    tokens: {
      docs_reader: {
        secret: 'docs-reader-token',
        repos: {
          docs: {
            paths: ['*'],
          },
        },
        permissions: {
          view: true,
          edit: false,
        },
      },
      other_reader: {
        secret: 'other-reader-token',
        repos: {
          other: {
            paths: ['*'],
          },
        },
        permissions: {
          view: true,
          edit: false,
        },
      },
    },
  };
}

async function run() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-editable-validate-'));
  const otherRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-editable-validate-other-'));
  await fs.mkdir(path.join(repoDir, 'images'));

  await fs.writeFile(path.join(repoDir, 'doc.md'), '# Hello\n\nInitial\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'config.yaml'), 'name: before\n', 'utf8');
  await fs.writeFile(
    path.join(repoDir, 'nested.yaml'),
    [
      'key:',
      '  subkey:',
      '    leaf: 1',
      '  sibling:',
      '    leaf: 2',
      'repeated path:',
      '  child: 3',
      '"repeated-path":',
      '  child: 4',
      '',
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(path.join(repoDir, 'bin.bin'), Buffer.from([0, 159, 146, 150, 0]));
  await fs.writeFile(path.join(otherRepoDir, 'doc.md'), '# Other\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'images', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Zx7kAAAAASUVORK5CYII=',
    'base64'
  ));

  const appDisabled = createApp({ mappings: { docs: repoDir }, editingEnabled: false });
  const appEnabled = createApp({ mappings: { docs: repoDir }, editingEnabled: true });
  const appAnnotationsDisabled = createApp({ mappings: { docs: repoDir }, annotationsEnabled: false });
  const appAnnotationsEnabled = createApp({ mappings: { docs: repoDir }, annotationsEnabled: true });
  const appAnnotationsScoped = createApp({
    mappings: { docs: repoDir, other: otherRepoDir },
    annotationsEnabled: true,
    accessConfig: buildScopedAccessConfig(),
  });

  const view = getRouteHandler(appEnabled, 'get', '/view/*');
  const edit = getRouteHandler(appEnabled, 'get', '/edit/*');
  const editDisabled = getRouteHandler(appDisabled, 'get', '/edit/*');
  const save = getRouteHandler(appEnabled, 'post', '/api/save/*');
  const preview = getRouteHandler(appEnabled, 'post', '/api/preview/*');
  const annotationsGet = getRouteHandler(appAnnotationsEnabled, 'get', '/api/annotations/:repo/*');
  const annotationsPost = getRouteHandler(appAnnotationsEnabled, 'post', '/api/annotations/:repo/*');
  const annotationsPatch = getRouteHandler(appAnnotationsEnabled, 'patch', '/api/annotations/:repo/*');
  const annotationsGetDisabled = getRouteHandler(appAnnotationsDisabled, 'get', '/api/annotations/:repo/*');
  const annotationsScopedGet = getRouteHandler(appAnnotationsScoped, 'get', '/api/annotations/:repo/*');
  const annotationsScopedPost = getRouteHandler(appAnnotationsScoped, 'post', '/api/annotations/:repo/*');

  {
    const res = createMockRes();
    await view({ params: { 0: 'docs/doc.md' } }, res);
    assert.equal(res.statusCode, 200, 'existing view mode failed');
    assert.equal(typeof res.body, 'string');
    assert(res.body.includes('Hello'), 'markdown content not rendered');
    assert(res.body.includes('id="hello"'), 'markdown heading anchor missing');
  }

  {
    const res = createMockRes();
    await view({ params: { 0: 'docs/nested.yaml' } }, res);
    assert.equal(res.statusCode, 200, 'nested yaml view failed');
    assert.equal(typeof res.body, 'string');
    assert(res.body.includes('id="key"'), 'top-level YAML anchor missing');
    assert(res.body.includes('id="key-subkey-leaf"'), 'nested YAML anchor missing');
    assert(res.body.includes('id="key-sibling-leaf"'), 'sibling nested YAML anchor missing');
    assert(res.body.includes('id="repeated-path-child"'), 'collision base anchor missing');
    assert(res.body.includes('id="repeated-path-child-2"'), 'collision suffix anchor missing');
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

  {
    const res = createMockRes();
    await annotationsGetDisabled({ params: { repo: 'docs', 0: 'doc.md' }, query: {} }, res);
    assert.equal(res.statusCode, 404, 'annotations-disabled gate failed');
  }

  {
    const res = createMockRes();
    await annotationsGet({ params: { repo: 'docs', 0: 'doc.md' }, query: {} }, res);
    assert.equal(res.statusCode, 200, 'annotation GET failed without sidecar');
    assert.deepEqual(res.body, {
      schema: 1,
      file: 'docs/doc.md',
      annotations: [],
    }, 'annotation GET empty shape mismatch');
  }

  let annotationId;
  let annotationMtime;
  {
    const res = createMockRes();
    await annotationsPost({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        anchor: '#hello',
        anchorKind: 'heading',
        body: 'Needs a follow-up.',
        author: 'builder',
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 201, 'annotation POST failed');
    assert.equal(res.body.ok, true, 'annotation POST missing ok');
    assert.equal(res.body.annotation.state, 'open', 'annotation POST initial state mismatch');
    assert.match(res.body.annotation.id, /^\d{4}-\d{2}-\d{2}-\d{3}$/, 'annotation id format mismatch');
    annotationId = res.body.annotation.id;
    annotationMtime = res.body.mtimeMs;

    const sidecarPath = path.join(repoDir, '.lookie-link', 'annotations', 'docs', 'doc.md.json');
    const sidecarRaw = await fs.readFile(sidecarPath, 'utf8');
    const sidecar = JSON.parse(sidecarRaw);
    assert.equal(sidecar.file, 'docs/doc.md', 'annotation sidecar file id mismatch');
    assert.equal(sidecar.annotations.length, 1, 'annotation sidecar write failed');
  }

  {
    const res = createMockRes();
    await annotationsPatch({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        id: annotationId,
        expectedMtimeMs: annotationMtime,
        op: 'claim',
        payload: { claimedBy: 'agent-bob' },
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 200, 'annotation claim failed');
    assert.equal(res.body.annotation.state, 'claimed', 'annotation claim state mismatch');
    assert.equal(res.body.annotation.claimedBy, 'agent-bob', 'annotation claim owner mismatch');
    assert.equal(typeof res.body.annotation.claimedAt, 'string', 'annotation claim timestamp missing');
    annotationMtime = res.body.mtimeMs;
  }

  {
    const res = createMockRes();
    await annotationsPatch({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        id: annotationId,
        expectedMtimeMs: annotationMtime,
        op: 'resolve',
        payload: {},
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 200, 'annotation resolve failed');
    assert.equal(res.body.annotation.state, 'resolved', 'annotation resolve state mismatch');
    assert.equal(typeof res.body.annotation.resolvedAt, 'string', 'annotation resolve timestamp missing');
    annotationMtime = res.body.mtimeMs;
  }

  {
    const res = createMockRes();
    await annotationsPatch({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        id: annotationId,
        expectedMtimeMs: annotationMtime,
        op: 'reopen',
        payload: {},
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 200, 'annotation reopen failed');
    assert.equal(res.body.annotation.state, 'open', 'annotation reopen state mismatch');
    annotationMtime = res.body.mtimeMs;
  }

  {
    const res = createMockRes();
    await annotationsPatch({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        id: annotationId,
        expectedMtimeMs: annotationMtime,
        op: 'reply',
        payload: {
          author: 'reviewer',
          body: 'Please tighten the wording.',
        },
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 200, 'annotation reply failed');
    assert.equal(res.body.annotation.replies.length, 1, 'annotation reply append failed');
    assert.equal(res.body.annotation.replies[0].author, 'reviewer', 'annotation reply author mismatch');
    annotationMtime = res.body.mtimeMs;
  }

  {
    const res = createMockRes();
    await annotationsGet({
      params: { repo: 'docs', 0: 'doc.md' },
      query: { state: 'open' },
    }, res);

    assert.equal(res.statusCode, 200, 'annotation GET filter failed');
    assert.equal(res.body.annotations.length, 1, 'annotation open filter mismatch');

    const filteredResolved = createMockRes();
    await annotationsGet({
      params: { repo: 'docs', 0: 'doc.md' },
      query: { state: 'resolved' },
    }, filteredResolved);
    assert.equal(filteredResolved.statusCode, 200, 'annotation GET resolved filter failed');
    assert.equal(filteredResolved.body.annotations.length, 0, 'annotation resolved filter mismatch after reopen');
  }

  {
    const sidecarPath = path.join(repoDir, '.lookie-link', 'annotations', 'docs', 'doc.md.json');
    const sidecarBefore = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    sidecarBefore.annotations[0].body = 'Externally updated.';
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(sidecarPath, `${JSON.stringify(sidecarBefore, null, 2)}\n`, 'utf8');

    const res = createMockRes();
    await annotationsPatch({
      params: { repo: 'docs', 0: 'doc.md' },
      body: {
        id: annotationId,
        expectedMtimeMs: annotationMtime,
        op: 'resolve',
        payload: {},
      },
      query: {},
    }, res);

    assert.equal(res.statusCode, 409, 'annotation stale mtime conflict failed');
    assert.equal(res.body.current.file, 'docs/doc.md', 'annotation stale response missing current doc');
    assert.equal(res.body.current.annotations[0].body, 'Externally updated.', 'annotation stale response did not include current annotations');
  }

  {
    const res = createMockRes();
    await annotationsScopedGet({
      params: { repo: 'other', 0: 'doc.md' },
      query: {},
      headers: { authorization: 'Bearer docs-reader-token' },
    }, res);
    assert.equal(res.statusCode, 403, 'cross-repo annotation read should be denied');
  }

  {
    const res = createMockRes();
    await annotationsScopedPost({
      params: { repo: 'other', 0: 'doc.md' },
      body: {
        anchor: '#other',
        anchorKind: 'heading',
        body: 'Should fail.',
        author: 'builder',
      },
      query: {},
      headers: { authorization: 'Bearer docs-reader-token' },
    }, res);
    assert.equal(res.statusCode, 403, 'cross-repo annotation write should be denied');
  }

  console.log('editable mode validation passed');
}

run().catch((error) => {
  console.error('editable mode validation failed:', error.message);
  process.exit(1);
});
