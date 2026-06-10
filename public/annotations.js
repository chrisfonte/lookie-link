/* Lookie-Link annotations viewer UX (FON-11764).
 *
 * Loaded on document pages when enableAnnotations is true. Reads the
 * bootstrap JSON, fetches the sidecar, renders cards under each
 * data-annotations-mount slot, and wires the Annotate / Claim / Resolve /
 * Reply controls plus the line-range picker for code views.
 *
 * Annotation bodies are rendered as plain text with newline preservation
 * (CSS white-space: pre-wrap). No HTML is injected from user content,
 * so DOMPurify is not required client-side.
 */
(function () {
  'use strict';

  var bootstrapEl = document.getElementById('annotations-bootstrap');
  if (!bootstrapEl) return;

  var bootstrap;
  try {
    bootstrap = JSON.parse(bootstrapEl.textContent || '{}');
  } catch (e) {
    return;
  }

  var repo = bootstrap.repo;
  var relativePath = bootstrap.relativePath;
  var queryToken = bootstrap.queryToken || null;
  var supportsLineRange = !!bootstrap.supportsLineRange;
  if (!repo || !relativePath) return;

  var renderedView = document.querySelector('[data-rendered-view]');
  var staleAside = document.querySelector('[data-annotations-stale]');
  var staleList = document.querySelector('[data-annotations-stale-list]');
  var staleCount = document.querySelector('[data-annotations-stale-count]');
  var lineRangeAside = document.querySelector('[data-annotations-line-range]');
  var lineRangeList = document.querySelector('[data-annotations-line-range-list]');
  var lineRangeCount = document.querySelector('[data-annotations-line-range-count]');
  var chipBtn = document.querySelector('[data-annotations-chip]');
  var chipCount = document.querySelector('[data-annotations-count]');

  var state = {
    sidecarMtimeMs: null,
    annotations: [],
    showResolved: false,
  };

  function withToken(url) {
    if (!queryToken) return url;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + 'token=' + encodeURIComponent(queryToken);
  }

  function annotationsUrl(query) {
    var segments = relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    var base = '/api/annotations/' + encodeURIComponent(repo) + '/' + segments;
    if (query) base += '?' + query;
    return withToken(base);
  }

  function getAuthor() {
    var stored = (localStorage.getItem('lookie-link-author') || '').trim();
    if (stored) return stored;
    var prompted = window.prompt('Your name (saved locally for future annotations):');
    if (prompted && prompted.trim()) {
      localStorage.setItem('lookie-link-author', prompted.trim());
      return prompted.trim();
    }
    return null;
  }

  function formatTimestamp(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (_e) {
      return iso;
    }
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function buildBadge(stateName) {
    var span = document.createElement('span');
    span.className = 'annotation-state annotation-state-' + stateName;
    span.textContent = stateName;
    return span;
  }

  function buildReplyNode(reply) {
    var wrap = document.createElement('div');
    wrap.className = 'annotation-reply';
    var meta = document.createElement('div');
    meta.className = 'annotation-reply-meta';
    meta.textContent = (reply.author || 'unknown') + ' · ' + formatTimestamp(reply.createdAt);
    var body = document.createElement('div');
    body.className = 'annotation-reply-body';
    body.textContent = reply.body || '';
    wrap.appendChild(meta);
    wrap.appendChild(body);
    return wrap;
  }

  function buildAnnotationCard(annotation) {
    var card = document.createElement('article');
    card.className = 'annotation-card annotation-state-row-' + annotation.state;
    if (annotation.state === 'resolved') card.classList.add('is-resolved');
    card.setAttribute('data-annotation-id', annotation.id);

    var header = document.createElement('header');
    header.className = 'annotation-meta';
    var who = document.createElement('span');
    who.className = 'annotation-author';
    who.textContent = annotation.author || 'unknown';
    var when = document.createElement('span');
    when.className = 'annotation-when';
    when.textContent = formatTimestamp(annotation.createdAt);
    header.appendChild(who);
    header.appendChild(when);
    header.appendChild(buildBadge(annotation.state));
    if (annotation.state === 'claimed' && annotation.claimedBy) {
      var claim = document.createElement('span');
      claim.className = 'annotation-claimed-by';
      claim.textContent = '→ ' + annotation.claimedBy;
      header.appendChild(claim);
    }
    card.appendChild(header);

    var body = document.createElement('div');
    body.className = 'annotation-body';
    body.textContent = annotation.body || '';
    card.appendChild(body);

    var replies = Array.isArray(annotation.replies) ? annotation.replies : [];
    if (replies.length) {
      var repliesWrap = document.createElement('div');
      repliesWrap.className = 'annotation-replies';
      replies.forEach(function (reply) { repliesWrap.appendChild(buildReplyNode(reply)); });
      card.appendChild(repliesWrap);
    }

    var actions = document.createElement('div');
    actions.className = 'annotation-actions';
    if (annotation.state !== 'claimed') actions.appendChild(actionButton('Claim', 'claim', annotation));
    if (annotation.state !== 'resolved') actions.appendChild(actionButton('Resolve', 'resolve', annotation));
    if (annotation.state === 'resolved') actions.appendChild(actionButton('Reopen', 'reopen', annotation));
    actions.appendChild(actionButton('Reply', 'reply', annotation));
    card.appendChild(actions);

    return card;
  }

  function actionButton(label, op, annotation) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotation-action annotation-action-' + op;
    btn.textContent = label;
    btn.addEventListener('click', function () { onAnnotationAction(op, annotation); });
    return btn;
  }

  function buildStaleEntry(annotation) {
    var wrap = document.createElement('article');
    wrap.className = 'annotation-card annotation-stale';
    wrap.setAttribute('data-annotation-id', annotation.id);
    var head = document.createElement('header');
    head.className = 'annotation-meta';
    var anchor = document.createElement('code');
    anchor.className = 'annotation-anchor';
    anchor.textContent = annotation.anchorKind + ' ' + annotation.anchor;
    head.appendChild(anchor);
    head.appendChild(buildBadge(annotation.state));
    wrap.appendChild(head);
    var body = document.createElement('div');
    body.className = 'annotation-body';
    body.textContent = annotation.body || '';
    wrap.appendChild(body);
    var meta = document.createElement('div');
    meta.className = 'annotation-when';
    meta.textContent = (annotation.author || 'unknown') + ' · ' + formatTimestamp(annotation.createdAt);
    wrap.appendChild(meta);
    return wrap;
  }

  function findAnchorTarget(annotation) {
    var id = (annotation.anchor || '').replace(/^#/, '');
    if (!id) return null;
    if (annotation.anchorKind === 'lineRange') return null;
    var node = document.getElementById(id);
    return node || null;
  }

  function ensureMountFor(anchorEl, anchorId) {
    var existing = document.querySelector('[data-annotations-mount][data-anchor-id="' + cssEscape(anchorId) + '"]');
    if (existing) return existing;
    var mount = document.createElement('section');
    mount.className = 'annotations-mount';
    mount.setAttribute('data-annotations-mount', '');
    mount.setAttribute('data-anchor-id', anchorId);
    var pre = anchorEl.closest('pre');
    if (pre && pre.parentNode) {
      pre.parentNode.insertBefore(mount, pre.nextSibling);
    } else if (anchorEl.parentNode) {
      anchorEl.parentNode.insertBefore(mount, anchorEl.nextSibling);
    }
    return mount;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/(["\\\[\]'])/g, '\\$1');
  }

  function clearAllMounts() {
    var mounts = document.querySelectorAll('[data-annotations-mount]');
    mounts.forEach(clearChildren);
    if (staleList) clearChildren(staleList);
    if (lineRangeList) clearChildren(lineRangeList);
  }

  function render() {
    clearAllMounts();
    var visibleCount = 0;
    var staleEntries = 0;
    var lineRangeEntries = 0;

    state.annotations.forEach(function (annotation) {
      if (annotation.state === 'resolved' && !state.showResolved) {
        return;
      }
      visibleCount += 1;
      if (annotation.anchorKind === 'lineRange') {
        if (lineRangeList) lineRangeList.appendChild(buildAnnotationCard(annotation));
        lineRangeEntries += 1;
        return;
      }
      var target = findAnchorTarget(annotation);
      if (!target) {
        if (staleList) staleList.appendChild(buildStaleEntry(annotation));
        staleEntries += 1;
        return;
      }
      var mount = ensureMountFor(target, (annotation.anchor || '').replace(/^#/, ''));
      if (mount) mount.appendChild(buildAnnotationCard(annotation));
    });

    if (staleAside) {
      var hasStale = staleEntries > 0;
      staleAside.hidden = !hasStale;
      staleAside.setAttribute('aria-hidden', hasStale ? 'false' : 'true');
      if (staleCount) staleCount.textContent = String(staleEntries);
    }
    if (lineRangeAside) {
      var hasLineRange = lineRangeEntries > 0;
      lineRangeAside.hidden = !hasLineRange;
      lineRangeAside.setAttribute('aria-hidden', hasLineRange ? 'false' : 'true');
      if (lineRangeCount) lineRangeCount.textContent = String(lineRangeEntries);
    }
    if (chipBtn) {
      var total = state.annotations.length;
      chipBtn.hidden = total === 0;
      if (chipCount) chipCount.textContent = String(total);
      chipBtn.setAttribute('aria-pressed', state.showResolved ? 'true' : 'false');
      chipBtn.classList.toggle('is-active', state.showResolved);
    }
  }

  function fetchAnnotations() {
    return fetch(annotationsUrl(''), {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    }).then(function (res) {
      if (!res.ok) throw new Error('annotations fetch failed: ' + res.status);
      return res.json();
    }).then(function (doc) {
      state.annotations = Array.isArray(doc.annotations) ? doc.annotations.slice() : [];
      state.annotations.sort(function (a, b) {
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
      render();
    }).catch(function () {
      state.annotations = [];
      render();
    });
  }

  function patchAnnotation(op, annotation, payload) {
    var body = {
      id: annotation.id,
      op: op,
      payload: payload || {},
    };
    return fetch(annotationsUrl(''), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 409) {
        return res.json().then(function () { return fetchAnnotations(); });
      }
      if (!res.ok) throw new Error('annotation update failed: ' + res.status);
      return fetchAnnotations();
    });
  }

  function postAnnotation(payload) {
    return fetch(annotationsUrl(''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error('annotation create failed: ' + res.status);
      return fetchAnnotations();
    });
  }

  function onAnnotationAction(op, annotation) {
    if (op === 'claim') {
      var author = getAuthor();
      if (!author) return;
      patchAnnotation('claim', annotation, { claimedBy: author, author: author });
      return;
    }
    if (op === 'resolve') { patchAnnotation('resolve', annotation, {}); return; }
    if (op === 'reopen') { patchAnnotation('reopen', annotation, {}); return; }
    if (op === 'reply') {
      openReplyEditor(annotation);
      return;
    }
  }

  function openReplyEditor(annotation) {
    var card = document.querySelector('.annotation-card[data-annotation-id="' + cssEscape(annotation.id) + '"]');
    if (!card) return;
    var existing = card.querySelector('.annotation-reply-editor');
    if (existing) { existing.querySelector('textarea').focus(); return; }
    var editor = buildEditor({
      placeholder: 'Reply…',
      submitLabel: 'Reply',
      onSubmit: function (body) {
        var author = getAuthor();
        if (!author) return Promise.resolve();
        return patchAnnotation('reply', annotation, { author: author, body: body });
      },
    });
    editor.classList.add('annotation-reply-editor');
    card.appendChild(editor);
    editor.querySelector('textarea').focus();
  }

  function buildEditor(opts) {
    var wrap = document.createElement('div');
    wrap.className = 'annotation-editor';
    var textarea = document.createElement('textarea');
    textarea.className = 'annotation-editor-input';
    textarea.placeholder = opts.placeholder || 'Annotation…';
    textarea.rows = 3;
    wrap.appendChild(textarea);
    var actions = document.createElement('div');
    actions.className = 'annotation-editor-actions';
    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'annotation-editor-submit';
    submitBtn.textContent = opts.submitLabel || 'Submit';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'annotation-editor-cancel';
    cancelBtn.textContent = 'Cancel';
    var status = document.createElement('span');
    status.className = 'annotation-editor-status';
    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(status);
    wrap.appendChild(actions);

    function submit() {
      var body = textarea.value.trim();
      if (!body) { status.textContent = 'Body is required.'; return; }
      status.textContent = 'Saving…';
      submitBtn.disabled = true;
      var p = opts.onSubmit(body);
      Promise.resolve(p).then(function () {
        wrap.remove();
      }).catch(function (err) {
        status.textContent = (err && err.message) || 'Failed to save.';
        submitBtn.disabled = false;
      });
    }

    submitBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', function () { wrap.remove(); });
    textarea.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        wrap.remove();
      }
    });
    return wrap;
  }

  function openAnnotateEditor(anchorId, anchorKind, triggerEl) {
    var mount = document.querySelector('[data-annotations-mount][data-anchor-id="' + cssEscape(anchorId) + '"]');
    if (!mount && triggerEl) {
      mount = ensureMountFor(triggerEl, anchorId);
    }
    if (!mount) return;
    var existing = mount.querySelector('.annotation-editor');
    if (existing) { existing.querySelector('textarea').focus(); return; }
    var editor = buildEditor({
      placeholder: 'Leave an annotation…',
      submitLabel: 'Submit',
      onSubmit: function (body) {
        var author = getAuthor();
        if (!author) return Promise.resolve();
        return postAnnotation({
          anchor: '#' + anchorId,
          anchorKind: anchorKind,
          body: body,
          author: author,
        });
      },
    });
    mount.appendChild(editor);
    editor.querySelector('textarea').focus();
  }

  function wireAffordances() {
    document.addEventListener('click', function (event) {
      var btn = event.target.closest && event.target.closest('.annotate-btn');
      if (!btn) return;
      event.preventDefault();
      var anchorId = btn.getAttribute('data-annotate-anchor-id');
      var anchorKind = btn.getAttribute('data-annotate-kind') || 'heading';
      if (!anchorId) return;
      openAnnotateEditor(anchorId, anchorKind, btn);
    });
  }

  function wireChip() {
    if (!chipBtn) return;
    chipBtn.addEventListener('click', function () {
      state.showResolved = !state.showResolved;
      render();
    });
  }

  function wireLineRangePicker() {
    if (!supportsLineRange || !renderedView) return;
    var pre = renderedView.querySelector('pre');
    var code = pre && pre.querySelector('code');
    if (!pre || !code) return;

    var rawText = code.textContent || '';
    var lineCount = rawText.split('\n').length;
    var gutter = document.createElement('div');
    gutter.className = 'line-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    for (var i = 1; i <= lineCount; i += 1) {
      var lineBtn = document.createElement('button');
      lineBtn.type = 'button';
      lineBtn.className = 'line-num';
      lineBtn.setAttribute('data-line', String(i));
      lineBtn.textContent = String(i);
      gutter.appendChild(lineBtn);
    }
    var wrap = document.createElement('div');
    wrap.className = 'code-with-gutter';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(gutter);
    wrap.appendChild(pre);

    var pickStart = null;
    var pickEnd = null;
    var floatBtn = document.createElement('button');
    floatBtn.type = 'button';
    floatBtn.className = 'line-range-annotate';
    floatBtn.hidden = true;
    wrap.appendChild(floatBtn);

    function clearPick() {
      pickStart = null;
      pickEnd = null;
      Array.prototype.forEach.call(gutter.querySelectorAll('.line-num'), function (el) {
        el.classList.remove('is-pick-start', 'is-pick-end', 'is-in-range');
      });
      floatBtn.hidden = true;
    }

    function paintRange(s, e) {
      Array.prototype.forEach.call(gutter.querySelectorAll('.line-num'), function (el) {
        var n = Number(el.getAttribute('data-line'));
        el.classList.toggle('is-pick-start', n === s);
        el.classList.toggle('is-pick-end', n === e);
        el.classList.toggle('is-in-range', n > Math.min(s, e) && n < Math.max(s, e));
      });
    }

    gutter.addEventListener('click', function (event) {
      var target = event.target.closest('.line-num');
      if (!target) return;
      var n = Number(target.getAttribute('data-line'));
      if (!n) return;
      if (pickStart === null || pickEnd !== null) {
        clearPick();
        pickStart = n;
        target.classList.add('is-pick-start');
        floatBtn.hidden = true;
        return;
      }
      pickEnd = n;
      var s = Math.min(pickStart, pickEnd);
      var e = Math.max(pickStart, pickEnd);
      paintRange(s, e);
      floatBtn.textContent = 'Annotate lines L' + s + '-L' + e;
      floatBtn.hidden = false;
    });

    floatBtn.addEventListener('click', function () {
      if (pickStart === null || pickEnd === null) return;
      var s = Math.min(pickStart, pickEnd);
      var e = Math.max(pickStart, pickEnd);
      var anchor = '#L' + s + '-L' + e;
      var mount = document.createElement('section');
      mount.className = 'annotations-mount annotations-mount-line-range';
      wrap.parentNode.insertBefore(mount, wrap.nextSibling);
      var editor = buildEditor({
        placeholder: 'Annotate lines L' + s + '-L' + e + '…',
        submitLabel: 'Submit',
        onSubmit: function (body) {
          var author = getAuthor();
          if (!author) return Promise.resolve();
          return postAnnotation({
            anchor: anchor,
            anchorKind: 'lineRange',
            body: body,
            author: author,
          }).then(function () {
            clearPick();
            mount.remove();
          });
        },
      });
      mount.appendChild(editor);
      editor.querySelector('textarea').focus();
    });
  }

  function init() {
    wireAffordances();
    wireChip();
    wireLineRangePicker();
    fetchAnnotations();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
