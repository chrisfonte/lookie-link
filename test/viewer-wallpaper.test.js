'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {JSDOM} = require('jsdom');
const {loadWallpaperCatalog} = require('../lib/config');
const wallpaper = require('../lib/viewer-wallpaper');
const {wallpaperControlsHtml} = require('../lib/embed-wallpaper');

function tempSet(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-wallpapers-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
}

test('wallpaper catalog scans folders into ordered, labelled, id-safe entries', () => {
  const dark = tempSet(['10-sunset-cloud-bands.jpg', '0-sunset-ember-ripples.jpg', '2-sunset-sun-through-oak.PNG', 'notes.txt', 'Weird Name!.webp']);
  const light = tempSet([]);
  const catalog = loadWallpaperCatalog([{slug:'sunset', label:'Sunset', wallpapers:{dark, light}}, {slug:'plain', label:'Plain'}]);
  assert.deepEqual(Object.keys(catalog), ['sunset']);
  assert.deepEqual(catalog.sunset.dark.map(e => e.id), ['ember-ripples', 'sun-through-oak', 'cloud-bands', 'weird-name']);
  assert.equal(catalog.sunset.dark[0].label, 'Ember Ripples');
  assert.equal(catalog.sunset.dark[0].file, path.join(dark, '0-sunset-ember-ripples.jpg'));
  assert.deepEqual(catalog.sunset.light, []);
});

test('missing wallpaper folders warn and yield an empty set', () => {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const catalog = loadWallpaperCatalog([{slug:'gone', label:'Gone', wallpapers:{dark:'/nonexistent/lookie-wallpapers'}}]);
    assert.deepEqual(catalog, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot read/);
  } finally { console.warn = previous; }
});

test('wallpaper files resolve only by catalog id, through aliases, and never leak paths', () => {
  const dark = tempSet(['1-sunset-dusk.jpg']);
  wallpaper.setWallpaperCatalog(loadWallpaperCatalog([{slug:'sunset', label:'Sunset', aliases:['beach'], wallpapers:{dark}}]), [{slug:'sunset', aliases:['beach']}]);
  try {
    assert.equal(wallpaper.resolveWallpaperFile('sunset', 'dark', 'dusk'), path.join(dark, '1-sunset-dusk.jpg'));
    assert.equal(wallpaper.resolveWallpaperFile('beach', 'dark', 'dusk'), path.join(dark, '1-sunset-dusk.jpg'));
    assert.equal(wallpaper.resolveWallpaperFile('sunset', 'light', 'dusk'), null);
    assert.equal(wallpaper.resolveWallpaperFile('sunset', 'dark', '../1-sunset-dusk.jpg'), null);
    assert.equal(wallpaper.resolveWallpaperFile('other', 'dark', 'dusk'), null);
    const pub = wallpaper.publicCatalog();
    assert.deepEqual(pub.sunset.dark, [{id:'dusk', label:'Dusk'}]);
    assert.deepEqual(pub.beach, pub.sunset);
    assert.equal(JSON.stringify(pub).includes(dark), false);
    assert.match(wallpaper.viewerWallpaperScript('n0nce'), /<script nonce="n0nce">/);
  } finally { wallpaper.setWallpaperCatalog({}); }
});

test('viewer runtime follows the theme, persists picks, and remembers no background', () => {
  const dark = tempSet(['0-sunset-a.jpg', '1-sunset-b.jpg']);
  wallpaper.setWallpaperCatalog(loadWallpaperCatalog([{slug:'sunset', label:'Sunset', wallpapers:{dark}}]));
  let dom;
  try {
    const html = `<!doctype html><html data-color-scheme="sunset"><body>${wallpaper.viewerWallpaperHtml()}<div class="viewer-toolbar">${wallpaperControlsHtml()}</div>${wallpaper.viewerWallpaperScript()}</body></html>`;
    dom = new JSDOM(html, {runScripts:'dangerously', url:'http://localhost/'});
    const win = dom.window, root = win.document.documentElement;
    const img = win.document.querySelector('[data-viewer-wallpaper] img');
    const menu = win.document.querySelector('[data-wallpaper-menu]');
    assert.equal(root.getAttribute('data-wallpaper'), 'on');
    assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/a');
    assert.equal(menu.hidden, false);
    menu.querySelector('[data-wallpaper-next]').click();
    assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/b');
    assert.equal(JSON.parse(win.localStorage.getItem('lookie-link-wallpaper')).choices.sunset, 'b');
    // Light mode has no set: plain page, menu explains.
    root.setAttribute('data-theme', 'light');
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      assert.equal(root.getAttribute('data-wallpaper'), 'off');
      assert.equal(menu.querySelector('[data-wallpaper-empty]').hidden, false);
      root.removeAttribute('data-theme');
      return new Promise((resolve) => setTimeout(resolve, 0));
    }).then(() => {
      assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/b');
      const select = menu.querySelector('[data-wallpaper-choice]');
      select.value = 'none'; select.dispatchEvent(new win.Event('change'));
      assert.equal(root.getAttribute('data-wallpaper'), 'off');
      assert.equal(JSON.parse(win.localStorage.getItem('lookie-link-wallpaper')).off, true);
      menu.querySelector('[data-wallpaper-reset]').click();
      assert.equal(root.getAttribute('data-wallpaper'), 'on');
      assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/a');
      const range = menu.querySelector('[data-wallpaper-opacity]');
      range.value = '90'; range.dispatchEvent(new win.Event('input'));
      assert.equal(root.style.getPropertyValue('--wallpaper-panel'), '90%');
    }).finally(() => { dom.window.close(); wallpaper.setWallpaperCatalog({}); });
  } catch (error) {
    if (dom) dom.window.close();
    wallpaper.setWallpaperCatalog({});
    throw error;
  }
});

