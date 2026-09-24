'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const { createApp } = require('../server');

const ADMIN_TOKEN = 'validate-kit-admin-token';
const OPS_CSS = fsSync.readFileSync(path.join(__dirname, '..', 'kits', 'ops', 'kit.css'), 'utf8');

async function makeMappedRepo(t, files) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-validate-kit-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const absolutePath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
  }));
  return repoRoot;
}

async function makePublishFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-validate-kit-pub-'));
  const sourceRepo = path.join(root, 'private-source');
  await fs.mkdir(sourceRepo);
  await fs.writeFile(path.join(sourceRepo, 'secret.md'), '# not published\n');
  return {
    root,
    sourceRepo,
    publishArea: path.join(root, 'publish-area'),
    apiKeyStorePath: path.join(root, 'agent-api-keys.yaml'),
  };
}

async function startPublishServer(fixture) {
  const app = createApp({
    mappings: { secret: fixture.sourceRepo },
    rawHtmlEnabled: true,
    accessConfig: {
      humanDefault: 'restricted',
      apiKeys: {
        storePath: fixture.apiKeyStorePath,
        adminTokens: { operator: { secret: ADMIN_TOKEN } },
      },
    },
    publishConfig: { areaPath: fixture.publishArea },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    async request(targetPath, init) {
      return fetch(`http://127.0.0.1:${address.port}${targetPath}`, init);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function createKey(server) {
  const response = await server.request('/api/agent-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Validate kit',
      subject: { companyId: 'example', agentId: `agent-${Date.now()}`, label: 'Validate kit' },
      permissions: { view: true, publish: true },
      repos: { published: true },
      issuer: { actorType: 'operator', actorId: 'test' },
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
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

test('published kit:ops page detects ops 1.26, not stale, no kit warnings', async () => {
  const fixture = await makePublishFixture();
  const server = await startPublishServer(fixture);
  try {
    const { token } = await createKey(server);
    const placeholder = [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<link rel="stylesheet" href="kit.css" data-kit>',
      '<title>Kit</title></head><body><h1>Hi</h1></body></html>',
    ].join('');
    const created = await server.request('/api/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'kit-validate',
        kit: 'ops',
        entryPath: 'index.html',
        files: [{ path: 'index.html', content: placeholder }],
      }),
    });
    assert.equal(created.status, 201, await created.text());

    const validate = await server.request('/view/published/kit-validate/index.html?validate=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(validate.status, 200);
    const report = await validate.json();
    assert.equal(report.kit.detected.name, 'ops');
    assert.equal(report.kit.detected.version, '1.26');
    assert.equal(report.kit.source, 'inline-style');
    assert.equal(report.kit.current.name, 'ops');
    assert.equal(report.kit.current.version, '1.26');
    assert.equal(report.kit.stale, false);
    assert.deepEqual(report.kit.warnings, []);
    assert.equal(report.summary.kitWarningCount, 0);
    assert.ok(report.pageContract);
    assert.equal(typeof report.summary.contractWarningCount, 'number');
  } finally {
    await server.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('hand-inlined unmarked kit warns kit-inlined-unmarked', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html><head>',
      `<style>${OPS_CSS}</style>`,
      '</head><body><h1>Unmarked</h1></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.kit.source, 'inline-unmarked');
  assert.equal(response.body.kit.detected.name, 'ops');
  assert.ok(response.body.kit.warnings.includes('kit-inlined-unmarked'));
  assert.equal(response.body.summary.kitWarningCount, response.body.kit.warnings.length);
});

test('placeholder link left in place warns kit-placeholder-not-inlined', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="kit.css" data-kit>',
      '</head><body></body></html>',
    ].join(''),
    'kit.css': 'body{}',
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.kit.source, 'link');
  assert.ok(response.body.kit.warnings.includes('kit-placeholder-not-inlined'));
});

test('older data-kit-version warns kit-stale', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html><head>',
      '<style data-kit="ops" data-kit-version="1.0">/* old */</style>',
      '</head><body></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.kit.detected.version, '1.0');
  assert.equal(response.body.kit.stale, true);
  assert.ok(response.body.kit.warnings.includes('kit-stale'));
  assert.equal(response.body.kit.current.version, '1.26');
});

test('theme-follow declared without tokens warns theme-follow-inert', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html data-lookie-follow-theme><head>',
      '<style>body{color:red}</style>',
      '</head><body><h1>x</h1></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.pageContract.themeFollow.declared, true);
  assert.equal(response.body.pageContract.themeFollow.consumesTokens, false);
  assert.ok(response.body.pageContract.warnings.includes('theme-follow-inert'));
});

test('topnav without viewport mode warns sticky-nav-without-viewport-mode', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html><head>',
      '<style>section{scroll-margin-top:3rem}</style>',
      '</head><body><nav class="topnav"><a href="#a">A</a></nav>',
      '<section id="a">A</section></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.pageContract.renderMode, 'content-height');
  assert.equal(response.body.pageContract.stickyNav.present, true);
  assert.ok(response.body.pageContract.warnings.includes('sticky-nav-without-viewport-mode'));
});

