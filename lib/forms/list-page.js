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
  // View state lives in memory only; mode changes re-render without touching it.
  var editMode = false;
  var editingId = null;
  var filterText = '';
  var statusEl = document.getElementById('list-save-status');
  var root = document.getElementById('list-root');
  var hideToggle = document.getElementById('list-hide-completed');
  var summaryEl = document.getElementById('list-summary-count');
  var progressEl = document.getElementById('list-progress');
  var modeBtn = document.getElementById('list-mode');
  var filterEl = document.getElementById('list-filter');
  var jumpEl = document.getElementById('list-jump');
  var addForm = document.getElementById('list-add-form');
  var addTarget = addForm && addForm.querySelector('select[name="section"]');
  var sectionForm = document.getElementById('list-add-section');
  var layoutEl = document.querySelector('.list-layout');
  if (!root || !statusEl || !hideToggle || !modeBtn || !filterEl || !jumpEl || !addForm || !addTarget) return;

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
    var total = state.items.length;
    var done = state.items.filter(function (item) { return item.checked; }).length;
    if (summaryEl) summaryEl.textContent = done + ' of ' + total + ' done';
    if (progressEl) { progressEl.max = Math.max(total, 1); progressEl.value = done; }
  }

  function itemShown(item) {
    if (hideCompleted && item.checked) return false;
    if (!filterText) return true;
    var hay = (item.text + ' ' + (item.owner || '')).toLowerCase();
    return hay.indexOf(filterText.toLowerCase()) !== -1;
  }

  // Sections to draw: populated ones always; empty ones only while editing or
  // when nothing at all is populated (so the first add stays reachable).
  function visibleSections() {
    var anyPopulated = state.items.length > 0;
    var narrowed = hideCompleted || filterText !== '';
    var out = [];
    state.sections.forEach(function (section) {
      var counts = countsFor(section.id);
      var items = state.items.filter(function (item) { return item.sectionId === section.id && itemShown(item); });
      if (!items.length) {
        if (narrowed && counts.total > 0) return;
        if (counts.total === 0 && (narrowed || !(editMode || !anyPopulated))) return;
      }
      out.push({ section: section, counts: counts, items: items });
    });
    return out;
  }

  function sectionOptions(selectedId, list) {
    return list.map(function (option) {
      return '<option value="' + escapeAttr(option.id) + '"' + (option.id === selectedId ? ' selected' : '') + '>' + escape(option.title) + '</option>';
    }).join('');
  }

  function renderRow(item, index, sectionItems) {
    var html = '<li class="list-item' + (item.checked ? ' is-checked' : '') + (item.id === editingId ? ' is-open' : '') + '" data-item-id="' + escapeAttr(item.id) + '">';
    html += '<div class="list-row"><label class="list-check"><input type="checkbox" data-action="toggle"' + (item.checked ? ' checked' : '') + '><span class="list-check-mark" aria-hidden="true"></span><span class="list-check-text">' + escape(item.text) + (item.owner ? ' <span class="list-owner">(' + escape(item.owner) + ')</span>' : '') + '</span></label>';
    if (editMode) {
      html += '<button type="button" class="list-icon-btn list-row-menu" data-action="menu" aria-expanded="' + (item.id === editingId ? 'true' : 'false') + '" aria-label="Edit item">' + (item.id === editingId ? 'Close' : 'Edit') + '</button>';
    }
    html += '</div>';
    if (editMode && item.id === editingId) {
      html += '<div class="list-item-panel">';
      html += '<form class="list-edit-form"><label>Item text<input name="text" maxlength="500" autocomplete="off" value="' + escapeAttr(item.text) + '"></label><button type="submit" class="list-icon-btn" aria-label="Save item text">Save text</button></form>';
      html += '<div class="list-item-actions">';
      html += '<button type="button" class="list-icon-btn" data-action="up" aria-label="Move up"' + (index === 0 ? ' disabled' : '') + '>Up</button>';
      html += '<button type="button" class="list-icon-btn" data-action="down" aria-label="Move down"' + (index === sectionItems.length - 1 ? ' disabled' : '') + '>Down</button>';
      html += item.id === pendingRemoveId
        ? '<button type="button" class="list-icon-btn list-remove-confirm" data-action="remove" aria-label="Confirm remove item">Confirm remove</button>'
        : '<button type="button" class="list-icon-btn" data-action="remove" aria-label="Remove item">Remove</button>';
      html += '</div>';
      html += '<label class="list-section-assign">Section<select data-action="section" aria-label="Assign section">' + sectionOptions(item.sectionId, state.sections) + '</select></label>';
      html += '</div>';
    }
    return html + '</li>';
  }

  function render() {
    var active = document.activeElement;
    var focusKey = null;
    if (active && root.contains(active)) {
      var activeRow = active.closest('.list-item');
      if (activeRow) {
        focusKey = {
          id: activeRow.getAttribute('data-item-id'),
          action: active.getAttribute('data-action'),
          field: active.getAttribute('name')
        };
      }
    }
    hideToggle.checked = hideCompleted === true;
    updateSummary();
    layoutEl.setAttribute('data-mode', editMode ? 'edit' : 'check');
    modeBtn.textContent = editMode ? 'Done editing' : 'Edit list';
    modeBtn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
    if (sectionForm) sectionForm.hidden = !editMode;
    var shown = visibleSections();
    var html = '';
    shown.forEach(function (entry) {
      var section = entry.section;
      html += '<section class="list-section" data-section-id="' + escapeAttr(section.id) + '" aria-labelledby="sec-' + escapeAttr(section.id) + '">';
      html += '<header class="list-section-header"><h2 id="sec-' + escapeAttr(section.id) + '" tabindex="-1">' + escape(section.title) + '</h2>';
      html += '<p class="list-section-count">' + entry.counts.done + ' of ' + entry.counts.total + '</p></header>';
      if (!entry.items.length) {
        html += '<p class="list-empty">No items yet.</p>';
      } else {
        html += '<ul class="list-items">';
        var all = state.items.filter(function (item) { return item.sectionId === section.id; });
        entry.items.forEach(function (item) { html += renderRow(item, all.indexOf(item), all); });
        html += '</ul>';
      }
      html += '</section>';
    });
    if (!shown.length) {
      html = '<p class="list-empty">' + (state.items.length ? 'No items match.' : 'Nothing here yet. Add the first item above.') + '</p>';
    }
    root.innerHTML = html;

    var chosen = addTarget.value;
    addTarget.innerHTML = sectionOptions(chosen, state.sections);
    if (!state.sections.some(function (section) { return section.id === chosen; }) && state.sections.length) addTarget.value = state.sections[0].id;
    jumpEl.innerHTML = '<option value="">Jump to section</option>' + shown.map(function (entry) {
      return '<option value="' + escapeAttr(entry.section.id) + '">' + escape(entry.section.title) + ' (' + entry.counts.done + '/' + entry.counts.total + ')</option>';
    }).join('');
    jumpEl.disabled = shown.length < 2;

    if (focusKey) {
      var row = root.querySelector('[data-item-id="' + focusKey.id + '"]');
      var target = row && (focusKey.field
        ? row.querySelector('input[name="' + focusKey.field + '"]')
        : row.querySelector('[data-action="' + focusKey.action + '"]'));
      if (target && !target.disabled) target.focus();
    }
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
      editingId = null;
      state.items.splice(found.index, 1);
      markDirty();
      return;
    }
    pendingRemoveId = null;
    if (action === 'menu') {
      editingId = editingId === id ? null : id;
      render();
      if (editingId) {
        var field = root.querySelector('[data-item-id="' + id + '"] input[name="text"]');
        if (field) field.focus();
      }
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
    var form = event.target.closest('.list-edit-form');
    if (!form) return;
    event.preventDefault();
    var found = findItem(form.closest('.list-item').getAttribute('data-item-id'));
    var next = String(form.querySelector('input[name="text"]').value || '').trim();
    if (!found || !next) return;
    found.item.text = next.slice(0, 500);
    editingId = null;
    markDirty();
  });

  addForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = addForm.querySelector('input[name="text"]');
    var text = input && String(input.value || '').trim();
    if (!text || !addTarget.value) return;
    state.items.push({
      id: newId(),
      text: text.slice(0, 500),
      sectionId: addTarget.value,
      checked: false
    });
    input.value = '';
    // A filter that hides the new item would make the add look lost.
    filterText = '';
    filterEl.value = '';
    markDirty();
    input.focus();
  });

  modeBtn.addEventListener('click', function () {
    editMode = !editMode;
    editingId = null;
    pendingRemoveId = null;
    render();
    modeBtn.focus();
  });

  filterEl.addEventListener('input', function () {
    filterText = filterEl.value.trim();
    render();
  });

  jumpEl.addEventListener('change', function () {
    var id = jumpEl.value;
    jumpEl.value = '';
    if (!id) return;
    var heading = document.getElementById('sec-' + id);
    if (!heading) return;
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  });

  root.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && editingId) {
      var id = editingId;
      editingId = null;
      render();
      var back = root.querySelector('[data-item-id="' + id + '"] [data-action="menu"]');
      if (back) back.focus();
    }
  });

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
      <div class="list-bar">
        <p class="list-summary"><span id="list-summary-count">${esc(String(done))} of ${esc(String(total))} done</span></p>
        <p class="list-save-status" id="list-save-status" data-status="saved" aria-live="polite">Saved</p>
        <button type="button" id="list-mode" class="list-mode-btn" aria-pressed="false">Edit list</button>
        <progress id="list-progress" class="list-progress" max="${esc(String(Math.max(total, 1)))}" value="${esc(String(done))}" aria-label="Items done"></progress>
      </div>
      <div class="list-controls">
      <div class="list-finder">
        <label class="list-filter"><span class="visually-hidden">Filter items</span><input type="search" id="list-filter" placeholder="Filter items" autocomplete="off"></label>
        <label class="list-jump"><span class="visually-hidden">Jump to section</span><select id="list-jump"></select></label>
        <label class="list-hide-completed"><input type="checkbox" id="list-hide-completed"><span>Hide completed</span></label>
      </div>
      <form id="list-add-form" class="list-add-form">
        <label class="list-add-text"><span class="visually-hidden">New item</span><input name="text" maxlength="500" placeholder="Add an item" autocomplete="off"></label>
        <label class="list-add-section-pick"><span class="visually-hidden">Add to section</span><select name="section" aria-label="Add to section"></select></label>
        <button type="submit" class="button-link button-link-primary list-add-btn">Add</button>
      </form>
      </div>
      <div id="list-root" class="list-root"></div>
      <form id="list-add-section" class="list-add-section" hidden>
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
