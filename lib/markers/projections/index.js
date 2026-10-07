'use strict';

// Projection dispatcher: `project()` is the hook the record router calls (see
// routes-records.js ProjectionHook). Run it inside the record store's save
// lock for (audio.sha256, templateId).

const { ProjectionError } = require('./errors');
const { createYamlPointersProjection } = require('./yaml-pointers');
const { createRivendellProjection } = require('./rivendell');

/**
 * @param {{yamlPointers?: {run: Function}, rivendell?: {run: Function}}} handlers
 * @returns {{project: Function}}
 */
function createProjectionRunner({ yamlPointers, rivendell } = {}) {
  const handlers = { 'yaml-pointers': yamlPointers, rivendell };

  /**
   * @param {object} args `{ template, projectionId, ...run arguments }` (see yaml-pointers run())
   */
  async function project(args) {
    const { template, projectionId } = args || {};
    const projection = template && Array.isArray(template.projections)
      ? template.projections.find((entry) => entry.id === projectionId) : null;
    if (!projection) throw new ProjectionError(404, 'not_found', 'The template does not declare that projection.');
    const handler = handlers[projection.kind];
    if (!handler || typeof handler.run !== 'function') {
      throw new ProjectionError(409, 'feature_disabled', `The ${projection.kind} projection is not configured on this instance.`);
    }
    return handler.run({ ...args, projection });
  }

  return { project };
}

module.exports = { createProjectionRunner, createYamlPointersProjection, createRivendellProjection, ProjectionError };