test('overflow-x hidden on body warns overflow-x-hidden-kills-sticky', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html data-lookie-render="viewport"><head>',
      '<style>body{overflow-x:hidden} section{scroll-margin-top:3rem}</style>',
      '</head><body><nav class="topnav">n</nav><section id="a">A</section></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.pageContract.stickyNav.overflowXHiddenOnAncestor, true);
  assert.ok(response.body.pageContract.warnings.includes('overflow-x-hidden-kills-sticky'));
});

test('clean viewport page with scroll-margin has zero contract warnings', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html data-lookie-render="viewport" data-lookie-follow-theme><head>',
      '<style>',
      '[data-lookie-follow-theme]{--accent:var(--lookie-link,#315f8c)}',
      'section{scroll-margin-top:3rem}',
      '</style>',
      '</head><body><nav class="topnav"><a href="#a">A</a></nav>',
      '<section id="a">A</section></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.pageContract.renderMode, 'viewport');
  assert.equal(response.body.pageContract.stickyNav.present, true);
  assert.equal(response.body.pageContract.stickyNav.sectionScrollMargin, true);
  assert.deepEqual(response.body.pageContract.warnings, []);
  assert.equal(response.body.summary.contractWarningCount, 0);
});

test('markdown target ignores validate=1 (no kit/pageContract keys)', async () => {
  const fixture = await makePublishFixture();
  const mapped = path.join(fixture.root, 'mapped');
  await fs.mkdir(mapped);
  await fs.writeFile(path.join(mapped, 'notes.md'), '# Hello\n');
  const app = createApp({
    mappings: { docs: mapped, secret: fixture.sourceRepo },
    rawHtmlEnabled: true,
    accessConfig: {
      humanDefault: 'open',
    },
    publishConfig: { areaPath: fixture.publishArea },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/view/docs/notes.md?validate=1`);
    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type') || '';
    assert.equal(contentType.includes('application/json'), false);
    const text = await response.text();
    assert.equal(text.includes('"kit"'), false);
    assert.equal(text.includes('"pageContract"'), false);
    assert.match(text, /Hello/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('the meta form of the render-mode hint counts as viewport, like the embed runtime', async (t) => {
  const repoRoot = await makeMappedRepo(t, {
    'page.html': [
      '<!doctype html><html><head><meta name="lookie-render" content="viewport">',
      '<style>section{scroll-margin-top:3rem}</style>',
      '</head><body><nav class="topnav"><a href="#a">A</a></nav><section id="a">A</section></body></html>',
    ].join(''),
  });
  const app = createApp({ mappings: { docs: repoRoot } });
  const response = await requestValidation(app, 'docs/page.html');
  assert.equal(response.body.pageContract.renderMode, 'viewport');
  assert.ok(!response.body.pageContract.warnings.includes('sticky-nav-without-viewport-mode'));
});
