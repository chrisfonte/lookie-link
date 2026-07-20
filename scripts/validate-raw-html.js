'use strict';

// Validates source and transformed HTML serving.
//
// Verifies:
//   * /raw/<path>.html is 404 when disabled
//   * /raw/<path>.html serves the file verbatim with text/html when enabled
//   * /raw/<path>.txt returns 415 (only .html/.htm allowed)
//   * /embed/<path>.html injects base/theme/navigation without changing /raw
//   * /embed rejects binary and invalid UTF-8 input
//   * /view uses the sanitised renderer when disabled and frames /embed when enabled
//   * /view exposes an "Open raw" toolbar link only when raw HTML is enabled
//
// Runs the real `createApp` against a tmp repo so the route/middleware wiring
// is exercised end to end.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createApp } = require('../server');

const CURRENT_ANNOTATION_SELECTORS = [
  '[data-annotations-mount]',
  '[data-annotate-trigger]',
  '[data-annotations-stale]',
  '[data-annotations-toggle]',
  '[data-rendered-view]',
];

function fetchResponse(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            headers: res.headers,
            body,
            text: body.toString('utf8'),
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
  '  <h1>Flashcards</h1>',
  '  <div id="root"></div>',
  '  <script>document.getElementById("root").textContent = "flipped";</script>',
  '</body></html>',
].join('\n');

const ODD_ENCODING_HTML = Buffer.from([
  0x3c, 0x21, 0x64, 0x6f, 0x63, 0x74, 0x79, 0x70, 0x65, 0x20, 0x68, 0x74, 0x6d, 0x6c, 0x3e,
  0x0d, 0x0a, 0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0xff, 0x3c, 0x2f, 0x70, 0x3e,
]);

