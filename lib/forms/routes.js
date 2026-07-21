'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { baseHtml, themeScript, toolbarHtml } = require('../renderer');
const { isDefinitionId } = require('./template-registry');

const CONTEXT_COOKIE = 'lookie_forms_context';
const MAX_CONTEXTS = 10000;
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

function renderFormPage(template, csrfToken, values = {}, errors = [], options = {}) {
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
  const body = `${toolbarHtml()}
  <main class="layout form-layout">
    <header class="topbar">
      <h1>${escapeHtml(template.title)}</h1>
      <p class="subtitle">Form</p>
      <p><a class="back" href="/">Back</a></p>
    </header>

    <section class="content form-card">
      ${template.description ? `<p class="form-description">${escapeHtml(template.description)}</p>` : ''}
      ${errorSummary}
      <form method="post" action="/forms/${encodeURIComponent(template.templateId)}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        ${fields}
        <button class="button-link button-link-primary form-primary-action" type="submit">${escapeHtml(submitLabel)}</button>
      </form>
    </section>
  </main>
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
    return `<dt>${escapeHtml(entry.fieldLabel || (field ? field.label : entry.fieldId))}</dt><dd>${escapeHtml(displayValue(entry))}</dd>`;
  }).join('');
  const formHref = `/forms/${encodeURIComponent(record.templateId || template && template.templateId || '')}`;
  const body = `${toolbarHtml()}
  <main class="layout form-layout">
    <header class="topbar">
      <h1>Submission received</h1>
      <p class="subtitle">${template ? escapeHtml(template.title) : 'Form receipt'}</p>
      <p><a class="back" href="/">Back</a></p>
    </header>

    <section class="content form-card receipt-card">
      <p class="receipt">Receipt ${escapeHtml(record.submissionId)} · ${escapeHtml(record.receiptAt)}</p>
      <dl>${rows}</dl>
      <a class="button-link button-link-primary form-primary-action" href="${formHref}">Log another</a>
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

  function apiAuthenticated(req, res) {
    if (principalFor(req)) return true;
    emitAudit(req, 'form.submit', 'rejected_authn');
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
      const csrfToken = issueContext(req, res);
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.render', 'accepted', template);
      res.status(200).type('html').send(renderFormPage(template, csrfToken, {}, [], { customThemeCss, cspNonce }));
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
      const allowedKeys = new Set(['_csrf', ...template.fields.map((field) => field.id)]);
      if (Object.keys(req.body || {}).some((key) => !allowedKeys.has(key))) {
        emitAudit(req, 'form.submit', 'rejected_validation', template);
        res.status(400).type('text/plain').send('Invalid form body.');
        return;
      }
      const submitted = nativeValues(template, req.body || {});
      const result = await service.submit({ templateId: template.templateId, values: submitted.values, actor });
      if (result.error) {
        if (result.error.code === 'not_found') return formNotFound(req, res, 'form.submit');
        emitAudit(req, 'form.submit', result.error.code === 'idempotency_conflict'
          ? 'rejected_idempotency'
          : 'rejected_validation', template);
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        formHeaders(res, cspNonce);
        res.status(result.error.code === 'idempotency_conflict' ? 409 : result.error.code === 'invalid_request' ? 400 : 422).type('html').send(renderFormPage(
          template,
          issueContext(req, res),
          submitted.raw,
          result.error.details,
          { customThemeCss, cspNonce }
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
      const allowedKeys = new Set(['values', 'eventAt', 'timezone', 'clientOffsetMinutes', 'idempotencyKey']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        emitAudit(req, 'form.submit', 'rejected_validation', template);
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
        if (result.error.code === 'not_found') return apiNotFound(req, res);
        const conflict = result.error.code === 'idempotency_conflict';
        emitAudit(req, 'form.submit', conflict ? 'rejected_idempotency' : 'rejected_validation', template);
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
      const cspNonce = crypto.randomBytes(18).toString('base64url');
      formHeaders(res, cspNonce);
      emitAudit(req, 'form.receipt.read', 'accepted', record);
      res.status(200).type('html').send(renderReceiptPage(template, record, { customThemeCss, cspNonce }));
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
  renderFormPage,
  renderReceiptPage,
};
