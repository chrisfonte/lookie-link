'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { baseHtml, themeScript, toolbarHtml, getThemeList, propertiesMenu } = require('../renderer');
const { storeForTemplate } = require('./destination-adapter');
const { isDefinitionId } = require('./template-registry');

const CONTEXT_COOKIE = 'lookie_forms_context';
const MAX_CONTEXTS = 10000;
const MAX_STEPPED_OPTIONS = 200;
const RECENT_ENTRY_LIMIT = 3;
const CONTAINER_RECENT_LIMIT = 6;
const ARTIFACT_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';
const EMBED_SANDBOX = `${ARTIFACT_SANDBOX} allow-top-navigation-by-user-activation`; // #232 — mirrors server.js
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMPLATE_CREATE_KEYS = new Set([
  'templateId', 'grammarVersion', 'destinationId', 'title', 'description', 'tags',
  'lineage', 'presentation', 'fields', 'kind', 'containerId', 'memberOrder', 'parentId',
]);
const TEMPLATE_PATCH_KEYS = new Set([
  'revision', 'grammarVersion', 'destinationId', 'title', 'description', 'tags',
  'lineage', 'presentation', 'fields', 'containerId', 'memberOrder', 'parentId',
]);
const TEMPLATE_PUBLISH_KEYS = new Set(['revision']);
const TEMPLATE_CLONE_KEYS = new Set(['templateId', 'templateVersion', 'title']);
const TEMPLATE_LIFECYCLE_KEYS = new Set(['revision']);
const FIELD_TYPES = [
  ['short-text', 'Short text'],
  ['long-text', 'Long text'],
  ['number', 'Number'],
  ['checkbox', 'Checkbox'],
  ['date', 'Date'],
  ['time', 'Time'],
  ['datetime', 'Date and time'],
  ['select', 'Select one'],
  ['multi-select', 'Select multiple'],
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cookieValue(req, name) {
  const header = typeof req.get === 'function' ? req.get('cookie') : null;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function queryCarriesToken(req) {
  return Boolean(req.query && Object.prototype.hasOwnProperty.call(req.query, 'token'));
}

function bearerPresented(req) {
  const header = req.get('authorization');
  return typeof header === 'string' && /^Bearer\s+\S/i.test(header);
}

function principalFor(req) {
  const context = req.accessContext || {};
  if (context.principal && typeof context.principal.id === 'string') {
    return { id: context.principal.id, type: context.principal.kind || 'agent' };
  }
  if (context.subject && typeof context.subject.agentId === 'string') {
    return { id: context.subject.agentId, type: 'agent' };
  }
  if (context.mode === 'unrestricted') return { id: 'operator', type: 'operator' };
  return null;
}

function capabilityValue(capabilities, capability) {
  if (Array.isArray(capabilities)) return capabilities.includes(capability);
  if (capabilities instanceof Set) return capabilities.has(capability);
  return Boolean(capabilities && capabilities[capability] === true);
}

function defaultAuthorize({ req, capability }) {
  const context = req.accessContext || {};
  if (context.mode === 'unrestricted') return true;
  return capabilityValue(context.capabilities, capability)
    || capabilityValue(context.formsCapabilities, capability)
    || capabilityValue(context.permissions, capability);
}

function formHeaders(res, cspNonce) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', [
    "default-src 'none'",
    `style-src 'self' https://fonts.googleapis.com 'nonce-${cspNonce}'`,
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${cspNonce}'`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; '));
}

function formBreadcrumbs(template, options = {}) {
  // #273: the ancestor path is gone — the toolbar's Trackers menu and lit group
  // buttons (#272) carry that navigation now. What remains is the page's name.
  if (template) {
    const href = `/forms/${encodeURIComponent(template.templateId)}`;
    const label = options.leadLabel ? escapeHtml(options.leadLabel) : escapeHtml(template.title);
    return `<nav class="breadcrumbs"><h1 class="crumb-title"><a href="${href}" aria-current="page">${label}</a></h1></nav>`;
  }
  if (options.leadLabel) {
    return `<nav class="breadcrumbs"><h1 class="crumb-title"><span aria-current="page">${escapeHtml(options.leadLabel)}</span></h1></nav>`;
  }
  return '';
}

function createLinks(group) {
  // #295: New tracker / New group as plain links under the bar — no button
  // chrome, no extra colors; the bar stays a view switcher.
  const tracker = group
    ? `/forms/new?group=${encodeURIComponent(group)}`
    : '/forms/new';
  return `<div class="create-links"><a href="${tracker}">+ New tracker</a><a href="/forms/new?kind=container">+ New group</a></div>`;
}

function containerHubNav(templateId, active, canManage) {
  // #234 follow-up: a container is a form, so its pages carry the same hub tabs.
  const href = `/forms/${encodeURIComponent(templateId)}`;
  // #285: hierarchy lives in the bars — a group's bar leads with Groups (the
  // main page), a tracker's leads with its group. The toolbar dropdown retired.
  // #293: same grammar as the tracker bar — up | main | do | history | admin;
  // the action sits next to what it acts on, admin stays last.
  // #295 (final): the bar carries views; creation is a quiet link line under it.
  const links = [
    ['groups', '/forms', 'Groups'],
    ['view', href, 'Trackers'],
    ['history', `${href}/entries`, 'History'],
    ...(canManage ? [['configure', `${href}/configure`, 'Configure']] : []),
  ];
  return `<nav class="form-hub-nav" aria-label="Group views">${links.map(([key, linkHref, label]) =>
    `<a class="${key}-link" href="${linkHref}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('')}</nav>`;
}

function formHubNav(templateId, active, canManage, group) {
  const formHref = `/forms/${encodeURIComponent(templateId)}`;
  // #284: the way UP rides the sticky bar — the tracker's group, or the root
  // for ungrouped trackers. Always on screen; no dead ends inside a tracker.
  const up = group
    ? ['up', `/forms/${encodeURIComponent(group.templateId)}`, `← ${escapeHtml(group.title)}`]
    : ['up', '/forms', '← Trackers'];
  const links = [
    up,
    ['log', formHref, 'Log an entry'],
    ['history', `${formHref}/entries`, 'History'],
    ...(canManage ? [['configure', `${formHref}/configure`, 'Configure']] : []),
  ];
  return `<nav class="form-hub-nav" aria-label="Form views">${links.map(([key, href, label]) =>
    `<a class="${key === 'history' ? 'entries-link' : `${key}-link`}" href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('')}</nav>`;
}

function errorMap(errors) {
  const mapped = new Map();
  for (const error of errors || []) {
    const fieldId = String(error.path || '').replace(/^values\./, '').split(/[.[]/, 1)[0];
    if (!mapped.has(fieldId)) mapped.set(fieldId, []);
    mapped.get(fieldId).push(error.message);
  }
  return mapped;
}

function hasRawValue(values, fieldId) {
  return Object.prototype.hasOwnProperty.call(values || {}, fieldId);
}

function rawValue(values, field) {
  if (hasRawValue(values, field.id)) return values[field.id];
  return field.default;
}

function unitFromLabel(label) {
  const match = /\s*\(([^()]{1,16})\)\s*$/.exec(String(label || ''));
  return match && match[1].trim() ? match[1].trim() : null;
}

function labelWithoutUnit(label) {
  const unit = unitFromLabel(label);
  return unit ? String(label).replace(/\s*\([^()]{1,16}\)\s*$/, '').trim() : String(label || '');
}

function groupedFields(fields) {
  const groups = [
    { key: 'selection', title: 'What you\u2019re logging', fields: [] },
    { key: 'readouts', title: 'Measurements', fields: [] },
    { key: 'details', title: 'More about this entry', fields: [] },
  ];
  for (const field of (fields || []).filter((candidate) => candidate.isDestroyed !== true)) {
    if (field.type === 'select' || field.type === 'multi-select') groups[0].fields.push(field);
    else if (field.type === 'number') groups[1].fields.push(field);
    else groups[2].fields.push(field);
  }
  return groups.filter((group) => group.fields.length > 0);
}

function constraintAttributes(field) {
  const constraints = field.constraints || {};
  const attributes = [];
  if (constraints.minimum !== undefined) attributes.push(`min="${escapeHtml(constraints.minimum)}"`);
  if (constraints.maximum !== undefined) attributes.push(`max="${escapeHtml(constraints.maximum)}"`);
  if (field.type === 'number') {
    attributes.push(`step="${escapeHtml(constraints.step ?? (constraints.integer === true ? 1 : 'any'))}"`);
  }
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

function steppedValues(field) {
  if (field.type !== 'number' || field.component !== 'stepped-select') return null;
  const { minimum, maximum, step } = field.constraints || {};
  if (![minimum, maximum, step].every((value) => typeof value === 'number' && Number.isFinite(value))
      || step <= 0 || maximum < minimum) return null;
  const intervals = Math.round((maximum - minimum) / step);
  const count = intervals + 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STEPPED_OPTIONS) return null;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const computed = index === intervals ? maximum : minimum + (index * step);
    const value = Number(computed.toPrecision(15));
    if (!Number.isFinite(value) || (values.length && value <= values.at(-1))) return null;
    values.push(Object.is(value, -0) ? 0 : value);
  }
  return values;
}

function renderSteppedOptions(value, options) {
  const hasValue = value !== undefined && value !== null && value !== '';
  const selectedValue = hasValue ? Number(value) : null;
  return `<option value="">Select…</option>${options.map((option) => {
    const text = String(option);
    return `<option value="${escapeHtml(text)}"${hasValue && selectedValue === option ? ' selected' : ''}>${escapeHtml(text)}</option>`;
  }).join('')}`;
}

function renderOptions(field, value, multiple) {
  const selected = new Set(Array.isArray(value) ? value.map(String) : [String(value ?? '')]);
  return (field.options || []).map((option) => {
    const attributes = [
      `value="${escapeHtml(option.id)}"`,
      selected.has(option.id) ? 'selected' : '',
      option.disabled ? 'disabled' : '',
    ].filter(Boolean).join(' ');
    return `<option ${attributes}>${escapeHtml(option.label)}</option>`;
  }).join('');
}

function renderControl(field, values, describedBy = [], invalid = false, options = {}) {
  const value = options.autoStamp ? options.datetimeSeed : rawValue(values, field);
  const description = describedBy.length ? ` aria-describedby="${describedBy.map(escapeHtml).join(' ')}"` : '';
  const controlId = options.controlId || `field-${field.id}`;
  const common = `id="${escapeHtml(controlId)}" name="${escapeHtml(field.id)}"${field.required ? ' required' : ''}${invalid ? ' aria-invalid="true"' : ''}${description}`;
  if (field.type === 'select') {
    return `<select ${common}><option value="">Select…</option>${renderOptions(field, value, false)}</select>`;
  }
  if (field.type === 'multi-select') {
    return `<select ${common} multiple size="${Math.min(6, Math.max(2, (field.options || []).length))}">${renderOptions(field, value, true)}</select>`;
  }
  if (field.type === 'long-text') {
    return `<textarea ${common} rows="5">${escapeHtml(value)}</textarea>`;
  }
  if (field.type === 'checkbox') {
    const checked = value === true || value === 'true' || value === 'on';
    return `<span class="checkbox-control"><input ${common} type="checkbox" value="true"${checked ? ' checked' : ''}><span class="checkbox-mark" aria-hidden="true"></span></span>`;
  }
  const steppedOptions = steppedValues(field);
  if (steppedOptions) {
    const select = `<select class="stepped-select" ${common}>${renderSteppedOptions(value, steppedOptions)}</select>`;
    const unit = unitFromLabel(field.label);
    return unit
      ? `<div class="readout-control readout-control-select">${select}<span class="readout-unit" id="${escapeHtml(controlId)}-unit">${escapeHtml(unit)}</span></div>`
      : select;
  }
  const inputTypes = {
    'short-text': 'text',
    number: 'number',
    date: 'date',
    time: 'time',
    datetime: 'datetime-local',
  };
  const datetimeCapture = field.type === 'datetime'
    ? ` data-datetime-local data-offset-field="${escapeHtml(field.id)}__offset" data-timezone-field="${escapeHtml(field.id)}__timezone"${options.autoStamp ? ` data-auto-stamp data-seed-field="${escapeHtml(field.id)}__seed" data-stamp-field="${escapeHtml(field.id)}__stamp"` : ''}`
    : '';
  const datetimeMetadata = field.type === 'datetime'
    ? `<input type="hidden" name="${escapeHtml(field.id)}__offset"><input type="hidden" name="${escapeHtml(field.id)}__timezone">${options.autoStamp ? `<input type="hidden" name="${escapeHtml(field.id)}__seed" value="${escapeHtml(options.datetimeSeed)}"><input type="hidden" name="${escapeHtml(field.id)}__stamp" value="seed">` : ''}`
    : '';
  const placeholder = field.type === 'number' ? ' placeholder="\u2014"' : '';
  const input = `<input ${common} type="${inputTypes[field.type]}" value="${escapeHtml(value)}"${placeholder}${field.type === 'number' || field.type === 'date' ? constraintAttributes(field) : ''}${datetimeCapture}>${datetimeMetadata}`;
  const unit = field.type === 'number' ? unitFromLabel(field.label) : null;
  return unit
    ? `<div class="readout-control">${input}<span class="readout-unit" id="${escapeHtml(controlId)}-unit">${escapeHtml(unit)}</span></div>`
    : input;
}

function datetimeCaptureScript(cspNonce) {
  return `<script nonce="${escapeHtml(cspNonce)}">
(() => {
  const pad = (value) => String(value).padStart(2, '0');
  const localValue = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  for (const input of document.querySelectorAll('input[data-datetime-local]')) {
    const offset = input.form.elements[input.dataset.offsetField];
    const timezone = input.form.elements[input.dataset.timezoneField];
    const stamp = input.dataset.stampField ? input.form.elements[input.dataset.stampField] : null;
    let dirty = !input.hasAttribute('data-auto-stamp');
    const sync = () => {
      const instant = new Date(input.value);
      if (offset && Number.isFinite(instant.getTime())) offset.value = String(-instant.getTimezoneOffset());
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timezone && zone) timezone.value = zone;
    };
    const override = () => {
      dirty = true;
      if (stamp) stamp.value = 'dirty';
      sync();
    };
    input.addEventListener('input', override);
    input.addEventListener('change', override);
    input.form.addEventListener('submit', () => {
      if (!dirty) {
        input.value = localValue(new Date());
        if (stamp) stamp.value = 'stamped';
      }
      sync();
    });
    sync();
  }
})();
</script>`;
}

function renderFormPreview(member) {
  // Container member previews use the platform's own field renderers inside a
  // disabled fieldset — see the form exactly as it renders, without submitting.
  const fields = (member.fields || []).filter((field) => field.isDestroyed !== true);
  const rows = fields.map((field) => {
    const controlId = `preview-${member.templateId}-${field.id}`;
    return `<div class="field field-${escapeHtml(field.type)}">
      <label for="${escapeHtml(controlId)}">${escapeHtml(field.label)}${field.required ? ' <span aria-label="required">*</span>' : ''}</label>
      ${renderControl(field, {}, [], false, {controlId})}
    </div>`;
  }).join('');
  return `<fieldset disabled class="container-form-preview" aria-label="Preview of ${escapeHtml(member.title)}">${rows}</fieldset>`;
}

function renderArchivedMembers(archived, csrfToken) {
  // #293: a group's archived trackers live WITH the group, restorable in place.
  if (!archived.length) return '';
  const rows = archived.map((member) => `<div class="archived-member-row"><span>${escapeHtml(member.title)}</span>
    <form method="post" action="/forms/${encodeURIComponent(member.templateId)}/restore">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="revision" value="${escapeHtml(member.revision)}">
      <button type="submit">Restore</button>
    </form></div>`).join('');
  return `<details class="forms-index-archived"><summary>Show archived <span>${archived.length}</span></summary><div class="archived-member-list">${rows}</div></details>`;
}

function renderContainerPage(template, members, options = {}) {
  // #234: a container's page IS its form view — member navigation instead of fields.
  const cards = members.length
    ? members.map((member) => (
      `<details class="container-member-row">
        <summary class="container-member"><a class="container-member-title" href="/forms/${encodeURIComponent(member.templateId)}">${escapeHtml(member.title)}</a><span aria-hidden="true">›</span></summary>
        <div class="container-member-preview">
          ${renderFormPreview(member)}
          <div class="container-member-actions">
            <a class="button-link button-link-primary container-member-open" href="/forms/${encodeURIComponent(member.templateId)}">Open ${escapeHtml(member.title)}</a>
            ${options.canManage ? `<a class="container-member-configure" href="/forms/${encodeURIComponent(member.templateId)}/configure">Configure</a>` : ''}
          </div>
        </div>
      </details>`
    )).join('')
    : '<p class="container-empty">No trackers in this group yet. Add some from its Configure page.</p>';
  const body = `${toolbarHtml(formProperties(template, {memberCount: members.length}))}
  <main class="layout form-layout container-layout">
    <header class="topbar">
      <div>${formBreadcrumbs(template)}${template.description ? `<p class="subtitle">${escapeHtml(template.description)}</p>` : ''}</div>
    </header>
    ${containerHubNav(template.templateId, 'view', options.canManage)}
    ${options.canManage ? createLinks(template.templateId) : ''}
    <section class="content form-card container-card">
      <div class="container-members">${cards}</div>
      ${renderArchivedMembers(options.archivedMembers || [], options.csrfToken)}
    </section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;
  return baseHtml({
    title: template.title,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
  });
}