test('URL parameters select wallpaper, panel and blur for this page only', () => {
  const dark = tempSet(['0-sunset-a.jpg', '1-sunset-b.jpg']);
  wallpaper.setWallpaperCatalog(loadWallpaperCatalog([{slug:'sunset', label:'Sunset', wallpapers:{dark}}]));
  const {themeScript, setThemeList} = require('../lib/renderer');
  setThemeList([{slug:'sunset', label:'Sunset'}]);
  const html = `<!doctype html><html data-color-scheme="sunset"><body>${wallpaper.viewerWallpaperHtml()}<div class="viewer-toolbar">${wallpaperControlsHtml()}</div><a id="l" href="/view/x">x</a>${themeScript()}${wallpaper.viewerWallpaperScript()}</body></html>`;
  const dom = new JSDOM(html, {runScripts:'dangerously', url:'http://localhost/view/y?lookie-scheme=sunset&lookie-wallpaper=b&lookie-panel=85&lookie-blur=3'});
  try {
    const win = dom.window, root = win.document.documentElement;
    const img = win.document.querySelector('[data-viewer-wallpaper] img');
    assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/b');
    assert.equal(root.style.getPropertyValue('--wallpaper-panel'), '85%');
    assert.equal(root.style.getPropertyValue('--wallpaper-blur'), '3px');
    assert.equal(win.localStorage.getItem('lookie-link-wallpaper'), null, 'URL overrides are not saved');
    const link = new win.URL(win.document.getElementById('l').href);
    assert.equal(link.searchParams.get('lookie-wallpaper'), 'b');
    assert.equal(link.searchParams.get('lookie-panel'), '85');
    win.document.querySelector('[data-wallpaper-next]').click();
    assert.equal(img.getAttribute('src'), '/wallpaper/sunset/dark/a');
    assert.equal(new win.URL(win.location.href).searchParams.get('lookie-wallpaper'), 'a');
    assert.equal(new win.URL(win.document.getElementById('l').href).searchParams.get('lookie-wallpaper'), 'a');
  } finally { dom.window.close(); wallpaper.setWallpaperCatalog({}); setThemeList(null); }
});

test('glass defaults and starting picture come from config, per theme over global', () => {
  const dark = tempSet(['0-sunset-a.jpg', '1-sunset-b.jpg']);
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let catalog;
  try {
    catalog = loadWallpaperCatalog([
      {slug:'sunset', label:'Sunset', wallpapers:{dark, default:{dark:'b', light:'missing'}, panelOpacity:88, blur:2}},
    ]);
  } finally { console.warn = previous; }
  assert.deepEqual(catalog.sunset.dark.map(e => e.id), ['b', 'a'], 'configured default leads the set');
  assert.equal(warnings.length, 0, 'a default for a mode with no folder is silently ignored');
  wallpaper.setWallpaperCatalog(catalog, [], {panelOpacity: 60, blur: 4});
  try {
    assert.equal(wallpaper.publicCatalog().sunset.panelOpacity, 88);
    assert.equal(wallpaper.publicCatalog().sunset.blur, 2);
    const html = `<!doctype html><html data-color-scheme="sunset"><body>${wallpaper.viewerWallpaperHtml()}<div class="viewer-toolbar">${wallpaperControlsHtml()}</div>${wallpaper.viewerWallpaperScript()}</body></html>`;
    const dom = new JSDOM(html, {runScripts:'dangerously', url:'http://localhost/'});
    try {
      const root = dom.window.document.documentElement;
      assert.equal(root.style.getPropertyValue('--wallpaper-panel'), '88%');
      assert.equal(root.style.getPropertyValue('--wallpaper-blur'), '2px');
      assert.equal(dom.window.document.querySelector('[data-viewer-wallpaper] img').getAttribute('src'), '/wallpaper/sunset/dark/b');
    } finally { dom.window.close(); }
  } finally { wallpaper.setWallpaperCatalog({}, [], {panelOpacity: 72, blur: 12}); }
});

