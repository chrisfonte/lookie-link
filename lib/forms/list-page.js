'use strict';

function listClientScript(templateId, csrfToken, initialState) {
  const payload = JSON.stringify({
    templateId,
    csrfToken,
    state: initialState,
  }).replace(/</g, '\\u003c');
  // hideCompleted is a per-browser display preference, not shared list state.
  return `
(function () {
  var boot = ${payload};
  var state = boot.state;
  var hideCompleted = false;
  try {
    hideCompleted = window.localStorage.getItem('lookie-list-hide-completed:' + boot.templateId) === '1';
  } catch (_error) { hideCompleted = false; }
  // Single-flight autosave: state is the user's working copy (including edits
  // not yet saved); serverRevision is the last revision the server confirmed.
  var serverRevision = state.revision;
  var inFlight = false;
  var dirty = false;
  var conflict = null;
  var pendingRemoveId = null;
  var statusEl = document.getElementById('list-save-status');
  var root = document.getElementById('list-root');
  var hideToggle = document.getElementById('list-hide-completed');
  var summaryEl = document.getElementById('list-summary-count');
  if (!root || !statusEl || !hideToggle) return;

  function addStatusButton(label, attr, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-retry';
    button.setAttribute(attr, '1');
    button.textContent = label;
    button.addEventListener('click', handler);
    statusEl.appendChild(document.createTextNode(' '));
    statusEl.appendChild(button);
  }

  function setStatus(kind, message) {
    statusEl.dataset.status = kind;
    statusEl.textContent = message;
    if (kind === 'error') {
      if (conflict) {
        addStatusButton('Keep my changes', 'data-keep', keepMine);
        addStatusButton('Load latest', 'data-latest', loadLatest);
      } else {
        addStatusButton('Retry', 'data-retry', function () { dirty = true; flush(); });
      }
    }
  }

  function escape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(value) { return escape(value).replace(/'/g, '&#39;'); }

  function countsFor(sectionId) {
    var items = state.items.filter(function (item) { return item.sectionId === sectionId; });
    var done = items.filter(function (item) { return item.checked; }).length;
    return { total: items.length, done: done };
  }

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function updateSummary() {
    if (!summaryEl) return;
    var total = state.items.length;
    var done = state.items.filter(function (item) { return item.checked; }).length;
    summaryEl.textContent = done + ' of ' + total + ' done';
  }

  function render() {
    hideToggle.checked = hideCompleted === true;
    updateSummary();
    var html = '';
    state.sections.forEach(function (section) {
      var counts = countsFor(section.id);
      html += '<section class="list-section" data-section-id="' + escapeAttr(section.id) + '">';
      html += '<header class="list-section-header"><h2>' + escape(section.title) + '</h2>';
      html += '<p class="list-section-count">' + counts.done + ' of ' + counts.total + ' done</p></header>';
      html += '<ul class="list-items">';
      var visible = state.items.filter(function (item) {
        return item.sectionId === section.id && !(hideCompleted && item.checked);
      });
      visible.forEach(function (item, index) {
        html += '<li class="list-item' + (item.checked ? ' is-checked' : '') + '" data-item-id="' + escapeAttr(item.id) + '">';
        html += '<label class="list-check"><input type="checkbox" data-action="toggle"' + (item.checked ? ' checked' : '') + '><span class="list-check-mark" aria-hidden="true"></span><span class="list-check-text">' + escape(item.text) + (item.owner ? ' <span class="list-owner">(' + escape(item.owner) + ')</span>' : '') + '</span></label>';
        html += '<div class="list-item-actions">';
        html += '<button type="button" class="list-icon-btn" data-action="edit" aria-label="Edit item">Edit</button>';
        html += '<button type="button" class="list-icon-btn" data-action="up" aria-label="Move up"' + (index === 0 ? ' disabled' : '') + '>Up</button>';
        html += '<button type="button" class="list-icon-btn" data-action="down" aria-label="Move down"' + (index === visible.length - 1 ? ' disabled' : '') + '>Down</button>';
        html += item.id === pendingRemoveId
          ? '<button type="button" class="list-icon-btn list-remove-confirm" data-action="remove" aria-label="Confirm remove item">Confirm remove</button>'
          : '<button type="button" class="list-icon-btn" data-action="remove" aria-label="Remove item">Remove</button>';
        html += '<label class="list-section-assign"><span class="visually-hidden">Section</span><select data-action="section" aria-label="Assign section">';
        state.sections.forEach(function (option) {
          html += '<option value="' + escapeAttr(option.id) + '"' + (option.id === item.sectionId ? ' selected' : '') + '>' + escape(option.title) + '</option>';
        });
        html += '</select></label></div></li>';
      });
      html += '</ul>';
      html += '<form class="list-add-form" data-section-id="' + escapeAttr(section.id) + '">';
      html += '<label><span class="visually-hidden">New item</span><input name="text" maxlength="500" placeholder="Add an item" autocomplete="off"></label>';
      html += '<button type="submit" class="button-link button-link-primary list-add-btn">Add</button></form>';
      html += '</section>';
    });
    root.innerHTML = html;
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id === id) return { item: state.items[i], index: i };
    }
    return null;
  }

  function moveWithinSection(itemId, direction) {
    var found = findItem(itemId);
    if (!found) return;
    var sectionId = found.item.sectionId;
    var indexes = [];
    state.items.forEach(function (item, index) {
      if (item.sectionId === sectionId) indexes.push(index);
    });
    var position = indexes.indexOf(found.index);
    var swapWith = position + direction;
    if (swapWith < 0 || swapWith >= indexes.length) return;
    var a = indexes[position];
    var b = indexes[swapWith];
    var tmp = state.items[a];
    state.items[a] = state.items[b];
    state.items[b] = tmp;
  }

  function flush() {
    if (inFlight || conflict || !dirty) return;
    inFlight = true;
    dirty = false;
    setStatus('saving', 'Saving');
    // Snapshot and revision are taken at dispatch time, never at click time.
    var body = {
      revision: serverRevision,
      sections: JSON.parse(JSON.stringify(state.sections)),
      items: JSON.parse(JSON.stringify(state.items))
    };
    fetch('/api/forms/' + encodeURIComponent(boot.templateId) + '/list', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': boot.csrfToken
      },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (payload) {
        return { response: response, payload: payload };
      }).catch(function () {
        return { response: response, payload: null };
      });
    }).then(function (result) {
      inFlight = false;
      if (result.response.ok && result.payload && result.payload.state) {
        // Only the revision is adopted; later local edits stay as typed.
        serverRevision = result.payload.state.revision;
        if (dirty) { flush(); return; }
        setStatus('saved', 'Saved');
        return;
      }
      dirty = true;
      if (result.response.status === 409 && result.payload && result.payload.state) {
        conflict = result.payload.state;
        setStatus('error', 'Someone else changed this list. Your changes are not saved yet.');
        return;
      }
      setStatus('error', 'Could not save.');
    }).catch(function () {
      inFlight = false;
      dirty = true;
      setStatus('error', 'Could not save.');
    });
  }

  function keepMine() {
    // Explicit resolution: save my working copy over the newer server revision.
    if (!conflict) return;
    serverRevision = conflict.revision;
    conflict = null;
    dirty = true;
    flush();
  }

  function loadLatest() {
    if (!conflict) return;
    state = conflict;
    serverRevision = conflict.revision;
    conflict = null;
    dirty = false;
    setStatus('saved', 'Saved');
    render();
  }

  function markDirty() {
    pendingRemoveId = null;
    dirty = true;
    render();
    flush();
  }

  hideToggle.addEventListener('change', function () {
    hideCompleted = hideToggle.checked;
    try {
      window.localStorage.setItem('lookie-list-hide-completed:' + boot.templateId, hideCompleted ? '1' : '0');
    } catch (_error) {}
    render();
  });

  root.addEventListener('change', function (event) {
    var target = event.target;
    var row = target.closest('.list-item');
    if (!row) return;
    var found = findItem(row.getAttribute('data-item-id'));
    if (!found) return;
    if (target.getAttribute('data-action') === 'toggle') {
      found.item.checked = target.checked;
      markDirty();
      return;
    }
    if (target.getAttribute('data-action') === 'section') {
      found.item.sectionId = target.value;
      markDirty();
    }
  });

  root.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var row = button.closest('.list-item');
    if (!row) return;
    var id = row.getAttribute('data-item-id');
    var found = findItem(id);
    if (!found) return;
    var action = button.getAttribute('data-action');
    if (action === 'remove') {
      // Two-step: the first press arms the button, the second removes the item.
      if (pendingRemoveId !== id) {
        pendingRemoveId = id;
        render();
        var armed = root.querySelector('[data-item-id="' + id + '"] [data-action="remove"]');
        if (armed) armed.focus();
        return;
      }
      pendingRemoveId = null;
      state.items.splice(found.index, 1);
      markDirty();
      return;
    }
    pendingRemoveId = null;
    if (action === 'edit') {
      var next = window.prompt('Edit item', found.item.text);
      if (next == null) return;
      next = String(next).trim();
      if (!next) return;
      found.item.text = next.slice(0, 500);
      markDirty();
      return;
    }
    if (action === 'up') {
      moveWithinSection(id, -1);
      markDirty();
      return;
    }
    if (action === 'down') {
      moveWithinSection(id, 1);
      markDirty();
    }
  });

  root.addEventListener('submit', function (event) {
    var form = event.target.closest('.list-add-form');
    if (!form) return;
    event.preventDefault();
    var input = form.querySelector('input[name="text"]');
    var text = input && String(input.value || '').trim();
    if (!text) return;
    state.items.push({
      id: newId(),
      text: text.slice(0, 500),
      sectionId: form.getAttribute('data-section-id'),
      checked: false
    });
    input.value = '';
    markDirty();
  });

  var sectionForm = document.getElementById('list-add-section');
  if (sectionForm) {
    sectionForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = sectionForm.querySelector('input[name="title"]');
      var title = input && String(input.value || '').trim();
      if (!title) return;
      var id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      if (!/^[a-z]/.test(id)) id = 'section-' + id;
      var base = id;
      var suffix = 2;
      while (state.sections.some(function (section) { return section.id === id; })) {
        id = base.slice(0, 60 - String(suffix).length - 1) + '-' + suffix;
        suffix += 1;
      }
      state.sections.push({ id: id, title: title.slice(0, 80) });
      input.value = '';
      markDirty();
    });
  }

  setStatus(state.persisted === false && state.revision === 0 ? 'saved' : 'saved', 'Saved');
  render();
})();`;
}

