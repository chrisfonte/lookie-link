'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

const { createApp } = require('../server');
const { loadKits, kitsRevision } = require('../lib/kits');

const BUNDLED_CSS = fs.readFileSync(path.join(__dirname, '..', 'kits', 'ops', 'kit.css'));

function request(base, route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text, buf });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(options = {}) {
  const app = createApp({
    mappings: options.mappings || {},
    accessConfig: options.accessConfig === undefined ? {} : options.accessConfig,
    apiKeyStore: null,
    grantStore: null,
    managedRepoStore: null,
    publishStore: null,
    editingEnabled: false,
    annotationsEnabled: false,
    rawHtmlEnabled: false,
    kitsConfig: options.kitsConfig,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    app,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('GET /api/kits lists the bundled ops kit with version 1.26 and a revision', async () => {
  const s = await startServer();
  try {
    const res = await request(s.base, '/api/kits');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.revision, 'string');
    assert.ok(res.json.revision.length > 0);
    assert.equal(res.json.default, 'ops');
    const ops = res.json.kits.find((kit) => kit.name === 'ops');
    assert.ok(ops, 'bundled ops kit present');
    assert.equal(ops.version, '1.26');
    assert.equal(ops.source, 'bundled');
    assert.equal(ops.stylesheetUrl, '/kit/ops/kit.css');
    assert.ok(Array.isArray(ops.consumes) && ops.consumes.includes('--lookie-bg'));
  } finally {
    await s.close();
  }
});

test('kits list supports ETag 304 and rejects unknown query params', async () => {
  const s = await startServer();
  try {
    const first = await request(s.base, '/api/kits');
    assert.equal(first.status, 200);
    assert.ok(first.headers.etag);
    const again = await request(s.base, '/api/kits', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304);
    const bad = await request(s.base, '/api/kits?bogus=1');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_request');
  } finally {
    await s.close();
  }
});

test('GET /api/kits/:name shows ops and 404s unknown names with the envelope', async () => {
  const s = await startServer();
  try {
    const ok = await request(s.base, '/api/kits/ops');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.kit.name, 'ops');
    assert.ok(Array.isArray(ok.json.kit.files));
    const missing = await request(s.base, '/api/kits/no-such-kit');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.error.code, 'not_found');
  } finally {
    await s.close();
  }
});

test('kit.css is text/css and byte-equal to kits/ops/kit.css; versioned URL is immutable', async () => {
  const s = await startServer();
  try {
    const css = await request(s.base, '/kit/ops/kit.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type'] || ''), /text\/css/);
    assert.ok(css.buf.equals(BUNDLED_CSS));
    assert.equal(css.headers['cache-control'], 'no-cache');

    const versioned = await request(s.base, '/kit/ops/v/1.26/kit.css');
    assert.equal(versioned.status, 200);
    assert.ok(versioned.buf.equals(BUNDLED_CSS));
    assert.match(String(versioned.headers['cache-control'] || ''), /immutable/);

    const wrong = await request(s.base, '/kit/ops/v/0.0.0/kit.css');
    assert.equal(wrong.status, 404);
    assert.equal(wrong.json.error.code, 'not_found');
  } finally {
    await s.close();
  }
});

test('kit files route serves templates and refuses traversal and unlisted files', async () => {
  const s = await startServer();
  try {
    const ok = await request(s.base, '/kit/ops/files/research-packet-template.html');
    assert.equal(ok.status, 200);
    assert.match(ok.text, /<!DOCTYPE html>|<html/i);

    const traversal = await request(s.base, '/kit/ops/files/..%2Fkit.yaml');
    assert.equal(traversal.status, 404);

    const unlisted = await request(s.base, '/kit/ops/files/README.md');
    assert.equal(unlisted.status, 404);
    assert.equal(unlisted.json.error.code, 'not_found');
  } finally {
    await s.close();
  }
});

test('config folder kit overrides bundled by name; missing folder skipped; bare folder ignored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-kits-'));
  const kitsRoot = path.join(root, 'extra');
  const opsDir = path.join(kitsRoot, 'ops');
  const ignored = path.join(kitsRoot, 'empty-child');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.mkdirSync(ignored, { recursive: true });
  fs.writeFileSync(path.join(opsDir, 'kit.css'), '/* override */\n');
  fs.writeFileSync(path.join(opsDir, 'kit.yaml'), [
    'name: ops',
    'label: Override Ops',
    'version: "9.9.9"',
    'stylesheet: kit.css',
    'templates: []',
    'examples: []',
    'consumes: []',
    'description: Config override.',
    '',
  ].join('\n'));

  const warnings = [];
  const s = await startServer({
    kitsConfig: {
      enabled: true,
      default: 'ops',
      folders: [kitsRoot, path.join(root, 'missing-folder')],
    },
  });
  // Re-load through the public loader to observe warnings for missing folder.
  loadKits({
    folders: [kitsRoot, path.join(root, 'missing-folder')],
    enabled: true,
    default: 'ops',
    warn: (...args) => warnings.push(args.join(' ')),
  });
  try {
    const res = await request(s.base, '/api/kits');
    assert.equal(res.status, 200);
    const ops = res.json.kits.find((kit) => kit.name === 'ops');
    assert.equal(ops.version, '9.9.9');
    assert.equal(ops.source, 'config');
    assert.equal(ops.label, 'Override Ops');
    assert.ok(warnings.some((line) => /missing|skipped/i.test(line)));
    assert.equal(res.json.kits.some((kit) => kit.name === 'empty-child'), false);

    const css = await request(s.base, '/kit/ops/kit.css');
    assert.equal(css.text, '/* override */\n');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
    // Restore bundled catalog for later tests in this process.
    loadKits({ enabled: true });
  }
});

test('denied caller gets the access error on kits routes', async () => {
  const s = await startServer({
    accessConfig: { humanDefault: 'none' },
  });
  try {
    const res = await request(s.base, '/api/kits');
    assert.ok(res.status === 401 || res.status === 403);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.error && res.json.error.code);
  } finally {
    await s.close();
  }
});

test('kitsRevision is a stable non-empty hash string', () => {
  loadKits({ enabled: true });
  const a = kitsRevision();
  const b = kitsRevision();
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 8);
  assert.equal(a, b);
});
