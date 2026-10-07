'use strict';

const { apiError } = require('../api-error');
const { isMarkerTemplateId } = require('./template-schema');

const MAX_PATH_LENGTH = 1024;

function queryString(req, name) {
  const value = req.query ? req.query[name] : undefined;
  return typeof value === 'string' ? value : null;
}

/**
 * GET /api/markers/context?repo&path&template (design §3.1, §5).
 *
 * @param {import('express').Application|import('express').Router} app
 * @param {object} deps
 * @param {{resolveContext: Function}} deps.resolver from createSourceResolver
 * @param {{get: (templateId: string) => Promise<object|null>}} deps.templateStore
 * @param {(req: object, repo: string, relPath: string) => (boolean|Promise<boolean>)} deps.authorizeRead
 *   `view` permission on the audio path; false -> 403
 * @param {(req: object, repo: string, relPath: string) => Promise<{sha256: string, basename: string, sampleRate: number, frames?: number}|null>} deps.resolveAudio
 *   null -> 404. May throw an error with `status`/`code`, which is passed through.
 * @param {(root: string, relPath: string) => (string|null)} [deps.assetUrlFor]
 *   `/asset` URL when the root is also a served repository, otherwise null
 *   (the image is then omitted with a neutral problem)
 */
function registerMarkerContextRoute(app, { resolver, templateStore, authorizeRead, resolveAudio, assetUrlFor } = {}) {
  if (!resolver || typeof resolver.resolveContext !== 'function') throw new TypeError('resolver.resolveContext is required.');
  if (!templateStore || typeof templateStore.get !== 'function') throw new TypeError('templateStore.get is required.');
  if (typeof authorizeRead !== 'function') throw new TypeError('authorizeRead is required.');
  if (typeof resolveAudio !== 'function') throw new TypeError('resolveAudio is required.');

  app.get('/api/markers/context', async (req, res, next) => {
    try {
      const repo = queryString(req, 'repo');
      const relPath = queryString(req, 'path');
      const templateId = queryString(req, 'template');
      if (!repo || !relPath || !templateId || relPath.length > MAX_PATH_LENGTH) {
        return apiError(res, 400, 'invalid_request', 'repo, path and template are required.');
      }
      if (!await authorizeRead(req, repo, relPath)) {
        return apiError(res, 403, 'forbidden', 'This path cannot be read by this caller.');
      }
      const template = isMarkerTemplateId(templateId) ? await templateStore.get(templateId) : null;
      if (!template) return apiError(res, 404, 'not_found', 'Marker template not found.');

      let audio;
      try {
        audio = await resolveAudio(req, repo, relPath);
      } catch (error) {
        if (error && Number.isInteger(error.status)) return apiError(res, error.status, error.code, error.message);
        throw error;
      }
      if (!audio) return apiError(res, 404, 'not_found', 'Audio file not found.');

      let context;
      try {
        context = await resolver.resolveContext({ template, audio });
      } catch (error) {
        if (error && error.status === 409) {
          return apiError(res, 409, error.code || 'ambiguous_target', 'More than one target file matches this audio file.');
        }
        throw error;
      }

      const problems = context.problems.slice();
      let image = null;
      if (context.image) {
        const url = typeof assetUrlFor === 'function' ? assetUrlFor(context.image.root, context.image.relPath) : null;
        if (url) image = { url, plot: context.image.plot };
        else problems.push({ sourceId: 'image', message: 'the image is not available to the viewer' });
      }
      const target = context.target
        ? { path: context.target.relPath, sha256: context.target.sha256, mtimeMs: context.target.mtimeMs }
        : null;
      return res.json({
        ok: true,
        template: { templateId: template.templateId, revision: template.revision, unit: template.unit },
        target,
        targetSha256: context.targetSha256,
        sources: context.sources,
        reads: context.reads,
        targetValues: context.targetValues,
        image,
        details: context.details || [],
        documents: context.documents || [],
        projections: context.projections,
        problems,
      });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerMarkerContextRoute };
