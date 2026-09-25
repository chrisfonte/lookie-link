'use strict';
// Guard (2026-09-25): theme CSS is live-reloadable — the server sets it AFTER
// createApp and on every theme change. A consumer that copies it once at
// construction ships pages with no custom-theme tokens (Trackers did exactly
// that: transparent glass over wallpapers on custom themes). This test sets the
// CSS after startup and requires every HTML page family to carry it. A new page
// family that renders chrome belongs in PAGES below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');

const MARKER = '--live-theme-guard-marker';

test('every HTML page family ships theme CSS that was set after startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-live-theme-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), '# Note\n\ntext\n');
  fs.writeFileSync(path.join(repo, 'docs', 'page.html'), '<!doctype html><html><body><p>x</p></body></html>');
  const templates = path.join(root, 'templates'); fs.mkdirSync(templates);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'forms', 'gym-session-entry.yaml'), path.join(templates, 'gym-session-entry.yaml'));
  const app = createApp({
    mappings: { repo }, accessConfig: { humanDefault: 'full' }, rawHtmlEnabled: true,
    formsConfig: { enabled: true, templatesPath: templates, submissionsPath: path.join(root, 'subs') },
    formsPublicOrigin: 'http://127.0.0.1', formsAudit: () => {}, customThemeCss: '',
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const get = (u) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: u }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }).on('error', reject));
  const PAGES = [
    ['document', '/view/repo/docs/note.md'],
    ['directory', '/view/repo/docs'],
    ['html viewer', '/view/repo/docs/page.html'],
    ['trackers index', '/forms'],
    ['tracker', '/forms/gym-session-entry'],
    ['tracker history', '/forms/entries'],
    ['api docs', '/api/docs'],
  ];
  try {
    app.locals.setCustomThemeCss(`:root { ${MARKER}: #abcdef; }`);
    const missing = [];
    for (const [name, url] of PAGES) {
      const r = await get(url);
      if (r.status !== 200 || !r.body.includes(MARKER)) missing.push(`${name} ${url} (${r.status})`);
    }
    assert.deepEqual(missing, [], `pages without live theme CSS: ${missing.join('; ')}`);
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
