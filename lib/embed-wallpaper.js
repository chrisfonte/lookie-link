'use strict';

// The viewer owns this fixed set of controls. Embedded documents supply only
// bounded labels/state, never HTML, URLs, scripts, or additional toolbar actions.
function wallpaperControlsHtml() {
  return `<details class="doc-properties toolbar-wallpaper" name="lookie-toolbar" data-wallpaper-menu hidden>
    <summary class="toolbar-btn">Wallpaper</summary>
    <div class="wallpaper-settings">
      <label>Background<select data-wallpaper-choice aria-label="Wallpaper"></select></label>
      <div class="wallpaper-cycle"><button type="button" data-wallpaper-previous aria-label="Previous wallpaper">←</button><button type="button" data-wallpaper-none>No background</button><button type="button" data-wallpaper-next aria-label="Next wallpaper">→</button></div>
      <label>Panel opacity <output data-wallpaper-opacity-value></output><input data-wallpaper-opacity aria-label="Panel opacity" type="range" min="50" max="100" step="1"></label>
      <label>Behind-panel blur <output data-wallpaper-blur-value></output><input data-wallpaper-blur aria-label="Behind-panel blur" type="range" min="0" max="16" step="1"></label>
      <button type="button" data-wallpaper-reset>Reset wallpaper</button>
    </div>
  </details>`;
}

function wallpaperRuntime() {
  var frame = document.querySelector('[data-embedded-html]');
  var menu = document.querySelector('[data-wallpaper-menu]');
  if (!frame || !menu) return;
  var choice = menu.querySelector('[data-wallpaper-choice]');
  var opacity = menu.querySelector('[data-wallpaper-opacity]');
  var blur = menu.querySelector('[data-wallpaper-blur]');
  var state = null;
  var catalogKey = '';
  function post(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }
  function valid(data) {
    if (!Array.isArray(data.choices) || data.choices.length < 1 || data.choices.length > 50) return false;
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
    choice.value = state.choice;
    opacity.value = state.opacity;
    blur.value = state.blur;
    menu.querySelector('[data-wallpaper-opacity-value]').textContent = state.opacity + '%';
    menu.querySelector('[data-wallpaper-blur-value]').textContent = state.blur + ' px';
    menu.hidden = false;
    post({type:'lookie-link:wallpaper-toolbar-ready'});
  });
  function send() {
    if (!state) return;
    post({type:'lookie-link:set-wallpaper', choice:choice.value, opacity:Number(opacity.value), blur:Number(blur.value)});
  }
  choice.addEventListener('change', send);
  opacity.addEventListener('input', send);
  blur.addEventListener('input', send);
  function cycle(step) {
    if (!state) return;
    var ids = state.choices.map(function (item) { return item.id; });
    var index = ids.indexOf(choice.value);
    choice.value = ids[index < 0 ? (step > 0 ? 0 : ids.length - 1) : (index + step + ids.length) % ids.length];
    send();
  }
  menu.querySelector('[data-wallpaper-previous]').addEventListener('click', function () { cycle(-1); });
  menu.querySelector('[data-wallpaper-next]').addEventListener('click', function () { cycle(1); });
  menu.querySelector('[data-wallpaper-none]').addEventListener('click', function () { choice.value = 'none'; send(); });
  menu.querySelector('[data-wallpaper-reset]').addEventListener('click', function () { if (state) post({type:'lookie-link:reset-wallpaper'}); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
  });
  document.addEventListener('click', function (event) { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  frame.addEventListener('load', function () {
    state = null;
    menu.hidden = true;
    menu.open = false;
    post({type:'lookie-link:request-wallpaper-state'});
  });
}

function wallpaperControlsScript() {
  return `<style>
  .toolbar-wallpaper { margin:0; }
  [data-wallpaper-menu][hidden] { display:none!important; }
  .wallpaper-settings { position:absolute; right:0; top:calc(100% + .5rem); width:min(300px,calc(100vw - 2rem)); max-height:calc(100dvh - var(--toolbar-height,4rem) - 2rem); overflow:auto; padding:1rem; border:1px solid var(--border); border-radius:12px; background:var(--bg-elev); color:var(--text); box-shadow:0 12px 36px #0004; font-size:14px; }
  .wallpaper-settings label { display:block; margin:0 0 1rem; }
  .wallpaper-settings select,.wallpaper-settings input { display:block; width:100%; margin-top:.4rem; color:var(--text); accent-color:var(--accent); }
  .wallpaper-settings select,.wallpaper-settings button { background:var(--bg-elev); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:.5rem; min-height:40px; font:inherit; }
  .wallpaper-settings output { float:right; }
  .wallpaper-cycle { display:flex; gap:.4rem; margin-bottom:1rem; }
  .wallpaper-cycle button:nth-child(2) { flex:1; }
  .wallpaper-settings :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  </style><script>(${wallpaperRuntime.toString()})();</script>`;
}

module.exports = {wallpaperControlsHtml, wallpaperControlsScript};
