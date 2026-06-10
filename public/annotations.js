'use strict';

(function () {
  const bootstrap = window.__lookieLinkAnnotations;
  if (!bootstrap || !bootstrap.repo || !bootstrap.relativePath) return;

  const repo = bootstrap.repo;
  const relativePath = bootstrap.relativePath;
  const queryToken = bootstrap.queryToken || null;
  const apiBase = `/api/annotations/${encodeURIComponent(repo)}/${relativePath
    .split('/').map(encodeURIComponent).join('/')}`;

  function withToken(url) {
    if (!queryToken) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(queryToken)}`;
  }

  function getDefaultAuthor() {
    try {
      const stored = window.localStorage.getItem('lookieLinkAnnotationAuthor');
      if (stored && stored.trim()) return stored.trim();
    } catch (_) {}
    return '';
  }

  function setDefaultAuthor(value) {
    if (!value) return;
    try { window.localStorage.setItem('lookieLinkAnnotationAuthor', value); } catch (_) {}
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2), v);
        } else if (v !== null && v !== undefined) {
          node.setAttribute(k, v);
        }
      }
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function formatTimestamp(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }

  function classifyAnchor(element) {
    if (!element) return 'lineRange';
    if (/^H[1-6]$/.test(element.tagName)) return 'heading';
    if (element.classList.contains('yaml-anchor-wrap')) return 'yamlKey';
    return 'heading';
  }

  let cachedMtimeMs = null;
  const annotationsByAnchor = new Map();

  async function api(method, path, body) {
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(withToken(path), init);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const message = (data && data.error) || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function buildAnnotateButton(anchorId, anchorKind) {
    const btn = el('button', {
      type: 'button',
      class: 'lookie-annotate-btn',
      'aria-label': `Annotate ${anchorId}`,
      title: 'Add annotation',
      dataset: { anchorId, anchorKind },
    }, '💬');
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAnnotateForm(anchorId, anchorKind);
    });
    return btn;
  }

  function getOrCreateAnchorCard(anchorId) {
    let card = document.querySelector(
      `.lookie-annotation-card[data-anchor-id="${CSS.escape(anchorId)}"]`);
    if (card) return card;

    const target = document.getElementById(anchorId);
    if (!target) return null;

    card = el('aside', { class: 'lookie-annotation-card', dataset: { anchorId } });
    let insertAfter = target;
    if (target.classList.contains('yaml-anchor-wrap')) {
      const preParent = target.closest('pre');
      if (preParent) insertAfter = preParent;
    }
    if (insertAfter.parentNode) {
      insertAfter.parentNode.insertBefore(card, insertAfter.nextSibling);
    }
    return card;
  }

  function renderAnnotationList(anchorId) {
    const card = getOrCreateAnchorCard(anchorId);
    if (!card) return;
    card.innerHTML = '';
    const items = annotationsByAnchor.get(anchorId) || [];
    if (items.length === 0) { card.remove(); return; }
    card.appendChild(el('div', { class: 'lookie-annotation-card-header' },
      `Annotations on ${anchorId} (${items.length})`));
    for (const annotation of items) {
      card.appendChild(renderAnnotationItem(annotation));
    }
  }

  function renderAnnotationItem(annotation) {
    const stateClass = `lookie-annotation-state lookie-annotation-state-${annotation.state}`;
    const item = el('article', {
      class: 'lookie-annotation-item',
      dataset: { annotationId: annotation.id, state: annotation.state },
    });
    item.appendChild(el('header', { class: 'lookie-annotation-item-header' },
      el('span', { class: stateClass }, annotation.state),
      el('span', { class: 'lookie-annotation-author' }, annotation.author || 'anonymous'),
      el('time', { class: 'lookie-annotation-time', datetime: annotation.createdAt },
        formatTimestamp(annotation.createdAt)),
    ));
    item.appendChild(el('p', { class: 'lookie-annotation-body' }, annotation.body));

    if (Array.isArray(annotation.replies) && annotation.replies.length > 0) {
      const replies = el('ul', { class: 'lookie-annotation-replies' });
      for (const reply of annotation.replies) {
        replies.appendChild(el('li', { class: 'lookie-annotation-reply' },
          el('span', { class: 'lookie-annotation-author' }, reply.author || 'anonymous'),
          el('time', { datetime: reply.createdAt }, formatTimestamp(reply.createdAt)),
          el('p', { class: 'lookie-annotation-body' }, reply.body),
        ));
      }
      item.appendChild(replies);
    }

    const actions = el('div', { class: 'lookie-annotation-actions' });
    if (annotation.state === 'open') {
      actions.appendChild(makeOpBtn('Claim', annotation, 'claim'));
      actions.appendChild(makeOpBtn('Resolve', annotation, 'resolve'));
    } else if (annotation.state === 'claimed') {
      actions.appendChild(el('span', { class: 'lookie-annotation-claimed-by' },
        `claimed by ${annotation.claimedBy || 'unknown'}`));
      actions.appendChild(makeOpBtn('Resolve', annotation, 'resolve'));
      actions.appendChild(makeOpBtn('Reopen', annotation, 'reopen'));
    } else if (annotation.state === 'resolved') {
      actions.appendChild(makeOpBtn('Reopen', annotation, 'reopen'));
    }
    actions.appendChild(makeReplyBtn(annotation));
    item.appendChild(actions);
    return item;
  }

  function makeOpBtn(label, annotation, op) {
    return el('button', {
      type: 'button',
      class: `lookie-annotation-op lookie-annotation-op-${op}`,
      onclick: async () => {
        try {
          const payload = {};
          if (op === 'claim') {
            const claimedBy = window.prompt('Claim as (your name)?', getDefaultAuthor() || '');
            if (!claimedBy) return;
            setDefaultAuthor(claimedBy);
            payload.claimedBy = claimedBy;
          }
          await patchAnnotation(annotation.id, op, payload);
          await refreshAnnotations();
        } catch (error) {
          window.alert(`Annotation ${op} failed: ${error.message}`);
        }
      },
    }, label);
  }

  function makeReplyBtn(annotation) {
    return el('button', {
      type: 'button',
      class: 'lookie-annotation-op lookie-annotation-op-reply',
      onclick: async () => {
        const author = window.prompt('Your name?', getDefaultAuthor() || '');
        if (!author) return;
        const body = window.prompt('Reply body?');
        if (!body || !body.trim()) return;
        setDefaultAuthor(author);
        try {
          await patchAnnotation(annotation.id, 'reply', { author, body: body.trim() });
          await refreshAnnotations();
        } catch (error) {
          window.alert(`Annotation reply failed: ${error.message}`);
        }
      },
    }, 'Reply');
  }

  async function patchAnnotation(id, op, payload) {
    return api('PATCH', apiBase, { id, op, payload, expectedMtimeMs: cachedMtimeMs });
  }

  function openAnnotateForm(anchorId, anchorKind) {
    document.querySelectorAll('.lookie-annotate-form').forEach((node) => node.remove());
    const card = getOrCreateAnchorCard(anchorId);
    if (!card) return;

    const form = el('form', { class: 'lookie-annotate-form', dataset: { anchorId } });
    const authorInput = el('input', {
      type: 'text', name: 'author', placeholder: 'Your name',
      required: 'required', value: getDefaultAuthor(),
    });
    const bodyInput = el('textarea', {
      name: 'body', placeholder: 'What needs attention?',
      required: 'required', rows: '3',
    });
    const submit = el('button', { type: 'submit', class: 'lookie-annotation-submit' }, 'Save annotation');
    const cancel = el('button', {
      type: 'button', class: 'lookie-annotation-cancel',
      onclick: () => form.remove(),
    }, 'Cancel');

    form.appendChild(authorInput);
    form.appendChild(bodyInput);
    form.appendChild(el('div', { class: 'lookie-annotate-form-actions' }, submit, cancel));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const author = authorInput.value.trim();
      const body = bodyInput.value.trim();
      if (!author || !body) return;
      setDefaultAuthor(author);
      submit.disabled = true;
      try {
        await api('POST', apiBase, {
          anchor: `#${anchorId}`, anchorKind, author, body,
        });
        form.remove();
        await refreshAnnotations();
      } catch (error) {
        window.alert(`Save annotation failed: ${error.message}`);
        submit.disabled = false;
      }
    });

    card.appendChild(form);
    bodyInput.focus();
  }

  async function refreshAnnotations() {
    try {
      const doc = await api('GET', apiBase);
      cachedMtimeMs = doc.mtimeMs || null;
      annotationsByAnchor.clear();
      for (const annotation of doc.annotations || []) {
        const anchorId = String(annotation.anchor || '').replace(/^#/, '');
        if (!anchorId) continue;
        const list = annotationsByAnchor.get(anchorId) || [];
        list.push(annotation);
        annotationsByAnchor.set(anchorId, list);
      }
      const seen = new Set();
      for (const [anchorId] of annotationsByAnchor) {
        renderAnnotationList(anchorId);
        seen.add(anchorId);
      }
      document.querySelectorAll('.lookie-annotation-card').forEach((node) => {
        if (!seen.has(node.dataset.anchorId)) node.remove();
      });
    } catch (error) {
      console.warn('Lookie-Link: failed to load annotations', error);
    }
  }

  function injectAnnotateButtons() {
    const root = document.querySelector('article.content[data-rendered-view]')
      || document.querySelector('article.content');
    if (!root) return;
    const targets = root.querySelectorAll(
      'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], span.yaml-anchor-wrap[id]'
    );
    for (const target of targets) {
      if (target.dataset.lookieAnnotateInjected) continue;
      target.dataset.lookieAnnotateInjected = '1';
      const anchorId = target.id;
      if (!anchorId) continue;
      const kind = classifyAnchor(target);
      const btn = buildAnnotateButton(anchorId, kind);
      if (/^H[1-6]$/.test(target.tagName)) {
        target.appendChild(document.createTextNode(' '));
        target.appendChild(btn);
      } else {
        target.appendChild(btn);
      }
    }
  }

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  ready(() => {
    injectAnnotateButtons();
    refreshAnnotations();
  });
})();
