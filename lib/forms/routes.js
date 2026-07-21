'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { isDefinitionId } = require('./template-registry');

const CONTEXT_COOKIE = 'lookie_forms_context';
const MAX_CONTEXTS = 10000;

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

function formHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'");
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

function constraintAttributes(field) {
  const constraints = field.constraints || {};
  const attributes = [];
  if (constraints.minimum !== undefined) attributes.push(`min="${escapeHtml(constraints.minimum)}"`);
  if (constraints.maximum !== undefined) attributes.push(`max="${escapeHtml(constraints.maximum)}"`);
  if (field.type === 'number') attributes.push(constraints.integer === true ? 'step="1"' : 'step="any"');
  return attributes.length ? ` ${attributes.join(' ')}` : '';
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

function renderControl(field, values) {
  const value = rawValue(values, field);
  const common = `id="field-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}"${field.required ? ' required' : ''}`;
  if (field.type === 'select') {
    return `<select ${common}><option value="">Choose…</option>${renderOptions(field, value, false)}</select>`;
  }
  if (field.type === 'multi-select') {
    return `<select ${common} multiple size="${Math.min(6, Math.max(2, (field.options || []).length))}">${renderOptions(field, value, true)}</select>`;
  }
  if (field.type === 'long-text') {
    return `<textarea ${common} rows="5">${escapeHtml(value)}</textarea>`;
  }
  if (field.type === 'checkbox') {
    const checked = value === true || value === 'true' || value === 'on';
    return `<input ${common} type="checkbox" value="true"${checked ? ' checked' : ''}>`;
  }
  const inputTypes = {
    'short-text': 'text',
    number: 'number',
    date: 'date',
    time: 'time',
    datetime: 'datetime-local',
  };
  return `<input ${common} type="${inputTypes[field.type]}" value="${escapeHtml(value)}"${field.type === 'number' || field.type === 'date' ? constraintAttributes(field) : ''}>`;
}

function renderFormPage(template, csrfToken, values = {}, errors = []) {
  const errorsByField = errorMap(errors);
  const errorSummary = errors.length
    ? `<div class="errors" role="alert"><strong>Please correct the highlighted fields.</strong><ul>${errors.map((error) => `<li>${escapeHtml(error.path.replace(/^values\./, ''))}: ${escapeHtml(error.message)}</li>`).join('')}</ul></div>`
    : '';
  const fields = template.fields.map((field) => {
    const fieldErrors = errorsByField.get(field.id) || [];
    const description = field.help ? `<small>${escapeHtml(field.help)}</small>` : '';
    const inlineErrors = fieldErrors.map((message) => `<small class="field-error">${escapeHtml(message)}</small>`).join('');
    const required = field.required ? ' <span aria-label="required">*</span>' : '';
    return `<div class="field${fieldErrors.length ? ' invalid' : ''}"><label for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}${required}</label>${description}${renderControl(field, values)}${inlineErrors}</div>`;
  }).join('');
  const submitLabel = template.presentation && template.presentation.submitLabel
    ? template.presentation.submitLabel
    : 'Submit';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(template.title)}</title><style>
:root{font-family:system-ui,sans-serif;color:#172033;background:#f4f6fa}*{box-sizing:border-box}body{margin:0;padding:1rem}.card{max-width:42rem;margin:auto;background:white;border:1px solid #d9dfeb;border-radius:14px;padding:clamp(1rem,4vw,2rem);box-shadow:0 8px 28px #17203312}h1{margin-top:0}.field{margin:1.15rem 0}.field label{display:block;font-weight:700;margin-bottom:.45rem}.field small{display:block;color:#526078;margin:.3rem 0}input,select,textarea,button{font:inherit;font-size:16px;width:100%;min-height:48px;border:1px solid #9aa7ba;border-radius:9px;padding:.7rem}input[type=checkbox]{width:48px;display:block}.invalid input,.invalid select,.invalid textarea{border:2px solid #b42318}.field-error,.errors{color:#8b1a10!important}.errors{background:#fff0ee;border:1px solid #f2aaa3;border-radius:9px;padding:.8rem}button{border:0;background:#1456c0;color:white;font-weight:750;cursor:pointer;margin-top:.7rem}</style></head><body><main class="card"><h1>${escapeHtml(template.title)}</h1>${template.description ? `<p>${escapeHtml(template.description)}</p>` : ''}${errorSummary}<form method="post" action="/forms/${encodeURIComponent(template.templateId)}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">${fields}<button type="submit">${escapeHtml(submitLabel)}</button></form></main></body></html>`;
}

function displayValue(entry) {
  if (entry.selectedOptions) return entry.selectedOptions.map((option) => option.optionLabel).join(', ');
  if (entry.fieldType === 'checkbox') return entry.value ? 'Yes' : 'No';
  if (Array.isArray(entry.value)) return entry.value.join(', ');
  return String(entry.value);
}

function renderReceiptPage(template, record) {
  const fields = new Map((template && template.fields || []).map((field) => [field.id, field]));
  const rows = record.values.map((entry) => {
    const field = fields.get(entry.fieldId);
    return `<dt>${escapeHtml(field ? field.label : entry.fieldId)}</dt><dd>${escapeHtml(displayValue(entry))}</dd>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Submission receipt</title><style>:root{font-family:system-ui,sans-serif;color:#172033;background:#f4f6fa}body{margin:0;padding:1rem}.card{max-width:42rem;margin:auto;background:white;border:1px solid #d9dfeb;border-radius:14px;padding:clamp(1rem,4vw,2rem)}dt{font-weight:700;margin-top:1rem}dd{margin:.25rem 0;white-space:pre-wrap}.receipt{color:#526078;overflow-wrap:anywhere}</style></head><body><main class="card"><h1>Submission received</h1><p class="receipt">Receipt ${escapeHtml(record.submissionId)} · ${escapeHtml(record.receiptAt)}</p><dl>${rows}</dl></main></body></html>`;
}

function nativeValues(template, body) {
  const values = {};
  const raw = {};
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
    } else if (field.type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(supplied)) {
      values[field.id] = `${supplied.length === 16 ? `${supplied}:00` : supplied}Z`;
    } else {
      values[field.id] = supplied;
    }
  }
  return { values, raw };
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

function originAllowed(req, configuredOrigin) {
  const expected = exactOrigin(configuredOrigin) || exactOrigin(`${req.protocol}://${req.get('host')}`);
  if (!expected) return false;
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
  if (originHeader && origin !== expected) return false;
  if (refererHeader && refererOrigin !== expected) return false;
  return Boolean(originHeader || refererHeader);
}

function createFormsRouter(options) {
  const { registry, service, store } = options;
  const authorize = options.authorize || defaultAuthorize;
  const contexts = options.contexts || new Map();
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 500 });

  function issueContext(req, res) {
    let contextId = cookieValue(req, CONTEXT_COOKIE);
    let context = contextId && contexts.get(contextId);
    if (!context) {
      contextId = crypto.randomBytes(24).toString('base64url');
      context = { csrfToken: crypto.randomBytes(32).toString('base64url') };
      contexts.set(contextId, context);
      if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
      const secure = (exactOrigin(options.publicOrigin) || '').startsWith('https://') || req.secure;
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

  function refuseQueryToken(req, res, next) {
    if (queryCarriesToken(req)) {
      res.status(400).json({ ok: false, error: 'URL credentials are not accepted for forms.' });
      return;
    }
    next();
  }

  function formNotFound(res) {
    res.status(404).type('text/plain').send('Not found.');
  }

  function apiNotFound(res) {
    res.status(404).json({ ok: false, error: 'Not found.' });
  }

  function browserEnvelope(req, res, token) {
    if (bearerPresented(req) || !originAllowed(req, options.publicOrigin) || !validCsrf(req, token)) {
      res.status(403).type('text/plain').send('Request refused.');
      return false;
    }
    return true;
  }

  function browserAuthenticated(req, res) {
    if (principalFor(req)) return true;
    res.status(401).type('text/plain').send('Authentication required.');
    return false;
  }

  function apiAuthenticated(req, res) {
    if (principalFor(req)) return true;
    res.status(401).json({ ok: false, error: 'Authentication required.' });
    return false;
  }

  router.use('/raw', (_req, res, next) => {
    res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
    next();
  });
  router.use('/forms', refuseQueryToken);
  router.use('/api/forms', refuseQueryToken);

  router.get('/forms/:templateId', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(res);
      const template = await registry.getTemplate(req.params.templateId);
      if (!template) return formNotFound(res);
      const canRender = await allowed(req, 'forms.submit', template)
        || await allowed(req, 'forms.view', template);
      if (!canRender) return formNotFound(res);
      const csrfToken = issueContext(req, res);
      formHeaders(res);
      res.status(200).type('html').send(renderFormPage(template, csrfToken));
    } catch (error) {
      next(error);
    }
  });

  router.post('/forms/:templateId', (req, res, next) => {
    if (!req.is('application/x-www-form-urlencoded')) {
      res.status(415).type('text/plain').send('Unsupported media type.');
      return;
    }
    formParser(req, res, (error) => {
      if (error) {
        res.status(error.status === 413 ? 413 : 400).type('text/plain').send('Invalid form body.');
        return;
      }
      next();
    });
  }, async (req, res, next) => {
    try {
      if (!browserEnvelope(req, res, req.body && req.body._csrf)) return;
      if (!browserAuthenticated(req, res)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(res);
      const template = await registry.getTemplate(req.params.templateId);
      if (!template || !await allowed(req, 'forms.submit', template)) return formNotFound(res);
      const actor = principalFor(req);
      if (!actor) return formNotFound(res);
      const allowedKeys = new Set(['_csrf', ...template.fields.map((field) => field.id)]);
      if (Object.keys(req.body || {}).some((key) => !allowedKeys.has(key))) {
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const submitted = nativeValues(template, req.body || {});
      const result = await service.submit({ templateId: template.templateId, values: submitted.values, actor });
      if (result.error) {
        if (result.error.code === 'not_found') return formNotFound(res);
        formHeaders(res);
        res.status(422).type('html').send(renderFormPage(
          template,
          contexts.get(cookieValue(req, CONTEXT_COOKIE)).csrfToken,
          submitted.raw,
          result.error.details
        ));
        return;
      }
      res.redirect(303, `/forms/${encodeURIComponent(template.templateId)}/receipts/${encodeURIComponent(result.submissionId)}`);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/forms/:templateId/submissions', async (req, res, next) => {
    try {
      if (!req.is('application/json')) {
        res.status(415).json({ ok: false, error: 'Content-Type must be application/json.' });
        return;
      }
      const bearer = bearerPresented(req);
      const contextId = cookieValue(req, CONTEXT_COOKIE);
      if (bearer && contextId) {
        res.status(400).json({ ok: false, error: 'Ambiguous credentials are not accepted.' });
        return;
      }
      if (!bearer && (!originAllowed(req, options.publicOrigin)
          || !validCsrf(req, req.get('x-csrf-token')))) {
        res.status(403).json({ ok: false, error: 'Request refused.' });
        return;
      }
      if (!apiAuthenticated(req, res)) return;
      if (!isDefinitionId(req.params.templateId)) return apiNotFound(res);
      const template = await registry.getTemplate(req.params.templateId);
      if (!template || !await allowed(req, 'forms.submit', template)) return apiNotFound(res);
      const actor = principalFor(req);
      if (!actor) return apiNotFound(res);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const allowedKeys = new Set(['values', 'eventAt', 'timezone', 'clientOffsetMinutes', 'idempotencyKey']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        res.status(400).json({ ok: false, error: 'Unknown or server-derived submission field.' });
        return;
      }
      const hasEventField = ['eventAt', 'timezone', 'clientOffsetMinutes']
        .some((key) => Object.prototype.hasOwnProperty.call(body, key));
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
      });
      if (result.error) {
        if (result.error.code === 'not_found') return apiNotFound(res);
        res.status(422).json({ ok: false, error: result.error });
        return;
      }
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

  router.get('/forms/:templateId/receipts/:submissionId', async (req, res, next) => {
    try {
      if (!browserAuthenticated(req, res)) return;
      if (!isDefinitionId(req.params.templateId)) return formNotFound(res);
      const record = await store.getSubmission(req.params.submissionId).catch((error) => {
        if (error && error.code === 'EVALIDATION') return null;
        throw error;
      });
      if (!record || record.templateId !== req.params.templateId) return formNotFound(res);
      const principal = principalFor(req);
      const ownReceipt = principal && record.actor
        && principal.id === record.actor.id && principal.type === record.actor.type;
      const canRead = ownReceipt
        || await allowed(req, 'forms.read_submissions', record);
      if (!canRead) return formNotFound(res);
      const template = await registry.getTemplate(req.params.templateId);
      formHeaders(res);
      res.status(200).type('html').send(renderReceiptPage(template, record));
    } catch (error) {
      next(error);
    }
  });

  router.use('/api/forms', (_req, res) => apiNotFound(res));
  router.use('/forms', (_req, res) => formNotFound(res));

  return router;
}

module.exports = {
  createFormsRouter,
  renderFormPage,
  renderReceiptPage,
};
