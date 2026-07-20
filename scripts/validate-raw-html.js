'use strict';

// Validates raw HTML serving.
//
// Verifies:
//   * /raw/<path>.html is 404 when disabled
//   * /raw/<path>.html serves the file verbatim with text/html when enabled
//   * /raw/<path>.txt returns 415 (only .html/.htm allowed)
//   * /view/<path>.html still wraps + sanitises (no inline <script> survives)
//   * /view exposes an "Open raw" toolbar link only when raw HTML is enabled
//
// Runs the real `createApp` against a tmp repo so the route/middleware wiring
// is exercised end to end.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

function fetchText(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const FLASHCARDS_HTML = [
  '<!doctype html>',
  '<html><head><title>Flashcards</title></head>',
  '<body>',
  '  <div id="root"></div>',
  '  <script>document.getElementById("root").textContent = "flipped";</script>',
  '</body></html>',
].join('\n');

async function run() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-raw-html-validate-'));

  try {
    await fs.writeFile(path.join(repoDir, 'flashcards.html'), FLASHCARDS_HTML, 'utf8');
    await fs.writeFile(path.join(repoDir, 'notes.md'), '# Notes\n', 'utf8');

    const appDisabled = createApp({ mappings: { docs: repoDir }, rawHtmlEnabled: false });
    const appEnabled = createApp({ mappings: { docs: repoDir }, rawHtmlEnabled: true });

    const disabledServer = await listen(appDisabled);
    const enabledServer = await listen(appEnabled);

    try {
      // 1. Disabled instance: /raw/* returns 404.
      const disabledResp = await fetchText(disabledServer, '/raw/docs/flashcards.html');
      assert.equal(disabledResp.status, 404, '/raw/* should 404 when disabled');
      assert.match(disabledResp.body, /disabled/i, 'disabled body should say disabled');

      // 2. Enabled instance: /raw/<.html> serves verbatim text/html.
      const enabledResp = await fetchText(enabledServer, '/raw/docs/flashcards.html');
      assert.equal(enabledResp.status, 200, '/raw/<.html> should 200 when enabled');
      assert.match(enabledResp.contentType, /^text\/html/, 'content-type should be text/html');
      assert.equal(enabledResp.body, FLASHCARDS_HTML, 'raw body should equal file bytes verbatim');
      assert.match(enabledResp.body, /<script>document.getElementById/, 'inline <script> must survive raw mode');

      // 3. Enabled instance: /raw rejects non-html extensions.
      const notMdResp = await fetchText(enabledServer, '/raw/docs/notes.md');
      assert.equal(notMdResp.status, 415, '/raw rejects non-html extensions with 415');

      // 4. Enabled instance: unknown repo returns 404.
      const unknownResp = await fetchText(enabledServer, '/raw/missing/flashcards.html');
      assert.equal(unknownResp.status, 404, 'unknown repo returns 404');

      // 5. Enabled instance: directory traversal blocked.
      const traversalResp = await fetchText(enabledServer, '/raw/docs/../../../etc/passwd');
      assert.notEqual(traversalResp.status, 200, 'directory traversal must not return 200');

      // 6. /view/<.html> still wraps + sanitises on both disabled and enabled.
      const viewDisabled = await fetchText(disabledServer, '/view/docs/flashcards.html');
      assert.equal(viewDisabled.status, 200);
      assert.match(viewDisabled.contentType, /^text\/html/);
      assert.match(viewDisabled.body, /<title>docs\/flashcards\.html<\/title>/, '/view wraps with viewer title');
      assert.doesNotMatch(
        viewDisabled.body,
        /<script>document\.getElementById\("root"\)\.textContent = "flipped";<\/script>/,
        '/view must strip inline <script> from rendered output'
      );

      const viewEnabled = await fetchText(enabledServer, '/view/docs/flashcards.html');
      assert.equal(viewEnabled.status, 200);
      assert.doesNotMatch(
        viewEnabled.body,
        /<script>document\.getElementById\("root"\)\.textContent = "flipped";<\/script>/,
        '/view must strip inline <script> even when raw mode is enabled'
      );

      // 7. "Open raw" toolbar appears only when raw HTML is enabled.
      assert.doesNotMatch(viewDisabled.body, /Open raw/, 'disabled /view should not advertise raw mode');
      assert.match(viewEnabled.body, /Open raw/, 'enabled /view should advertise raw mode');
      assert.match(viewEnabled.body, /href="\/raw\/docs\/flashcards\.html"/, 'Open raw button should link to /raw/');

      // 8. healthz reflects rawHtmlEnabled.
      const healthDisabled = JSON.parse((await fetchText(disabledServer, '/healthz')).body);
      const healthEnabled = JSON.parse((await fetchText(enabledServer, '/healthz')).body);
      assert.equal(healthDisabled.rawHtmlEnabled, false);
      assert.equal(healthEnabled.rawHtmlEnabled, true);

      console.log('OK — /raw HTML serving validates against the acceptance criteria.');
    } finally {
      await close(disabledServer);
      await close(enabledServer);
    }
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
