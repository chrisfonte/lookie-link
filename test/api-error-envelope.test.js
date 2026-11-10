'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../server');

async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-api-error-'));
  const docsRoot = path.join(root, 'docs');
  await fs.mkdir(docsRoot, { recursive: true });
  await fs.writeFile(path.join(docsRoot, 'readme.md'), '# Readme\n');
  const app = createApp({ mappings: { docs: docsRoot }, editingEnabled: true, annotationsEnabled: true });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function assertEnvelope(body, code) {
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, 'object');
  assert.notEqual(body.error, null);
  assert.notEqual(typeof body.error, 'string');
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
}

test('unknown /api/ path answers 404 in the JSON error envelope', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/api/definitely-not-a-route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assertEnvelope(body, 'not_found');
    assert.equal(body.error.message, 'Not found: /api/definitely-not-a-route');
  } finally {
    await server.close();
  }
});

test('unknown non-API path keeps the text/plain 404', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/definitely-not-a-page`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.equal(await response.text(), 'Not found: /definitely-not-a-page');
  } finally {
    await server.close();
  }
});

test('unknown path answers JSON when the client prefers application/json', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/definitely-not-a-page`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(response.status, 404);
    assertEnvelope(await response.json(), 'not_found');
  } finally {
    await server.close();
  }
});

test('mutation with ?token= is rejected with query_credentials_rejected', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/api/save/docs/readme.md?token=abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Changed\n' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assertEnvelope(body, 'query_credentials_rejected');
    assert.equal(body.error.message, 'Mutation credentials must use the Authorization header.');
  } finally {
    await server.close();
  }
});

test('core JSON errors carry a specific code with the previous text as message', async () => {
  const server = await boot();
  try {
    const response = await fetch(`${server.base}/api/annotations/nope/readme.md`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assertEnvelope(body, 'unknown_repo');
    assert.equal(body.error.message, 'Unknown repository: nope');
  } finally {
    await server.close();
  }
});
