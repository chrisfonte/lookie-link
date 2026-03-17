'use strict';

(function () {
  var bootstrapEl = document.getElementById('editor-bootstrap');
  var input = document.querySelector('[data-editor-input]');
  var saveBtn = document.querySelector('[data-save-btn]');
  var statusEl = document.querySelector('[data-save-status]');
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('[data-tab-btn]'));
  var panes = {
    edit: document.querySelector('[data-pane="edit"]'),
    preview: document.querySelector('[data-pane="preview"]'),
  };
  var previewContainer = document.querySelector('[data-preview-container]');

  if (!bootstrapEl || !input || !saveBtn || !statusEl) {
    return;
  }

  var bootstrap = {};
  try {
    bootstrap = JSON.parse(bootstrapEl.textContent || '{}');
  } catch (_error) {
    bootstrap = {};
  }

  var lastSaved = input.value;
  var isSaving = false;
  var activeTab = 'edit';
  var previewInFlight = false;
  var previewQueued = false;
  var previewTimer = null;

  function setStatus(message, kind) {
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.remove('notice-error', 'notice-success');
    if (kind === 'error') {
      statusEl.classList.add('notice-error');
    } else if (kind === 'success') {
      statusEl.classList.add('notice-success');
    }
  }

  function clearStatus() {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('notice-error', 'notice-success');
  }

  function setTab(nextTab) {
    activeTab = nextTab === 'preview' ? 'preview' : 'edit';

    tabButtons.forEach(function (button) {
      var target = button.getAttribute('data-target');
      var isActive = target === activeTab;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    Object.keys(panes).forEach(function (key) {
      var pane = panes[key];
      if (!pane) {
        return;
      }
      var isVisible = key === activeTab;
      pane.hidden = !isVisible;
      pane.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
    });

    if (activeTab === 'preview') {
      queuePreview(0);
    }
  }

  async function refreshPreview() {
    if (!bootstrap.previewHref || !previewContainer) {
      return;
    }

    if (previewInFlight) {
      previewQueued = true;
      return;
    }

    previewInFlight = true;
    previewContainer.setAttribute('aria-busy', 'true');

    try {
      var response = await fetch(bootstrap.previewHref, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.value }),
      });

      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || !payload.ok || typeof payload.html !== 'string') {
        previewContainer.innerHTML = '<p class="notice notice-error">Preview unavailable.</p>';
      } else {
        previewContainer.innerHTML = payload.html;
      }
    } catch (_error) {
      previewContainer.innerHTML = '<p class="notice notice-error">Preview request failed.</p>';
    } finally {
      previewInFlight = false;
      previewContainer.removeAttribute('aria-busy');
      if (previewQueued) {
        previewQueued = false;
        refreshPreview();
      }
    }
  }

  function queuePreview(delayMs) {
    if (activeTab !== 'preview') {
      return;
    }

    if (previewTimer) {
      clearTimeout(previewTimer);
    }

    previewTimer = setTimeout(function () {
      previewTimer = null;
      refreshPreview();
    }, delayMs);
  }

  saveBtn.addEventListener('click', async function () {
    if (isSaving) {
      return;
    }

    isSaving = true;
    saveBtn.disabled = true;
    clearStatus();
    setStatus('Saving…');

    try {
      var response = await fetch(bootstrap.saveHref, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: input.value,
          expectedMtimeMs: bootstrap.mtimeMs,
        }),
      });

      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || !payload.ok) {
        if (response.status === 409) {
          setStatus('File changed on disk since you opened it. Refresh before saving.', 'error');
        } else {
          setStatus(payload.error || 'Save failed.', 'error');
        }
        return;
      }

      bootstrap.mtimeMs = payload.mtimeMs;
      lastSaved = input.value;
      setStatus('Saved.', 'success');
      queuePreview(0);
    } catch (_error) {
      setStatus('Save failed due to a network error.', 'error');
    } finally {
      isSaving = false;
      saveBtn.disabled = false;
    }
  });

  input.addEventListener('input', function () {
    queuePreview(220);
  });

  tabButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      setTab(button.getAttribute('data-target'));
    });
  });

  window.addEventListener('beforeunload', function (event) {
    if (input.value === lastSaved) {
      return;
    }
    event.preventDefault();
    event.returnValue = '';
  });

  setTab('edit');
}());
