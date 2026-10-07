'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

const SIZE = 4096;

async function startFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-asset-range-'));
  const repoRoot = path.join(root, 'demo');
  await fs.mkdir(repoRoot, { recursive: true });
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i += 1) bytes[i] = i % 251;
  await fs.writeFile(path.join(repoRoot, 'tone.wav'), bytes);
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# Demo\n');
  const app = createApp({ mappings: { demo: repoRoot }, editingEnabled: false, accessConfig: {} });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, bytes };
}

test('Range 0-99 answers 206 with Content-Range and the right bytes', async (t) => {
  const { base, bytes } = await startFixture(t);
  const response = await fetch(`${base}/asset/demo/tone.wav`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-99/${SIZE}`);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 100));
});

test('a suffix range answers 206 with the tail', async (t) => {
  const { base, bytes } = await startFixture(t);
  const response = await fetch(`${base}/asset/demo/tone.wav`, { headers: { Range: 'bytes=-50' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes ${SIZE - 50}-${SIZE - 1}/${SIZE}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(SIZE - 50));
});

test('an unsatisfiable range answers 416 (not 500) with Content-Range', async (t) => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/asset/demo/tone.wav`, { headers: { Range: 'bytes=99999-' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(await response.text(), 'Requested range not satisfiable.');
});

test('HEAD answers 200 with Accept-Ranges and the full length', async (t) => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/asset/demo/tone.wav`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), String(SIZE));
  assert.equal(response.headers.get('content-type'), 'audio/wav');
});

test('a plain GET still answers 200 and a missing file 404', async (t) => {
  const { base } = await startFixture(t);
  const ok = await fetch(`${base}/asset/demo/tone.wav`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, SIZE);
  const missing = await fetch(`${base}/asset/demo/missing.wav`);
  assert.equal(missing.status, 404);
});
