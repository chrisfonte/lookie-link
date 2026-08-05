'use strict';

(function () {
  const bootstrap = window.__lookieLinkAnnotations;
  if (!bootstrap || !bootstrap.repo || !bootstrap.relativePath) {
    return;
  }

  const repo = bootstrap.repo;
  const relativePath = bootstrap.relativePath;
  const queryToken = bootstrap.queryToken || null;
  const supportsLineRanges = Boolean(bootstrap.supportsLineRangeAnnotations);
  const apiBase = `/api/annotations/${encodeURIComponent(repo)}/${relativePath
    .split('/').map(encodeURIComponent).join('/')}`;

  const mountSelector = '[data-annotations-mount][data-anchor-id]';
  const toolbarToggle = document.querySelector('[data-annotations-toggle]');
  const staleBucket = document.querySelector('[data-annotations-stale]');
  const lineRangeRoot = document.querySelector('[data-annotations-line-range-root]');
  const renderedView = document.querySelector('[data-rendered-view]');

  let cachedDocument = null;
  let cachedMtimeMs = null;
  let showResolved = false;

  function withToken(url) {
    if (!queryToken) {
      return url;
    }
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(queryToken)}`;
  }

  function getDefaultAuthor() {
    try {
      const stored = window.localStorage.getItem('lookieLinkAnnotationAuthor');
      if (stored && stored.trim()) {
        return stored.trim();
      }
    } catch (_error) {
      // Ignore storage failures.
    }
    return '';
  }

  function setDefaultAuthor(value) {
    if (!value) {
      return;
    }
    try {
      window.localStorage.setItem('lookieLinkAnnotationAuthor', value);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) {
          continue;
        }
        if (key === 'class') {
          node.className = value;
        } else if (key === 'dataset') {
          for (const [dataKey, dataValue] of Object.entries(value)) {
            node.dataset[dataKey] = dataValue;
          }
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
        } else if (key === 'hidden') {
          node.hidden = Boolean(value);
        } else {
          node.setAttribute(key, value);
        }
      }
    }

    for (const child of children) {
      if (child === null || child === undefined) {
        continue;
      }
      if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  function formatTimestamp(iso) {
    if (!iso) {
      return '';
    }
    try {
      return new Date(iso).toLocaleString();
    } catch (_error) {
      return iso;
    }
  }

  async function api(method, path, body) {
    const init = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(withToken(path), init);
    let data = null;
    try {
      data = await response.json();
    } catch (_error) {
      data = null;
    }

    if (!response.ok) {
      const error = new Error((data && data.error) || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function parseLineRange(anchor) {
    const match = String(anchor || '').match(/^#L(\d+)-L(\d+)$/);
    if (!match) {
      return null;
    }
    return {
      start: Number(match[1]),
      end: Number(match[2]),
    };
  }

  function getSourceLineCount() {
    if (Number.isFinite(Number(bootstrap.sourceLineCount))) {
      return Number(bootstrap.sourceLineCount);
    }
    const codeNode = renderedView ? renderedView.querySelector('pre code, pre') : null;
    const raw = codeNode ? codeNode.textContent || '' : '';
    return raw ? raw.split(/\r?\n/).length : 1;
  }

  function getMount(anchorId) {
    return document.querySelector(`${mountSelector}[data-anchor-id="${CSS.escape(anchorId)}"]`);
  }

  function lineRangeAnchorId(anchor) {
    return String(anchor || '').replace(/^#/, '');
  }

  function updateToolbarCount(total, resolvedCount) {
    if (!toolbarToggle) {
      return;
    }
    toolbarToggle.hidden = false;
    toolbarToggle.textContent = `💬 ${total}`;
    toolbarToggle.setAttribute('aria-pressed', showResolved ? 'true' : 'false');
    toolbarToggle.title = showResolved
      ? 'Hide resolved annotations'
      : resolvedCount > 0
        ? `Show ${resolvedCount} resolved annotation${resolvedCount === 1 ? '' : 's'}`
        : 'Resolved annotations are hidden';
  }

  function summarizeText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function annotationBodyNode(entry) {
    const node = el('div', { class: 'lookie-annotation-body' });
    // bodyHtml is rendered server-side with raw HTML escaped; absence means an
    // older server or a degraded path, so fall back to the plain body.
    if (typeof entry.bodyHtml === 'string') {
      node.classList.add('lookie-annotation-body-rich');
      node.innerHTML = entry.bodyHtml;
    } else {
      node.textContent = entry.body;
    }
    return node;
  }

  function renderAnnotationItem(annotation) {
    const replyCount = Array.isArray(annotation.replies) ? annotation.replies.length : 0;
    const item = el('details', {
      class: 'lookie-annotation-item',
      dataset: {
        annotationId: annotation.id,
        state: annotation.state,
      },
    });

    item.appendChild(el(
      'summary',
      { class: 'lookie-annotation-summary' },
      el('span', { class: `lookie-annotation-state lookie-annotation-state-${annotation.state}` }, annotation.state),
      el('span', { class: 'lookie-annotation-author' }, annotation.author || 'anonymous'),
      el('time', { class: 'lookie-annotation-time', datetime: annotation.createdAt }, formatTimestamp(annotation.createdAt)),
      replyCount > 0
        ? el('span', { class: 'lookie-annotation-reply-count' }, `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`)
        : el('span', { class: 'lookie-annotation-reply-count lookie-annotation-reply-count-empty', 'aria-hidden': 'true' }, ''),
      el('span', { class: 'lookie-annotation-preview' }, summarizeText(annotation.body, 110))
    ));

    const detail = el('div', { class: 'lookie-annotation-detail' });
    detail.appendChild(annotationBodyNode(annotation));

    if (Array.isArray(annotation.replies) && annotation.replies.length > 0) {
      const replies = el('ul', { class: 'lookie-annotation-replies' });
      for (const reply of annotation.replies) {
        replies.appendChild(el(
          'li',
          { class: 'lookie-annotation-reply' },
          el('span', { class: 'lookie-annotation-author' }, reply.author || 'anonymous'),
          el('time', { datetime: reply.createdAt }, formatTimestamp(reply.createdAt)),
          annotationBodyNode(reply)
        ));
      }
      detail.appendChild(replies);
    }

    const actions = el('div', { class: 'lookie-annotation-actions' });
    if (annotation.state === 'open') {
      actions.appendChild(makeOpButton('Claim', annotation, 'claim'));
      actions.appendChild(makeOpButton('Resolve', annotation, 'resolve'));
    } else if (annotation.state === 'claimed') {
      actions.appendChild(el('span', { class: 'lookie-annotation-claimed-by' }, `claimed by ${annotation.claimedBy || 'unknown'}`));
      actions.appendChild(makeOpButton('Resolve', annotation, 'resolve'));
      actions.appendChild(makeOpButton('Reopen', annotation, 'reopen'));
    } else if (annotation.state === 'resolved') {
      actions.appendChild(makeOpButton('Reopen', annotation, 'reopen'));
    }
    actions.appendChild(makeOpButton('Redact', annotation, 'redact'));
    actions.appendChild(makeReplyButton(annotation));
    detail.appendChild(actions);
    item.appendChild(detail);

    return item;
  }

  function makeOpButton(label, annotation, op) {
    return el('button', {
      type: 'button',
      class: `lookie-annotation-op lookie-annotation-op-${op}`,
      onclick: async () => {
        try {
          const payload = {};
          if (op === 'claim') {
            const claimedBy = window.prompt('Claim as (your name)?', getDefaultAuthor() || '');
            if (!claimedBy || !claimedBy.trim()) {
              return;
            }
            payload.claimedBy = claimedBy.trim();
            setDefaultAuthor(payload.claimedBy);
          } else if (op === 'redact') {
            const redactedBy = window.prompt('Redact as (your name)?', getDefaultAuthor() || '');
            if (!redactedBy || !redactedBy.trim()) {
              return;
            }
            const confirmed = window.confirm('Redact this annotation body and all reply bodies? This cannot be undone.');
            if (!confirmed) {
              return;
            }
            payload.redactedBy = redactedBy.trim();
            setDefaultAuthor(payload.redactedBy);
          }
          await patchAnnotation(annotation.id, op, payload);
        } catch (error) {
          window.alert(`Annotation ${op} failed: ${error.message}`);
        }
      },
    }, label);
  }

  function makeReplyButton(annotation) {
    return el('button', {
      type: 'button',
      class: 'lookie-annotation-op lookie-annotation-op-reply',
      onclick: async () => {
        const author = window.prompt('Your name?', getDefaultAuthor() || '');
        if (!author || !author.trim()) {
          return;
        }
        const body = window.prompt('Reply body?');
        if (!body || !body.trim()) {
          return;
        }
        setDefaultAuthor(author.trim());
        try {
          await patchAnnotation(annotation.id, 'reply', {
            author: author.trim(),
            body: body.trim(),
          });
        } catch (error) {
          window.alert(`Annotation reply failed: ${error.message}`);
        }
      },
    }, 'Reply');
  }

  function clearAnchorMounts() {
    // Re-renders must not destroy an open compose form (or a draft in it).
    document.querySelectorAll(mountSelector).forEach((mount) => {
      mount.querySelectorAll('.lookie-annotation-card').forEach((card) => card.remove());
      mount.hidden = !mount.querySelector('.lookie-annotate-form');
    });
  }

  function clearLineRangeRoot() {
    if (!lineRangeRoot) {
      return;
    }
    lineRangeRoot.innerHTML = '';
    lineRangeRoot.hidden = true;
  }

  function clearStaleBucket() {
    if (!staleBucket) {
      return;
    }
    staleBucket.innerHTML = '';
    staleBucket.hidden = true;
  }

  function createCard(title, anchorId) {
    return el(
      'section',
      {
        class: 'lookie-annotation-card',
        dataset: anchorId ? { anchorId } : {},
      },
      el('div', { class: 'lookie-annotation-card-header' }, title)
    );
  }

  function renderGroup(card, annotations) {
    for (const annotation of annotations) {
      card.appendChild(renderAnnotationItem(annotation));
    }
  }

  function ensureLineRangePicker() {
    if (!supportsLineRanges || !lineRangeRoot) {
      return;
    }

    lineRangeRoot.hidden = false;
    const lineCount = Math.max(1, getSourceLineCount());
    const title = el('div', { class: 'lookie-annotation-card-header' }, `Line-range annotations (${lineCount} lines)`);
    const groups = el('div', { class: 'lookie-line-range-groups', dataset: { role: 'groups' } });

    const form = el('form', { class: 'lookie-line-range-form', dataset: { role: 'lineRangeForm' } });
    const startInput = el('input', {
      type: 'number',
      min: '1',
      max: String(lineCount),
      name: 'start',
      placeholder: 'Start line',
      required: 'required',
      value: '1',
    });
    const endInput = el('input', {
      type: 'number',
      min: '1',
      max: String(lineCount),
      name: 'end',
      placeholder: 'End line',
      required: 'required',
      value: '1',
    });
    const authorInput = el('input', {
      type: 'text',
      name: 'author',
      placeholder: 'Your name',
      required: 'required',
      value: getDefaultAuthor(),
    });
    const bodyInput = el('textarea', {
      name: 'body',
      rows: '3',
      placeholder: 'What needs attention in this range?',
      required: 'required',
    });
    const submit = el('button', { type: 'submit', class: 'lookie-annotation-submit' }, 'Annotate lines');

    form.appendChild(el('div', { class: 'lookie-line-range-row' }, startInput, endInput, authorInput));
    form.appendChild(bodyInput);
    form.appendChild(el('div', { class: 'lookie-annotate-form-actions' }, submit));
    bindQuickSubmit(form, bodyInput, submit);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const start = Number(startInput.value);
      const end = Number(endInput.value);
      const author = authorInput.value.trim();
      const body = bodyInput.value.trim();
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lineCount) {
        window.alert(`Choose a valid line range between 1 and ${lineCount}.`);
        return;
      }
      if (!author || !body) {
        return;
      }

      setDefaultAuthor(author);
      submit.disabled = true;
      try {
        await createAnnotation({
          anchor: `#L${start}-L${end}`,
          anchorKind: 'lineRange',
          author,
          body,
        });
        bodyInput.value = '';
      } catch (error) {
        window.alert(`Save annotation failed: ${error.message}`);
      } finally {
        submit.disabled = false;
      }
    });

    lineRangeRoot.appendChild(title);
    lineRangeRoot.appendChild(form);
    lineRangeRoot.appendChild(groups);
  }

  function addLineRangeGroups(annotations) {
    if (!supportsLineRanges || !lineRangeRoot) {
      return;
    }

    const groups = lineRangeRoot.querySelector('[data-role="groups"]');
    if (!groups) {
      return;
    }

    const sortedEntries = Array.from(annotations.entries()).sort((left, right) => {
      const leftRange = parseLineRange(left[0]);
      const rightRange = parseLineRange(right[0]);
      return (leftRange ? leftRange.start : 0) - (rightRange ? rightRange.start : 0);
    });

    for (const [anchor, items] of sortedEntries) {
      const range = parseLineRange(anchor);
      if (!range) {
        continue;
      }
      const card = createCard(`Lines ${range.start}-${range.end}`, lineRangeAnchorId(anchor));
      renderGroup(card, items);
      groups.appendChild(card);
    }
  }

  function renderStaleAnnotations(annotations) {
    if (!staleBucket || annotations.length === 0) {
      return;
    }

    staleBucket.hidden = false;
    staleBucket.appendChild(el('h2', { class: 'lookie-stale-title' }, `Stale anchors (${annotations.length})`));
    for (const annotation of annotations) {
      const label = annotation.anchorKind === 'lineRange'
        ? `Missing line range ${annotation.anchor}`
        : `Missing anchor ${annotation.anchor}`;
      const card = createCard(label, lineRangeAnchorId(annotation.anchor));
      renderGroup(card, [annotation]);
      staleBucket.appendChild(card);
    }
  }

  function bindQuickSubmit(form, bodyInput, submit) {
    bodyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(submit);
        } else {
          submit.click();
        }
      }
    });
  }

  function openAnchorForm(anchorId, anchorKind) {
    const mount = getMount(anchorId);
    if (!mount) {
      return;
    }

    mount.hidden = false;
    const prior = mount.querySelector('.lookie-annotate-form');
    if (prior) {
      const priorBody = prior.querySelector('textarea[name="body"]');
      if (priorBody) {
        priorBody.focus();
      }
      return;
    }

    const form = el('form', { class: 'lookie-annotate-form' });
    const authorInput = el('input', {
      type: 'text',
      name: 'author',
      placeholder: 'Your name',
      required: 'required',
      value: getDefaultAuthor(),
    });
    const bodyInput = el('textarea', {
      name: 'body',
      rows: '6',
      placeholder: 'What needs attention?',
      required: 'required',
    });
    const submit = el('button', { type: 'submit', class: 'lookie-annotation-submit' }, 'Save annotation');
    const cancel = el('button', {
      type: 'button',
      class: 'lookie-annotation-cancel',
      onclick: () => {
        form.remove();
        if (!mount.querySelector('.lookie-annotation-item')) {
          mount.hidden = true;
        }
      },
    }, 'Cancel');

    form.appendChild(authorInput);
    form.appendChild(bodyInput);
    form.appendChild(el('div', { class: 'lookie-annotate-form-actions' }, submit, cancel));
    bindQuickSubmit(form, bodyInput, submit);

    // The form persists after a save (body clears, focus returns) so a run of
    // rapid notes on one anchor costs one open, not one per note.
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const author = authorInput.value.trim();
      const body = bodyInput.value.trim();
      if (!author || !body) {
        return;
      }
      setDefaultAuthor(author);
      submit.disabled = true;
      try {
        await createAnnotation({
          anchor: `#${anchorId}`,
          anchorKind,
          author,
          body,
        });
        bodyInput.value = '';
      } catch (error) {
        window.alert(`Save annotation failed: ${error.message}`);
        return;
      } finally {
        submit.disabled = false;
      }
      bodyInput.focus();
    });

    mount.appendChild(form);
    bodyInput.focus();
  }

  function applyDocument(doc, mtimeMs) {
    cachedDocument = doc;
    cachedMtimeMs = mtimeMs === undefined ? null : mtimeMs;

    clearAnchorMounts();
    clearLineRangeRoot();
    clearStaleBucket();

    if (!doc || !Array.isArray(doc.annotations)) {
      updateToolbarCount(0, 0);
      if (supportsLineRanges) {
        ensureLineRangePicker();
      }
      return;
    }

    const totalCount = doc.annotations.length;
    const resolvedCount = doc.annotations.filter((annotation) => annotation.state === 'resolved').length;
    updateToolbarCount(totalCount, resolvedCount);

    const anchored = new Map();
    const lineRanges = new Map();
    const stale = [];
    const sourceLineCount = Math.max(1, getSourceLineCount());

    for (const annotation of doc.annotations) {
      if (annotation.state === 'resolved' && !showResolved) {
        continue;
      }

      if (annotation.anchorKind === 'lineRange') {
        const range = parseLineRange(annotation.anchor);
        if (!range || range.end > sourceLineCount) {
          stale.push(annotation);
          continue;
        }
        const bucket = lineRanges.get(annotation.anchor) || [];
        bucket.push(annotation);
        lineRanges.set(annotation.anchor, bucket);
        continue;
      }

      const anchorId = lineRangeAnchorId(annotation.anchor);
      const mount = getMount(anchorId);
      const anchorNode = document.getElementById(anchorId);
      if (!mount || !anchorNode) {
        stale.push(annotation);
        continue;
      }
      const bucket = anchored.get(anchorId) || [];
      bucket.push(annotation);
      anchored.set(anchorId, bucket);
    }

    for (const [anchorId, annotations] of anchored.entries()) {
      const mount = getMount(anchorId);
      if (!mount) {
        continue;
      }
      const title = mount.dataset.anchorKind === 'yamlKey'
        ? `Annotations on ${anchorId}`
        : `Annotations on ${anchorId}`;
      const card = createCard(title, anchorId);
      renderGroup(card, annotations);
      mount.hidden = false;
      mount.insertBefore(card, mount.querySelector('.lookie-annotate-form'));
    }

    if (supportsLineRanges) {
      ensureLineRangePicker();
      addLineRangeGroups(lineRanges);
    }

    renderStaleAnnotations(stale);
  }

  async function refreshAnnotations() {
    try {
      const doc = await api('GET', apiBase);
      applyDocument(doc, doc.mtimeMs);
    } catch (error) {
      console.warn('Lookie-Link: failed to load annotations', error);
    }
  }

  async function createAnnotation(payload) {
    const result = await api('POST', apiBase, payload);
    cachedMtimeMs = result.mtimeMs === undefined ? cachedMtimeMs : result.mtimeMs;
    await refreshAnnotations();
    return result;
  }

  async function patchAnnotation(id, op, payload) {
    try {
      const result = await api('PATCH', apiBase, {
        id,
        op,
        payload,
        expectedMtimeMs: cachedMtimeMs,
      });
      cachedMtimeMs = result.mtimeMs === undefined ? cachedMtimeMs : result.mtimeMs;
      await refreshAnnotations();
      return result;
    } catch (error) {
      if (error.status === 409 && error.data && error.data.current) {
        applyDocument(error.data.current, error.data.currentMtimeMs);
      }
      throw error;
    }
  }

  function bindAnnotateButtons() {
    document.querySelectorAll('[data-annotate-trigger][data-anchor-id]').forEach((button) => {
      if (button.dataset.lookieBound === '1') {
        return;
      }
      button.dataset.lookieBound = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const anchorId = button.dataset.anchorId;
        const anchorKind = button.dataset.anchorKind || 'heading';
        if (!anchorId) {
          return;
        }
        openAnchorForm(anchorId, anchorKind);
      });
    });
  }

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  ready(() => {
    bindAnnotateButtons();
    if (toolbarToggle) {
      toolbarToggle.addEventListener('click', () => {
        showResolved = !showResolved;
        if (cachedDocument) {
          applyDocument(cachedDocument, cachedMtimeMs);
        }
      });
    }
    refreshAnnotations();
  });
})();
