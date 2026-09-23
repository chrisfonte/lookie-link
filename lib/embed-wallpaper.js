'use strict';

// The viewer owns this fixed set of controls. Embedded documents supply only
// bounded labels/state, never HTML, URLs, scripts, or additional toolbar actions.
//
// Layout: one picker row (select + a paired previous/next stepper), two sliders,
// one reset. "No background" is the first option of the select, so it needs no
// button of its own.
function wallpaperControlsHtml() {
  return `<details class="doc-properties toolbar-wallpaper" name="lookie-toolbar" data-wallpaper-menu hidden>
    <summary class="toolbar-btn">Wallpaper</summary>
    <div class="wallpaper-settings" role="group" aria-label="Wallpaper">
      <div class="wallpaper-pick">
        <select data-wallpaper-choice aria-label="Background"></select>
        <span class="wallpaper-step"><button type="button" data-wallpaper-previous aria-label="Previous background" title="Previous">&#8249;</button><button type="button" data-wallpaper-next aria-label="Next background" title="Next">&#8250;</button></span>
      </div>
      <p class="wallpaper-empty" data-wallpaper-empty hidden></p>
      <label class="wallpaper-range"><span>Panel opacity</span><output data-wallpaper-opacity-value></output><input data-wallpaper-opacity aria-label="Panel opacity" type="range" min="50" max="100" step="1"></label>
      <label class="wallpaper-range"><span>Blur behind panel</span><output data-wallpaper-blur-value></output><input data-wallpaper-blur aria-label="Blur behind panel" type="range" min="0" max="16" step="1"></label>
      <button type="button" class="wallpaper-reset" data-wallpaper-reset>Reset to theme default</button>
    </div>
  </details>`;
}

function wallpaperRuntime() {
  var frame = document.querySelector('[data-embedded-html]');
  var menu = document.querySelector('[data-wallpaper-menu]');
  if (!frame || !menu) return;
  var choice = menu.querySelector('[data-wallpaper-choice]');
  var previous = menu.querySelector('[data-wallpaper-previous]');
  var next = menu.querySelector('[data-wallpaper-next]');
  var opacity = menu.querySelector('[data-wallpaper-opacity]');
  var blur = menu.querySelector('[data-wallpaper-blur]');
  var state = null;
  var catalogKey = '';
  function post(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }
  function valid(data) {
    if (!Array.isArray(data.choices) || data.choices.length > 50) return false;
    var ids = new Set();
    for (var item of data.choices) {
      if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || item.id === 'none' || ids.has(item.id)) return false;
      if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80) return false;
      ids.add(item.id);
    }
    return (data.choice === 'none' || ids.has(data.choice))
      && Number.isInteger(data.opacity) && data.opacity >= 50 && data.opacity <= 100
      && Number.isInteger(data.blur) && data.blur >= 0 && data.blur <= 16;
  }
  function render() {
    var empty = !state.choices.length;
    previous.disabled = empty;
    next.disabled = empty;
    choice.disabled = empty;
    // Name the theme so an empty catalog reads as "pick another theme", not a fault.
    var current = document.querySelector('[data-theme-item][aria-current="true"]');
    var label = current ? current.textContent.trim() : (document.documentElement.getAttribute('data-color-scheme') || 'This theme');
    choice.options[0].textContent = empty ? 'No backgrounds' : 'No background';
    var note = menu.querySelector('[data-wallpaper-empty]');
    note.hidden = !empty;
    note.textContent = empty ? label + ' has no background set. Pick another theme in the bar.' : '';
    choice.value = state.choice;
    opacity.value = state.opacity;
    blur.value = state.blur;
    menu.querySelector('[data-wallpaper-opacity-value]').textContent = state.opacity + '%';
    menu.querySelector('[data-wallpaper-blur-value]').textContent = state.blur ? state.blur + ' px' : 'Off';
  }
  window.addEventListener('message', function (event) {
    // Opaque sandbox origin cannot be allowlisted; bind to this exact window.
    if (event.source !== frame.contentWindow || !event.data || event.data.type !== 'lookie-link:wallpaper-state' || !valid(event.data)) return;
    state = {choices: event.data.choices.map(function (item) { return {id:item.id,label:item.label}; }), choice:event.data.choice, opacity:event.data.opacity, blur:event.data.blur};
    var key = JSON.stringify(state.choices);
    if (key !== catalogKey) {
      catalogKey = key;
      choice.replaceChildren();
      [{id:'none',label:'No background'}].concat(state.choices).forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        choice.appendChild(option);
      });
    }
    render();
    menu.hidden = false;
    post({type:'lookie-link:wallpaper-toolbar-ready'});
  });
  function send() {
    if (!state) return;
    post({type:'lookie-link:set-wallpaper', choice:choice.value, opacity:Number(opacity.value), blur:Number(blur.value)});
  }
  choice.addEventListener('change', send);
  opacity.addEventListener('input', function () {
    menu.querySelector('[data-wallpaper-opacity-value]').textContent = opacity.value + '%';
    send();
  });
  blur.addEventListener('input', function () {
    menu.querySelector('[data-wallpaper-blur-value]').textContent = Number(blur.value) ? blur.value + ' px' : 'Off';
    send();
  });
  function cycle(step) {
    if (!state || !state.choices.length) return;
    var ids = state.choices.map(function (item) { return item.id; });
    var index = ids.indexOf(choice.value);
    choice.value = ids[index < 0 ? (step > 0 ? 0 : ids.length - 1) : (index + step + ids.length) % ids.length];
    send();
  }
  previous.addEventListener('click', function () { cycle(-1); });
  next.addEventListener('click', function () { cycle(1); });
  menu.querySelector('[data-wallpaper-reset]').addEventListener('click', function () { if (state) post({type:'lookie-link:reset-wallpaper'}); });
  function close() {
    if (!menu.open) return;
    menu.open = false;
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.open) { close(); menu.querySelector('summary').focus(); }
  });
  document.addEventListener('click', function (event) { if (!menu.contains(event.target)) close(); });
  // Clicks inside the sandboxed frame never reach this document; focus moving
  // into the frame is the only signal, so treat it as an outside click.
  window.addEventListener('blur', function () {
    if (document.activeElement === frame) close();
  });
  frame.addEventListener('load', function () {
    state = null;
    menu.hidden = true;
    menu.open = false;
    post({type:'lookie-link:request-wallpaper-state'});
  });
}

// Mirrors the viewer's other toolbar menus (.doc-properties-grid): the same
// translucent, blurred surface, hairline border and radius, so the wallpaper
// menu reads as one of the set rather than a separate widget.
// Menu styling lives in public/style.css (.wallpaper-settings), shared with
// the viewer-wide runtime in lib/viewer-wallpaper.js.
function wallpaperControlsScript() {
  return `<script>(${wallpaperRuntime.toString()})();</script>`;
}

module.exports = {wallpaperControlsHtml, wallpaperControlsScript};
