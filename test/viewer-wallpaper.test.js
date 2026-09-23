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
