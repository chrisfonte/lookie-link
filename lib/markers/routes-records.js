'use strict';

const express = require('express');

const { apiError } = require('../api-error');
const { evaluateConstraints } = require('./constraints');
const { normalizeMarkers, summarizeRecord, validActorName } = require('./record-store');
const { isMarkerTemplateId } = require('./template-schema');

const BODY_LIMIT = '2mb';
const RECORD_TYPE = 'markers.record';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY_KEYS = new Set(['audio', 'templateId', 'templateRevision', 'markers', 'tags', 'reason', 'supersedesRecord', 'actor', 'touched', 'overrides', 'projection']);
const PROJECTION_KEYS = new Set(['id', 'mode', 'accept', 'expectedTargetSha256']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bearerPresented(req) {
  const header = req.get('authorization');
  return typeof header === 'string' && /^Bearer\s+\S/i.test(header);
}

function validationFailure(details, message = 'Validation failed.') {
  const error = new Error(message);
  error.code = 'EVALIDATION';
  error.details = details;
  return error;
}

/**
 * @typedef {object} ProjectionHook
 * `project({ template, projectionId, record, audio, mode, accept, expectedTargetSha256, touched })`
 * returns a receipt or throws `{ status, code, message, details, extra? }`.
 * `record` is pre-built with `recordId` allocated. In live mode a returned
 * receipt is always followed by the record write.
 */

/**
 * Marker record routes (design §5).
 *
 * @param {object} options
 * @param {{forDestination: (id: string) => import('./record-store').MarkerRecordStore}} options.stores
 * @param {{get: Function, list: Function}} options.templateStore
 * @param {{check: Function}} options.gate browser-write gate
 * @param {(req: object, repo: string, path: string) => (boolean|Promise<boolean>)} options.authorizeRead
 * @param {(req: object, repo: string, path: string) => (boolean|Promise<boolean>)} options.authorizeWrite
 * @param {(req: object, repo: string, path: string) => Promise<object>} options.resolveAudio
 *   `{ ok: true, sampleRate, channels, frames, sha256, absPath }` or `{ ok: false, status, code, message }`;
 *   sha256 is the peaks header's source hash, absPath is never echoed.
 * @param {(absPath: string) => Promise<string>} options.hashAudio sha256 hex of the audio bytes
 * @param {(req: object) => ({id: string, type: string}|null)} options.principalFor
 * @param {ProjectionHook} [options.project]
 * @param {(req: object, info: {mode: string, projection: object, target: *}) => (boolean|Promise<boolean>)} [options.authorizeProjection]
 *   required in practice when `project` is set: live needs template-admin authority or write on the projection's repo
 *   path, preview needs view. Absent means denied.
 * @param {(event: string, req: object, details: object) => void} [options.audit]
 * @param {string} [options.operatorName] default display name (nameSource 'config')
 * @param {(req: object) => (string|null)} [options.tokenSubjectFor] token subject for bearer callers (default principal id)
 * @param {() => string[]} [options.destinationIds] destinations to search for reads (default: templates' plus 'default')
 * @param {{warn?: Function}} [options.logger]
 * @returns {import('express').Router}
 */
function createMarkerRecordRouter({
  stores, templateStore, gate, authorizeRead, authorizeWrite, resolveAudio, hashAudio, principalFor,
  project, authorizeProjection, audit, operatorName, tokenSubjectFor, destinationIds, logger,
} = {}) {
  if (!stores || typeof stores.forDestination !== 'function') throw new TypeError('stores.forDestination is required.');
  if (!templateStore || typeof templateStore.get !== 'function') throw new TypeError('templateStore is required.');
  if (!gate || typeof gate.check !== 'function') throw new TypeError('gate.check is required.');
  for (const [name, fn] of Object.entries({ authorizeRead, authorizeWrite, resolveAudio, hashAudio, principalFor })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} is required.`);
  }
  const router = express.Router();
  const parser = express.json({ limit: BODY_LIMIT });

  function emitAudit(event, req, details) {
    if (typeof audit !== 'function') return;
    try {
      audit(event, req, details);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn('Marker record audit sink failed.', { error: error.message });
    }
  }

  function parseBody(req, res) {
    return new Promise((resolve) => {
      parser(req, res, (error) => {
        if (!error) return resolve(true);
        const oversized = error.status === 413 || error.type === 'entity.too.large';
        apiError(res, oversized ? 413 : 400, oversized ? 'payload_too_large' : 'invalid_json',
          oversized ? 'Request body is too large.' : 'Invalid JSON body.');
        return resolve(false);
      });
    });
  }

  function destinationOf(template) {
    return (template && template.destinationId) || 'default';
  }

  async function candidateDestinations() {
    if (typeof destinationIds === 'function') return [...new Set(destinationIds())];
    const ids = new Set(['default']);
    for (const template of await templateStore.list()) ids.add(destinationOf(template));
    return [...ids];
  }

  async function findRecord(recordId) {
    if (!UUID.test(recordId)) return null;
    for (const id of await candidateDestinations()) {
      const store = stores.forDestination(id);
      const record = await store.getRecord(recordId);
      if (record) return { record, store };
    }
    return null;
  }

  function sendAudioFailure(res, resolved) {
    const failure = resolved || {};
    // No ffmpeg/ffprobe: frames are unknown, so positions cannot be validated (design N10).
    if (failure.code === 'peaks_unavailable' || failure.peaksUnavailable === true) {
      return apiError(res, 503, 'peaks_unavailable', failure.message || 'Audio analysis is unavailable on this instance; marker records cannot be validated.');
    }
    return apiError(res, failure.status || 500, failure.code || 'internal_error', failure.message || 'Audio could not be resolved.');
  }

  function sendError(req, res, error, event, details = {}) {
    const code = error && error.code;
    const note = (outcome) => emitAudit(event, req, { ...details, outcome });
    if (code === 'EVALIDATION') {
      note('rejected_validation');
      apiError(res, 422, 'validation_error', error.message, error.details || []);
    } else if (code === 'ESTALE_LATEST') {
      note('rejected_stale');
      apiError(res, 409, 'revision_conflict', error.message, undefined,
        { currentRecordId: error.currentRecordId, currentRecord: error.currentRecord });
    } else if (code === 'ESTALE_AUDIO') {
      note('rejected_stale_audio');
      apiError(res, 409, 'revision_conflict', error.message, undefined,
        { ...(error.currentRecordId ? { currentRecordId: error.currentRecordId, currentRecord: error.currentRecord } : {}) });
    } else if (code === 'ENOTFOUND') {
      note('rejected_not_found');
      apiError(res, 404, 'not_found', 'Not found.');
    } else if (code === 'RECORD_WRITE_FAILED') {
      note('failed_after_projection');
      if (logger && typeof logger.warn === 'function') logger.warn('Marker record write failed after a live projection.', { recordId: error.recordId, error: error.cause && error.cause.message });
      apiError(res, 500, 'record_write_failed',
        'The projection was applied but the record could not be written; keep this response and retry or report it.',
        { recordId: error.recordId, projection: error.projection });
    } else if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600 && typeof error.code === 'string') {
      note(`rejected_${error.code}`);
      const extra = isPlainObject(error.extra) ? error.extra : undefined;
      apiError(res, error.status, error.code, error.message, error.details, extra);
    } else {
      return false;
    }
    return true;
  }

  function internalError(req, res, error, event) {
    if (logger && typeof logger.warn === 'function') logger.warn('Marker record route failed.', { error: error && error.message });
    emitAudit(event, req, { outcome: 'error' });
    apiError(res, 500, 'internal_error', 'Internal error.');
  }

  // ---- shared save preparation ---------------------------------------------

  function actorFor(req, body) {
    const principal = principalFor(req);
    const actor = { id: principal.id, type: principal.type };
    const requested = isPlainObject(body.actor) && body.actor.name !== undefined ? body.actor.name : undefined;
    if (bearerPresented(req)) {
      const subject = typeof tokenSubjectFor === 'function' ? tokenSubjectFor(req) : null;
      actor.name = subject || principal.id;
      actor.nameSource = 'token';
    } else if (requested !== undefined) {
      actor.name = requested;
      actor.nameSource = 'self-asserted';
    } else if (typeof operatorName === 'string' && operatorName.trim()) {
      actor.name = operatorName.trim();
      actor.nameSource = 'config';
    }
    return actor;
  }

  function checkBodyShape(body) {
    const details = [];
    for (const key of Object.keys(body)) {
      if (!BODY_KEYS.has(key)) details.push({ path: key, message: 'is not allowed' });
    }
    const audio = body.audio;
    if (!isPlainObject(audio) || typeof audio.repo !== 'string' || !audio.repo || typeof audio.path !== 'string' || !audio.path
        || Object.keys(audio).some((key) => key !== 'repo' && key !== 'path')) {
      details.push({ path: 'audio', message: 'must be { repo, path }' });
    }
    if (!isMarkerTemplateId(body.templateId)) details.push({ path: 'templateId', message: 'must be a marker template id' });
    if (body.actor !== undefined && (!isPlainObject(body.actor) || Object.keys(body.actor).some((key) => key !== 'name'))) {
      details.push({ path: 'actor', message: 'may only carry name' });
    } else if (body.actor && body.actor.name !== undefined && !validActorName(body.actor.name)) {
      details.push({ path: 'actor.name', message: 'must be 1-80 printable characters' });
    }
    if (body.overrides !== undefined && (!Array.isArray(body.overrides) || body.overrides.length > 1000)) {
      details.push({ path: 'overrides', message: 'must be an array of { markerId, reason }' });
    }
    if (body.projection !== undefined && body.projection !== null) {
      if (!isPlainObject(body.projection) || typeof body.projection.id !== 'string' || !body.projection.id
          || Object.keys(body.projection).some((key) => !PROJECTION_KEYS.has(key))
          || (body.projection.accept !== undefined && typeof body.projection.accept !== 'boolean')
          || (body.projection.expectedTargetSha256 !== undefined && (typeof body.projection.expectedTargetSha256 !== 'string' || body.projection.expectedTargetSha256.length > 200))) {
        details.push({ path: 'projection', message: 'must be { id, mode?, accept?, expectedTargetSha256? }' });
      }
    }
    return details;
  }

  // Common envelope: gate, authentication, JSON body, whitelist, authorization,
  // template and revision. Returns the context or null after sending a response.
  async function prepare(req, res, event, previewRoute = false) {
    if (!await gate.check(req, res, { mutation: true, type: RECORD_TYPE })) return null;
    const principal = principalFor(req);
    if (!principal) {
      apiError(res, 401, 'unauthenticated', 'Authentication required.');
      return null;
    }
    if (!req.is('application/json')) {
      apiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
      return null;
    }
    if (!await parseBody(req, res)) return null;
    const body = req.body;
    if (!isPlainObject(body)) {
      apiError(res, 400, 'invalid_request', 'Body must be a JSON object.');
      return null;
    }
    const details = checkBodyShape(body);
    if (details.length > 0) {
      emitAudit(event, req, { templateId: null, outcome: 'rejected_validation' });
      apiError(res, 422, 'validation_error', 'Request body is invalid.', details);
      return null;
    }
    // P1: the records route projects live only; dry runs go to /api/markers/preview.
    if (body.projection && body.projection.mode !== undefined && body.projection.mode !== (previewRoute ? 'preview' : 'live')) {
      apiError(res, 400, 'invalid_request', previewRoute
        ? 'The preview route only projects in preview mode.'
        : 'A record save projects in live mode; use /api/markers/preview to dry-run.');
      return null;
    }
    if (!Number.isSafeInteger(body.templateRevision) || body.templateRevision < 1) {
      apiError(res, 400, 'invalid_request', 'templateRevision is required.', [{ path: 'templateRevision', message: 'must be a positive integer' }]);
      return null;
    }
    const { repo, path: audioPath } = body.audio;
    if (!await authorizeWrite(req, repo, audioPath)) {
      emitAudit(event, req, { templateId: body.templateId, outcome: 'rejected_authz' });
      apiError(res, 403, 'forbidden', 'Writing markers for this audio is not permitted for this caller.');
      return null;
    }
    const template = await templateStore.get(body.templateId);
    if (!template) {
      apiError(res, 404, 'not_found', 'Marker template not found.');
      return null;
    }
    if (template.revision !== body.templateRevision) {
      emitAudit(event, req, { templateId: template.templateId, outcome: 'rejected_stale' });
      apiError(res, 409, 'revision_conflict', 'Template revision is stale.', undefined, { currentRevision: template.revision });
      return null;
    }
    const resolved = await resolveAudio(req, repo, audioPath);
    if (!resolved || resolved.ok === false) {
      sendAudioFailure(res, resolved);
      return null;
    }
    let markers;
    try {
      markers = normalizeMarkers(body.markers);
    } catch (error) {
      if (sendError(req, res, error, event, { templateId: template.templateId })) return null;
      throw error;
    }
    if (Array.isArray(body.overrides)) {
      const ids = new Set(markers.map((marker) => marker.id));
      const problems = body.overrides
        .map((entry, index) => (isPlainObject(entry) && ids.has(entry.markerId) ? null : { path: `overrides[${index}].markerId`, message: 'must name a marker in this record' }))
        .filter(Boolean);
      if (problems.length > 0) {
        apiError(res, 422, 'validation_error', 'Request body is invalid.', problems);
        return null;
      }
    }
    let projection = null;
    if (body.projection) {
      projection = (template.projections || []).find((entry) => entry.id === body.projection.id);
      if (!projection) {
        apiError(res, 422, 'validation_error', 'Request body is invalid.', [{ path: 'projection.id', message: 'is not declared by the template' }]);
        return null;
      }
      const mode = previewRoute ? 'preview' : 'live';
      const permitted = typeof authorizeProjection === 'function'
        && await authorizeProjection(req, { mode, projection, target: projection.target === undefined ? null : projection.target });
      if (!permitted) {
        emitAudit(event, req, { templateId: template.templateId, projectionId: projection.id, outcome: 'rejected_authz' });
        apiError(res, 403, 'projection_not_allowed', 'This caller may not run that projection.');
        return null;
      }
      if (typeof project !== 'function') {
        apiError(res, 409, 'feature_disabled', 'no projection configured');
        return null;
      }
    }
    return {
      principal, body, template, resolved, markers, repo, path: audioPath, projectionRequest: body.projection || null,
    };
  }

  function constraintCheck(context, sampleRate, frames) {
    return evaluateConstraints({
      template: context.template,
      markers: context.markers,
      frames,
      sampleRate,
      tags: context.body.tags === undefined ? {} : context.body.tags,
      overrides: context.body.overrides,
    });
  }

  function recordInput(req, context, audio, extra = {}) {
    const { body } = context;
    return {
      actor: actorFor(req, body),
      reason: body.reason === undefined ? null : body.reason,
      audio,
      templateId: context.template.templateId,
      templateRevision: context.template.revision,
      markers: context.markers,
      tags: body.tags,
      ...(body.touched === undefined ? {} : { touched: body.touched }),
      ...(body.overrides === undefined ? {} : { overrides: body.overrides }),
      supersedesRecord: body.supersedesRecord === undefined ? null : body.supersedesRecord,
      ...extra,
    };
  }

  function audioFields(context, sha256) {
    const { resolved } = context;
    return {
      repo: context.repo, path: context.path, sha256, sampleRate: resolved.sampleRate, channels: resolved.channels, frames: resolved.frames,
    };
  }

  function projectionArgs(context, record, mode) {
    const request = context.projectionRequest;
    return {
      template: context.template,
      projectionId: request.id,
      record,
      audio: { ...record.audio, ...(context.resolved.absPath ? { absPath: context.resolved.absPath } : {}) },
      mode,
      accept: request.accept === true,
      expectedTargetSha256: request.expectedTargetSha256,
      touched: record.touched || [],
    };
  }

  function targetShaAfter(receipt) {
    if (!isPlainObject(receipt) || receipt.status === 'skipped') return null;
    if (typeof receipt.targetSha256After === 'string') return receipt.targetSha256After;
    if (typeof receipt.after === 'string') return receipt.after;
    if (isPlainObject(receipt.after) && typeof receipt.after.sha256 === 'string') return receipt.after.sha256;
    return null;
  }

  // ---- reads ---------------------------------------------------------------

  router.use(['/api/markers/records', '/api/markers/preview'], (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.query && Object.prototype.hasOwnProperty.call(req.query, 'token')) {
      apiError(res, 400, 'query_credentials_rejected', 'URL credentials are not accepted for marker writes.');
      return;
    }
    next();
  });

  router.get('/api/markers/records', async (req, res, next) => {
    try {
      const { repo, path: audioPath, templateId } = req.query;
      if (typeof repo !== 'string' || !repo || typeof audioPath !== 'string' || !audioPath) {
        return apiError(res, 400, 'invalid_request', 'repo and path are required.');
      }
      if (templateId !== undefined && !isMarkerTemplateId(templateId)) {
        return apiError(res, 400, 'invalid_request', 'templateId is invalid.');
      }
      if (!await authorizeRead(req, repo, audioPath)) return apiError(res, 404, 'not_found', 'Not found.');
      const resolved = await resolveAudio(req, repo, audioPath);
      // With peaks unavailable the bytes cannot be keyed; reads fall back to the recorded repo/path.
      const unkeyed = resolved && resolved.ok === false && (resolved.code === 'peaks_unavailable' || resolved.peaksUnavailable === true);
      if (!resolved || (resolved.ok === false && !unkeyed)) return sendAudioFailure(res, resolved);
      const all = req.query.all === '1' || req.query.all === 'true';
      let ids = await candidateDestinations();
      if (templateId) {
        const template = await templateStore.get(templateId);
        if (template) ids = [destinationOf(template)];
      }
      const records = [];
      for (const id of ids) {
        records.push(...await stores.forDestination(id).listLatest(unkeyed
          ? { repo, path: audioPath, templateId, all }
          : { sha256: resolved.sha256, templateId, all }));
      }
      records.sort((left, right) => (left.receiptAt < right.receiptAt ? 1 : left.receiptAt > right.receiptAt ? -1 : 0));
      return res.json({ ok: true, records });
    } catch (error) {
      return next(error);
    }
  });

  async function readableRecord(req, res) {
    const found = await findRecord(req.params.recordId);
    if (!found || !await authorizeRead(req, found.record.audio.repo, found.record.audio.path)) {
      apiError(res, 404, 'not_found', 'Not found.');
      return null;
    }
    return found;
  }

  router.get('/api/markers/records/:recordId', async (req, res, next) => {
    try {
      const found = await readableRecord(req, res);
      if (found) res.json({ ok: true, record: found.record });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/markers/records/:recordId/history', async (req, res, next) => {
    try {
      const found = await readableRecord(req, res);
      if (!found) return;
      const history = await found.store.getHistory(req.params.recordId);
      if (!history) return apiError(res, 404, 'not_found', 'Not found.');
      res.json({ ok: true, requestedRecordId: req.params.recordId, latest: history.latest, predecessors: history.predecessors });
    } catch (error) {
      next(error);
    }
  });

  // ---- create --------------------------------------------------------------

  router.post('/api/markers/records', async (req, res) => {
    const event = 'markers.record.create';
    let details = { templateId: null };
    try {
      const context = await prepare(req, res, event);
      if (!context) return;
      const { body, template, resolved } = context;
      details = { templateId: template.templateId };
      const request = context.projectionRequest;
      if (request) {
        if (typeof request.expectedTargetSha256 !== 'string' || !request.expectedTargetSha256) {
          return apiError(res, 400, 'invalid_request', 'expectedTargetSha256 is required for a live projection.',
            [{ path: 'projection.expectedTargetSha256', message: 'is required' }]);
        }
      }
      if (body.supersedesRecord !== undefined && body.supersedesRecord !== null
          && template.templateId !== 'freeform' && !(typeof body.reason === 'string' && body.reason.trim())) {
        return apiError(res, 422, 'validation_error', 'A reason is required to supersede a record.', [{ path: 'reason', message: 'is required' }]);
      }
      // The server hashes the bytes itself on every create (design §1.3).
      let sha256;
      try {
        sha256 = String(await hashAudio(resolved.absPath)).toLowerCase();
      } catch (error) {
        if (logger && typeof logger.warn === 'function') logger.warn('Audio hash failed.', { error: error.message });
        return apiError(res, 500, 'audio_unreadable', 'The audio could not be read.');
      }
      if (typeof resolved.sha256 === 'string' && resolved.sha256.toLowerCase() !== sha256) {
        emitAudit(event, req, { ...details, outcome: 'rejected_sidecar_conflict' });
        return apiError(res, 409, 'sidecar_conflict', 'The audio changed since its peaks sidecar was generated; reload and retry.');
      }
      const store = stores.forDestination(destinationOf(template));
      const audio = audioFields(context, sha256);
      const supersedesId = body.supersedesRecord && typeof body.supersedesRecord.id === 'string' ? body.supersedesRecord.id : null;

      const outcome = await store.withSaveLock(sha256, template.templateId, async () => {
        await store.assertCanWrite({ sha256, templateId: template.templateId, supersedesId });
        const verdict = constraintCheck(context, resolved.sampleRate, resolved.frames);
        if (!verdict.ok) throw validationFailure(verdict.errors, 'Marker constraints failed.');
        const record = store.buildRecord(recordInput(req, context, audio, { recordId: store.newRecordId() }));
        if (!request) return { saved: await store.persistRecord(record, { lockHeld: true }), receipt: null };
        const result = await project(projectionArgs(context, record, 'live'));
        // From here the record is always written (design §4.1 step 7).
        const receipt = isPlainObject(result) ? result : { mode: 'live', status: 'uncertain' };
        try {
          return { saved: await store.persistRecord({ ...record, projection: receipt }, { lockHeld: true, skipChecks: true }), receipt };
        } catch (error) {
          const failure = new Error('Record write failed after projection.');
          failure.code = 'RECORD_WRITE_FAILED';
          failure.cause = error;
          failure.recordId = record.recordId;
          failure.projection = receipt;
          throw failure;
        }
      });
      emitAudit(event, req, { ...details, recordId: outcome.saved.recordId, outcome: 'accepted' });
      if (outcome.receipt) {
        emitAudit('markers.projection.apply', req, {
          ...details, recordId: outcome.saved.recordId, projectionId: request.id, outcome: outcome.receipt.status || 'applied',
        });
      }
      const targetSha256After = targetShaAfter(outcome.receipt);
      return res.status(201).json({ ok: true, record: outcome.saved, ...(targetSha256After ? { targetSha256After } : {}) });
    } catch (error) {
      if (!sendError(req, res, error, event, details)) internalError(req, res, error, event);
    }
  });

  // ---- preview -------------------------------------------------------------

  router.post('/api/markers/preview', async (req, res) => {
    const event = 'markers.projection.preview';
    let details = { templateId: null };
    try {
      const context = await prepare(req, res, event, true);
      if (!context) return;
      const { body, template, resolved } = context;
      details = { templateId: template.templateId };
      const request = context.projectionRequest;
      const constraints = constraintCheck(context, resolved.sampleRate, resolved.frames);
      let projection = null;
      if (request && constraints.ok) {
        const store = stores.forDestination(destinationOf(template));
        let supersedesRecord = body.supersedesRecord === undefined ? null : body.supersedesRecord;
        if (!supersedesRecord) {
          const latest = await store.latestFor(resolved.sha256, template.templateId);
          if (latest) supersedesRecord = { resourceKind: 'marker-record', id: latest.recordId };
        }
        const record = store.buildRecord(recordInput(req, context, audioFields(context, resolved.sha256), {
          recordId: store.newRecordId(), supersedesRecord,
        }));
        projection = await project(projectionArgs(context, record, 'preview'));
        emitAudit(event, req, { ...details, projectionId: request.id, outcome: 'accepted' });
      }
      return res.json({ ok: true, constraints, projection: projection === undefined ? null : projection });
    } catch (error) {
      if (!sendError(req, res, error, event, details)) internalError(req, res, error, event);
    }
  });

  return router;
}

module.exports = { createMarkerRecordRouter, summarizeRecord };
