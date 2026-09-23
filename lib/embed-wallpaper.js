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
    choice.options[0].textContent = empty ? 'This theme has no backgrounds' : 'No background';
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
function wallpaperControlsScript() {
  return `<style>
  .toolbar-wallpaper { margin:0; }
  [data-wallpaper-menu][hidden] { display:none!important; }
  .wallpaper-settings { position:absolute; right:0; top:calc(100% + .5rem); z-index:40; width:min(19rem,calc(100vw - 1.6rem)); max-height:min(60vh,28rem); overflow:auto; padding:.85rem .95rem .95rem; border:1px solid var(--border); border-radius:10px; background:var(--bg-elev); background-color:color-mix(in srgb, color-mix(in srgb, var(--bg-elev) 86%, var(--text-soft)) 84%, transparent); backdrop-filter:blur(10px); color:var(--text); box-shadow:0 8px 24px rgba(0,0,0,.3); font-size:.85rem; line-height:1.3; }
  .wallpaper-pick { display:flex; gap:.4rem; margin-bottom:.9rem; }
  .wallpaper-pick select { flex:1 1 auto; min-width:0; min-height:2.2rem; padding:.3rem .5rem; font:inherit; color:var(--text); background:var(--bg-elev); border:1px solid var(--border); border-radius:8px; }
  .wallpaper-pick select:disabled { color:var(--text-soft); }
  .wallpaper-step { display:inline-flex; flex:none; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:var(--bg-elev); }
  .wallpaper-step button { width:2.2rem; min-height:2.2rem; padding:0; font:inherit; font-size:1.25rem; line-height:1; color:var(--text); background:transparent; border:0; cursor:pointer; }
  .wallpaper-step button + button { border-left:1px solid var(--border); }
  .wallpaper-step button:hover:not(:disabled) { background:var(--toolbar-btn-hover); }
  .wallpaper-step button:disabled { color:var(--text-soft); cursor:default; }
  .wallpaper-range { display:grid; grid-template-columns:1fr auto; align-items:center; gap:.2rem .6rem; margin:0 0 .7rem; }
  .wallpaper-range output { color:var(--text-soft); font-variant-numeric:tabular-nums; }
  .wallpaper-range input { grid-column:1 / -1; width:100%; margin:0; accent-color:var(--accent); }
  .wallpaper-reset { display:block; width:100%; margin-top:.2rem; padding:.45rem .6rem; font:inherit; font-size:.82rem; color:var(--text-soft); background:transparent; border:1px solid var(--border); border-radius:8px; cursor:pointer; }
  .wallpaper-reset:hover { color:var(--text); background:var(--toolbar-btn-hover); }
  .wallpaper-settings :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  </style><script>(${wallpaperRuntime.toString()})();</script>`;
}

module.exports = {wallpaperControlsHtml, wallpaperControlsScript};