test('wallpaper watcher rescans after a folder change without a restart', async () => {
  const dark = tempSet(['0-sunset-a.jpg']);
  const seen = [];
  let calls = 0;
  const watcher = wallpaper.watchWallpapers({
    fs, path, quietMs: 50, log: (m) => seen.push(m), warn: () => {},
    reload() {
      calls += 1;
      const catalog = loadWallpaperCatalog([{slug:'sunset', label:'Sunset', wallpapers:{dark}}]);
      wallpaper.setWallpaperCatalog(catalog);
      return { watch: [dark], summary: `${catalog.sunset.dark.length} pictures` };
    },
  });
  try {
    assert.equal(calls, 1);
    assert.equal(wallpaper.publicCatalog().sunset.dark.length, 1);
    fs.writeFileSync(path.join(dark, '1-sunset-b.jpg'), 'x');
    const started = Date.now();
    while (calls < 2 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls, 2, 'folder change triggered one rescan');
    assert.equal(wallpaper.publicCatalog().sunset.dark.length, 2);
    assert.match(seen.at(-1), /Themes reloaded: 2 pictures/);
  } finally { watcher.close(); wallpaper.setWallpaperCatalog({}); }
});

test('theme CSS swaps live through app.locals.setCustomThemeCss', async () => {
  const {createApp} = require('../server');
  const app = createApp({mappings:{}, accessConfig:{}, apiKeyStore:null, grantStore:null, managedRepoStore:null, publishStore:null, editingEnabled:false, annotationsEnabled:false, rawHtmlEnabled:false, customThemeCss:'/* before */'});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.match(await (await fetch(base + '/')).text(), /\/\* before \*\//);
    app.locals.setCustomThemeCss('/* after */');
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /\/\* after \*\//);
    assert.doesNotMatch(html, /\/\* before \*\//);
  } finally { server.close(); }
});

test('the agent card advertises the appearance surface', async () => {
  const dark = tempSet(['0-sunset-a.jpg']);
  const catalog = loadWallpaperCatalog([{slug:'sunset', label:'Sunset', wallpapers:{dark}}]);
  const {createApp} = require('../server');
  const {setThemeList} = require('../lib/renderer');
  setThemeList([{slug:'slate', label:'Slate'}, {slug:'sunset', label:'Sunset', aliases:['beach']}]);
  const app = createApp({mappings:{}, accessConfig:{}, apiKeyStore:null, grantStore:null, managedRepoStore:null, publishStore:null, editingEnabled:false, annotationsEnabled:false, rawHtmlEnabled:false, wallpaperCatalog:catalog, wallpaperThemes:[{slug:'sunset', aliases:['beach']}], wallpaperDefaults:{panelOpacity:66, blur:5}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const card = await (await fetch('http://127.0.0.1:' + server.address().port + '/.well-known/agent.json')).json();
    assert.deepEqual(card.themes.parameters, {scheme:'lookie-scheme', mode:'lookie-theme', wallpaper:'lookie-wallpaper', panelOpacity:'lookie-panel', blur:'lookie-blur'});
    assert.equal(card.themes.wallpapers.imageUrl, '/wallpaper/{scheme}/{mode}/{id}');
    assert.equal(card.themes.wallpapers.panelOpacity.default, 66);
    const sunset = card.themes.available.find((t) => t.id === 'sunset');
    assert.deepEqual(sunset.wallpapers.dark, [{id:'a', label:'A'}]);
    assert.equal(sunset.wallpapers.blur, 5);
    assert.deepEqual(card.themes.available.find((t) => t.id === 'slate').wallpapers.dark, []);
    assert.equal(JSON.stringify(card).includes(dark), false, 'no folder paths leak');
  } finally { server.close(); setThemeList(null); wallpaper.setWallpaperCatalog({}, [], {panelOpacity:72, blur:12}); }
});
