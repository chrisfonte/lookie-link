'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const { registerAppearanceRoutes } = require('../lib/appearance-api');
const { loadCustomThemes, loadWallpaperCatalog, getWallpaperDefaults, mergeAppearance, THEME_CSS_PROPERTIES } = require('../lib/config');

const ADMIN = 'appearance-admin-placeholder';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-appearance-'));
  const omarchy = path.join(root, 'omarchy-sunset-dark');
  fs.mkdirSync(omarchy);
  fs.writeFileSync(path.join(omarchy, '0-sunset-ember.jpg'), 'x');
  const base = {
    wallpapers: { panel_opacity: 70, blur: 10 },
    themes: {
      Sunset: { aliases: ['beach'], dark: { bg: '#111111', accent: '#ff8800' }, light: { bg: '#ffffff' }, wallpapers: { dark: omarchy } },
    },
  };
  const overlayPath = path.join(root, 'appearance.yaml');
  const managedRoot = path.join(root, 'managed');
  const app = express();
  const audits = [];
  const readState = () => {
    const config = mergeAppearance(base, fs.existsSync(overlayPath) ? require('js-yaml').load(fs.readFileSync(overlayPath, 'utf8')) : null);
    const themes = loadCustomThemes(config);
    return { themes, catalog: loadWallpaperCatalog(themes), defaults: getWallpaperDefaults(config) };
  };
  registerAppearanceRoutes(app, {
    overlayPath,
    managedRoot,
    adminTokens: { ops: { secret: ADMIN } },
    readState,
    validate(overlay) {
      const warnings = [];
      const previous = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      try { loadCustomThemes(mergeAppearance(base, overlay)); } finally { console.warn = previous; }
      return { warnings: warnings.filter((w) => !/cannot read/.test(w)) };
    },
    audit: (type, req, target, metadata) => audits.push({ type, target, metadata }),
    sendAccessError: (res) => res.status(403).end(),
    themeProperties: THEME_CSS_PROPERTIES,
  });
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve({
    root, overlayPath, managedRoot, audits, server, omarchy,
    base: 'http://127.0.0.1:' + server.address().port,
  })));
}

function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (body) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });

test('appearance read side lists what exists, hides folder paths, and supports conditional polling', async () => {
  const f = await fixture();
  try {
    const res = await request(f.base + '/api/appearance');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.revision, 0);
    assert.equal(res.json.count, 1);
    assert.deepEqual(res.json.defaults, { panelOpacity: 70, blur: 10 });
    const sunset = res.json.themes[0];
    assert.equal(sunset.id, 'sunset');
    assert.deepEqual(sunset.aliases, ['beach']);
    assert.deepEqual(sunset.wallpapers.dark, [{ id: 'ember', label: 'Ember' }]);
    assert.deepEqual(sunset.wallpapers.managed, { dark: false, light: false });
    assert.equal(res.text.includes(f.omarchy), false, 'no host paths in the read side');
    assert.equal(res.headers['cache-control'], 'no-cache');
    const again = await request(f.base + '/api/appearance', { headers: { 'if-none-match': res.headers.etag } });
    assert.equal(again.status, 304);
    const one = await request(f.base + '/api/appearance/themes/beach');
    assert.equal(one.json.theme.id, 'sunset', 'aliases resolve');
    assert.equal((await request(f.base + '/api/appearance/themes/nope')).json.error.code, 'not_found');
  } finally { f.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('appearance writes need an admin bearer, a fresh revision, and valid keys', async () => {
  const f = await fixture();
  try {
    const anon = await request(f.base + '/api/appearance', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'unauthenticated');
    const bad = await request(f.base + '/api/appearance', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' });
    assert.equal(bad.status, 403);
    const invalid = await request(f.base + '/api/appearance', { method: 'PATCH', ...json({ expectedRevision: 0, wallpapers: { blur: 99 }, themes: { Sunset: { dark: { nope: '#000' } } }, bogus: 1 }) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_request');
    assert.deepEqual(invalid.json.error.details.map((d) => d.path).sort(), ['bogus', 'themes.Sunset.dark.nope', 'wallpapers.blur']);
    const stale = await request(f.base + '/api/appearance', { method: 'PATCH', ...json({ expectedRevision: 7, wallpapers: { blur: 4 } }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');
    assert.equal(stale.json.currentRevision, 0);
    const ok = await request(f.base + '/api/appearance', { method: 'PATCH', ...json({ expectedRevision: 0, wallpapers: { blur: 4 }, themes: { Sunset: { dark: { accent: '#00ff00' }, wallpapers: { panel_opacity: 90 } }, Dusk: { dark: { bg: '#222222' } } } }) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.revision, 1);
    assert.equal(ok.json.defaults.blur, 4);
    const sunset = ok.json.themes.find((t) => t.id === 'sunset');
    assert.equal(sunset.dark.accent, '#00ff00', 'patched key');
    assert.equal(sunset.dark.bg, '#111111', 'untouched key survives');
    assert.equal(sunset.wallpapers.panelOpacity, 90);
    assert.ok(ok.json.themes.find((t) => t.id === 'dusk'), 'new theme added');
    assert.equal(fs.existsSync(f.overlayPath), true);
    assert.equal(f.audits.at(-1).type, 'appearance.update');
    // Loader-level refusal: an alias that collides with a built-in.
    const collide = await request(f.base + '/api/appearance', { method: 'PATCH', ...json({ expectedRevision: 1, themes: { Dusk: { aliases: ['slate'] } } }) });
    assert.equal(collide.status, 400);
    assert.match(collide.json.error.details[0].message, /alias/i);
    // Deletion marker removes a theme; the overlay revision advances.
    const gone = await request(f.base + '/api/appearance', { method: 'PATCH', ...json({ expectedRevision: 1, themes: { Dusk: null } }) });
    assert.equal(gone.status, 200);
    assert.equal(gone.json.themes.some((t) => t.id === 'dusk'), false);
    assert.equal(gone.json.revision, 2);
  } finally { f.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('picture upload writes only the managed folder and adopts it on first use', async () => {
  const f = await fixture();
  try {
    const refused = await request(f.base + '/api/appearance/themes/sunset/wallpapers/dark?name=new-one', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${ADMIN}` }, body: Buffer.from('png') });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'folder_not_managed', 'the dark set comes from an Omarchy folder');
    const light = await request(f.base + '/api/appearance/themes/sunset/wallpapers/light?name=Pale%20Dawn', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${ADMIN}` }, body: Buffer.from('png') });
    assert.equal(light.status, 201, light.text);
    assert.deepEqual(light.json.theme.wallpapers.light, [{ id: 'pale-dawn', label: 'Pale Dawn' }]);
    assert.equal(light.json.theme.wallpapers.managed.light, true);
    assert.ok(fs.existsSync(path.join(f.managedRoot, 'sunset', 'light', '0-pale-dawn.png')));
    const unsupported = await request(f.base + '/api/appearance/themes/sunset/wallpapers/light?name=x', { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${ADMIN}` }, body: Buffer.from('nope') });
    assert.equal(unsupported.status, 415);
    const removed = await request(f.base + '/api/appearance/themes/sunset/wallpapers/light/pale-dawn', { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json.theme.wallpapers.light, []);
    assert.equal(fs.existsSync(path.join(f.managedRoot, 'sunset', 'light', '0-pale-dawn.png')), false);
    assert.deepEqual(f.audits.map((a) => a.type), ['appearance.wallpaper.upload', 'appearance.wallpaper.delete']);
  } finally { f.server.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
