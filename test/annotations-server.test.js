'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');
const { renderDocumentPage } = require('../lib/renderer');
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

test('document rendering exposes line ranges and deliberate authored-HTML annotation targets', () => {
  const shared = {
    repo: 'docs',
    repoRoot: '/tmp/example-docs',
    parentHref: '/view/docs',
    mtime: 'just now',
    size: '1 KB',
    annotationsEnabled: true,
  };

  const textHtml = renderDocumentPage({
    ...shared,
    relativePath: 'notes.txt',
    source: 'alpha\nbeta\ngamma\ndelta',
  });
  assert.match(textHtml, /"supportsLineRangeAnnotations":true/);
  assert.match(textHtml, /"sourceLineCount":4/);
  assert.match(textHtml, /data-annotations-line-range-root/);

  const authoredHtml = renderDocumentPage({
    ...shared,
    relativePath: 'report.html',
    source: '<section data-lookie-annotation-anchor="review-target"><h2>Review panel</h2></section>',
  });
  assert.match(authoredHtml, /data-lookie-annotation-anchor="review-target"/);
  assert.match(authoredHtml, /id="review-target"/);
  assert.match(authoredHtml, /data-annotate-trigger(?:="")? data-anchor-id="review-target"/);
  assert.match(authoredHtml, /data-annotations-mount(?:="")? data-anchor-id="review-target"/);
});

test('overlapping annotation creates on one file all persist with distinct ids', async () => {
  const root = await makeFixture();

  try {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_value, index) => createAnnotation(root, 'docs', 'guide.md', {
        anchor: '#guide',
        anchorKind: 'heading',
        author: 'capturer',
        body: `Concurrent note ${index}`,
      }))
    );

    const stored = await readAnnotationDocument(root, 'docs', 'guide.md');
    assert.equal(stored.document.annotations.length, 5);

    const ids = stored.document.annotations.map((annotation) => annotation.id);
    assert.equal(new Set(ids).size, 5);

    const bodies = stored.document.annotations.map((annotation) => annotation.body).sort();
    assert.deepEqual(bodies, created.map((_result, index) => `Concurrent note ${index}`).sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('annotation ids stay unique past 999 same-day annotations on one file', async () => {
  const root = await makeFixture();

  try {
    const today = new Date().toISOString().slice(0, 10);
    const sidecarPath = path.join(root, '.lookie-link', 'annotations', 'docs', 'guide.md.json');
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      schema: 1,
      file: 'docs/guide.md',
      annotations: [{
        id: `${today}-999`,
        anchor: '#guide',
        anchorKind: 'heading',
        body: 'Note 999',
        author: 'capturer',
        createdAt: new Date().toISOString(),
        state: 'open',
        claimedBy: null,
        claimedAt: null,
        resolvedAt: null,
        replies: [],
      }],
    }, null, 2)}\n`, 'utf8');

    const thousandth = await createAnnotation(root, 'docs', 'guide.md', {
      anchor: '#guide',
      anchorKind: 'heading',
      author: 'capturer',
      body: 'Note 1000',
    });
    const thousandFirst = await createAnnotation(root, 'docs', 'guide.md', {
      anchor: '#guide',
      anchorKind: 'heading',
      author: 'capturer',
      body: 'Note 1001',
    });

    assert.equal(thousandth.annotation.id, `${today}-1000`);
    assert.equal(thousandFirst.annotation.id, `${today}-1001`);

    const stored = await readAnnotationDocument(root, 'docs', 'guide.md');
    const ids = stored.document.annotations.map((annotation) => annotation.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
