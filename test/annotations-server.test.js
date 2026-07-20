'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');
const {
  parseAccessConfig,
  authenticateRequest,
  canAccessPath,
} = require('../lib/access-control');
const { createAnnotation, readAnnotationDocument, updateAnnotation } = require('../lib/annotations');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-annotations-'));
  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');
  return root;
}

function getRouteHandler(app, method) {
  const routePath = '/api/annotations/:repo/*';
  const layer = app._router.stack.find((entry) => (
    entry.route && entry.route.path === routePath && entry.route.methods[method]
  ));
  assert.ok(layer, `Missing route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function requestWithToken(token, body) {
  return {
    params: { repo: 'docs', 0: 'guide.md' },
    query: { token },
    headers: {},
    body,
  };
}

test('redact operation scrubs annotation and reply payloads while preserving audit metadata', async () => {
  const root = await makeFixture();

  try {
    const created = await createAnnotation(root, 'docs', 'guide.md', {
      anchor: '#guide',
      anchorKind: 'heading',
      author: 'builder',
      body: 'Original annotation body',
    });

    const replied = await updateAnnotation(root, 'docs', 'guide.md', {
      id: created.annotation.id,
      op: 'reply',
      payload: {
        author: 'reviewer',
        body: 'Quoted payload should disappear too',
      },
      expectedMtimeMs: created.mtimeMs,
    });

    const redacted = await updateAnnotation(root, 'docs', 'guide.md', {
      id: created.annotation.id,
      op: 'redact',
      payload: {
        redactedBy: 'builder',
      },
      expectedMtimeMs: replied.mtimeMs,
    });

    assert.equal(redacted.annotation.body, '[annotation redacted]');
    assert.equal(redacted.annotation.state, 'resolved');
    assert.equal(redacted.annotation.redactedBy, 'builder');
    assert.ok(redacted.annotation.redactedAt);
    assert.equal(redacted.annotation.replies.length, 1);
    assert.equal(redacted.annotation.replies[0].body, '[reply redacted]');
    assert.equal(redacted.annotation.replies[0].redactedBy, 'builder');

    const stored = await readAnnotationDocument(root, 'docs', 'guide.md');
    const [annotation] = stored.document.annotations;
    assert.equal(annotation.body, '[annotation redacted]');
    assert.equal(annotation.state, 'resolved');
    assert.equal(annotation.redactedBy, 'builder');
    assert.equal(annotation.replies[0].body, '[reply redacted]');
    assert.equal(annotation.replies[0].redactedBy, 'builder');
    assert.doesNotMatch(JSON.stringify(annotation), /Original annotation body/);
    assert.doesNotMatch(JSON.stringify(annotation), /Quoted payload should disappear too/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('annotation mutations require write authority and view-only attempts leave the sidecar unchanged', async () => {
  const root = await makeFixture();

  try {
    const created = await createAnnotation(root, 'docs', 'guide.md', {
      anchor: '#guide',
      anchorKind: 'heading',
      author: 'builder',
      body: 'Must remain unchanged',
    });
    const sidecarPath = (await readAnnotationDocument(root, 'docs', 'guide.md')).sidecarPath;
    const before = await fs.readFile(sidecarPath);
    const app = createApp({
      mappings: { docs: root },
      annotationsEnabled: true,
      accessConfig: {
        humanDefault: 'restricted',
        tokens: {
          viewer: {
            secret: 'viewer-token',
            repos: { docs: { paths: ['*'] } },
            permissions: { view: true, write: false },
          },
        },
      },
    });
    const post = getRouteHandler(app, 'post');
    const patch = getRouteHandler(app, 'patch');

    const postRes = createMockRes();
    await post(requestWithToken('viewer-token', {
      anchor: '#guide',
      anchorKind: 'heading',
      author: 'viewer',
      body: 'Unauthorized create',
    }), postRes);
    assert.equal(postRes.statusCode, 403);

    const patchCases = [
      ['claim', { claimedBy: 'viewer' }],
      ['resolve', {}],
      ['reopen', {}],
      ['reply', { author: 'viewer', body: 'Unauthorized reply' }],
      ['redact', { redactedBy: 'viewer' }],
      ['delete', {}],
    ];
    for (const [op, payload] of patchCases) {
      const patchRes = createMockRes();
      await patch(requestWithToken('viewer-token', {
        id: created.annotation.id,
        op,
        payload,
        expectedMtimeMs: created.mtimeMs,
      }), patchRes);
      assert.equal(patchRes.statusCode, 403, `${op} should require write authority`);
    }

    const after = await fs.readFile(sidecarPath);
    assert.deepEqual(after, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy edit permission and explicit write permission normalize to write authority', () => {
  const config = parseAccessConfig({
    humanDefault: 'restricted',
    tokens: {
      legacy_writer: {
        secret: 'legacy-token',
        repos: { docs: { paths: ['*'] } },
        permissions: { view: true, edit: true },
      },
      writer: {
        secret: 'writer-token',
        repos: { docs: { paths: ['*'] } },
        permissions: { view: true, write: true },
      },
    },
  });

  for (const token of ['legacy-token', 'writer-token']) {
    const access = authenticateRequest({ query: { token }, headers: {} }, config);
    assert.equal(access.permissions.write, true);
    assert.equal(access.permissions.edit, true);
    assert.equal(canAccessPath(access, 'write', 'docs', 'guide.md'), true);
    assert.equal(canAccessPath(access, 'edit', 'docs', 'guide.md'), true);
  }
});
