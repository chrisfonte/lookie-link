'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { baseHtml, themeScript, toolbarHtml } = require('../renderer');
const { isDefinitionId } = require('./template-registry');

const CONTEXT_COOKIE = 'lookie_forms_context';
const MAX_CONTEXTS = 10000;
const MAX_STEPPED_OPTIONS = 200;
const RECENT_ENTRY_LIMIT = 3;
const ARTIFACT_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  for (const field of fields || []) {
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

function renderControl(field, values, describedBy = [], invalid = false) {
  const value = rawValue(values, field);
  const description = describedBy.length ? ` aria-describedby="${describedBy.map(escapeHtml).join(' ')}"` : '';
  const common = `id="field-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}"${field.required ? ' required' : ''}${invalid ? ' aria-invalid="true"' : ''}${description}`;
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
      ? `<div class="readout-control readout-control-select">${select}<span class="readout-unit" id="field-${escapeHtml(field.id)}-unit">${escapeHtml(unit)}</span></div>`
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
    ? ` data-datetime-local data-offset-field="${escapeHtml(field.id)}__offset" data-timezone-field="${escapeHtml(field.id)}__timezone"><input type="hidden" name="${escapeHtml(field.id)}__offset"><input type="hidden" name="${escapeHtml(field.id)}__timezone"`
    : '';
  const placeholder = field.type === 'number' ? ' placeholder="\u2014"' : '';
  const input = `<input ${common} type="${inputTypes[field.type]}" value="${escapeHtml(value)}"${placeholder}${field.type === 'number' || field.type === 'date' ? constraintAttributes(field) : ''}${datetimeCapture}>`;
  const unit = field.type === 'number' ? unitFromLabel(field.label) : null;
  return unit
    ? `<div class="readout-control">${input}<span class="readout-unit" id="field-${escapeHtml(field.id)}-unit">${escapeHtml(unit)}</span></div>`
    : input;
}

function datetimeCaptureScript(cspNonce) {
  return `<script nonce="${escapeHtml(cspNonce)}">
(() => {
  const pad = (value) => String(value).padStart(2, '0');
  const localValue = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const input of document.querySelectorAll('input[data-datetime-local]')) {
    const offset = input.form.elements[input.dataset.offsetField];
    const timezone = input.form.elements[input.dataset.timezoneField];
    const sync = () => {
      const instant = new Date(input.value);
      if (offset && Number.isFinite(instant.getTime())) offset.value = String(-instant.getTimezoneOffset());
      if (timezone && zone) timezone.value = zone;
    };
    if (!input.value) input.value = localValue(new Date());
    input.addEventListener('input', sync);
    input.form.addEventListener('submit', sync);
    sync();
  }
})();
</script>`;
}

function renderRecentEntries(template, records, timezone) {
  const entriesHref = `/forms/${encodeURIComponent(template.templateId)}/entries`;
  const content = records.length
    ? `<div class="entry-list">${records.map((record) => renderEntryRow(template, record, timezone)).join('')}</div>`
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
      return `<div class="${classes}"><label for="field-${escapeHtml(field.id)}">${escapeHtml(label)}${required}</label>${description}${renderControl(field, values, describedBy, fieldErrors.length > 0)}${inlineErrors}</div>`;
    }).join('');
    return `<section class="form-section form-section-${group.key}" aria-labelledby="form-section-${group.key}">
          <h2 id="form-section-${group.key}">${group.title}</h2>
          <div class="form-section-fields">${fields}</div>
        </section>`;
  }).join('');
  const editing = Boolean(options.correctionRecord);
  const configuredSubmitLabel = template.presentation && template.presentation.submitLabel;
  const submitLabel = editing
    ? 'Save correction'
    : configuredSubmitLabel || 'Submit';
  const entriesHref = `/forms/${encodeURIComponent(template.templateId)}/entries`;
  const body = `${toolbarHtml()}
  <main class="layout form-layout">
    <header class="topbar">
      <h1>${escapeHtml(template.title)}</h1>
      <nav class="form-page-links" aria-label="Form navigation">
        <a class="back" href="/">Back</a>
        <a class="entries-link" href="${entriesHref}">View entries</a>
      </nav>
    </header>

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
      ${renderRecentEntries(template, options.recentRecords || [], options.timezone)}
    </section>
  </main>
  ${datetimeCaptureScript(options.cspNonce)}
  ${themeScript(options.cspNonce)}`;

  return baseHtml({
    title: template.title,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
}

function displayValue(entry) {
  if (entry.selectedOptions) return entry.selectedOptions.map((option) => option.optionLabel).join(', ');
  if (entry.fieldType === 'checkbox') return entry.value ? 'Yes' : 'No';
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
    return `<tr><th scope="row">${escapeHtml(label)}</th><td class="receipt-value${entry.fieldType === 'number' ? ' receipt-value-number' : ''}">${escapeHtml(displayValue(entry))}</td><td class="receipt-unit">${unit ? escapeHtml(unit) : ''}</td></tr>`;
  }).join('');
  const formHref = `/forms/${encodeURIComponent(record.templateId || template && template.templateId || '')}`;
  const entriesHref = `${formHref}/entries`;
  const editHref = `${formHref}/receipts/${encodeURIComponent(record.submissionId)}/edit`;
  const canEdit = options.canEdit !== false;
  const received = formatRecordTime(record, options.timezone).dateTimeLabel;
  const body = `${toolbarHtml()}
  <main class="layout form-layout">
    <header class="topbar">
      <h1>Entry logged</h1>
      <p class="subtitle">${template ? escapeHtml(template.title) : 'Form receipt'}</p>
      <p><a class="back" href="/">Back</a></p>
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
    </section>
  </main>
  ${themeScript(options.cspNonce)}`;

  return baseHtml({
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
  };
}