async function run() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-raw-html-validate-'));

  try {
    await fs.writeFile(path.join(repoDir, 'flashcards.html'), FLASHCARDS_HTML, 'utf8');
    await fs.writeFile(path.join(repoDir, 'odd-encoding.htm'), ODD_ENCODING_HTML);
    await fs.writeFile(path.join(repoDir, 'notes.md'), '# Notes\n', 'utf8');

    const appDisabled = createApp({ mappings: { docs: repoDir }, rawHtmlEnabled: false });
    const appEnabled = createApp({
      mappings: { docs: repoDir },
      rawHtmlEnabled: true,
      annotationsEnabled: true,
    });

    const disabledServer = await listen(appDisabled);
    const enabledServer = await listen(appEnabled);

    try {
      // 1. Disabled instance: /raw/* returns 404.
      const disabledResp = await fetchResponse(disabledServer, '/raw/docs/flashcards.html');
      assert.equal(disabledResp.status, 404, '/raw/* should 404 when disabled');
      assert.match(disabledResp.text, /disabled/i, 'disabled body should say disabled');

      // 2. /raw exact-byte contract: UTF-8 and odd-encoding fixtures are unchanged.
      const enabledResp = await fetchResponse(enabledServer, '/raw/docs/flashcards.html');
      assert.equal(enabledResp.status, 200, '/raw/<.html> should 200 when enabled');
      assert.match(enabledResp.contentType, /^text\/html/, 'content-type should be text/html');
      assert.deepEqual(enabledResp.body, Buffer.from(FLASHCARDS_HTML), 'raw body should equal file bytes verbatim');
      assert.match(enabledResp.text, /<script>document.getElementById/, 'inline <script> must survive raw mode');

      const oddEncodingResp = await fetchResponse(enabledServer, '/raw/docs/odd-encoding.htm');
      assert.equal(oddEncodingResp.status, 200, '/raw odd-encoding HTML should 200');
      assert.deepEqual(oddEncodingResp.body, ODD_ENCODING_HTML, '/raw must not decode or normalize invalid UTF-8 bytes');

      // 3. /embed injection contract is separate from /raw byte identity.
      const embedResp = await fetchResponse(
        enabledServer,
        '/embed/docs/flashcards.html?lookie-theme=light&lookie-scheme=teal'
      );
      assert.equal(embedResp.status, 200, '/embed/<.html> should 200 when enabled');
      assert.equal(embedResp.headers['x-lookie-content-mode'], 'transformed-embed');
      assert.match(embedResp.text, /<base href="\/asset\/docs\/">/, '/embed injects an opaque asset base');
      assert.match(embedResp.text, /id="lookie-link-embed-theme"/, '/embed injects theme tokens');
      assert.match(embedResp.text, /data-lookie-link-theme="light"/, '/embed accepts the framed theme mode');
      assert.match(embedResp.text, /data-lookie-link-scheme="teal"/, '/embed accepts the framed color scheme');
      assert.match(embedResp.text, /lookie-link-annotations-bootstrap/, '/embed mounts annotations when enabled');
      const embedDocument = new JSDOM(embedResp.text).window.document;
      for (const selector of CURRENT_ANNOTATION_SELECTORS) {
        assert.ok(embedDocument.querySelector(selector), `/embed must emit current annotation selector ${selector}`);
      }
      const oldAnchorLinkOnly = Boolean(embedDocument.querySelector('a.anchor-link[data-anchor-id]'))
        && !embedDocument.querySelector('[data-annotations-mount][data-anchor-id]')
        && !embedDocument.querySelector('[data-annotate-trigger][data-anchor-id]');
      assert.equal(oldAnchorLinkOnly, false, '/embed must not regress to obsolete anchor-link-only annotation markup');
      assert.match(embedResp.text, /<script>document\.getElementById/, 'authored inline scripts survive /embed');
      assert.notDeepEqual(embedResp.body, enabledResp.body, '/embed is explicitly transformed');

      const rejectedEmbed = await fetchResponse(enabledServer, '/embed/docs/odd-encoding.htm');
      assert.equal(rejectedEmbed.status, 415, '/embed rejects invalid UTF-8 while /raw preserves it');

      // 4. Enabled instance: /raw rejects non-html extensions.
      const notMdResp = await fetchResponse(enabledServer, '/raw/docs/notes.md');
      assert.equal(notMdResp.status, 415, '/raw rejects non-html extensions with 415');

      // 5. Enabled instance: unknown repo returns 404.
      const unknownResp = await fetchResponse(enabledServer, '/raw/missing/flashcards.html');
      assert.equal(unknownResp.status, 404, 'unknown repo returns 404');

      // 6. Enabled instance: directory traversal blocked.
      const traversalResp = await fetchResponse(enabledServer, '/raw/docs/../../../etc/passwd');
      assert.notEqual(traversalResp.status, 200, 'directory traversal must not return 200');

      // 7. /view sanitises when disabled and frames /embed when enabled.
      const viewDisabled = await fetchResponse(disabledServer, '/view/docs/flashcards.html');
      assert.equal(viewDisabled.status, 200);
      assert.match(viewDisabled.contentType, /^text\/html/);
      assert.match(viewDisabled.text, /<title>docs\/flashcards\.html<\/title>/, '/view wraps with viewer title');
      assert.doesNotMatch(
        viewDisabled.text,
        /<script>document\.getElementById\("root"\)\.textContent = "flipped";<\/script>/,
        '/view must strip inline <script> from rendered output'
      );

      const viewEnabled = await fetchResponse(enabledServer, '/view/docs/flashcards.html');
      assert.equal(viewEnabled.status, 200);
      assert.match(
        viewEnabled.text,
        /<iframe[\s\S]*data-embedded-html[\s\S]*src="\/embed\/docs\/flashcards\.html"/,
        '/view frames trusted authored HTML through /embed'
      );
      assert.doesNotMatch(
        viewEnabled.text,
        /<iframe[\s\S]*src="\/raw\/docs\/flashcards\.html"/,
        '/view must not use the byte-preserving source route as its transformed runtime'
      );
      assert.doesNotMatch(
        viewEnabled.text,
        /<script>document\.getElementById\("root"\)\.textContent = "flipped";<\/script>/,
        '/view wrapper must not copy authored inline scripts when embed mode is enabled'
      );

      // 8. "Open raw" toolbar appears only when raw HTML is enabled.
      assert.doesNotMatch(viewDisabled.text, /Open raw/, 'disabled /view should not advertise raw mode');
      assert.match(viewEnabled.text, /Open raw/, 'enabled /view should advertise raw mode');
      assert.match(viewEnabled.text, /href="\/raw\/docs\/flashcards\.html"/, 'Open raw button should link to /raw/');

      // 9. healthz reflects rawHtmlEnabled.
      const healthDisabled = JSON.parse((await fetchResponse(disabledServer, '/healthz')).text);
      const healthEnabled = JSON.parse((await fetchResponse(enabledServer, '/healthz')).text);
      assert.equal(healthDisabled.rawHtmlEnabled, false);
      assert.equal(healthEnabled.rawHtmlEnabled, true);

      console.log('OK — /raw exact bytes and /embed injection validate as separate contracts.');
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
