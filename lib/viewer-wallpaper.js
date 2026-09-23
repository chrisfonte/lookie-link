'use strict';

// Viewer-wide wallpapers. The server scans each theme's configured folders at
// startup (lib/config.js loadWallpaperCatalog); this module holds that catalog,
// resolves image requests by id (never by path), and ships the client runtime
// that paints the picture behind every page built on the shared shell.
//
// The embedded-HTML page is the one exception: its sandboxed frame is opaque,
// so there the document supplies its own pictures over the message bridge in
// lib/embed-wallpaper.js and this runtime is not injected.

const path = require('node:path');

let _catalog = {};
let _aliases = {};

function setWallpaperCatalog(catalog, themes = []) {
  _catalog = catalog && typeof catalog === 'object' ? catalog : {};
  _aliases = {};
  for (const theme of themes) {
    for (const alias of theme.aliases || []) _aliases[alias] = theme.slug;
  }
}

function hasWallpapers() {
  return Object.keys(_catalog).length > 0;
}

function canonicalSlug(slug) {
  return _aliases[slug] || slug;
}

// Path on disk for one catalog entry, or null. Ids come from the catalog, so a
// request can only ever name a file the scan already admitted.
function resolveWallpaperFile(slug, mode, id) {
  const sets = _catalog[canonicalSlug(String(slug || ''))];
  if (!sets || (mode !== 'dark' && mode !== 'light')) return null;
  const entry = sets[mode].find((item) => item.id === id);
  return entry ? entry.file : null;
}

function contentTypeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return 'image/jpeg';
  }
}

// What the page sees: ids and labels only, keyed by canonical slug and by
// every alias, so the client can index straight off data-color-scheme.
function publicCatalog() {
  const out = {};
  for (const [slug, sets] of Object.entries(_catalog)) {
    out[slug] = {
      dark: sets.dark.map(({ id, label }) => ({ id, label })),
      light: sets.light.map(({ id, label }) => ({ id, label })),
    };
  }
  for (const [alias, slug] of Object.entries(_aliases)) {
    if (out[slug]) out[alias] = out[slug];
  }
  return out;
}