function entryMetrics(record) {
  const numeric = record.values.filter((entry) => entry.fieldType === 'number').slice(0, 3);
  const entries = numeric.length > 0
    ? numeric
    : record.values.filter((entry) => entry.fieldType !== 'long-text').slice(0, 2);
  return entries.map((entry) => {
    const unit = entry.fieldType === 'number' ? unitFromLabel(entry.fieldLabel) : null;
    const label = unit ? labelWithoutUnit(entry.fieldLabel) : entry.fieldLabel;
    return `<span class="entry-metric"><span class="entry-metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(displayValue(entry))}</strong>${unit ? `<span class="entry-metric-unit">${escapeHtml(unit)}</span>` : ''}</span>`;
  }).join('');
}

function renderEntryRow(template, record, timezone) {
  const formHref = `/forms/${encodeURIComponent(template.templateId)}`;
  const stamp = formatRecordTime(record, timezone);
  const href = `${formHref}/receipts/${encodeURIComponent(record.submissionId)}`;
  const selection = record.values.find((entry) => entry.fieldType === 'select' || entry.fieldType === 'multi-select');
  return `<a class="entry-row" href="${href}">
            <span class="entry-row-heading"><time datetime="${escapeHtml(stamp.timestamp)}">${escapeHtml(stamp.dateTimeLabel)}</time>${selection ? `<strong>${escapeHtml(displayValue(selection))}</strong>` : ''}</span>
            <span class="entry-metrics">${entryMetrics(record)}</span>
          </a>`;
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
        <div class="entry-list">${dayRecords.map(({ record }) => renderEntryRow(template, record, options.timezone)).join('')}</div>
      </section>`).join('');
  const content = records.length > 0
    ? entries
    : `<div class="entries-empty"><h2>Ready for your first entry?</h2><p>Log it now and it will show up here.</p><a class="button-link button-link-primary form-primary-action" href="${formHref}">Log an entry</a></div>`;
  const body = `${toolbarHtml()}
  <main class="layout form-layout entries-layout">
    <header class="topbar">
      <h1>All entries</h1>
      <p class="subtitle">${escapeHtml(template.title)}</p>
      <p><a class="back" href="${formHref}">Back to form</a></p>
    </header>
    <section class="content form-card entries-card">${content}</section>
  </main>
  ${themeScript(options.cspNonce)}`;
  return baseHtml({
    title: `${template.title} entries`,
    body,
    customThemeCss: options.customThemeCss,
    cspNonce: options.cspNonce,
  });
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
  for (const field of template.fields) {
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
  const serverTimezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: serverTimezone }).format(new Date());
  } catch (_error) {
    throw new Error('forms.timezone must be a valid IANA timezone.');
  }
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 500 });
  const apiParser = express.json({ limit: '2mb' });

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

  async function listVisibleSubmissions(req, template, limit) {
    const visible = await allowed(req, 'forms.submit', template)
      || await allowed(req, 'forms.read_submissions', template);
    const actor = principalFor(req);
    if (!visible || !actor) return null;
    return store.listSubmissions({ templateId: template.templateId, actor, limit });
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

  router.use('/raw', (_req, res, next) => {
    res.set('Content-Security-Policy', ARTIFACT_SANDBOX);
    next();
  });
  router.use('/embed', (_req, res, next) => {
    res.set('Content-Security-Policy', ARTIFACT_SANDBOX);
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

  router.get('/forms/:templateId', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res, 'form.render')) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(req, res, 'form.render');
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(req, res, 'form.render');
      const canRender = await allowed(req, 'forms.submit', template)
        || await allowed(req, 'forms.view', template);
      if (!canRender) return formNotFound(req, res, 'form.render');
      const recentRecords = await listVisibleSubmissions(req, template, RECENT_ENTRY_LIMIT) || [];
      const csrfToken = issueContext(req, res);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.render', 'accepted', template);
      res.status(200).type('html').send(renderFormPage(template, csrfToken, {}, [], {
        customThemeCss,
        cspNonce,
        recentRecords,
        timezone: serverTimezone,
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
      const submissions = await listVisibleSubmissions(req, template, 100);
      if (!submissions) return formNotFound(req, res, 'form.submissions.list');
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.submissions.list', 'accepted', template);
      res.status(200).type('html').send(renderEntriesPage(template, submissions, {
        customThemeCss,
        cspNonce,
        timezone: serverTimezone,
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
      const record = await store.getSubmission(req.params.submissionId).catch((error) => {
        if (error && error.code === 'EVALIDATION') return null;
        throw error;
      });
      if (!template || !record || record.templateId !== template.templateId) {
        return formNotFound(req, res, 'form.render');
      }
      const canSubmit = await allowed(req, 'forms.submit', template);
      const principal = principalFor(req);
      const own = principal && record.actor
        && principal.id === record.actor.id && principal.type === record.actor.type;
      const canRead = own || await allowed(req, 'forms.read_submissions', record);
      if (!canRead || !canSubmit) return formNotFound(req, res, 'form.render');
      const recentRecords = await listVisibleSubmissions(req, template, RECENT_ENTRY_LIMIT) || [];
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
      const actor = principalFor(req);
      if (!actor) return formNotFound(req, res, 'form.submit');
      const allowedKeys = new Set([
        '_csrf',
        '_supersedes',
        ...template.fields.flatMap((field) => field.type === 'datetime'
          ? [field.id, `${field.id}__offset`, `${field.id}__timezone`]
          : [field.id]),
      ]);
      if (Object.keys(req.body || {}).some((key) => !allowedKeys.has(key))) {
        emitAudit(req, 'form.submit', 'rejected_validation', template);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const submitted = nativeValues(template, req.body || {}, serverTimezone);
      let predecessor = null;
      let correctionAuthorized = false;
      if (req.body._supersedes !== undefined) {
        predecessor = await store.getSubmission(req.body._supersedes).catch((error) => {
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
        const recentRecords = await listVisibleSubmissions(req, template, RECENT_ENTRY_LIMIT) || [];
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
          ? await store.getSubmission(reference.id).catch((error) => {
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
      const submissions = await store.listSubmissions({
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
      const history = await store.getSubmissionHistory(req.params.submissionId).catch((error) => {
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
      const record = await store.getSubmission(req.params.submissionId).catch((error) => {
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
      const template = await registry.getTemplate(req.params.templateId);
      const latest = await store.resolveLatest(record.submissionId);
      const canEdit = Boolean(template && latest && latest.submissionId === record.submissionId
        && await allowed(req, 'forms.submit', template));
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.receipt.read', 'accepted', record);
      res.status(200).type('html').send(renderReceiptPage(template, record, {
        customThemeCss,
        cspNonce,
        canEdit,
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
  renderEntriesPage,
  renderFormPage,
  renderReceiptPage,
};
