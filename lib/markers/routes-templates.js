'use strict';

const express = require('express');

const { apiError } = require('../api-error');
const { isMarkerTemplateId, summarizeTemplate } = require('./template-schema');

const BODY_LIMIT = '2mb';
const CREATE_TYPE = 'markers.template';

/**
 * @typedef {object} BrowserWriteGate
 * @property {(req: object, res: object, options: {mutation: boolean, type: string}) => (boolean|Promise<boolean>)} check
 *   Runs the browser-write checks (Origin, CSRF, ambiguous credentials, authentication). Returns true to continue.
 *   Returns false after it has already sent the refusal response.
 */

/**
 * Marker template routes (design §5).
 *
 * @param {object} options
 * @param {import('./template-store').MarkerTemplateStore} options.store
 * @param {(req: object) => (boolean|Promise<boolean>)} options.authorizeAdmin template admin check for mutations
 * @param {BrowserWriteGate} options.gate
 * @param {(event: string, req: object, details: {templateId: string|null, outcome: string}) => void} [options.audit]
 * @param {{warn?: Function}} [options.logger]
 * @returns {import('express').Router}
 */
function createMarkerTemplateRouter({ store, authorizeAdmin, gate, audit, logger } = {}) {
  if (!store) throw new TypeError('store is required.');
  if (typeof authorizeAdmin !== 'function') throw new TypeError('authorizeAdmin is required.');
  if (!gate || typeof gate.check !== 'function') throw new TypeError('gate.check is required.');
  const router = express.Router();
  const parser = express.json({ limit: BODY_LIMIT });

  function emitAudit(event, req, templateId, outcome) {
    if (typeof audit !== 'function') return;
    try {
      audit(event, req, { templateId: templateId || null, outcome });
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn('Marker template audit sink failed.', { error: error.message });
    }
  }

  function notFound(res) {
    apiError(res, 404, null, 'Not found.');
  }

  function parseBody(req, res) {
    return new Promise((resolve) => {
      parser(req, res, (error) => {
        if (!error) {
          resolve(true);
          return;
        }
        const oversized = error.status === 413 || error.type === 'entity.too.large';
        apiError(res, oversized ? 413 : 400, oversized ? 'payload_too_large' : 'invalid_json',
          oversized ? 'Template body is too large.' : 'Invalid JSON body.');
        resolve(false);
      });
    });
  }

  // Gate, then admin authorization, then body. Returns the parsed body or null
  // when a response has already been sent.
  async function mutationEnvelope(req, res, event, templateId, { bodyRequired = true } = {}) {
    if (!await gate.check(req, res, { mutation: true, type: CREATE_TYPE })) return null;
    if (!await authorizeAdmin(req)) {
      emitAudit(event, req, templateId, 'rejected_authz');
      apiError(res, 403, 'forbidden', 'Template administration is not permitted for this caller.');
      return null;
    }
    if (bodyRequired && !req.is('application/json')) {
      apiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
      return null;
    }
    if (!await parseBody(req, res)) return null;
    const body = req.body === undefined ? {} : req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      apiError(res, 400, 'invalid_request', 'Body must be a JSON object.');
      return null;
    }
    return body;
  }

  // `expectedRevision` is canonical, `revision` its alias; both given must agree.
  // Returns the revision, or null after sending a 400.
  function requireRevision(res, body) {
    const { expectedRevision, revision } = body;
    if (expectedRevision !== undefined && revision !== undefined && expectedRevision !== revision) {
      apiError(res, 400, 'invalid_request', 'expectedRevision and revision must be equal when both are given.',
        [{ path: 'revision', message: 'must equal expectedRevision' }]);
      return null;
    }
    const value = expectedRevision !== undefined ? expectedRevision : revision;
    const field = expectedRevision !== undefined ? 'expectedRevision' : 'revision';
    if (Number.isSafeInteger(value) && value >= 1) return value;
    apiError(res, 400, 'invalid_request', 'expectedRevision is required.', [{ path: field, message: 'must be a positive integer' }]);
    return null;
  }

  function sendStoreError(req, res, error, event, templateId) {
    const code = error && error.code;
    if (code === 'EVALIDATION') {
      emitAudit(event, req, templateId, 'rejected_validation');
      apiError(res, 422, 'validation_error', error.message, error.details || []);
    } else if (code === 'ESTALE') {
      emitAudit(event, req, templateId, 'rejected_stale');
      apiError(res, 409, 'revision_conflict', 'Template revision is stale.', undefined, { currentRevision: error.currentRevision });
    } else if (code === 'ECONFLICT') {
      emitAudit(event, req, templateId, 'rejected_conflict');
      apiError(res, 409, 'conflict', error.message);
    } else if (code === 'EREADONLY') {
      emitAudit(event, req, templateId, 'rejected_read_only');
      apiError(res, 403, 'read_only', error.message);
    } else if (code === 'ENOTFOUND') {
      emitAudit(event, req, templateId, 'rejected_not_found');
      notFound(res);
    } else {
      return false;
    }
    return true;
  }

  // Non-admin callers do not see where data lives or how it is written back.
  function templateOf(entry, isAdmin = true) {
    const { source: _source, writable: _writable, ...template } = entry;
    if (!isAdmin) {
      delete template.sources;
      delete template.projections;
      delete template.image;
      delete template.details;
      delete template.documents;
    }
    return template;
  }

  function parseRevisionQuery(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value)) return null;
    return Number(value);
  }

  router.use('/api/markers/templates', (req, res, next) => {
    // Reads may carry a query token like every other read; mutations never do.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.query && Object.prototype.hasOwnProperty.call(req.query, 'token')) {
      apiError(res, 400, 'query_credentials_rejected', 'URL credentials are not accepted for marker templates.');
      return;
    }
    next();
  });

  router.get('/api/markers/templates', async (_req, res, next) => {
    try {
      const { templates, skipped } = typeof store.listWithSkipped === 'function'
        ? await store.listWithSkipped()
        : { templates: await store.list(), skipped: [] };
      res.json({ ok: true, templates: templates.map((entry) => summarizeTemplate(entry)), skipped });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/markers/templates/:templateId', async (req, res, next) => {
    try {
      const { templateId } = req.params;
      let entry = null;
      if (req.query.revision !== undefined) {
        const revision = parseRevisionQuery(req.query.revision);
        if (revision === null) {
          apiError(res, 400, 'invalid_request', 'revision must be a positive integer.');
          return;
        }
        entry = isMarkerTemplateId(templateId) ? await store.getRevision(templateId, revision) : null;
      } else {
        entry = isMarkerTemplateId(templateId) ? await store.get(templateId) : null;
      }
      if (!entry) return notFound(res);
      const isAdmin = Boolean(await authorizeAdmin(req));
      res.json({ ok: true, template: templateOf(entry, isAdmin), source: entry.source, writable: entry.writable });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/markers/templates', async (req, res, next) => {
    const event = 'markers.template.create';
    let templateId = null;
    try {
      const body = await mutationEnvelope(req, res, event, null);
      if (!body) return;
      templateId = typeof body.templateId === 'string' ? body.templateId : null;
      const created = await store.create(body);
      emitAudit(event, req, created.templateId, 'accepted');
      res.status(201).json({ ok: true, template: templateOf(created) });
    } catch (error) {
      if (!sendStoreError(req, res, error, event, templateId)) next(error);
    }
  });

  router.patch('/api/markers/templates/:templateId', async (req, res, next) => {
    const event = 'markers.template.update';
    const { templateId } = req.params;
    try {
      const body = await mutationEnvelope(req, res, event, templateId);
      if (!body) return;
      const revision = requireRevision(res, body);
      if (revision === null) return;
      const { revision: _alias, expectedRevision: _canonical, ...changes } = body;
      if (Object.keys(changes).length === 0) {
        apiError(res, 400, 'invalid_request', 'At least one template field must change.');
        return;
      }
      const updated = await store.update(templateId, revision, changes);
      emitAudit(event, req, templateId, 'accepted');
      res.json({ ok: true, template: templateOf(updated) });
    } catch (error) {
      if (!sendStoreError(req, res, error, event, templateId)) next(error);
    }
  });

  router.delete('/api/markers/templates/:templateId', async (req, res, next) => {
    const event = 'markers.template.delete';
    const { templateId } = req.params;
    try {
      const body = await mutationEnvelope(req, res, event, templateId, { bodyRequired: false });
      if (!body) return;
      const revision = requireRevision(res, body);
      if (revision === null) return;
      await store.remove(templateId, revision);
      emitAudit(event, req, templateId, 'accepted');
      res.json({ ok: true, deleted: true });
    } catch (error) {
      if (!sendStoreError(req, res, error, event, templateId)) next(error);
    }
  });

  return router;
}

module.exports = { createMarkerTemplateRouter };