function viewerWallpaperRuntime() {
  var root = document.documentElement;
  var node = document.getElementById('lookie-link-wallpapers');
  var menu = document.querySelector('[data-wallpaper-menu]');
  var layer = document.querySelector('[data-viewer-wallpaper]');
  if (!node || !menu || !layer) return;
  var catalog;
  try { catalog = JSON.parse(node.textContent || '{}'); } catch (_) { return; }
  var image = layer.querySelector('img');
  var choice = menu.querySelector('[data-wallpaper-choice]');
  var previous = menu.querySelector('[data-wallpaper-previous]');
  var next = menu.querySelector('[data-wallpaper-next]');
  var opacity = menu.querySelector('[data-wallpaper-opacity]');
  var blur = menu.querySelector('[data-wallpaper-blur]');
  var note = menu.querySelector('[data-wallpaper-empty]');
  var DEFAULTS = {opacity: 72, blur: 12};
  var KEY = 'lookie-link-wallpaper';
  var state = load();
  var catalogKey = '';
  // Link-scoped overrides (?lookie-wallpaper=, ?lookie-panel=, ?lookie-blur=)
  // win on this page only; they are not saved unless the reader then changes
  // something, exactly like ?lookie-scheme=.
  var urlApi = window.lookieLinkUrl || {get: function () { return null; }, set: function () {}};
  var urlWallpaper = urlApi.get('lookie-wallpaper');
  if (urlApi.get('lookie-panel')) state.opacity = Number(urlApi.get('lookie-panel'));
  if (urlApi.get('lookie-blur')) state.blur = Number(urlApi.get('lookie-blur'));

  function load() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
    var s = {choices: {}, off: false, opacity: DEFAULTS.opacity, blur: DEFAULTS.blur};
    if (saved && typeof saved === 'object') {
      if (saved.choices && typeof saved.choices === 'object') s.choices = saved.choices;
      s.off = saved.off === true;
      if (Number.isInteger(saved.opacity) && saved.opacity >= 50 && saved.opacity <= 100) s.opacity = saved.opacity;
      if (Number.isInteger(saved.blur) && saved.blur >= 0 && saved.blur <= 16) s.blur = saved.blur;
    }
    return s;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }
  function scheme() { return root.getAttribute('data-color-scheme') || 'slate'; }
  function mode() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function list() {
    var sets = catalog[scheme()];
    return sets && Array.isArray(sets[mode()]) ? sets[mode()] : [];
  }
  // Which picture shows for the current theme: the saved pick for this theme
  // if it still exists, else the set's first. An explicit "No background"
  // is remembered across themes until a picture is chosen again.
  function current(items) {
    if (urlWallpaper === 'none') return 'none';
    if (urlWallpaper && items.some(function (item) { return item.id === urlWallpaper; })) return urlWallpaper;
    if (state.off || !items.length) return 'none';
    var saved = state.choices[scheme()];
    for (var i = 0; i < items.length; i++) if (items[i].id === saved) return saved;
    return items[0].id;
  }
  function themeLabel() {
    var item = document.querySelector('[data-theme-item][aria-current="true"]');
    return item ? item.textContent.trim() : scheme();
  }
  function apply() {
    var items = list();
    var id = current(items);
    var on = id !== 'none';
    if (on) {
      var src = '/wallpaper/' + encodeURIComponent(scheme()) + '/' + mode() + '/' + encodeURIComponent(id);
      if (image.getAttribute('src') !== src) {
        image.classList.remove('is-ready');
        image.src = src;
      }
    }
    root.setAttribute('data-wallpaper', on ? 'on' : 'off');
    root.style.setProperty('--wallpaper-panel', state.opacity + '%');
    root.style.setProperty('--wallpaper-blur', state.blur + 'px');
    // Menu.
    var key = JSON.stringify(items);
    if (key !== catalogKey) {
      catalogKey = key;
      choice.replaceChildren();
      [{id: 'none', label: 'No background'}].concat(items).forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        choice.appendChild(option);
      });
    }
    var empty = !items.length;
    previous.disabled = empty;
    next.disabled = empty;
    choice.disabled = empty;
    choice.options[0].textContent = empty ? 'No backgrounds' : 'No background';
    note.hidden = !empty;
    note.textContent = empty ? themeLabel() + ' has no background set. Pick another theme in the bar.' : '';
    choice.value = id;
    opacity.value = state.opacity;
    blur.value = state.blur;
    menu.querySelector('[data-wallpaper-opacity-value]').textContent = state.opacity + '%';
    menu.querySelector('[data-wallpaper-blur-value]').textContent = state.blur ? state.blur + ' px' : 'Off';
  }
  function pick(id) {
    urlWallpaper = null;
    if (id === 'none') {
      state.off = true;
    } else {
      state.off = false;
      state.choices[scheme()] = id;
    }
    save();
    urlApi.set('lookie-wallpaper', id);
    apply();
  }
  function cycle(step) {
    var items = list();
    if (!items.length) return;
    var ids = items.map(function (item) { return item.id; });
    var index = ids.indexOf(current(items));
    pick(ids[index < 0 ? (step > 0 ? 0 : ids.length - 1) : (index + step + ids.length) % ids.length]);
  }
  image.addEventListener('load', function () { image.classList.add('is-ready'); });
  image.addEventListener('error', function () {
    // A missing file must not leave the page frosted over nothing.
    root.setAttribute('data-wallpaper', 'off');
  });
  choice.addEventListener('change', function () { pick(choice.value); });
  previous.addEventListener('click', function () { cycle(-1); });
  next.addEventListener('click', function () { cycle(1); });
  opacity.addEventListener('input', function () { state.opacity = Number(opacity.value); save(); urlApi.set('lookie-panel', state.opacity); apply(); });
  blur.addEventListener('input', function () { state.blur = Number(blur.value); save(); urlApi.set('lookie-blur', state.blur); apply(); });
  menu.querySelector('[data-wallpaper-reset]').addEventListener('click', function () {
    urlWallpaper = null;
    delete state.choices[scheme()];
    state.off = false;
    state.opacity = DEFAULTS.opacity;
    state.blur = DEFAULTS.blur;
    save();
    urlApi.set('lookie-panel', state.opacity);
    urlApi.set('lookie-blur', state.blur);
    apply();
  });
  function close() { if (menu.open) menu.open = false; }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.open) { close(); menu.querySelector('summary').focus(); }
  });
  document.addEventListener('click', function (event) { if (!menu.contains(event.target)) close(); });
  // The theme picker and light/dark button change root attributes; follow them.
  new MutationObserver(apply).observe(root, {attributes: true, attributeFilter: ['data-color-scheme', 'data-theme']});
  menu.hidden = false;
  apply();
}

function viewerWallpaperHtml() {
  if (!hasWallpapers()) return '';
  return `<div class="viewer-wallpaper" data-viewer-wallpaper aria-hidden="true"><img alt="" decoding="async"></div>`;
}

function viewerWallpaperScript(cspNonce = null) {
  if (!hasWallpapers()) return '';
  const json = JSON.stringify(publicCatalog()).replace(/</g, '\\u003c');
  const nonce = cspNonce ? ` nonce="${String(cspNonce).replace(/"/g, '&quot;')}"` : '';
  return `<script id="lookie-link-wallpapers" type="application/json">${json}</script>
  <script${nonce}>(${viewerWallpaperRuntime.toString()})();</script>`;
}

module.exports = {
  setWallpaperCatalog,
  hasWallpapers,
  resolveWallpaperFile,
  contentTypeFor,
  publicCatalog,
  viewerWallpaperHtml,
  viewerWallpaperScript,
};