function renderRelatedFormsNav(nav) {
  // #234: container membership (with a back-to-container button) or tag fallback.
  const related = nav && nav.related ? nav.related : [];
  const container = nav && nav.container ? nav.container : null;
  if (!related.length && !container) return '';
  const back = container
    ? `<a class="related-container-link" href="/forms/${encodeURIComponent(container.templateId)}">← ${escapeHtml(container.title)}</a>`
    : '';
  const pills = related.map((template) => (
    `<a class="related-form-link" href="/forms/${encodeURIComponent(template.templateId)}">${escapeHtml(template.title)}</a>`
  )).join('');
  // No heading — the strip explains itself (operator call, 2026-07-29).
  return `<nav class="related-forms" aria-label="Related trackers">
        <div class="related-forms-list">${back}${pills}</div>
      </nav>`;
}

function renderRecentEntries(template, records, timezone, csrfToken, now) {
  const entriesHref = `/forms/${encodeURIComponent(template.templateId)}/entries`;
  const content = records.length
    ? `<div class="entry-list">${records.map((record) => renderEntryRow(template, record, timezone, csrfToken, { now })).join('')}</div>`
    : '<p class="recent-entries-empty">Your first entry will appear here after you submit it.</p>';
  return `<aside class="recent-entries" aria-labelledby="recent-entries-heading">
        <div class="recent-entries-heading">
          <h2 id="recent-entries-heading">Recent entries</h2>
          <a href="${entriesHref}">View all</a>
        </div>
        ${content}
      </aside>`;
}

