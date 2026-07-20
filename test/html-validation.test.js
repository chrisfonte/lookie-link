'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

async function makeRepo(t, files) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-validation-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));

  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const absolutePath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
  }));
  return repoRoot;
}

function viewHandler(app) {
  const layer = app._router.stack.find((candidate) => candidate.route && candidate.route.path === '/view/*');
  assert.ok(layer, 'GET /view/* route should be registered');
  return layer.route.stack[0].handle;
}

async function requestValidation(app, requestPath, query = {}) {
  const response = {
    statusCode: 200,
    contentType: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    json(value) {
      this.contentType = 'application/json';
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
  const req = {
    params: { 0: requestPath },
    query: { validate: '1', ...query },
    headers: {},
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };

  await viewHandler(app)(req, response);
  return response;
}

test('valid HTML bundle reports local assets and document targets', async (t) => {
  const source = `<!doctype html>
<html><head><link rel="stylesheet" href="./styles.css"><script src="./app.js"></script></head>
<body><img src="./image.png"><a href="./next.html?mode=review#details">Next</a></body></html>`;
  const repoRoot = await makeRepo(t, {
    'bundle/index.html': source,
    'bundle/styles.css': 'body { color: black; }',
    'bundle/app.js': 'document.body.dataset.ready = "true";',
    'bundle/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'bundle/next.html': '<h1 id="details">Next</h1>',
  });
  const app = createApp({ mappings: { docs: repoRoot }, rawHtmlEnabled: false });

  const response = await requestValidation(app, 'docs/bundle/index.html');

  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, 'application/json');
  assert.equal(response.body.ok, true);
  assert.equal(response.body.renderMode, 'sanitized-html');
  assert.deepEqual(response.body.summary, {
    localAssetCount: 3,
    missingLocalAssetCount: 0,
    unsupportedLocalAssetCount: 0,
    navigationLinkCount: 1,
    missingNavigationTargetCount: 0,
  });
  assert.deepEqual(response.body.localAssets.map((entry) => entry.resolvedPath), [
    'bundle/styles.css',
    'bundle/app.js',
    'bundle/image.png',
  ]);
  assert.ok(response.body.localAssets.every((entry) => entry.exists));
  assert.deepEqual(response.body.navigationLinks[0], {
    tag: 'a',
    attr: 'href',
    kind: 'document',
    href: './next.html?mode=review#details',
    resolvedPath: 'bundle/next.html',
    query: '?mode=review',
    hash: '#details',
    assetUrl: '/asset/docs/bundle/next.html',
    viewUrl: '/view/docs/bundle/next.html',
    contentType: 'text/plain; charset=utf-8',
    exists: true,
    bytes: Buffer.byteLength('<h1 id="details">Next</h1>'),
    isDirectory: false,
    supportedAsset: true,
    rewrittenViewUrl: '/view/docs/bundle/next.html?mode=review#details',
    rewriteTarget: '_top',
  });
});

test('missing local asset uses a stable not-found result', async (t) => {
  const repoRoot = await makeRepo(t, {
    'bundle/index.html': '<img src="./missing.png">',
  });
  const app = createApp({ mappings: { docs: repoRoot } });

  const response = await requestValidation(app, 'docs/bundle/index.html');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.summary.missingLocalAssetCount, 1);
  assert.deepEqual(response.body.localAssets[0], {
    tag: 'img',
    attr: 'src',
    kind: 'asset',
    href: './missing.png',
    resolvedPath: 'bundle/missing.png',
    query: '',
    hash: '',
    assetUrl: '/asset/docs/bundle/missing.png',
    viewUrl: '/view/docs/bundle/missing.png',
    contentType: 'image/png',
    exists: false,
    bytes: null,
    isDirectory: false,
    supportedAsset: true,
    error: 'not_found',
  });
});

test('out-of-scope references are indistinguishable from missing references', async (t) => {
  const repoRoot = await makeRepo(t, {
    'bundle/index.html': '<img src="../private/secret.png"><img src="../public/missing.png">',
    'private/secret.png': Buffer.from('private fixture'),
  });
  const app = createApp({
    mappings: { docs: repoRoot },
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        validator: {
          secret: 'scoped-fixture-token',
          permissions: { view: true },
          repos: { docs: ['bundle/index.html', 'public/missing.png'] },
        },
      },
    },
  });

  const response = await requestValidation(app, 'docs/bundle/index.html', { token: 'scoped-fixture-token' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.summary.missingLocalAssetCount, 2);
  const results = response.body.localAssets.map((entry) => ({
    exists: entry.exists,
    bytes: entry.bytes,
    isDirectory: entry.isDirectory,
    supportedAsset: entry.supportedAsset,
    contentType: entry.contentType,
    error: entry.error,
  }));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], {
    exists: false,
    bytes: null,
    isDirectory: false,
    supportedAsset: true,
    contentType: 'image/png',
    error: 'not_found',
  });
});

test('validation response keeps the deployed schema', async (t) => {
  const repoRoot = await makeRepo(t, {
    'index.html': '<!doctype html><title>Schema</title>',
  });
  const app = createApp({ mappings: { docs: repoRoot }, rawHtmlEnabled: false });

  const response = await requestValidation(app, 'docs/index.html');

  assert.deepEqual(Object.keys(response.body), [
    'ok',
    'kind',
    'repo',
    'relativePath',
    'renderMode',
    'source',
    'urls',
    'localAssets',
    'navigationLinks',
    'summary',
  ]);
  assert.equal(response.body.kind, 'html-render-validation');
  assert.equal(response.body.repo, 'docs');
  assert.equal(response.body.relativePath, 'index.html');
  assert.deepEqual(Object.keys(response.body.source), ['bytes', 'mtimeMs', 'contentType']);
  assert.equal(response.body.source.contentType, 'text/html; charset=utf-8');
  assert.equal(typeof response.body.source.bytes, 'number');
  assert.equal(typeof response.body.source.mtimeMs, 'number');
  assert.deepEqual(response.body.urls, {
    view: '/view/docs/index.html',
    raw: null,
    asset: '/asset/docs/index.html',
    assetBase: '/asset/docs/',
  });
  assert.ok(Array.isArray(response.body.localAssets));
  assert.ok(Array.isArray(response.body.navigationLinks));
});

test('validation response never exposes absolute host paths', async (t) => {
  const repoRoot = await makeRepo(t, {
    'nested/index.html': '<img src="./image.png"><a href="./next.html">Next</a>',
    'nested/image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'nested/next.html': '<p>Next</p>',
  });
  const app = createApp({ mappings: { docs: repoRoot } });

  const response = await requestValidation(app, 'docs/nested/index.html');
  const serialized = JSON.stringify(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(serialized.includes(repoRoot), false);
  assert.equal(serialized.includes(path.dirname(repoRoot)), false);
  assert.ok(response.body.localAssets.every((entry) => !path.isAbsolute(entry.resolvedPath)));
  assert.ok(response.body.navigationLinks.every((entry) => !path.isAbsolute(entry.resolvedPath)));
});
