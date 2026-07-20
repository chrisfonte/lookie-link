'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const fs = require('node:fs/promises');

const { createApp } = require('../server');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-asset-mime-'));
  const repoRoot = path.join(root, 'demo');
  await fs.mkdir(repoRoot, { recursive: true });

  await fs.writeFile(path.join(repoRoot, 'table.csv'), 'col_a,col_b\n1,2\n3,4\n');
  await fs.writeFile(path.join(repoRoot, 'data.json'), '{"ok":true}\n');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# Demo\n');
  await fs.writeFile(path.join(repoRoot, 'blocked.exe'), 'not really executable\n');

  return {
    root,
    mappings: { demo: repoRoot },
  };
}

async function requestApp(app, targetPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    socket.on('error', reject);

    const req = new http.IncomingMessage(socket);
    req.method = 'GET';
    req.url = targetPath;
    req.headers = { host: 'localhost' };

    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => {
      const response = Buffer.concat(chunks);
      const headerEnd = response.indexOf('\r\n\r\n');
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: response.subarray(headerEnd + 4).toString('utf8'),
      });
    });

    app(req, res);
  });
}

test('GET /asset serves CSV with text/csv MIME', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const app = createApp({ mappings: fixture.mappings, editingEnabled: false, accessConfig: {} });

  const response = await requestApp(app, '/asset/demo/table.csv');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'] || '', /^text\/csv/);
  assert.match(response.body, /col_a,col_b/);
});

test('GET /asset still serves JSON and markdown as expected', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const app = createApp({ mappings: fixture.mappings, editingEnabled: false, accessConfig: {} });

  const jsonResponse = await requestApp(app, '/asset/demo/data.json');
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers['content-type'] || '', /^application\/json/);

  const markdownResponse = await requestApp(app, '/asset/demo/README.md');
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers['content-type'] || '', /^text\/markdown/);
});

test('GET /asset refuses a disallowed extension', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const app = createApp({ mappings: fixture.mappings, editingEnabled: false, accessConfig: {} });

  const response = await requestApp(app, '/asset/demo/blocked.exe');

  assert.equal(response.status, 415);
  assert.equal(response.body, 'Unsupported asset type.');
});
