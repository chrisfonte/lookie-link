'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../server.js');

// Artifact HTML executes author-supplied scripts. If it is served same-origin,
// those scripts can drive first-party mutations (/api/save, annotations, forms)
// using the viewer's own credentials — proven exploitable before this guard.
// The CSP sandbox forces an opaque origin. allow-same-origin must NEVER appear.
// /embed additionally grants click-gated top navigation (#232) so the link
// rewriter's target="_top" links work inside the /view frame; /raw does not.
const EXPECTED_RAW = 'sandbox allow-scripts allow-forms allow-popups';
const EXPECTED_EMBED = `${EXPECTED_RAW} allow-top-navigation-by-user-activation`;

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-sandbox-'));
  const repo = path.join(root, 'docs');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'artifact.html'), '<!doctype html><html><body><h1 id="t">a</h1></body></html>');
  const app = createApp({
    mappings: { docs: repo },
    accessConfig: { humanDefault: 'full' },
    rawHtmlEnabled: true,
    editingEnabled: true,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('artifact HTML is served with an opaque-origin CSP sandbox on /raw and /embed', async () => {
  await withServer(async (origin) => {
    const expectations = { raw: EXPECTED_RAW, embed: EXPECTED_EMBED };
    for (const [route, expected] of Object.entries(expectations)) {
      const response = await fetch(`${origin}/${route}/docs/artifact.html`);
      assert.equal(response.status, 200, `${route} should serve the artifact`);
      const csp = response.headers.get('content-security-policy');
      assert.equal(csp, expected, `${route} must carry the exact artifact sandbox`);
      assert.ok(!/allow-same-origin/.test(csp), `${route} must never grant allow-same-origin`);
    }
    // negative canary: /raw must NOT gain top-navigation — it is the stricter surface
    const rawCsp = (await fetch(`${origin}/raw/docs/artifact.html`)).headers.get('content-security-policy');
    assert.ok(!/allow-top-navigation/.test(rawCsp), '/raw must not grant any top-navigation');
  });
});

test('the /view wrapper frames the embedded artifact with a sandbox attribute', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/view/docs/artifact.html`)).text();
    const iframe = html.match(/<iframe[^>]*data-embedded-html[^>]*>/);
    assert.ok(iframe, '/view should frame the artifact');
    assert.match(iframe[0], /sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"/);
    assert.ok(!/allow-same-origin/.test(iframe[0]), 'iframe must never grant allow-same-origin');
  });
});

test('scriptable asset MIME types are sandboxed on /asset; ordinary files are not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-asset-'));
  const repo = path.join(root, 'docs');
  fs.mkdirSync(repo, { recursive: true });
  // SVG can carry <script>; served same-origin it is the same write primitive
  // as unsandboxed /embed was (proven exploitable in a real browser).
  fs.writeFileSync(path.join(repo, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
  fs.writeFileSync(path.join(repo, 'notes.md'), '# plain\n');
  const app = createApp({
    mappings: { docs: repo },
    accessConfig: { humanDefault: 'full' },
    editingEnabled: true,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const svg = await fetch(`${origin}/asset/docs/diagram.svg`);
    assert.equal(svg.headers.get('content-security-policy'), EXPECTED_RAW, 'SVG must be sandboxed');
    assert.ok(!/allow-same-origin/.test(svg.headers.get('content-security-policy')));
    assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');

    const md = await fetch(`${origin}/asset/docs/notes.md`);
    assert.equal(md.headers.get('content-security-policy'), null, 'non-scriptable assets need no sandbox');
    assert.equal(md.headers.get('x-content-type-options'), 'nosniff', 'but must still refuse MIME sniffing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