function renderFormPage(template, csrfToken, values = {}, errors = [], options = {}) {
  const editing = Boolean(options.correctionRecord);
  const autoStampDatetimeIds = options.autoStampDatetimeIds || new Set((template.fields || [])
    .filter((field) => field.isDestroyed !== true && !editing && field.type === 'datetime'
      && !hasRawValue(values, field.id) && (field.default === undefined || field.default === ''))
    .map((field) => field.id));
  const renderNow = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const datetimeSeed = localDatetimeInZone(renderNow, options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const errorsByField = errorMap(errors);
  const errorSummary = errors.length
    ? `<div class="errors" role="alert"><strong>Please correct the highlighted fields.</strong><ul>${errors.map((error) => {
        const id = String(error.path || '').replace(/^values\./, '').split(/[.[]/, 1)[0];
        const field = (template.fields || []).find((entry) => entry.id === id);
        return `<li>${escapeHtml(field && field.label ? field.label : id)}: ${escapeHtml(error.message)}</li>`;
      }).join('')}</ul></div>`
    : '';
  const sections = groupedFields(template.fields).map((group) => {
    const fields = group.fields.map((field) => {
      const fieldErrors = errorsByField.get(field.id) || [];
      const helpId = `field-${field.id}-help`;
      const errorId = `field-${field.id}-error`;
      const unitId = `field-${field.id}-unit`;
      const describedBy = [
        ...(field.help ? [helpId] : []),
        ...(fieldErrors.length ? [errorId] : []),
        ...(field.type === 'number' && unitFromLabel(field.label) ? [unitId] : []),
      ];
      const description = field.help
        ? `<small id="${escapeHtml(helpId)}">${escapeHtml(field.help)}</small>`
        : '';
      const inlineErrors = fieldErrors.length
        ? `<small class="field-error" id="${escapeHtml(errorId)}"><strong>Error:</strong> ${fieldErrors.map(escapeHtml).join('; ')}</small>`
        : '';
      const required = field.required ? ' <span aria-label="required">*</span>' : '';
      const label = field.type === 'number' ? labelWithoutUnit(field.label) : field.label;
      const classes = [
        'field',
        `field-${field.type}`,
        field.type === 'number' ? 'field-readout' : '',
        fieldErrors.length ? 'invalid' : '',
      ].filter(Boolean).join(' ');
      const autoStamp = autoStampDatetimeIds.has(field.id);
      const seed = autoStamp && hasRawValue(values, field.id) ? values[field.id] : datetimeSeed;
      return `<div class="${classes}"><label for="field-${escapeHtml(field.id)}">${escapeHtml(label)}${required}</label>${description}${renderControl(field, values, describedBy, fieldErrors.length > 0, { autoStamp, datetimeSeed: seed })}${inlineErrors}</div>`;
    }).join('');
    return `<section class="form-section form-section-${group.key}" aria-labelledby="form-section-${group.key}">
          <h2 id="form-section-${group.key}">${group.title}</h2>
          <div class="form-section-fields">${fields}</div>
        </section>`;
  }).join('');
  const configuredSubmitLabel = template.presentation && template.presentation.submitLabel;
  const submitLabel = editing
    ? 'Save correction'
    : configuredSubmitLabel || 'Submit';
  const body = `${toolbarHtml(formProperties(template))}
  <main class="layout form-layout">
    <header class="topbar">
      ${formBreadcrumbs(template, {container: options.relatedForms && options.relatedForms.container})}
    </header>
    ${formHubNav(template.templateId, 'log', options.canManage, options.relatedForms && options.relatedForms.container)}

    <section class="content form-card">
      ${template.description ? `<p class="form-description">${escapeHtml(template.description)}</p>` : ''}
      ${editing ? '<p class="correction-note"><strong>Editing a logged entry.</strong> Saving creates a correction; the earlier version stays preserved.</p>' : ''}
      ${errorSummary}
      <form method="post" action="/forms/${encodeURIComponent(template.templateId)}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        ${editing ? `<input type="hidden" name="_supersedes" value="${escapeHtml(options.correctionRecord.submissionId)}">` : ''}
        ${sections}
        <button class="button-link button-link-primary form-primary-action" type="submit">${escapeHtml(submitLabel)}</button>
      </form>
      ${renderRecentEntries(template, options.recentRecords || [], options.timezone, csrfToken, options.now)}
      ${renderRelatedFormsNav(options.relatedForms)}
    </section>
  </main>
  ${datetimeCaptureScript(options.cspNonce)}
  ${themeScript(options.cspNonce, themeDefaults(template))}`;

  return baseHtml({
    title: template.title,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
  });
}

// A template may name a theme in presentation.theme / presentation.themeMode.
// It is a SELECTION from operator-installed themes, not a definition -- the same
// indirection destinationId uses. An unknown slug degrades to the viewer default
// rather than failing the form, because a theme is cosmetic, not a write path.
// A form's facts, in the same shape documents use. Different values -- a form has
// no size or mtime -- but the same question: what is actually true of this thing,
// as opposed to what its title says.
function formProperties(record, extras = {}) {
  const template = (record && record.draft) || record;
  if (!template) return '';
  const published = record && record.publishedVersion;
  const presentation = template.presentation || {};
  const isGroup = template.kind === 'container';
  const rows = [
    [isGroup ? 'Group' : 'Form', escapeHtml(template.templateId)],
    ['Revision', escapeHtml(String(template.revision))],
    ['Published', published
      ? escapeHtml(`v${published.templateVersion} from revision ${published.sourceRevision}`)
      : 'not published'],
    // #271: a group has no destination or fields of its own — report members.
    ...(isGroup ? [] : [['Destination', escapeHtml(template.destinationId || 'default')]]),
    ['Owner', escapeHtml(template.ownerId)],
    isGroup
      ? ['Trackers', escapeHtml(String(extras.memberCount ?? 0))]
      : ['Fields', escapeHtml(String((template.fields || []).filter((field) => !field.isDestroyed).length))],
  ];
  // Only report a theme that is actually installed. An unknown or malformed slug
  // does not apply -- the form renders in the viewer's theme -- so printing it here
  // would report something untrue, and Properties exists to report what IS true.
  if (presentation.theme && getThemeList().some((entry) => entry.slug === presentation.theme)) {
    rows.push(['Theme', escapeHtml(presentation.theme)]);
  }
  return propertiesMenu(rows);
}

function themeDefaults(template) {
  const presentation = template && template.presentation;
  const out = {};
  if (presentation) {
    if (typeof presentation.theme === 'string') out.scheme = presentation.theme;
    if (presentation.themeMode === 'dark' || presentation.themeMode === 'light') out.mode = presentation.themeMode;
  }
  // #289: view routes attach the group's theme — a themeless tracker renders in
  // its group's look instead of the viewer default. Configure never attaches it,
  // so the builder keeps reporting only what is actually saved.
  if (template && template.__groupTheme) {
    if (!out.scheme && template.__groupTheme.scheme) out.scheme = template.__groupTheme.scheme;
    if (!out.mode && template.__groupTheme.mode) out.mode = template.__groupTheme.mode;
  }
  return out;
}

function withGroupTheme(template, container) {
  if (!template || !container) return template;
  const group = themeDefaults(container);
  if (!group.scheme && !group.mode) return template;
  return {...template, __groupTheme: group};
}

function displayValue(entry, timeZone) {
  if (entry.selectedOptions) return entry.selectedOptions.map((option) => option.optionLabel).join(', ');
  if (entry.fieldType === 'checkbox') return entry.value ? 'Yes' : 'No';
  if (entry.fieldType === 'datetime' && typeof entry.value === 'string') {
    const date = new Date(entry.value);
    if (Number.isFinite(date.getTime())) {
      // #231: humanize captured datetimes everywhere values render; the raw ISO
      // string stays in the record itself.
      return new Intl.DateTimeFormat('en-US', {
        ...(timeZone ? { timeZone } : {}),
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(date);
    }
  }
  if (Array.isArray(entry.value)) return entry.value.join(', ');
  return String(entry.value);
}

function renderReceiptPage(template, record, options = {}) {
  const fields = new Map((template && template.fields || []).map((field) => [field.id, field]));
  const rows = record.values.map((entry) => {
    const field = fields.get(entry.fieldId);
    const capturedLabel = entry.fieldLabel || (field ? field.label : entry.fieldId);
    const unit = entry.fieldType === 'number' ? unitFromLabel(capturedLabel) : null;
    const label = unit ? labelWithoutUnit(capturedLabel) : capturedLabel;
    return `<tr><th scope="row">${escapeHtml(label)}</th><td class="receipt-value${entry.fieldType === 'number' ? ' receipt-value-number' : ''}">${escapeHtml(displayValue(entry, record.timezone || options.timezone))}</td><td class="receipt-unit">${unit ? escapeHtml(unit) : ''}</td></tr>`;
  }).join('');
  const formHref = `/forms/${encodeURIComponent(record.templateId || template && template.templateId || '')}`;
  const entriesHref = `${formHref}/entries`;
  const editHref = `${formHref}/receipts/${encodeURIComponent(record.submissionId)}/edit`;
  const canEdit = options.canEdit !== false;
  const received = formatRecordTime(record, options.timezone).dateTimeLabel;
  const body = `${toolbarHtml(formProperties(template))}
  <main class="layout form-layout">
    <header class="topbar">
      ${formBreadcrumbs(template, {leadLabel: template ? undefined : 'Form receipt', container: options.relatedForms && options.relatedForms.container})}
    </header>

    <section class="content form-card receipt-card">
      ${record.supersedesRecord ? '<p class="correction-note"><strong>Correction saved.</strong> This entry supersedes an earlier version, which remains preserved.</p>' : ''}
      <div class="receipt-table-wrap"><table class="receipt-table">
        <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <nav class="form-actions" aria-label="Entry actions">
        <a class="button-link button-link-primary form-primary-action" href="${formHref}">Log another</a>
        <div class="form-secondary-actions">
          ${canEdit ? `<a class="button-link" href="${editHref}">Edit</a>` : ''}
          <a class="button-link" href="${entriesHref}">All entries</a>
        </div>
      </nav>
      <p class="receipt-meta">Logged ${escapeHtml(received)}<br><span>Receipt ID ${escapeHtml(record.submissionId)}</span></p>
      ${renderRelatedFormsNav(options.relatedForms)}
    </section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;

  return baseHtml({
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
    title: 'Submission receipt',
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function formatRecordTime(record, fallbackTimezone) {
  const timestamp = record.eventAt || record.receiptAt;
  const timeZone = record.timezone || fallbackTimezone;
  const date = new Date(timestamp);
  const options = timeZone ? { timeZone } : {};
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...options,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  const dateKey = `${value('year')}-${value('month')}-${value('day')}`;
  return {
    timestamp,
    dateKey,
    dayLabel: new Intl.DateTimeFormat('en-US', {
      ...options,
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }).format(date),
    dateTimeLabel: new Intl.DateTimeFormat('en-US', {
      ...options,
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date),
    timeLabel: new Intl.DateTimeFormat('en-US', {
      ...options,
      hour: 'numeric', minute: '2-digit',
    }).format(date),
    shortDayLabel: new Intl.DateTimeFormat('en-US', {
      ...options,
      month: 'short', day: 'numeric',
    }).format(date),
  };
}

function listedValues(template, record) {
  const activeFields = (template.fields || []).filter((field) => field.isDestroyed !== true);
  const captured = new Map(record.values.map((entry) => [entry.fieldId, entry]));
  const activeIds = new Set(activeFields.map((field) => field.id));
  const visible = record.values.filter((entry) => activeIds.has(entry.fieldId));
  // #230: the heading selection always renders (it is the card's label); metrics
  // never duplicate it, and showInList narrows metrics rather than suppressing
  // the heading.
  const selection = visible.find((entry) => entry.fieldType === 'select' || entry.fieldType === 'multi-select') || null;
  const notSelection = (entry) => !selection || entry.fieldId !== selection.fieldId;
  const marked = activeFields.filter((field) => field.showInList === true);
  if (marked.length > 0) {
    return {
      selection,
      entries: marked.map((field) => captured.get(field.id)).filter(Boolean).filter(notSelection),
    };
  }
  const numeric = visible.filter((entry) => entry.fieldType === 'number').slice(0, 3);
  const entries = numeric.length > 0
    ? numeric
    : visible.filter((entry) => entry.fieldType !== 'long-text').filter(notSelection).slice(0, 2);
  return {selection, entries};
}

function entryMetrics(entries, timeZone) {
  return entries.map((entry) => {
    const unit = entry.fieldType === 'number' ? unitFromLabel(entry.fieldLabel) : null;
    const label = unit ? labelWithoutUnit(entry.fieldLabel) : entry.fieldLabel;
    // #230: text values must not render at stat size — they wrap into card balloons.
    const metricClass = entry.fieldType === 'number' ? 'entry-metric' : 'entry-metric entry-metric-text';
    return `<span class="${metricClass}"><span class="entry-metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(displayValue(entry, timeZone))}</strong>${unit ? `<span class="entry-metric-unit">${escapeHtml(unit)}</span>` : ''}</span>`;
  }).join('');
}

function renderInlineEditFields(template, record) {
  const values = rawValuesForRecord(record);
  const prefix = `edit-${record.submissionId}`;
  return (template.fields || []).filter((field) => field.isDestroyed !== true).map((field) => {
    const controlId = `${prefix}-${field.id}`;
    const helpId = `${controlId}-help`;
    const unitId = `${controlId}-unit`;
    const describedBy = [
      ...(field.help ? [helpId] : []),
      ...(field.type === 'number' && unitFromLabel(field.label) ? [unitId] : []),
    ];
    const label = field.type === 'number' ? labelWithoutUnit(field.label) : field.label;
    return `<div class="field inline-edit-field field-${escapeHtml(field.type)}${field.type === 'number' ? ' field-readout' : ''}">
      <label for="${escapeHtml(controlId)}">${escapeHtml(label)}${field.required ? ' <span aria-label="required">*</span>' : ''}</label>
      ${field.help ? `<small id="${escapeHtml(helpId)}">${escapeHtml(field.help)}</small>` : ''}
      ${renderControl(field, values, describedBy, false, {controlId})}
    </div>`;
  }).join('');
}

function renderEntryRow(template, record, timezone, csrfToken, rowOptions = {}) {
  const formHref = `/forms/${encodeURIComponent(template.templateId)}`;
  const stamp = formatRecordTime(record, timezone);
  const href = `${formHref}/receipts/${encodeURIComponent(record.submissionId)}`;
  const listed = listedValues(template, record);
  const recordTimeZone = record.timezone || timezone;
  // #231: in flat lists (the recent panel) a bare time is ambiguous across days —
  // prefix the short day whenever the record is not from "today" in its timezone.
  let headTime = stamp.timeLabel;
  if (rowOptions.now instanceof Date && Number.isFinite(rowOptions.now.getTime())) {
    const todayKey = formatRecordTime({ eventAt: rowOptions.now.toISOString(), timezone: recordTimeZone }, timezone).dateKey;
    if (stamp.dateKey !== todayKey) headTime = `${stamp.shortDayLabel} · ${stamp.timeLabel}`;
  }
  return `<details class="entry-row">
    <summary class="entry-row-summary">
      <span class="entry-row-heading"><time datetime="${escapeHtml(stamp.timestamp)}">${escapeHtml(headTime)}</time>${rowOptions.memberTitle ? `<span class="entry-form-chip">${escapeHtml(rowOptions.memberTitle)}</span>` : ''}${listed.selection ? `<strong>${escapeHtml(displayValue(listed.selection, recordTimeZone))}</strong>` : ''}<span class="entry-edit-marker">Edit</span></span>
      <span class="entry-metrics">${entryMetrics(listed.entries, recordTimeZone)}</span>
    </summary>
    <div class="entry-row-editor">
      <form method="post" action="${formHref}" class="inline-edit-form">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="_supersedes" value="${escapeHtml(record.submissionId)}">
        <div class="inline-edit-fields">${renderInlineEditFields(template, record)}</div>
        <button class="button-link button-link-primary inline-edit-save" type="submit">Save correction</button>
      </form>
      <a class="entry-receipt-link" href="${href}">View receipt</a>
    </div>
  </details>`;
}

function renderEntriesPage(template, records, options = {}) {
  const formHref = `/forms/${encodeURIComponent(template.templateId)}`;
  const groups = new Map();
  for (const record of records) {
    const stamp = formatRecordTime(record, options.timezone);
    if (!groups.has(stamp.dateKey)) groups.set(stamp.dateKey, { stamp, records: [] });
    groups.get(stamp.dateKey).records.push({ record, stamp });
  }
  const entries = [...groups.values()].map(({ stamp, records: dayRecords }) => `
      <section class="entries-day" aria-labelledby="entries-${escapeHtml(stamp.dateKey)}">
        <h2 id="entries-${escapeHtml(stamp.dateKey)}"><time datetime="${escapeHtml(stamp.dateKey)}">${escapeHtml(stamp.dayLabel)}</time></h2>
        <div class="entry-list">${dayRecords.map(({ record }) => renderEntryRow(record.__member || template, record, options.timezone, options.csrfToken, record.__member ? { memberTitle: record.__member.title } : {})).join('')}</div>
      </section>`).join('');
  const content = records.length > 0
    ? entries
    : `<div class="entries-empty"><h2>Ready for your first entry?</h2><p>Log it now and it will show up here.</p><a class="button-link button-link-primary form-primary-action" href="${formHref}">${template.kind === 'container' ? 'Open the trackers' : 'Log an entry'}</a></div>`;
  const body = `${toolbarHtml(formProperties(template))}
  <main class="layout form-layout entries-layout">
    <header class="topbar">
      ${formBreadcrumbs(template, {container: options.relatedForms && options.relatedForms.container})}
    </header>
    ${template.kind === 'container' ? containerHubNav(template.templateId, 'history', options.canManage) : formHubNav(template.templateId, 'history', options.canManage, options.relatedForms && options.relatedForms.container)}
    <section class="content form-card entries-card">${content}</section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;
  return baseHtml({
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
    title: `${template.title} entries`,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function fieldTypeOptions(selectedType) {
  return FIELD_TYPES.map(([value, label]) =>
    `<option value="${value}"${value === selectedType ? ' selected' : ''}>${label}</option>`
  ).join('');
}

function fieldTypeLabel(type) {
  const match = FIELD_TYPES.find(([value]) => value === type);
  return match ? match[1] : type;
}

function builderErrors(errors) {
  if (!errors || errors.length === 0) return '';
  return `<div class="errors builder-errors" role="alert"><strong>Draft not saved.</strong><ul>${errors.map((error) =>
    `<li>${escapeHtml(error.path || 'template')}: ${escapeHtml(error.message || 'is invalid')}</li>`
  ).join('')}</ul></div>`;
}

function builderOption(option, fieldIndex, optionIndex, optionCount) {
  const prefix = `field.${fieldIndex}.option.${optionIndex}`;
  return `<div class="builder-option">
    <input type="hidden" name="${prefix}.id" value="${escapeHtml(option.id)}">
    <label><span>Option label</span><input name="${prefix}.label" value="${escapeHtml(option.label)}" maxlength="200" required></label>
    <div class="builder-row-actions" aria-label="Actions for option ${optionIndex + 1}">
      <button type="submit" name="_action" value="option-up:${fieldIndex}:${optionIndex}"${optionIndex === 0 ? ' disabled' : ''}>Move up</button>
      <button type="submit" name="_action" value="option-down:${fieldIndex}:${optionIndex}"${optionIndex === optionCount - 1 ? ' disabled' : ''}>Move down</button>
      <button class="builder-remove" type="submit" name="_action" value="option-remove:${fieldIndex}:${optionIndex}"${optionCount === 1 ? ' disabled' : ''}>Remove</button>
    </div>
  </div>`;
}

function builderField(field, fieldIndex, fieldCount) {
  const prefix = `field.${fieldIndex}`;
  const constraints = field.constraints || {};
  const selection = field.type === 'select' || field.type === 'multi-select';
  const preservedInputs = () => {
    const values = [
      ['id', field.id], ['type', field.type], ['label', field.label],
      ['required', String(field.required === true)],
      ['showInList', String(field.showInList === true)],
      ['isDestroyed', String(field.isDestroyed === true)],
      ...(field.help ? [['help', field.help]] : []),
      ...(field.component ? [['component', field.component]] : []),
      ...(field.providerSlot ? [['providerSlot', field.providerSlot]] : []),
      ...Object.entries(constraints),
    ];
    const inputs = values.map(([name, value]) => `<input type="hidden" name="${prefix}.${escapeHtml(name)}" value="${escapeHtml(value)}">`);
    for (const [optionIndex, option] of (field.options || []).entries()) {
      inputs.push(`<input type="hidden" name="${prefix}.option.${optionIndex}.id" value="${escapeHtml(option.id)}">`);
      inputs.push(`<input type="hidden" name="${prefix}.option.${optionIndex}.label" value="${escapeHtml(option.label)}">`);
    }
    return inputs.join('');
  };
  const summary = `<span class="builder-field-title"><strong>${escapeHtml(field.label)}</strong><span class="builder-type-badge">${escapeHtml(fieldTypeLabel(field.type))}</span></span>
      <span class="builder-field-markers">${field.required ? '<span class="builder-marker builder-required-marker">Required</span>' : ''}${field.showInList ? '<span class="builder-marker builder-list-marker">In list</span>' : ''}${field.isDestroyed ? '<span class="builder-marker builder-removed-marker">Removed</span>' : ''}</span>`;
  if (field.isDestroyed === true) {
    return `<div class="builder-field builder-field-removed">
      <div class="builder-field-summary">${summary}</div>
      ${preservedInputs()}
      <button class="builder-restore" type="submit" name="_action" value="field-restore:${fieldIndex}">Restore field</button>
    </div>`;
  }
  const bounds = ['number', 'date', 'datetime'].includes(field.type)
    ? `<div class="builder-grid builder-bounds">
        <label><span>Minimum</span><input name="${prefix}.minimum" value="${escapeHtml(constraints.minimum)}" inputmode="${field.type === 'number' ? 'decimal' : 'text'}"></label>
        <label><span>Maximum</span><input name="${prefix}.maximum" value="${escapeHtml(constraints.maximum)}" inputmode="${field.type === 'number' ? 'decimal' : 'text'}"></label>
        ${field.type === 'number' ? `<label><span>Step</span><input name="${prefix}.step" value="${escapeHtml(constraints.step)}" inputmode="decimal"></label>
        <label class="builder-check"><input type="checkbox" name="${prefix}.integer" value="true"${constraints.integer === true ? ' checked' : ''}><span>Whole numbers only</span></label>` : ''}
      </div>`
    : '';
  const options = selection && field.providerSlot
    ? `<section class="builder-options"><input type="hidden" name="${prefix}.providerSlot" value="${escapeHtml(field.providerSlot)}"><p class="builder-help">Options for this field come from the configured provider <strong>${escapeHtml(field.providerSlot)}</strong> and cannot be edited here.</p></section>`
    : selection
    ? `<section class="builder-options" aria-labelledby="field-${fieldIndex}-options">
        <div class="builder-section-heading"><h3 id="field-${fieldIndex}-options">Options</h3><button type="submit" name="_action" value="option-add:${fieldIndex}">Add option</button></div>
        <p class="builder-help">Option IDs are retained when labels are renamed, so earlier entries keep matching the same choice.</p>
        ${(field.options || []).map((option, optionIndex) => builderOption(option, fieldIndex, optionIndex, field.options.length)).join('')}
      </section>`
    : '';
  return `<details class="builder-field">
    <summary class="builder-field-summary">${summary}</summary>
    <div class="builder-field-settings">
    <input type="hidden" name="${prefix}.id" value="${escapeHtml(field.id)}">
    <div class="builder-grid">
      <label><span>Label</span><input name="${prefix}.label" value="${escapeHtml(field.label)}" maxlength="200" required></label>
      <label><span>Type</span><select name="${prefix}.type">${fieldTypeOptions(field.type)}</select></label>
      <label class="builder-wide"><span>Help text</span><textarea name="${prefix}.help" rows="2" maxlength="1000">${escapeHtml(field.help || '')}</textarea></label>
      <label><span>Component hint</span><input name="${prefix}.component" value="${escapeHtml(field.component || '')}" maxlength="64" pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"></label>
      <label class="builder-check"><input type="checkbox" name="${prefix}.required" value="true"${field.required ? ' checked' : ''}><span>Required</span></label>
      <label class="builder-check"><input type="checkbox" name="${prefix}.showInList" value="true"${field.showInList ? ' checked' : ''}><span>Show in entries list</span></label>
    </div>
    ${bounds}
    ${options}
    <div class="builder-row-actions" aria-label="Actions for field ${fieldIndex + 1}">
      <button type="submit" name="_action" value="field-up:${fieldIndex}"${fieldIndex === 0 ? ' disabled' : ''}>Move up</button>
      <button type="submit" name="_action" value="field-down:${fieldIndex}"${fieldIndex === fieldCount - 1 ? ' disabled' : ''}>Move down</button>
      <button class="builder-remove" type="submit" name="_action" value="field-remove:${fieldIndex}">Remove field</button>
    </div>
    </div>
  </details>`;
}

function configureLifecycle(template, csrfToken) {
  // #291: lifecycle lives with Configure — Clone and Archive moved here when
  // the root Manage section retired.
  const templateId = encodeURIComponent(template.templateId);
  return `<div class="configure-lifecycle" aria-label="Lifecycle">
    <form method="post" action="/forms/${templateId}/clone">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit">Clone</button>
    </form>
    <form method="post" action="/forms/${templateId}/archive">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
      <button type="submit">Archive</button>
    </form>
  </div>`;
}

function renderConfigurePage(record, csrfToken, destinationIds, options = {}) {
  const template = record.draft;
  const configureHref = `/forms/${encodeURIComponent(template.templateId)}/configure`;
  const published = record.publishedVersion;
  const status = options.status
    ? `<p class="builder-status" role="status">${escapeHtml(options.status)}</p>`
    : '';
  const conflict = options.conflict
    ? '<div class="builder-conflict" role="alert"><strong>This template changed since you opened it.</strong> The newest draft is shown below. Your stale edit was not saved; review the changes and try again.</div>'
    : '';
  const destinationOptions = destinationIds.map((destinationId) =>
    `<option value="${escapeHtml(destinationId)}"${(template.destinationId || 'default') === destinationId ? ' selected' : ''}>${escapeHtml(destinationId)}</option>`
  ).join('');
  const currentTheme = (template.presentation && template.presentation.theme) || '';
  const currentThemeMode = (template.presentation && template.presentation.themeMode) || '';
  // Offered themes come from the running server, so the author can only ever pick
  // one the deployment has actually installed.
  const themeOptions = [{slug: '', label: 'Use the viewer theme'}, ...getThemeList()].map((theme) =>
    `<option value="${escapeHtml(theme.slug)}"${currentTheme === theme.slug ? ' selected' : ''}>${escapeHtml(theme.label)}</option>`
  ).join('');
  const themeModeOptions = [['', 'Follow the viewer'], ['dark', 'Always dark'], ['light', 'Always light']].map(
    ([value, label]) => `<option value="${value}"${currentThemeMode === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  const publishedText = published
    ? `Version ${published.templateVersion}, from draft revision ${published.sourceRevision}`
    : 'Not published yet';
  const body = `${toolbarHtml(formProperties(record))}
  <main class="layout form-layout builder-layout">
    <header class="topbar">
      ${formBreadcrumbs(template, {container: options.relatedForms && options.relatedForms.container})}
    </header>
    ${formHubNav(template.templateId, 'configure', true, options.relatedForms && options.relatedForms.container)}
    <section class="content form-card builder-card">
      <dl class="builder-revisions">
        <div><dt>Draft</dt><dd>Revision ${escapeHtml(template.revision)}</dd></div>
        <div><dt>Published</dt><dd>${escapeHtml(publishedText)}</dd></div>
      </dl>
      ${status}${conflict}${builderErrors(options.errors)}
      <p class="builder-warning"><strong>Past entries stay intact.</strong> Removed fields are retained as restorable schema identities and hidden from new entries; earlier receipts keep their captured values and labels.</p>
      <form method="post" action="${configureHref}" class="builder-form">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
        <section class="builder-basics" aria-labelledby="builder-basics-heading">
          <h2 id="builder-basics-heading">Template</h2>
          <label><span>Title</span><input name="title" value="${escapeHtml(template.title)}" maxlength="200" required></label>
          <label><span>Destination</span><select name="destinationId" required>${destinationOptions}</select></label>
          <p class="builder-help">Destinations are deployment-approved aliases. Filesystem paths cannot be entered here.</p>
          <label><span>Theme</span><select name="theme">${themeOptions}</select></label>
          <label><span>Theme mode</span><select name="themeMode">${themeModeOptions}</select></label>
          ${Array.isArray(options.parents) && options.parents.length ? `<label><span>Parent form</span><select name="parent"><option value=""${!template.parentId ? ' selected' : ''}>None</option>${options.parents.map((parent) => `<option value="${escapeHtml(parent.templateId)}"${template.parentId === parent.templateId ? ' selected' : ''}>${escapeHtml(parent.title)}</option>`).join('')}</select></label><p class="builder-help">A child form inherits every parent field live. Fields below override a parent field with the same id or extend the form; detaching copies the resolved fields back onto this form (#245).</p>` : ''}
          ${Array.isArray(options.children) && options.children.length ? `<p class="builder-help builder-parent-note">Parent of ${options.children.length} form${options.children.length === 1 ? '' : 's'}: ${options.children.map((child) => escapeHtml(child.title)).join(', ')}. Edits here flow to them live.</p>` : ''}
          ${Array.isArray(options.containers) && options.containers.length ? `<label><span>Group</span><select name="container"><option value=""${!template.containerId ? ' selected' : ''}>None</option>${options.containers.map((container) => `<option value="${escapeHtml(container.templateId)}"${template.containerId === container.templateId ? ' selected' : ''}>${escapeHtml(container.title)}</option>`).join('')}</select></label><p class="builder-help">Groups hold related trackers and give each member back-and-sibling navigation.</p>` : ''}
          <p class="builder-help">Themes are installed by the deployment and read from the server. Leave both alone and this form follows whatever theme the viewer has chosen.</p>
        </section>
        <section class="builder-fields" aria-labelledby="builder-fields-heading">
          <div class="builder-section-heading"><div><h2 id="builder-fields-heading">Fields</h2><p class="builder-help">Tap a field to edit its settings.</p></div><button type="submit" name="_action" value="field-add">Add field</button></div>
          ${(template.fields || []).map((field, index) => builderField(field, index, (template.fields || []).length)).join('')}
        </section>
        <button class="button-link button-link-primary form-primary-action" type="submit" name="_action" value="save">Save draft</button>
      </form>
      <section class="builder-publish" aria-labelledby="builder-publish-heading">
        <h2 id="builder-publish-heading">Publish</h2>
        <p>Publishing creates a new immutable version from the saved draft. Past published versions and submissions remain unchanged.</p>
        <form method="post" action="${configureHref}/publish">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
          <button class="button-link builder-publish-action" type="submit">Publish saved draft</button>
        </form>
        ${configureLifecycle(template, csrfToken)}
      </section>
    </section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;
  return baseHtml({
    defaultScheme: themeDefaults(template).scheme || null,
    defaultMode: themeDefaults(template).mode || null,
    title: `Configure ${template.title}`,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function renderTemplateActions(template, csrfToken) {
  const templateId = encodeURIComponent(template.templateId);
  const lifecycle = template.state === 'archived' ? 'restore' : 'archive';
  const lifecycleLabel = template.state === 'archived' ? 'Restore' : 'Archive';
  return `<div class="forms-index-actions" aria-label="Actions for ${escapeHtml(template.title)}">
    <a href="/forms/${templateId}">Open</a>
    <a href="/forms/${templateId}/entries">History</a>
    <a href="/forms/${templateId}/configure">Configure</a>
    <form method="post" action="/forms/${templateId}/clone">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit">Clone</button>
    </form>
    <form method="post" action="/forms/${templateId}/${lifecycle}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
      <button type="submit">${lifecycleLabel}</button>
    </form>
  </div>`;
}

function renderQuickConfigure(template, all, csrfToken) {
  // #257: the /forms root is the one-page manager — the configure BASICS inline,
  // behind the platform's disclosure idiom. Save & publish in one tap; the full
  // draft/publish field editor stays at /forms/:id/configure.
  if (template.state === 'archived') return '';
  const configureHref = `/forms/${encodeURIComponent(template.templateId)}/configure`;
  const themeOptions = [{slug: '', label: 'Use the viewer theme'}, ...getThemeList()].map((theme) =>
    `<option value="${escapeHtml(theme.slug)}"${(template.theme || '') === theme.slug ? ' selected' : ''}>${escapeHtml(theme.label || theme.slug)}</option>`
  ).join('');
  const themeModeOptions = [['', 'Follow theme'], ['dark', 'Dark'], ['light', 'Light']].map(([value, label]) =>
    `<option value="${value}"${(template.themeMode || '') === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  let membership = '';
  if (template.kind === 'container') {
    const candidates = all.filter((other) => other.kind !== 'container' && other.state !== 'archived' && other.management === true);
    membership = `<fieldset class="quick-configure-members"><legend>Trackers in this group</legend>${candidates.map((other) =>
      `<label class="container-member-choice"><input type="checkbox" name="member" value="${escapeHtml(other.templateId)}"${other.containerId === template.templateId ? ' checked' : ''}> ${escapeHtml(other.title)}</label>`
    ).join('')}</fieldset>`;
  }
  const containers = all.filter((other) => other.kind === 'container' && other.state !== 'archived');
  const containerSelect = template.kind !== 'container' && containers.length
    ? `<label><span>Group</span><select name="container"><option value=""${!template.containerId ? ' selected' : ''}>None</option>${containers.map((container) =>
      `<option value="${escapeHtml(container.templateId)}"${template.containerId === container.templateId ? ' selected' : ''}>${escapeHtml(container.title)}</option>`).join('')}</select></label>`
    : '';
  const parents = all.filter((other) => other.kind !== 'container' && other.state !== 'archived'
    && !other.parentId && other.templateId !== template.templateId && other.management === true);
  const parentSelect = template.kind !== 'container' && parents.length
    ? `<label><span>Parent form</span><select name="parent"><option value=""${!template.parentId ? ' selected' : ''}>None</option>${parents.map((parent) =>
      `<option value="${escapeHtml(parent.templateId)}"${template.parentId === parent.templateId ? ' selected' : ''}>${escapeHtml(parent.title)}</option>`).join('')}</select></label>`
    : '';
  return `<details class="quick-configure">
    <summary>Quick configure</summary>
    <form method="post" action="${configureHref}" class="quick-configure-form">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="_action" value="basics">
      <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
      <label><span>Title</span><input name="title" value="${escapeHtml(template.title)}" maxlength="200" required></label>
      <label><span>Theme</span><select name="theme">${themeOptions}</select></label>
      <label><span>Theme mode</span><select name="themeMode">${themeModeOptions}</select></label>
      ${containerSelect}
      ${parentSelect}
      ${membership}
      <div class="quick-configure-actions">
        <button class="button-link button-link-primary" type="submit">Save &amp; publish</button>
        <a href="${configureHref}">Full editor</a>
      </div>
    </form>
  </details>`;
}

function renderManagedTemplate(template, csrfToken, all = []) {
  const published = template.publishedVersion === null ? 'Not published' : `Version ${template.publishedVersion}`;
  const stateLabel = template.state === 'archived'
    ? 'Archived'
    : template.state === 'published' ? 'Published' : 'Draft';
  return `<article class="forms-index-item${template.state === 'archived' ? ' is-archived' : ''}">
    <div class="forms-index-title"><h2><a href="/forms/${encodeURIComponent(template.templateId)}">${escapeHtml(template.title)}</a></h2><span class="forms-index-state">${stateLabel}</span></div>
    <dl class="forms-index-meta">
      <div><dt>Draft</dt><dd>r${escapeHtml(template.revision)}</dd></div>
      <div><dt>Published</dt><dd>${escapeHtml(published)}</dd></div>
      <div><dt>Destination</dt><dd>${escapeHtml(template.destinationId || 'default')}</dd></div>
      <div><dt>Entries</dt><dd>${escapeHtml(template.entryCount)}</dd></div>
    </dl>
    ${renderTemplateActions(template, csrfToken)}
    ${renderQuickConfigure(template, all, csrfToken)}
  </article>`;
}

function renderContainerConfigurePage(record, csrfToken, options = {}) {
  // #234: a container is itself a form — same Configure surface, members instead of fields.
  const template = record.draft;
  const configureHref = `/forms/${encodeURIComponent(template.templateId)}/configure`;
  const published = record.publishedVersion;
  const publishedText = published
    ? `Version ${published.templateVersion}, from draft revision ${published.sourceRevision}`
    : 'Not published yet';
  const status = options.status ? `<p class="builder-status">${escapeHtml(options.status)}</p>` : '';
  const conflict = options.conflict ? '<p class="builder-conflict">Someone else saved a newer draft. Review it and reapply your change.</p>' : '';
  const currentTheme = (template.presentation && template.presentation.theme) || '';
  const currentThemeMode = (template.presentation && template.presentation.themeMode) || '';
  const themeOptions = [{slug: '', label: 'Use the viewer theme'}, ...getThemeList()].map((theme) =>
    `<option value="${escapeHtml(theme.slug)}"${currentTheme === theme.slug ? ' selected' : ''}>${escapeHtml(theme.label)}</option>`
  ).join('');
  const themeModeOptions = [['', 'Follow the viewer'], ['dark', 'Always dark'], ['light', 'Always light']].map(
    ([value, label]) => `<option value="${value}"${currentThemeMode === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  const memberChoices = Array.isArray(options.memberChoices) ? options.memberChoices : [];
  const membersHtml = memberChoices.length
    ? memberChoices.map((choice) => (
      `<label class="builder-check container-member-choice"><input type="checkbox" name="member" value="${escapeHtml(choice.templateId)}"${choice.checked ? ' checked' : ''}><span>${escapeHtml(choice.title)}</span></label>`
    )).join('')
    : '<p class="builder-help">No forms exist yet to add.</p>';
  const lifecycle = template.archived === true ? 'restore' : 'archive';
  const body = `${toolbarHtml(formProperties(record, {memberCount: (options.memberChoices || []).filter((choice) => choice.checked).length}))}
  <main class="layout form-layout builder-layout">
    <header class="topbar">
      <div>${formBreadcrumbs(template)}</div>
    </header>
    ${containerHubNav(template.templateId, 'configure', true)}
    <section class="content form-card builder-card container-configure-card">
      <dl class="builder-revisions">
        <div><dt>Draft</dt><dd>Revision ${escapeHtml(template.revision)}</dd></div>
        <div><dt>Published</dt><dd>${escapeHtml(publishedText)}</dd></div>
      </dl>
      ${status}${conflict}${builderErrors(options.errors)}
      <form method="post" action="${configureHref}" class="builder-form">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
        <section class="builder-basics" aria-labelledby="container-basics-heading">
          <h2 id="container-basics-heading">Container</h2>
          <label><span>Title</span><input name="title" value="${escapeHtml(template.title)}" maxlength="200" required></label>
          <label class="builder-wide"><span>Description</span><textarea name="description" rows="2" maxlength="2000">${escapeHtml(template.description || '')}</textarea></label>
          <label><span>Theme</span><select name="theme">${themeOptions}</select></label>
          <label><span>Theme mode</span><select name="themeMode">${themeModeOptions}</select></label>
        </section>
        <section class="builder-members" aria-labelledby="container-members-heading">
          <h2 id="container-members-heading">Forms in this container</h2>
          <p class="builder-help">Checked trackers join this group; unchecking releases them. Members gain back-and-sibling navigation automatically.</p>
          <div class="container-member-choices">${membersHtml}</div>
        </section>
        <button class="button-link button-link-primary" type="submit">Save draft</button>
      </form>
      <form method="post" action="${configureHref}/publish" class="builder-publish-form">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
        <button class="button-link" type="submit">Publish revision ${escapeHtml(template.revision)}</button>
      </form>
      <form method="post" action="/forms/${encodeURIComponent(template.templateId)}/${lifecycle}" class="builder-lifecycle-form">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="revision" value="${escapeHtml(template.revision)}">
        <button class="button-link" type="submit">${lifecycle === 'archive' ? 'Archive container' : 'Restore container'}</button>
      </form>
    </section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;
  return baseHtml({
    title: `Configure — ${template.title}`,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function renderFormsIndexPage(templates, canCreate, csrfToken, options = {}) {
  const managed = templates.some((template) => template.management === true);
  const active = templates.filter((template) => template.state !== 'archived');
  const archived = templates.filter((template) => template.state === 'archived');
  // #260: the root IS a container page one level up — clean tap-to-enter rows
  // (containers first, then ungrouped forms straight to a new entry). The
  // management detail (#257 quick-configure, meta, archived) lives in one
  // collapsed Manage section at the bottom, out of the main view.
  const containers = active.filter((template) => template.kind === 'container');
  const containerIds = new Set(containers.map((template) => template.templateId));
  const ungrouped = active.filter((template) => template.kind !== 'container' && !(template.containerId && containerIds.has(template.containerId)));
  const memberCount = (container) => active.filter((template) => template.containerId === container.templateId).length;
  const rows = [
    ...containers.map((container) => {
      const count = memberCount(container);
      return `<a class="container-member forms-root-row" href="/forms/${encodeURIComponent(container.templateId)}"><span class="container-member-title">${escapeHtml(container.title)}</span><span class="forms-root-count">${count} tracker${count === 1 ? '' : 's'}</span><span aria-hidden="true">›</span></a>`;
    }),
    ...ungrouped.map((template) => (
      `<a class="container-member forms-root-row" href="/forms/${encodeURIComponent(template.templateId)}"><span class="container-member-title">${escapeHtml(template.title)}</span><span aria-hidden="true">›</span></a>`
    )),
  ].join('');
  const emptyState = `<div class="forms-index-empty"><h2>${canCreate ? 'Create your first group' : 'No trackers available'}</h2><p>${canCreate ? 'Groups hold your trackers — make one, then add trackers inside it.' : 'There are no active trackers you can log to.'}</p>${canCreate ? '<a class="button-link button-link-primary" href="/forms/new?kind=container">New group</a>' : ''}</div>`;
  // #291: the Manage section (and with it the #257 root quick-configure surface)
  // is retired — lifecycle actions live on each Configure page now. Archived
  // stays reachable here, collapsed.
  const rootArchived = archived.filter((template) => template.kind === 'container'
    || !(template.containerId && containerIds.has(template.containerId)));
  const manageHtml = managed && rootArchived.length
    ? `<details class="forms-index-archived"><summary>Show archived <span>${rootArchived.length}</span></summary><div class="forms-index-list">${rootArchived.map((template) => renderManagedTemplate(template, csrfToken, templates)).join('')}</div></details>`
    : '';
  const body = `${toolbarHtml()}
  <main class="layout form-layout container-layout forms-index-layout">
    <header class="topbar forms-index-header">
      <div><h1>Groups</h1><p class="subtitle">${managed ? 'Tap a group to see and configure what lives inside it.' : 'Choose a tracker to log an entry.'}</p></div>
    </header>
    ${canCreate ? createLinks(null) : ''}
    <section class="content form-card container-card">
      <div class="container-members">${rows || emptyState}</div>
    </section>
    ${manageHtml}
  </main>
  ${themeScript(options.cspNonce)}`;
  return baseHtml({
    title: 'Groups',
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function renderCreateTemplatePage(csrfToken, destinationIds, options = {}) {
  const destinationOptions = destinationIds.map((destinationId) =>
    `<option value="${escapeHtml(destinationId)}"${options.destinationId === destinationId ? ' selected' : ''}>${escapeHtml(destinationId)}</option>`
  ).join('');
  // #281: no dead ends — the bar you arrived from persists, current tab lit.
  const lead = options.group ? 'New tracker' : (options.kind === 'container' ? 'New group' : 'New template');
  const escapeNav = options.group
    ? containerHubNav(options.group.templateId, 'new', true)
    : `<nav class="form-hub-nav" aria-label="Tracker views"><a class="groups-link" href="/forms">Groups</a><a class="configure-link" href="/forms/new?kind=container" aria-current="page">New group</a></nav>`;
  const body = `${toolbarHtml()}
  <main class="layout form-layout builder-layout">
    <header class="topbar">${formBreadcrumbs(null, {leadLabel: lead})}</header>
    ${escapeNav}
    <section class="content form-card builder-card first-run-card">
      <p>Create a draft with one starter field. You can edit its fields immediately afterward.</p>
      ${builderErrors(options.errors)}
      <form method="post" action="/forms">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <label><span>Name</span><input name="title" value="${escapeHtml(options.title || '')}" maxlength="200" required autofocus></label>
        <label><span>ID (optional)</span><input name="templateId" value="${escapeHtml(options.templateId || '')}" maxlength="64" pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"></label>
        <p class="builder-help">Leave the ID blank and it derives from the name (#279).</p>
        ${options.group ? `<input type="hidden" name="group" value="${escapeHtml(options.group.templateId)}"><p class="builder-help">Joining group: <strong>${escapeHtml(options.group.title || options.group.templateId)}</strong></p>` : `<label><span>Kind</span><select name="kind"><option value="">Form</option><option value="container"${options.kind === 'container' ? ' selected' : ''}>Group (holds related trackers)</option></select></label>`}
        <label><span>Destination</span><select name="destinationId">${destinationOptions}</select></label>
        <p class="builder-help">Destination applies to trackers only — groups hold trackers, not entries.</p>
        <p class="builder-help">Only deployment-approved destination aliases are available; a filesystem path is never accepted.</p>
        <button class="button-link button-link-primary form-primary-action" type="submit">Create template</button>
      </form>
    </section>
  </main>
  ${themeScript(options.cspNonce, (options.group && options.group.theme) || {})}`;
  const groupTheme = (options.group && options.group.theme) || {};
  return baseHtml({
    title: lead,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
    defaultScheme: groupTheme.scheme || null,
    defaultMode: groupTheme.mode || null,
  });
}

function renderArchivedFormPage(template, options = {}) {
  const body = `${toolbarHtml(formProperties(template))}
  <main class="layout form-layout">
    <header class="topbar">${formBreadcrumbs(template)}</header>
    ${formHubNav(template.templateId, 'log', options.canManage)}
    <section class="content form-card archived-form-state"><h2>This form is archived</h2><p>It is not accepting new entries. Existing history and receipts are still available.</p><a class="button-link" href="/forms/${encodeURIComponent(template.templateId)}/entries">View history</a></section>
  </main>
  ${themeScript(options.cspNonce, themeDefaults(template))}`;
  return baseHtml({title: `${template.title} is archived`, body, customThemeCss: options.customThemeCss, cspNonce: options.cspNonce, defaultScheme: themeDefaults(template).scheme || null, defaultMode: themeDefaults(template).mode || null});
}

function postedString(body, name, fallback = '') {
  const value = body && body[name];
  return typeof value === 'string' ? value : fallback;
}

function generatedDefinitionId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function postedIndices(body, expression) {
  const indices = new Set();
  for (const key of Object.keys(body || {})) {
    const match = expression.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].filter(Number.isSafeInteger).sort((left, right) => left - right);
}

function postedFields(current, body) {
  const indices = postedIndices(body, /^field\.(\d+)\./);
  return indices.map((fieldIndex) => {
    const prefix = `field.${fieldIndex}`;
    const previous = (current.fields || [])[fieldIndex];
    const id = previous ? previous.id : postedString(body, `${prefix}.id`);
    const type = postedString(body, `${prefix}.type`);
    const sameType = previous && previous.type === type;
    const field = {
      ...(sameType ? structuredClone(previous) : {}),
      id,
      type,
      label: postedString(body, `${prefix}.label`),
      required: postedString(body, `${prefix}.required`) === 'true',
    };
    if (postedString(body, `${prefix}.showInList`) === 'true') field.showInList = true;
    else delete field.showInList;
    if (postedString(body, `${prefix}.isDestroyed`) === 'true') field.isDestroyed = true;
    else delete field.isDestroyed;
    const help = postedString(body, `${prefix}.help`);
    if (help) field.help = help;
    else delete field.help;
    const component = postedString(body, `${prefix}.component`);
    if (component) field.component = component;
    else delete field.component;

    delete field.constraints;
    if (type === 'number') {
      const constraints = {};
      for (const key of ['minimum', 'maximum', 'step']) {
        const value = postedString(body, `${prefix}.${key}`);
        if (value !== '') constraints[key] = Number(value);
      }
      if (postedString(body, `${prefix}.integer`) === 'true') constraints.integer = true;
      if (Object.keys(constraints).length) field.constraints = constraints;
    } else if (type === 'date' || type === 'datetime') {
      const constraints = {};
      for (const key of ['minimum', 'maximum']) {
        const value = postedString(body, `${prefix}.${key}`);
        if (value !== '') constraints[key] = value;
      }
      if (Object.keys(constraints).length) field.constraints = constraints;
    } else if (sameType && previous.constraints) {
      field.constraints = structuredClone(previous.constraints);
    }

    delete field.options;
    delete field.providerSlot;
    if (type === 'select' || type === 'multi-select') {
      const providerSlot = postedString(body, `${prefix}.providerSlot`);
      if (providerSlot) {
        field.providerSlot = providerSlot;
      } else {
        const optionIndices = postedIndices(body, new RegExp(`^field\\.${fieldIndex}\\.option\\.(\\d+)\\.`));
        field.options = optionIndices.map((optionIndex) => {
          const optionPrefix = `${prefix}.option.${optionIndex}`;
          const previousOption = sameType && Array.isArray(previous.options)
            ? previous.options[optionIndex]
            : null;
          const optionId = previousOption ? previousOption.id : postedString(body, `${optionPrefix}.id`);
          return {
            id: optionId,
            label: postedString(body, `${optionPrefix}.label`),
            ...(previousOption && previousOption.disabled ? {disabled: true} : {}),
          };
        });
        if (field.options.length === 0) {
          field.options.push({id: generatedDefinitionId('option'), label: 'New option'});
        }
      }
    }
    return field;
  });
}

function applyBuilderAction(fields, action) {
  if (action === 'field-add') {
    let id;
    do id = generatedDefinitionId('field');
    while (fields.some((field) => field.id === id));
    fields.push({
      id,
      type: 'short-text',
      label: 'New field',
      required: false,
    });
    return;
  }
  let match = /^field-(up|down|remove|restore):(\d+)$/.exec(action);
  if (match) {
    const index = Number(match[2]);
    if (match[1] === 'remove' && fields[index]) fields[index].isDestroyed = true;
    if (match[1] === 'restore' && fields[index]) delete fields[index].isDestroyed;
    if (match[1] === 'up' && index > 0 && fields[index]) [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
    if (match[1] === 'down' && fields[index] && fields[index + 1]) [fields[index], fields[index + 1]] = [fields[index + 1], fields[index]];
    return;
  }
  match = /^option-(add|up|down|remove):(\d+)(?::(\d+))?$/.exec(action);
  if (!match) return;
  const field = fields[Number(match[2])];
  if (!field || !Array.isArray(field.options)) return;
  const index = Number(match[3]);
  if (match[1] === 'add') field.options.push({id: generatedDefinitionId('option'), label: 'New option'});
  if (match[1] === 'remove' && field.options.length > 1 && field.options[index]) field.options.splice(index, 1);
  if (match[1] === 'up' && index > 0 && field.options[index]) [field.options[index - 1], field.options[index]] = [field.options[index], field.options[index - 1]];
  if (match[1] === 'down' && field.options[index] && field.options[index + 1]) [field.options[index], field.options[index + 1]] = [field.options[index + 1], field.options[index]];
}

function builderPatch(current, body) {
  const fields = postedFields(current, body);
  applyBuilderAction(fields, postedString(body, '_action', 'save'));
  // reviseDraft REPLACES presentation wholesale, so rebuild it from the existing
  // object rather than the posted fields alone -- otherwise saving from the builder
  // would silently drop submitLabel and component.
  const presentation = {};
  const existing = (current && current.presentation) || {};
  if (typeof existing.submitLabel === 'string') presentation.submitLabel = existing.submitLabel;
  if (typeof existing.component === 'string') presentation.component = existing.component;
  const theme = postedString(body, 'theme');
  const themeMode = postedString(body, 'themeMode');
  if (theme) presentation.theme = theme;
  if (themeMode === 'dark' || themeMode === 'light') presentation.themeMode = themeMode;

  const patch = {
    revision: Number(postedString(body, 'revision')),
    title: postedString(body, 'title'),
    destinationId: postedString(body, 'destinationId'),
    // null removes the key entirely, which is how "no presentation at all" is expressed.
    presentation: Object.keys(presentation).length ? presentation : null,
    fields,
  };
  if (Object.prototype.hasOwnProperty.call(body, 'container')) {
    // '' means uncontained; the registry fail-closes unknown container ids (#234).
    patch.containerId = postedString(body, 'container') || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'parent')) {
    // '' detaches; the registry fail-closes unknown/nested parents and
    // materializes the resolved fields on detach (#245).
    patch.parentId = postedString(body, 'parent') || null;
  }
  return patch;
}

function timeZoneOffset(timestamp, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
  }).formatToParts(new Date(timestamp)).find((entry) => entry.type === 'timeZoneName');
  if (!part || part.value === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part.value);
  if (!match) throw new Error('Configured forms timezone has an unsupported offset.');
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function offsetSuffix(minutes) {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function localDateTimeParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0),
  };
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function localDatetimeInZone(timestamp, timeZone) {
  const parts = zonedParts(timestamp, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function prepareNativeDatetimeStamps(template, body, serverTimezone, timestamp, correcting) {
  const untouchedDatetimeIds = new Set();
  if (correcting) return untouchedDatetimeIds;
  const submitSeed = localDatetimeInZone(timestamp, serverTimezone);
  for (const field of template.fields.filter((candidate) => candidate.isDestroyed !== true)) {
    if (field.type !== 'datetime') continue;
    const value = body[field.id];
    const seed = body[`${field.id}__seed`];
    const stamp = body[`${field.id}__stamp`];
    if (stamp === 'seed' && typeof seed === 'string' && value === seed) {
      body[field.id] = submitSeed;
      body[`${field.id}__offset`] = '';
      body[`${field.id}__timezone`] = '';
      untouchedDatetimeIds.add(field.id);
    } else if (stamp === 'stamped' && localDateTimeParts(value)
        && /^-?\d+$/.test(String(body[`${field.id}__offset`] ?? ''))
        && typeof body[`${field.id}__timezone`] === 'string'
        && body[`${field.id}__timezone`]) {
      untouchedDatetimeIds.add(field.id);
    }
  }
  return untouchedDatetimeIds;
}

function normalizeNativeDatetime(value, offsetValue, timezoneValue, serverTimezone) {
  const parts = localDateTimeParts(value);
  if (!parts) return null;
  let offset = /^-?\d+$/.test(String(offsetValue ?? '')) ? Number(offsetValue) : null;
  let timezone = typeof timezoneValue === 'string' && timezoneValue ? timezoneValue : serverTimezone;
  if (offset === null) {
    timezone = serverTimezone;
    const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    let instant = wallAsUtc;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      offset = timeZoneOffset(instant, timezone);
      instant = wallAsUtc - offset * 60000;
    }
    const actual = zonedParts(instant, timezone);
    if (Object.keys(parts).some((key) => actual[key] !== parts[key])) return null;
  }
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) return null;
  const seconds = `${value.length === 16 ? `${value}:00` : value}${offsetSuffix(offset)}`;
  return { value: seconds, eventAt: seconds, timezone, clientOffsetMinutes: offset };
}

function nativeValues(template, body, serverTimezone) {
  const values = {};
  const raw = {};
  let eventTime;
  for (const field of template.fields.filter((candidate) => candidate.isDestroyed !== true)) {
    const supplied = body[field.id];
    if (field.type === 'checkbox') {
      values[field.id] = supplied === 'true' || supplied === 'on';
      raw[field.id] = values[field.id];
      continue;
    }
    if (supplied === undefined || supplied === '') continue;
    raw[field.id] = supplied;
    if (field.type === 'number') {
      const parsed = Number(supplied);
      values[field.id] = Number.isNaN(parsed) ? supplied : parsed;
    } else if (field.type === 'multi-select') {
      values[field.id] = Array.isArray(supplied) ? supplied : [supplied];
    } else if (field.type === 'datetime') {
      const normalized = normalizeNativeDatetime(
        supplied,
        body[`${field.id}__offset`],
        body[`${field.id}__timezone`],
        serverTimezone
      );
      values[field.id] = normalized ? normalized.value : supplied;
      if (!eventTime && normalized) {
        eventTime = {
          eventAt: normalized.eventAt,
          timezone: normalized.timezone,
          clientOffsetMinutes: normalized.clientOffsetMinutes,
        };
      }
    } else {
      values[field.id] = supplied;
    }
  }
  return { values, raw, eventTime };
}

function rawValuesForRecord(record) {
  return Object.fromEntries(record.values.map((entry) => {
    if (entry.fieldType !== 'datetime') return [entry.fieldId, entry.value];
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(String(entry.value));
    return [entry.fieldId, match ? match[1] : entry.value];
  }));
}

function exactOrigin(value) {
  if (typeof value !== 'string' || !value || value.includes(',')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch (_error) {
    return null;
  }
}

function configuredOrigins(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(exactOrigin).filter(Boolean))];
}

function originAllowed(req, configuredOrigin) {
  const expected = configuredOrigins(configuredOrigin);
  if (expected.length === 0) return false;
  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  const origin = originHeader ? exactOrigin(originHeader) : null;
  let refererOrigin = null;
  if (refererHeader) {
    try {
      const referer = new URL(refererHeader);
      if (referer.username || referer.password) return false;
      refererOrigin = referer.origin;
    } catch (_error) {
      return false;
    }
  }
  if (originHeader && !expected.includes(origin)) return false;
  if (refererHeader && !expected.includes(refererOrigin)) return false;
  if (originHeader && refererHeader && origin !== refererOrigin) return false;
  return Boolean(originHeader || refererHeader);
}

function createFormsRouter(options) {
  const { registry, service, store } = options;
  const authorize = options.authorize || defaultAuthorize;
  const contexts = options.contexts || new Map();
  const logger = options.logger || console;
  const customThemeCss = options.customThemeCss || '';
  const publicOrigins = configuredOrigins(options.publicOrigin);
  const destinationIds = [...(options.destinationIds || registry.destinationIds || ['default'])].sort();
  const serverTimezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = options.clock || (() => new Date());
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: serverTimezone }).format(new Date());
  } catch (_error) {
    throw new Error('forms.timezone must be a valid IANA timezone.');
  }
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 500 });
  const builderParser = express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 10000 });
  const apiParser = express.json({ limit: '2mb' });

  function currentDate() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('The forms clock returned an invalid time.');
    return date;
  }

  if (publicOrigins.length === 0) {
    logger.warn('Forms are enabled without an explicit valid public origin; browser mutations will be refused.');
  }

  function emitAudit(req, type, outcome, details = {}) {
    const principal = principalFor(req);
    const contentLength = Number(req.get('content-length'));
    const event = {
      id: crypto.randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      outcome,
      requestId: req.formsRequestId || (req.formsRequestId = crypto.randomUUID()),
      ...(isDefinitionId(details.templateId || req.params && req.params.templateId)
        ? { templateId: details.templateId || req.params.templateId }
        : {}),
      ...(UUID.test(details.submissionId || req.params && req.params.submissionId || '')
        ? { submissionId: details.submissionId || req.params.submissionId }
        : {}),
      ...(principal ? { principalId: principal.id, principalType: principal.type } : {}),
      ...(Number.isSafeInteger(details.templateVersion) ? { templateVersion: details.templateVersion } : {}),
      ...(typeof details.schemaDigest === 'string' ? { schemaDigest: details.schemaDigest } : {}),
      ...(Number.isSafeInteger(contentLength) && contentLength >= 0 ? { byteCount: contentLength } : {}),
    };
    try {
      if (typeof options.audit === 'function') options.audit(event, req);
    } catch (error) {
      logger.error('Forms audit emission failed.', { code: error && error.code || 'EAUDIT' });
    }
  }

  function eventTypeFor(req) {
    if (req.path.includes('/receipts/')) return 'form.receipt.read';
    if (req.method === 'GET') return 'form.render';
    return 'form.submit';
  }

  function issueContext(req, res) {
    let contextId = cookieValue(req, CONTEXT_COOKIE);
    let context = contextId && contexts.get(contextId);
    if (!context) {
      contextId = crypto.randomBytes(24).toString('base64url');
      context = { csrfToken: crypto.randomBytes(32).toString('base64url') };
      contexts.set(contextId, context);
      if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
      const secure = publicOrigins.length > 0 && publicOrigins.every((origin) => origin.startsWith('https://'));
      res.append('Set-Cookie', `${CONTEXT_COOKIE}=${encodeURIComponent(contextId)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    return context.csrfToken;
  }

  function validCsrf(req, token) {
    const contextId = cookieValue(req, CONTEXT_COOKIE);
    const context = contextId && contexts.get(contextId);
    return Boolean(context && typeof token === 'string' && safeEqual(context.csrfToken, token));
  }

  async function allowed(req, capability, resource) {
    return Boolean(await authorize({ req, capability, resource }));
  }

  // #248: a container's entries are the merged, newest-first entries of its members.
  async function containerTaggedEntries(req, members, limit) {
    const batches = await Promise.all(members.map(async (member) => {
      const records = await listVisibleSubmissions(req, member, limit) || [];
      return records.map((record) => ({ member, record }));
    }));
    return batches.flat()
      .sort((a, b) => Date.parse(b.record.eventAt || b.record.submittedAt || 0) - Date.parse(a.record.eventAt || a.record.submittedAt || 0))
      .slice(0, limit);
  }

  async function listVisibleSubmissions(req, template, limit) {
    const visible = await allowed(req, 'forms.submit', template)
      || await allowed(req, 'forms.read_submissions', template);
    const actor = principalFor(req);
    if (!visible || !actor) return null;
    return storeForTemplate(store, template)
      .listSubmissions({ templateId: template.templateId, actor, limit });
  }

  function refuseQueryToken(req, res, next) {
    if (queryCarriesToken(req)) {
      emitAudit(req, eventTypeFor(req), 'rejected_validation');
      res.status(400).json({ ok: false, error: 'URL credentials are not accepted for forms.' });
      return;
    }
    next();
  }

  function formNotFound(req, res, type) {
    emitAudit(req, type, 'rejected_authz');
    res.status(404).type('text/plain').send('Not found.');
  }

  function apiNotFound(req, res, type = 'form.submit') {
    emitAudit(req, type, 'rejected_authz');
    res.status(404).json({ ok: false, error: 'Not found.' });
  }

  function browserEnvelope(req, res, token, type) {
    let outcome = null;
    if (bearerPresented(req)) outcome = 'rejected_authn';
    else if (!originAllowed(req, publicOrigins)) outcome = 'rejected_origin';
    else if (!validCsrf(req, token)) outcome = 'rejected_csrf';
    if (outcome) {
      emitAudit(req, type, outcome);
      res.status(403).type('text/plain').send('Request refused.');
      return false;
    }
    return true;
  }

  function browserAuthenticated(req, res, type) {
    if (principalFor(req)) return true;
    emitAudit(req, type, 'rejected_authn');
    res.status(401).type('text/plain').send('Authentication required.');
    return false;
  }

  function apiAuthenticated(req, res, type = 'form.submit') {
    if (principalFor(req)) return true;
    emitAudit(req, type, 'rejected_authn');
    res.status(401).json({ ok: false, error: 'Authentication required.' });
    return false;
  }

  function managementBody(req, res, allowedKeys, type) {
    if (!req.is('application/json')) {
      emitAudit(req, type, 'rejected_validation');
      res.status(415).json({ ok: false, error: 'Content-Type must be application/json.' });
      return null;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      emitAudit(req, type, 'rejected_validation');
      res.status(400).json({
        ok: false,
        error: { code: 'invalid_request', message: 'Request body must be an object.', details: [{path: '', message: 'must be an object'}] },
      });
      return null;
    }
    const forbidden = Object.keys(req.body).filter((key) => !allowedKeys.has(key));
    if (forbidden.length) {
      emitAudit(req, type, 'rejected_validation');
      res.status(400).json({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Unknown or server-derived template field.',
          details: forbidden.map((key) => ({path: key, message: 'is not accepted from clients'})),
        },
      });
      return null;
    }
    return req.body;
  }

  function managementContentType(req, res, type) {
    if (req.is('application/json')) return true;
    emitAudit(req, type, 'rejected_validation');
    res.status(415).json({ ok: false, error: 'Content-Type must be application/json.' });
    return false;
  }

  function orderMembers(container, members) {
    // Optional presentation-only ordering: memberOrder first (unknown ids ignored),
    // everything unlisted appended title-sorted. Circuit order beats the alphabet.
    const order = Array.isArray(container && container.memberOrder) ? container.memberOrder : [];
    const byId = new Map(members.map((member) => [member.templateId, member]));
    const ordered = [];
    for (const memberId of order) {
      if (byId.has(memberId)) {
        ordered.push(byId.get(memberId));
        byId.delete(memberId);
      }
    }
    return ordered.concat([...byId.values()].sort((left, right) => String(left.title).localeCompare(String(right.title))));
  }

  async function containerMembersFor(req, container) {
    const members = [];
    for (const candidate of await registry.listTemplates()) {
      if (candidate.archived === true || candidate.kind === 'container') continue;
      if (candidate.containerId !== container.templateId) continue;
      if (await allowed(req, 'forms.submit', candidate) || await allowed(req, 'forms.view', candidate)) {
        members.push(candidate);
      }
    }
    return orderMembers(container, members);
  }

  async function relatedFormsFor(req, template) {
    // #234: container membership drives the strip; tags remain the fallback for
    // uncontained forms.
    if (template.containerId) {
      const container = await registry.getTemplate(template.containerId);
      if (container && container.kind === 'container' && container.archived !== true) {
        const members = await containerMembersFor(req, container);
        return {
          container: {templateId: container.templateId, title: container.title},
          related: members.filter((member) => member.templateId !== template.templateId),
        };
      }
    }
    const tags = Array.isArray(template.tags) ? template.tags : [];
    if (!tags.length) return {container: null, related: []};
    const related = [];
    for (const candidate of await registry.listTemplates()) {
      if (candidate.templateId === template.templateId || candidate.archived === true) continue;
      if (candidate.kind === 'container') continue;
      const candidateTags = Array.isArray(candidate.tags) ? candidate.tags : [];
      if (!candidateTags.some((tag) => tags.includes(tag))) continue;
      if (await allowed(req, 'forms.submit', candidate) || await allowed(req, 'forms.view', candidate)) {
        related.push(candidate);
      }
    }
    return {container: null, related: related.sort((left, right) => String(left.title).localeCompare(String(right.title)))};
  }

  function managementEnvelope(req, res, mutation, type) {
    const bearer = bearerPresented(req);
    if (bearer && cookieValue(req, CONTEXT_COOKIE)) {
      emitAudit(req, type, 'rejected_authn');
      res.status(400).json({ ok: false, error: 'Ambiguous credentials are not accepted.' });
      return false;
    }
    if (mutation && !bearer && (!originAllowed(req, publicOrigins)
        || !validCsrf(req, req.get('x-csrf-token')))) {
      emitAudit(req, type, originAllowed(req, publicOrigins) ? 'rejected_csrf' : 'rejected_origin');
      res.status(403).json({ ok: false, error: 'Request refused.' });
      return false;
    }
    return apiAuthenticated(req, res, type);
  }

  function templateProjection(record) {
    return {
      template: record.draft,
      state: record.state,
      publishedVersion: record.publishedVersion,
      publishedVersions: record.publishedVersions,
    };
  }

  async function createTemplateThroughApi(req, body) {
    const principal = principalFor(req);
    const draft = {
      contractVersion: 1,
      resourceKind: 'form-template',
      templateId: body.templateId,
      ownerId: principal.id,
      revision: 1,
      ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'templateId')),
    };
    return registry.createDraft(draft);
  }

  async function reviseTemplateThroughApi(templateId, body) {
    const changes = {...body};
    delete changes.revision;
    return registry.reviseDraft(templateId, body.revision, changes);
  }

  async function publishTemplateThroughApi(req, templateId, body) {
    return registry.publishDraft(templateId, principalFor(req), body.revision);
  }

  function routeValidationError(path, message) {
    const error = new Error('Template validation failed.');
    error.code = 'EVALIDATION';
    error.details = [{path, message}];
    return error;
  }

  async function availableCloneId(sourceId) {
    const suffix = '-copy';
    const base = `${sourceId.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    for (let index = 1; index <= 1000; index += 1) {
      const candidate = index === 1
        ? base
        : `${base.slice(0, 64 - String(index).length - 1).replace(/-+$/, '')}-${index}`;
      if (!await registry.getTemplate(candidate)) return candidate;
    }
    throw new Error('Could not allocate a template ID for the clone.');
  }

  async function cloneTemplateThroughApi(req, sourceRecord, body) {
    let source = sourceRecord.draft;
    if (body.templateVersion !== undefined) {
      if (!Number.isSafeInteger(body.templateVersion) || body.templateVersion < 1) {
        throw routeValidationError('templateVersion', 'must be a positive integer');
      }
      source = await registry.getTemplateVersion(sourceRecord.draft.templateId, body.templateVersion);
      if (!source) throw routeValidationError('templateVersion', 'does not identify a published version');
    }
    const templateId = body.templateId === undefined
      ? await availableCloneId(sourceRecord.draft.templateId)
      : body.templateId;
    const destinationId = sourceRecord.draft.destinationId;
    const derivedTitle = `${[...source.title].slice(0, 195).join('')} copy`;
    return createTemplateThroughApi(req, {
      templateId,
      grammarVersion: source.grammarVersion,
      ...(destinationId === undefined ? {} : {destinationId}),
      title: body.title === undefined ? derivedTitle : body.title,
      ...(source.description === undefined ? {} : {description: structuredClone(source.description)}),
      ...(source.tags === undefined ? {} : {tags: structuredClone(source.tags)}),
      lineage: {
        relation: 'clone',
        templateId: sourceRecord.draft.templateId,
        ...(body.templateVersion === undefined ? {} : {templateVersion: body.templateVersion}),
      },
      ...(source.presentation === undefined ? {} : {presentation: structuredClone(source.presentation)}),
      fields: structuredClone(source.fields),
    });
  }

  async function setTemplateArchivedThroughApi(templateId, body, archived) {
    return registry.setArchived(templateId, body.revision, archived);
  }

  async function listTemplatesThroughApi(req) {
    const records = await registry.listManagementTemplates();
    const templates = [];
    for (const record of records) {
      if (await allowed(req, 'forms.manage', record.draft)) {
        const destinationStore = storeForTemplate(store, record.draft);
        const entryCount = await destinationStore.countSubmissions({templateId: record.draft.templateId});
        templates.push({
          management: true,
          templateId: record.draft.templateId,
          title: record.draft.title,
          revision: record.draft.revision,
          publishedVersion: record.publishedVersion && record.publishedVersion.templateVersion,
          destinationId: record.draft.destinationId || 'default',
          state: record.state,
          entryCount,
          kind: record.draft.kind === 'container' ? 'container' : 'form',
          containerId: record.draft.containerId || null,
          parentId: record.draft.parentId || null,
          theme: (record.draft.presentation && record.draft.presentation.theme) || '',
          themeMode: (record.draft.presentation && record.draft.presentation.themeMode) || '',
        });
      } else if (record.state !== 'archived' && await allowed(req, 'forms.submit', record.draft)) {
        templates.push({
          templateId: record.draft.templateId,
          title: record.draft.title,
          kind: record.draft.kind === 'container' ? 'container' : 'form',
          containerId: record.draft.containerId || null,
          parentId: record.draft.parentId || null,
        });
      }
    }
    return templates;
  }

  function sendTemplateMutationError(req, res, error, type) {
    if (error && error.code === 'EVALIDATION') {
      emitAudit(req, type, 'rejected_validation');
      res.status(422).json({
        ok: false,
        error: { code: 'validation_error', message: error.message, details: error.details || [] },
      });
      return true;
    }
    if (error && error.code === 'ESTALE') {
      emitAudit(req, type, 'rejected_validation');
      res.status(409).json({ ok: false, error: { code: 'revision_conflict', message: 'Template revision is stale.' } });
      return true;
    }
    if (error && error.code === 'ECONFLICT') {
      emitAudit(req, type, 'rejected_validation');
      res.status(409).json({ ok: false, error: { code: 'conflict', message: error.message } });
      return true;
    }
    if (error && error.code === 'ENOTFOUND') {
      apiNotFound(req, res, type);
      return true;
    }
    return false;
  }

  router.use('/raw', (_req, res, next) => {
    res.set('Content-Security-Policy', ARTIFACT_SANDBOX);
    next();
  });
  router.use('/embed', (_req, res, next) => {
    res.set('Content-Security-Policy', EMBED_SANDBOX);
    next();
  });
  router.use('/forms', refuseQueryToken);
  router.use('/api/forms', refuseQueryToken);
  router.use('/api/forms', (req, res, next) => {
    apiParser(req, res, (error) => {
      if (!error) return next();
      const oversized = error.status === 413 || error.type === 'entity.too.large';
      emitAudit(req, 'form.submit', oversized ? 'rejected_size' : 'rejected_validation');
      res.status(oversized ? 413 : 400).json({
        ok: false,
        error: oversized ? 'Submission body is too large.' : 'Invalid JSON body.',
      });
    });
  });

  router.get('/api/forms/templates', async (req, res, next) => {
    const type = 'form.template.list';
    try {
      if (!managementEnvelope(req, res, false, type)) return;
      const templates = await listTemplatesThroughApi(req);
      emitAudit(req, type, 'accepted');
      res.status(200).json({
        ok: true,
        templates: templates.map(({management: _management, ...template}) => template),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/forms/templates/:templateId', async (req, res, next) => {
    const type = 'form.template.read';
    try {
      if (!managementEnvelope(req, res, false, type)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record || !await allowed(req, 'forms.manage', record.draft)) return apiNotFound(req, res, type);
      emitAudit(req, type, 'accepted', record.draft);
      // #245: the draft carries a child's OWN fields (what the builder edits);
      // resolvedFields/resolvedSchemaDigest show what actually serves.
      const projection = templateProjection(record);
      if (record.draft.parentId) {
        const resolved = await registry.getTemplate(record.draft.templateId);
        if (resolved) {
          projection.resolvedFields = resolved.fields;
          projection.resolvedSchemaDigest = resolved.schemaDigest;
        }
      }
      res.status(200).json({ ok: true, ...projection });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/forms/templates', async (req, res, next) => {
    const type = 'form.template.create';
    try {
      if (!managementEnvelope(req, res, true, type)) return;
      const principal = principalFor(req);
      const resource = principal && isDefinitionId(principal.id)
        ? { resourceKind: 'form-template', ownerId: principal.id }
        : null;
      if (!managementContentType(req, res, type)) return;
      if (!resource || !await allowed(req, 'forms.manage', resource)) {
        emitAudit(req, type, 'rejected_authz');
        res.status(403).json({ ok: false, error: 'Forbidden.' });
        return;
      }
      const body = managementBody(req, res, TEMPLATE_CREATE_KEYS, type);
      if (!body) return;
      const record = await createTemplateThroughApi(req, body);
      emitAudit(req, type, 'accepted', record.draft);
      res.status(201).json({ ok: true, ...templateProjection(record) });
    } catch (error) {
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.patch('/api/forms/templates/:templateId', async (req, res, next) => {
    const type = 'form.template.revise';
    try {
      if (!managementEnvelope(req, res, true, type)) return;
      if (!managementContentType(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record || !await allowed(req, 'forms.manage', record.draft)) return apiNotFound(req, res, type);
      const body = managementBody(req, res, TEMPLATE_PATCH_KEYS, type);
      if (!body) return;
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
        emitAudit(req, type, 'rejected_validation', record.draft);
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'revision is required.', details: [{path: 'revision', message: 'must be a positive integer'}] },
        });
        return;
      }
      if (Object.keys(body).length === 1) {
        emitAudit(req, type, 'rejected_validation', record.draft);
        res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'At least one draft field must change.' } });
        return;
      }
      const revised = await reviseTemplateThroughApi(req.params.templateId, body);
      emitAudit(req, type, 'accepted', revised.draft);
      res.status(200).json({ ok: true, ...templateProjection(revised) });
    } catch (error) {
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.post('/api/forms/templates/:templateId/publish', async (req, res, next) => {
    const type = 'form.template.publish';
    try {
      if (!managementEnvelope(req, res, true, type)) return;
      if (!managementContentType(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record || !await allowed(req, 'forms.manage', record.draft)) return apiNotFound(req, res, type);
      const body = managementBody(req, res, TEMPLATE_PUBLISH_KEYS, type);
      if (!body) return;
      if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 1)) {
        emitAudit(req, type, 'rejected_validation', record.draft);
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'revision must be a positive integer.', details: [{path: 'revision', message: 'must be a positive integer'}] },
        });
        return;
      }
      const version = await publishTemplateThroughApi(req, req.params.templateId, body);
      emitAudit(req, type, 'accepted', version);
      res.status(201).json({ ok: true, version });
    } catch (error) {
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.post('/api/forms/templates/:templateId/clone', async (req, res, next) => {
    const type = 'form.template.clone';
    try {
      if (!managementEnvelope(req, res, true, type)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, type);
      const source = await registry.getManagementTemplate(req.params.templateId);
      if (!source || !await allowed(req, 'forms.manage', source.draft)) return apiNotFound(req, res, type);
      if (!managementContentType(req, res, type)) return;
      const body = managementBody(req, res, TEMPLATE_CLONE_KEYS, type);
      if (!body) return;
      const cloned = await cloneTemplateThroughApi(req, source, body);
      emitAudit(req, type, 'accepted', cloned.draft);
      res.status(201).json({ok: true, ...templateProjection(cloned)});
    } catch (error) {
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    router.post(`/api/forms/templates/:templateId/${action}`, async (req, res, next) => {
      const type = `form.template.${action}`;
      try {
        if (!managementEnvelope(req, res, true, type)) return;
        if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, type);
        const current = await registry.getManagementTemplate(req.params.templateId);
        if (!current || !await allowed(req, 'forms.manage', current.draft)) return apiNotFound(req, res, type);
        if (!managementContentType(req, res, type)) return;
        const body = managementBody(req, res, TEMPLATE_LIFECYCLE_KEYS, type);
        if (!body) return;
        if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
          emitAudit(req, type, 'rejected_validation', current.draft);
          res.status(400).json({
            ok: false,
            error: {code: 'invalid_request', message: 'revision is required.', details: [{path: 'revision', message: 'must be a positive integer'}]},
          });
          return;
        }
        const changed = await setTemplateArchivedThroughApi(req.params.templateId, body, archived);
        emitAudit(req, type, 'accepted', changed.draft);
        res.status(200).json({ok: true, ...templateProjection(changed)});
      } catch (error) {
        if (!sendTemplateMutationError(req, res, error, type)) next(error);
      }
    });
  }

  function parseBuilder(req, res, next) {
    if (!req.is('application/x-www-form-urlencoded')) {
      emitAudit(req, 'form.template.revise', 'rejected_validation');
      res.status(415).type('text/plain').send('Unsupported media type.');
      return;
    }
    builderParser(req, res, (error) => {
      if (!error) return next();
      emitAudit(req, 'form.template.revise', error.status === 413 ? 'rejected_size' : 'rejected_validation');
      res.status(error.status === 413 ? 413 : 400).type('text/plain').send('Invalid form body.');
    });
  }

  function validContainerBuilderBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const fixed = new Set(['_csrf', '_action', 'revision', 'title', 'description', 'theme', 'themeMode', 'member']);
    const theme = body.theme;
    if (typeof theme === 'string' && theme !== '' && !getThemeList().some((entry) => entry.slug === theme)) return false;
    const mode = body.themeMode;
    if (typeof mode === 'string' && mode !== '' && mode !== 'dark' && mode !== 'light') return false;
    return Object.entries(body).every(([key, value]) => {
      if (!fixed.has(key)) return false;
      if (key === 'member') {
        return [].concat(value).every((memberId) => typeof memberId === 'string' && isDefinitionId(memberId));
      }
      return typeof value === 'string';
    });
  }

  function validBuilderBody(body, create = false) {
    const fixed = create
      ? new Set(['_csrf', 'templateId', 'title', 'destinationId', 'kind', 'group'])
      : new Set(['_csrf', '_action', 'revision', 'title', 'destinationId', 'theme', 'themeMode', 'container', 'parent']);
    // An author SELECTS an installed theme; they can never introduce one. Anything
    // outside the server's list is refused rather than quietly ignored.
    if (!create && body && typeof body === 'object') {
      const theme = body.theme;
      if (typeof theme === 'string' && theme !== ''
        && !getThemeList().some((entry) => entry.slug === theme)) return false;
      const mode = body.themeMode;
      if (typeof mode === 'string' && mode !== '' && mode !== 'dark' && mode !== 'light') return false;
    }
    const fieldKey = /^field\.\d+\.(?:id|type|label|required|help|component|showInList|isDestroyed|minimum|maximum|step|integer|providerSlot|option\.\d+\.(?:id|label))$/;
    return body && typeof body === 'object' && !Array.isArray(body)
      && Object.entries(body).every(([key, value]) => typeof value === 'string'
        && (fixed.has(key) || (!create && fieldKey.test(key))));
  }

  async function canCreateTemplate(req) {
    const principal = principalFor(req);
    const resource = principal && isDefinitionId(principal.id)
      ? {resourceKind: 'form-template', ownerId: principal.id}
      : null;
    return Boolean(resource && await allowed(req, 'forms.manage', resource));
  }

  function sendCreateTemplate(res, csrfToken, responseOptions = {}, status = 200) {
    const cspNonce = crypto.randomBytes(18).toString('base64url');
    formHeaders(res, cspNonce);
    res.status(status).type('html').send(renderCreateTemplatePage(csrfToken, destinationIds, {
      customThemeCss,
      cspNonce,
      ...responseOptions,
    }));
  }

  // #262: breadcrumb ancestor — identity only, no submission access implied.
  async function containerCrumbFor(template) {
    if (!template || !template.containerId) return null;
    const container = await registry.getTemplate(template.containerId);
    // #289: full template — the theme fallback needs presentation, not just the name.
    return container && container.kind === 'container' && container.archived !== true
      ? container
      : null;
  }

  async function sendConfigure(res, record, csrfToken, responseOptions = {}, status = 200) {
    const cspNonce = crypto.randomBytes(18).toString('base64url');
    formHeaders(res, cspNonce);
    const all = await registry.listManagementTemplates();
    if (record.draft.kind === 'container') {
      const memberChoices = all
        .filter((candidate) => candidate.draft.kind !== 'container' && candidate.state !== 'archived')
        .map((candidate) => ({
          templateId: candidate.draft.templateId,
          title: candidate.draft.title,
          checked: candidate.draft.containerId === record.draft.templateId,
        }))
        .sort((left, right) => String(left.title).localeCompare(String(right.title)));
      res.status(status).type('html').send(renderContainerConfigurePage(record, csrfToken, {
        customThemeCss,
        cspNonce,
        memberChoices,
        ...responseOptions,
      }));
      return;
    }
    const containers = all
      .filter((candidate) => candidate.draft.kind === 'container' && candidate.state !== 'archived')
      .map((candidate) => ({templateId: candidate.draft.templateId, title: candidate.draft.title}))
      .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    // #245: eligible parents are top-level active forms (single-level inheritance).
    const parents = all
      .filter((candidate) => candidate.draft.kind !== 'container' && candidate.state !== 'archived'
        && !candidate.draft.parentId && candidate.draft.templateId !== record.draft.templateId)
      .map((candidate) => ({templateId: candidate.draft.templateId, title: candidate.draft.title}))
      .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    const children = all
      .filter((candidate) => candidate.draft.parentId === record.draft.templateId && candidate.state !== 'archived')
      .map((candidate) => ({templateId: candidate.draft.templateId, title: candidate.draft.title}))
      .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    res.status(status).type('html').send(renderConfigurePage(record, csrfToken, destinationIds, {
      customThemeCss,
      cspNonce,
      containers,
      parents,
      children,
      relatedForms: {container: await containerCrumbFor(record.draft), related: []},
      ...responseOptions,
    }));
  }

  router.get('/forms', async (req, res, next) => {
    const type = 'form.template.list';
    try {
      if (!browserAuthenticated(req, res, type)) return;
      const templates = await listTemplatesThroughApi(req);
      const canCreate = await canCreateTemplate(req);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, type, 'accepted');
      res.status(200).type('html').send(renderFormsIndexPage(
        templates,
        canCreate,
        issueContext(req, res),
        {customThemeCss, cspNonce},
      ));
    } catch (error) {
      next(error);
    }
  });

  router.get('/forms/new', async (req, res, next) => {
    const type = 'form.template.create';
    try {
      if (!browserAuthenticated(req, res, type)) return;
      if (!await canCreateTemplate(req)) return formNotFound(req, res, type);
      emitAudit(req, type, 'accepted');
      // #260: the root's New group action lands here preselected.
      // #279: arriving from a group page pre-joins the new tracker to it.
      let group = null;
      if (typeof req.query.group === 'string' && isDefinitionId(req.query.group)) {
        const target = await registry.getTemplate(req.query.group);
        if (target && target.kind === 'container' && target.archived !== true) {
          group = {templateId: target.templateId, title: target.title, theme: themeDefaults(target)};
        }
      }
      sendCreateTemplate(res, issueContext(req, res), {kind: req.query.kind === 'container' ? 'container' : '', group});
    } catch (error) {
      next(error);
    }
  });

  router.post('/forms', parseBuilder, async (req, res, next) => {
    const type = 'form.template.create';
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf, type)) return;
      if (!browserAuthenticated(req, res, type)) return;
      if (!await canCreateTemplate(req)) {
        emitAudit(req, type, 'rejected_authz');
        res.status(403).type('text/plain').send('Forbidden.');
        return;
      }
      if (!validBuilderBody(req.body, true)) {
        emitAudit(req, type, 'rejected_validation');
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const title = postedString(req.body, 'title');
      // #279: the ID is optional — blank derives a deduped slug from the name.
      let templateId = postedString(req.body, 'templateId');
      if (!templateId) {
        let slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
        if (!/^[a-z]/.test(slug)) slug = `tracker${slug ? `-${slug}` : ''}`;
        templateId = slug;
        for (let suffix = 2; await registry.getTemplate(templateId); suffix += 1) {
          templateId = `${slug}-${suffix}`;
        }
      }
      const kind = postedString(req.body, 'kind');
      const group = postedString(req.body, 'group');
      // #234: the GUI creates containers through the same flow — no starter field,
      // no destination; the Configure page then manages members.
      const body = kind === 'container'
        ? {templateId, grammarVersion: 1, title, kind: 'container'}
        : {
          templateId,
          grammarVersion: 1,
          destinationId: postedString(req.body, 'destinationId'),
          title,
          fields: [{id: 'entry', type: 'short-text', label: 'Entry', required: true}],
          // #279: created from inside a group — joins it (registry fail-closes bad ids)
          ...(group ? {containerId: group} : {}),
        };
      const record = await createTemplateThroughApi(req, body);
      emitAudit(req, type, 'accepted', record.draft);
      res.redirect(303, `/forms/${encodeURIComponent(templateId)}/configure`);
    } catch (error) {
      if (error && (error.code === 'EVALIDATION' || error.code === 'ECONFLICT')) {
        emitAudit(req, type, 'rejected_validation');
        const errorGroup = postedString(req.body, 'group');
        sendCreateTemplate(res, issueContext(req, res), {
          errors: error.details || [{path: 'templateId', message: error.message}],
          templateId: postedString(req.body, 'templateId'),
          title: postedString(req.body, 'title'),
          destinationId: postedString(req.body, 'destinationId'),
          kind: postedString(req.body, 'kind') === 'container' ? 'container' : '',
          ...(errorGroup && isDefinitionId(errorGroup) ? {group: {templateId: errorGroup, title: errorGroup}} : {}),
        }, error.code === 'ECONFLICT' ? 409 : 422);
        return;
      }
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.post('/forms/:templateId/clone', parseBuilder, async (req, res, next) => {
    const type = 'form.template.clone';
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf, type)) return;
      if (!browserAuthenticated(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, type);
      const source = await registry.getManagementTemplate(req.params.templateId);
      if (!source || !await allowed(req, 'forms.manage', source.draft)) return formNotFound(req, res, type);
      if (!req.body || Object.keys(req.body).some((key) => key !== '_csrf')) {
        emitAudit(req, type, 'rejected_validation', source.draft);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const cloned = await cloneTemplateThroughApi(req, source, {});
      emitAudit(req, type, 'accepted', cloned.draft);
      res.redirect(303, `/forms/${encodeURIComponent(cloned.draft.templateId)}/configure`);
    } catch (error) {
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    router.post(`/forms/:templateId/${action}`, parseBuilder, async (req, res, next) => {
      const type = `form.template.${action}`;
      try {
        if (!browserEnvelope(req, res, req.body && req.body._csrf, type)) return;
        if (!browserAuthenticated(req, res, type)) return;
        if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, type);
        const current = await registry.getManagementTemplate(req.params.templateId);
        if (!current || !await allowed(req, 'forms.manage', current.draft)) return formNotFound(req, res, type);
        if (!req.body || Object.keys(req.body).some((key) => !['_csrf', 'revision'].includes(key))
            || !Number.isSafeInteger(Number(req.body.revision)) || Number(req.body.revision) < 1) {
          emitAudit(req, type, 'rejected_validation', current.draft);
          res.status(400).type('text/plain').send('Invalid form body.');
          return;
        }
        const changed = await setTemplateArchivedThroughApi(req.params.templateId, {revision: Number(req.body.revision)}, archived);
        emitAudit(req, type, 'accepted', changed.draft);
        res.redirect(303, '/forms');
      } catch (error) {
        if (error && error.code === 'ESTALE') {
          emitAudit(req, type, 'rejected_validation');
          res.status(409).type('text/plain').send('Template revision is stale. Reload the templates page and try again.');
          return;
        }
        if (!sendTemplateMutationError(req, res, error, type)) next(error);
      }
    });
  }

  router.get('/forms/:templateId/configure', async (req, res, next) => {
    const type = 'form.template.read';
    try {
      if (!browserAuthenticated(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record) return formNotFound(req, res, type);
      if (!await allowed(req, 'forms.manage', record.draft)) return formNotFound(req, res, type);
      emitAudit(req, type, 'accepted', record.draft);
      await sendConfigure(res, record, issueContext(req, res));
    } catch (error) {
      next(error);
    }
  });

  router.post('/forms/:templateId/configure', parseBuilder, async (req, res, next) => {
    const type = 'form.template.revise';
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf, type)) return;
      if (!browserAuthenticated(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record || !await allowed(req, 'forms.manage', record.draft)) return formNotFound(req, res, type);
      if (record.draft.kind === 'container') {
        // #234: container Configure — basics on the container itself, membership as
        // containerId diffs applied to the chosen member forms (truth stays on members).
        if (!validContainerBuilderBody(req.body)) {
          emitAudit(req, type, 'rejected_validation', record.draft);
          res.status(400).type('text/plain').send('Invalid form body.');
          return;
        }
        const presentation = {};
        const existing = record.draft.presentation || {};
        if (typeof existing.submitLabel === 'string') presentation.submitLabel = existing.submitLabel;
        const theme = postedString(req.body, 'theme');
        const themeMode = postedString(req.body, 'themeMode');
        if (theme) presentation.theme = theme;
        if (themeMode === 'dark' || themeMode === 'light') presentation.themeMode = themeMode;
        const description = postedString(req.body, 'description');
        const revisedContainer = await reviseTemplateThroughApi(req.params.templateId, {
          revision: Number(postedString(req.body, 'revision')),
          title: postedString(req.body, 'title'),
          description: description || null,
          presentation: Object.keys(presentation).length ? presentation : null,
        });
        const desired = new Set([].concat(req.body.member || []).filter((memberId) => typeof memberId === 'string' && memberId));
        const containerId = req.params.templateId;
        for (const candidate of await registry.listManagementTemplates()) {
          if (candidate.draft.kind === 'container' || candidate.state === 'archived') continue;
          if (!await allowed(req, 'forms.manage', candidate.draft)) continue;
          const isMember = candidate.draft.containerId === containerId;
          const shouldBe = desired.has(candidate.draft.templateId);
          if (isMember === shouldBe) continue;
          await registry.reviseDraft(candidate.draft.templateId, candidate.draft.revision, {
            containerId: shouldBe ? containerId : null,
          });
        }
        const fresh = await registry.getManagementTemplate(containerId);
        emitAudit(req, type, 'accepted', revisedContainer.draft);
        if (postedString(req.body, '_action') === 'basics') {
          // #257: root quick-configure — one tap makes the change live.
          await publishTemplateThroughApi(req, containerId, {revision: fresh.draft.revision});
          res.redirect(303, '/forms');
          return;
        }
        await sendConfigure(res, fresh, issueContext(req, res), {status: 'Draft saved.'});
        return;
      }
      if (!validBuilderBody(req.body)) {
        emitAudit(req, type, 'rejected_validation', record.draft);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      if (postedString(req.body, '_action') === 'basics') {
        // #257: root quick-configure — basics only, fields untouched (a field-less
        // save through builderPatch would wipe them), publish, back to the root.
        const theme = postedString(req.body, 'theme');
        const themeMode = (postedString(req.body, 'themeMode') === 'dark' || postedString(req.body, 'themeMode') === 'light')
          ? postedString(req.body, 'themeMode') : '';
        const basics = {
          revision: Number(postedString(req.body, 'revision')),
          title: postedString(req.body, 'title'),
        };
        if (record.draft.presentation && typeof record.draft.presentation === 'object') {
          // merge path: null unsets a single key (#225)
          basics.presentation = {theme: theme || null, themeMode: themeMode || null};
        } else if (theme || themeMode) {
          const fresh = {};
          if (theme) fresh.theme = theme;
          if (themeMode) fresh.themeMode = themeMode;
          basics.presentation = fresh;
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'container')) {
          basics.containerId = postedString(req.body, 'container') || null;
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'parent')) {
          basics.parentId = postedString(req.body, 'parent') || null;
        }
        const revised = await reviseTemplateThroughApi(req.params.templateId, basics);
        await publishTemplateThroughApi(req, req.params.templateId, {revision: revised.draft.revision});
        emitAudit(req, type, 'accepted', revised.draft);
        res.redirect(303, '/forms');
        return;
      }
      const patch = builderPatch(record.draft, req.body);
      const revised = await reviseTemplateThroughApi(req.params.templateId, patch);
      emitAudit(req, type, 'accepted', revised.draft);
      await sendConfigure(res, revised, issueContext(req, res), {status: 'Draft saved.'});
    } catch (error) {
      if (error && error.code === 'ESTALE') {
        emitAudit(req, type, 'rejected_validation');
        const latest = await registry.getManagementTemplate(req.params.templateId);
        await sendConfigure(res, latest, issueContext(req, res), {conflict: true}, 409);
        return;
      }
      if (error && error.code === 'EVALIDATION') {
        emitAudit(req, type, 'rejected_validation');
        const current = await registry.getManagementTemplate(req.params.templateId);
        const candidate = {
          ...current,
          draft: {...current.draft, ...builderPatch(current.draft, req.body), revision: current.draft.revision},
        };
        await sendConfigure(res, candidate, issueContext(req, res), {errors: error.details}, 422);
        return;
      }
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.post('/forms/:templateId/configure/publish', parseBuilder, async (req, res, next) => {
    const type = 'form.template.publish';
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf, type)) return;
      if (!browserAuthenticated(req, res, type)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, type);
      const record = await registry.getManagementTemplate(req.params.templateId);
      if (!record || !await allowed(req, 'forms.manage', record.draft)) return formNotFound(req, res, type);
      if (!req.body || Object.keys(req.body).some((key) => !['_csrf', 'revision'].includes(key))
          || !Number.isSafeInteger(Number(req.body.revision)) || Number(req.body.revision) < 1) {
        emitAudit(req, type, 'rejected_validation', record.draft);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const version = await publishTemplateThroughApi(req, req.params.templateId, {revision: Number(req.body.revision)});
      const published = await registry.getManagementTemplate(req.params.templateId);
      emitAudit(req, type, 'accepted', version);
      await sendConfigure(res, published, issueContext(req, res), {status: `Published version ${version.templateVersion}.`});
    } catch (error) {
      if (error && error.code === 'ESTALE') {
        emitAudit(req, type, 'rejected_validation');
        const latest = await registry.getManagementTemplate(req.params.templateId);
        await sendConfigure(res, latest, issueContext(req, res), {conflict: true}, 409);
        return;
      }
      if (!sendTemplateMutationError(req, res, error, type)) next(error);
    }
  });

  router.get('/forms/:templateId', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res, 'form.render')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.render');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(req, res, 'form.render');
      const canRender = await allowed(req, 'forms.submit', template)
        || await allowed(req, 'forms.view', template);
      if (!canRender) return formNotFound(req, res, 'form.render');
      const canManage = await allowed(req, 'forms.manage', template);
      if (template.archived === true) {
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        formHeaders(res, cspNonce);
        emitAudit(req, 'form.render', 'accepted', template);
        res.status(200).type('html').send(renderArchivedFormPage(template, {customThemeCss, cspNonce, canManage}));
        return;
      }
      if (template.kind === 'container') {
        const members = await containerMembersFor(req, template);
        // #293: no recent-entries aside here — the History tab owns it. Managers
        // see the group's archived trackers, restorable in place.
        const archivedMembers = canManage
          ? (await registry.listManagementTemplates())
            .filter((record) => record.draft.containerId === template.templateId && record.state === 'archived')
            .map((record) => ({templateId: record.draft.templateId, title: record.draft.title, revision: record.draft.revision}))
          : [];
        const csrfToken = issueContext(req, res);
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        formHeaders(res, cspNonce);
        emitAudit(req, 'form.render', 'accepted', template);
        res.status(200).type('html').send(renderContainerPage(template, members, {
          customThemeCss, cspNonce, canManage, archivedMembers, csrfToken,
          timezone: serverTimezone, now: currentDate(),
        }));
        return;
      }
      const recentRecords = await listVisibleSubmissions(req, template, RECENT_ENTRY_LIMIT) || [];
      const csrfToken = issueContext(req, res);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.render', 'accepted', template);
      const relatedForms = await relatedFormsFor(req, template);
      res.status(200).type('html').send(renderFormPage(withGroupTheme(template, relatedForms.container), csrfToken, {}, [], {
        customThemeCss,
        cspNonce,
        recentRecords,
        timezone: serverTimezone,
        canManage,
        relatedForms,
        now: currentDate(),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/forms/:templateId/entries', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res, 'form.submissions.list')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.submissions.list');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(req, res, 'form.submissions.list');
      if (template.kind === 'container') {
        const members = await containerMembersFor(req, template);
        const tagged = await containerTaggedEntries(req, members, 100);
        const submissions = tagged.map(({ member, record }) => ({ ...record, __member: member }));
        const canManage = await allowed(req, 'forms.manage', template);
        const csrfToken = issueContext(req, res);
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        formHeaders(res, cspNonce);
        emitAudit(req, 'form.submissions.list', 'accepted', template);
        res.status(200).type('html').send(renderEntriesPage(template, submissions, {
          customThemeCss, cspNonce, timezone: serverTimezone, canManage, csrfToken,
        }));
        return;
      }
      const submissions = await listVisibleSubmissions(req, template, 100);
      if (!submissions) return formNotFound(req, res, 'form.submissions.list');
      const canManage = await allowed(req, 'forms.manage', template);
      const csrfToken = issueContext(req, res);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.submissions.list', 'accepted', template);
      const relatedForms = {container: await containerCrumbFor(template), related: []};
      res.status(200).type('html').send(renderEntriesPage(withGroupTheme(template, relatedForms.container), submissions, {
        customThemeCss,
        cspNonce,
        timezone: serverTimezone,
        canManage,
        csrfToken,
        relatedForms,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/forms/:templateId/receipts/:submissionId/edit', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res, 'form.render')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.render');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(req, res, 'form.render');
      if (template.kind === 'container') return formNotFound(req, res, 'form.render');
      const destinationStore = storeForTemplate(store, template);
      const record = await destinationStore.getSubmission(req.params.submissionId).catch((error) => {
        if (error && error.code === 'EVALIDATION') return null;
        throw error;
      });
      if (!record || record.templateId !== template.templateId) {
        return formNotFound(req, res, 'form.render');
      }
      const canSubmit = await allowed(req, 'forms.submit', template);
      const principal = principalFor(req);
      const own = principal && record.actor
        && principal.id === record.actor.id && principal.type === record.actor.type;
      const canRead = own || await allowed(req, 'forms.read_submissions', record);
      if (!canRead || !canSubmit) return formNotFound(req, res, 'form.render');
      const recentRecords = (await listVisibleSubmissions(req, template, RECENT_ENTRY_LIMIT + 1) || [])
        .filter((candidate) => candidate.submissionId !== record.submissionId)
        .slice(0, RECENT_ENTRY_LIMIT);
      const canManage = await allowed(req, 'forms.manage', template);
      const csrfToken = issueContext(req, res);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.render', 'accepted', record);
      res.status(200).type('html').send(renderFormPage(
        template,
        csrfToken,
        rawValuesForRecord(record),
        [],
        {
          customThemeCss,
          cspNonce,
          correctionRecord: record,
          recentRecords,
          timezone: serverTimezone,
          canManage,
          relatedForms: await relatedFormsFor(req, template),
          now: currentDate(),
        }
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post('/forms/:templateId', (req, res, next) => {
    if (!req.is('application/x-www-form-urlencoded')) {
      emitAudit(req, 'form.submit', 'rejected_validation');
      res.status(415).type('text/plain').send('Unsupported media type.');
      return;
    }
    formParser(req, res, (error) => {
      if (error) {
        const oversized = error.status === 413 || error.type === 'entity.too.large';
        emitAudit(req, 'form.submit', oversized ? 'rejected_size' : 'rejected_validation');
        res.status(oversized ? 413 : 400).type('text/plain').send('Invalid form body.');
        return;
      }
      next();
    });
  }, async (req, res, next) => {
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf, 'form.submit')) return;
      if (!browserAuthenticated(req, res, 'form.submit')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.submit');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template || !await allowed(req, 'forms.submit', template)) return formNotFound(req, res, 'form.submit');
      if (template.kind === 'container') return formNotFound(req, res, 'form.submit');
      const destinationStore = storeForTemplate(store, template);
      const actor = principalFor(req);
      if (!actor) return formNotFound(req, res, 'form.submit');
      const allowedKeys = new Set([
        '_csrf',
        '_supersedes',
        ...template.fields.filter((field) => field.isDestroyed !== true).flatMap((field) => field.type === 'datetime'
          ? [field.id, `${field.id}__offset`, `${field.id}__timezone`, `${field.id}__seed`, `${field.id}__stamp`]
          : [field.id]),
      ]);
      if (Object.keys(req.body || {}).some((key) => !allowedKeys.has(key))) {
        emitAudit(req, 'form.submit', 'rejected_validation', template);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const untouchedDatetimeIds = prepareNativeDatetimeStamps(
        template,
        req.body || {},
        serverTimezone,
        currentDate(),
        req.body._supersedes !== undefined
      );
      const submitted = nativeValues(template, req.body || {}, serverTimezone);
      let predecessor = null;
      let correctionAuthorized = false;
      if (req.body._supersedes !== undefined) {
        predecessor = await destinationStore.getSubmission(req.body._supersedes).catch((error) => {
          if (error && error.code === 'EVALIDATION') return null;
          throw error;
        });
        const own = predecessor && predecessor.actor
          && predecessor.actor.id === actor.id && predecessor.actor.type === actor.type;
        if (!predecessor || predecessor.templateId !== template.templateId) {
          return formNotFound(req, res, 'form.submit');
        }
        correctionAuthorized = Boolean(own
          || await allowed(req, 'forms.read_submissions', predecessor)
          || await allowed(req, 'forms.manage', predecessor));
        if (!correctionAuthorized) return formNotFound(req, res, 'form.submit');
      }
      const result = await service.submit({
        templateId: template.templateId,
        values: submitted.values,
        actor,
        ...(submitted.eventTime || {}),
        ...(predecessor ? {
          supersedesRecord: { resourceKind: 'form-submission', id: predecessor.submissionId },
        } : {}),
      }, { correctionAuthorized });
      if (result.error) {
        if (result.error.code === 'not_found') return formNotFound(req, res, 'form.submit');
        emitAudit(req, 'form.submit', result.error.code === 'idempotency_conflict'
          ? 'rejected_idempotency'
          : 'rejected_validation', template);
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        formHeaders(res, cspNonce);
        const visibleErrors = result.error.details && result.error.details.length
          ? result.error.details
          : [{ path: 'entry', message: result.error.message }];
        const recentRecords = (await listVisibleSubmissions(
          req,
          template,
          predecessor ? RECENT_ENTRY_LIMIT + 1 : RECENT_ENTRY_LIMIT
        ) || []).filter((candidate) => !predecessor || candidate.submissionId !== predecessor.submissionId)
          .slice(0, RECENT_ENTRY_LIMIT);
        const canManage = await allowed(req, 'forms.manage', template);
        res.status(result.error.code === 'idempotency_conflict' || result.error.code === 'correction_conflict' ? 409 : result.error.code === 'invalid_request' ? 400 : 422).type('html').send(renderFormPage(
          template,
          issueContext(req, res),
          submitted.raw,
          visibleErrors,
          {
            customThemeCss,
            cspNonce,
            correctionRecord: predecessor,
            recentRecords,
            timezone: serverTimezone,
            canManage,
            relatedForms: await relatedFormsFor(req, template),
            now: currentDate(),
            autoStampDatetimeIds: untouchedDatetimeIds,
            now: currentDate(),
          }
        ));
        return;
      }
      emitAudit(req, 'form.submit', 'accepted', result.receipt);
      res.redirect(303, `/forms/${encodeURIComponent(template.templateId)}/receipts/${encodeURIComponent(result.submissionId)}`);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/forms/:templateId/submissions', async (req, res, next) => {
    try {
      if (!req.is('application/json')) {
        emitAudit(req, 'form.submit', 'rejected_validation');
        res.status(415).json({ ok: false, error: 'Content-Type must be application/json.' });
        return;
      }
      const bearer = bearerPresented(req);
      const contextId = cookieValue(req, CONTEXT_COOKIE);
      if (bearer && contextId) {
        emitAudit(req, 'form.submit', 'rejected_authn');
        res.status(400).json({ ok: false, error: 'Ambiguous credentials are not accepted.' });
        return;
      }
      if (!bearer && !originAllowed(req, publicOrigins)) {
        emitAudit(req, 'form.submit', 'rejected_origin');
        res.status(403).json({ ok: false, error: 'Request refused.' });
        return;
      }
      if (!bearer && !validCsrf(req, req.get('x-csrf-token'))) {
        emitAudit(req, 'form.submit', 'rejected_csrf');
        res.status(403).json({ ok: false, error: 'Request refused.' });
        return;
      }
      if (!apiAuthenticated(req, res)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res);
      const template = await registry.getTemplate(req.params.templateId);
      if (!template || !await allowed(req, 'forms.submit', template)) return apiNotFound(req, res);
      if (template.kind === 'container') return apiNotFound(req, res);
      const destinationStore = storeForTemplate(store, template);
      const actor = principalFor(req);
      if (!actor) return apiNotFound(req, res);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const allowedKeys = new Set([
        'values', 'eventAt', 'timezone', 'clientOffsetMinutes', 'idempotencyKey', 'supersedesRecord',
      ]);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        emitAudit(req, 'form.submit', 'rejected_validation', template);
        res.status(400).json({ ok: false, error: 'Unknown or server-derived submission field.' });
        return;
      }
      const hasEventField = ['eventAt', 'timezone', 'clientOffsetMinutes']
        .some((key) => Object.prototype.hasOwnProperty.call(body, key));
      let correctionAuthorized = false;
      if (body.supersedesRecord !== undefined) {
        const reference = body.supersedesRecord;
        const predecessor = reference && reference.resourceKind === 'form-submission'
          ? await destinationStore.getSubmission(reference.id).catch((error) => {
            if (error && error.code === 'EVALIDATION') return null;
            throw error;
          })
          : null;
        const own = predecessor && predecessor.actor
          && predecessor.actor.id === actor.id && predecessor.actor.type === actor.type;
        if (!predecessor || predecessor.templateId !== template.templateId) return apiNotFound(req, res);
        correctionAuthorized = Boolean(own
          || await allowed(req, 'forms.read_submissions', predecessor)
          || await allowed(req, 'forms.manage', predecessor));
        if (!correctionAuthorized) return apiNotFound(req, res);
      }
      const result = await service.submit({
        templateId: template.templateId,
        values: body.values,
        actor,
        ...(hasEventField ? {
          eventAt: body.eventAt,
          timezone: body.timezone,
          clientOffsetMinutes: body.clientOffsetMinutes,
        } : {}),
        ...(body.idempotencyKey === undefined && req.get('idempotency-key') === undefined ? {} : {
          idempotencyKey: req.get('idempotency-key') || body.idempotencyKey,
        }),
        ...(body.supersedesRecord === undefined ? {} : {
          supersedesRecord: body.supersedesRecord,
        }),
      }, { correctionAuthorized });
      if (result.error) {
        if (result.error.code === 'not_found') return apiNotFound(req, res);
        const conflict = result.error.code === 'idempotency_conflict'
          || result.error.code === 'correction_conflict';
        emitAudit(req, 'form.submit', result.error.code === 'idempotency_conflict'
          ? 'rejected_idempotency'
          : 'rejected_validation', template);
        res.status(conflict ? 409 : result.error.code === 'invalid_request' ? 400 : 422).json({ ok: false, error: result.error });
        return;
      }
      emitAudit(req, 'form.submit', 'accepted', result.receipt);
      res.status(201).json({
        ok: true,
        submissionId: result.submissionId,
        receipt: result.receipt,
        receiptUrl: `/forms/${encodeURIComponent(template.templateId)}/receipts/${encodeURIComponent(result.submissionId)}`,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/forms/:templateId/submissions', async (req, res, next) => {
    try {
      const bearer = bearerPresented(req);
      if (bearer && cookieValue(req, CONTEXT_COOKIE)) {
        emitAudit(req, 'form.submissions.list', 'rejected_authn');
        res.status(400).json({ ok: false, error: 'Ambiguous credentials are not accepted.' });
        return;
      }
      if (!apiAuthenticated(req, res, 'form.submissions.list')) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, 'form.submissions.list');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return apiNotFound(req, res, 'form.submissions.list');
      if (template.kind === 'container') return apiNotFound(req, res, 'form.submissions.list');
      const visible = await allowed(req, 'forms.submit', template)
        || await allowed(req, 'forms.read_submissions', template);
      const actor = principalFor(req);
      if (!visible || !actor) return apiNotFound(req, res, 'form.submissions.list');
      const parsedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
        emitAudit(req, 'form.submissions.list', 'rejected_validation', template);
        res.status(400).json({ ok: false, error: 'limit must be a positive integer.' });
        return;
      }
      const submissions = await storeForTemplate(store, template).listSubmissions({
        templateId: template.templateId,
        actor,
        limit: Math.min(parsedLimit, 100),
      });
      emitAudit(req, 'form.submissions.list', 'accepted', template);
      res.status(200).json({ ok: true, submissions, limit: Math.min(parsedLimit, 100) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/forms/:templateId/submissions/:submissionId/history', async (req, res, next) => {
    try {
      if (bearerPresented(req) && cookieValue(req, CONTEXT_COOKIE)) {
        emitAudit(req, 'form.submission.history', 'rejected_authn');
        res.status(400).json({ ok: false, error: 'Ambiguous credentials are not accepted.' });
        return;
      }
      if (!apiAuthenticated(req, res, 'form.submission.history')) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(req, res, 'form.submission.history');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return apiNotFound(req, res, 'form.submission.history');
      if (template.kind === 'container') return apiNotFound(req, res, 'form.submission.history');
      const destinationStore = storeForTemplate(store, template);
      const history = await destinationStore.getSubmissionHistory(req.params.submissionId).catch((error) => {
        if (error && error.code === 'EVALIDATION') return null;
        throw error;
      });
      if (!history || history.latest.templateId !== req.params.templateId) {
        return apiNotFound(req, res, 'form.submission.history');
      }
      const canRead = await allowed(req, 'forms.read_submissions', history.latest);
      const canManage = canRead ? false : await allowed(req, 'forms.manage', history.latest);
      const principal = principalFor(req);
      const own = principal && history.latest.actor
        && principal.id === history.latest.actor.id && principal.type === history.latest.actor.type;
      if (!own && !canRead && !canManage) {
        return apiNotFound(req, res, 'form.submission.history');
      }
      emitAudit(req, 'form.submission.history', 'accepted', history.latest);
      res.status(200).json({
        ok: true,
        requestedSubmissionId: req.params.submissionId,
        latestSubmissionId: history.latest.submissionId,
        submissions: [history.latest, ...history.predecessors],
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/forms/:templateId/receipts/:submissionId', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res, 'form.receipt.read')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.receipt.read');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(req, res, 'form.receipt.read');
      if (template.kind === 'container') return formNotFound(req, res, 'form.receipt.read');
      const destinationStore = storeForTemplate(store, template);
      const record = await destinationStore.getSubmission(req.params.submissionId).catch((error) => {
        if (error && error.code === 'EVALIDATION') return null;
        throw error;
      });
      if (!record || record.templateId !== req.params.templateId) return formNotFound(req, res, 'form.receipt.read');
      const principal = principalFor(req);
      const ownReceipt = principal && record.actor
        && principal.id === record.actor.id && principal.type === record.actor.type;
      const canRead = ownReceipt
        || await allowed(req, 'forms.read_submissions', record);
      if (!canRead) return formNotFound(req, res, 'form.receipt.read');
      const latest = await destinationStore.resolveLatest(record.submissionId);
      const canEdit = Boolean(template && template.archived !== true && latest && latest.submissionId === record.submissionId
        && await allowed(req, 'forms.submit', template));
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.receipt.read', 'accepted', record);
      const receiptRelated = await relatedFormsFor(req, template);
      res.status(200).type('html').send(renderReceiptPage(withGroupTheme(template, receiptRelated.container), record, {
        customThemeCss,
        cspNonce,
        canEdit,
        relatedForms: receiptRelated,
        timezone: serverTimezone,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.use('/api/forms', (req, res) => apiNotFound(req, res));
  router.use('/forms', (req, res) => formNotFound(req, res, eventTypeFor(req)));

  return router;
}

module.exports = {
  createFormsRouter,
  renderArchivedFormPage,
  renderConfigurePage,
  renderCreateTemplatePage,
  renderEntriesPage,
  renderFormPage,
  renderFormsIndexPage,
  renderReceiptPage,
};