function renderListPage(helpers, template, csrfToken, listState, options = {}) {
  const {
    escapeHtml: esc,
    toolbarHtml,
    formBreadcrumbs,
    formHubNav,
    formProperties,
    relatedFormsStrip,
    themeScript,
    themeDefaults,
    baseHtml,
  } = helpers;
  const propertiesExtras = {
    path: ['Trackers', options.relatedForms && options.relatedForms.container && options.relatedForms.container.title, template && template.title].filter(Boolean).join(' > '),
  };
  const total = listState.items.length;
  const done = listState.items.filter((item) => item.checked).length;
  const body = `${toolbarHtml(formProperties(template, propertiesExtras))}
  <main class="layout form-layout list-layout">
    <header class="topbar">${formBreadcrumbs(template, { leadLabel: template.title })}</header>
    ${formHubNav(template.templateId, 'log', options.canManage, options.relatedForms && options.relatedForms.container)}
    <section class="content form-card list-card">
      <div class="list-toolbar">
        <p class="list-summary"><span id="list-summary-count">${esc(String(done))} of ${esc(String(total))} done</span></p>
        <label class="list-hide-completed"><input type="checkbox" id="list-hide-completed"><span>Hide completed</span></label>
        <p class="list-save-status" id="list-save-status" data-status="saved" aria-live="polite">Saved</p>
      </div>
      <div id="list-root" class="list-root"></div>
      <form id="list-add-section" class="list-add-section">
        <label><span>New section</span><input name="title" maxlength="80" placeholder="Section name" autocomplete="off"></label>
        <button type="submit" class="button-link">Add section</button>
      </form>
    </section>
    ${relatedFormsStrip ? relatedFormsStrip(options.relatedForms) : ''}
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}
  <script${options.cspNonce ? ` nonce="${esc(options.cspNonce)}"` : ''}>${listClientScript(template.templateId, csrfToken, listState)}</script>`;
  return baseHtml({
    title: template.title,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
  });
}

module.exports = {
  renderListPage,
  listClientScript,
};
