'use strict';

// `rivendell` projection stub (design §4.2): validates the field map, converts
// a record to the millisecond field set an EditCut call would carry, and
// refuses live mode honestly. Nothing here talks to a Rivendell instance.

const { ProjectionError } = require('./errors');

const FIELDS = Object.freeze([
  'START_POINT', 'END_POINT', 'SEGUE_START_POINT', 'SEGUE_END_POINT', 'HOOK_START_POINT', 'HOOK_END_POINT',
  'TALK_START_POINT', 'TALK_END_POINT', 'FADEUP_POINT', 'FADEDOWN_POINT',
]);
const UNSET = -1;

const NOT_IMPLEMENTED = 'The Rivendell projection needs a live Rivendell adapter (cart and cut number, rdxport host, '
  + 'a user with Edit Audio, the cut\'s current points). Not available on this instance.';

function problem(message, details) {
  return new ProjectionError(422, 'validation_error', message, details);
}

function toMs(sample, sampleRate) {
  return Math.round((sample / sampleRate) * 1000);
}

/**
 * @returns {{ run: Function, kind: 'rivendell' }}
 */
function createRivendellProjection() {
  /**
   * Preview: `{ kind, mode, status: 'preview', fields }` with every mapped field present
   * (-1 = unset). Live: 501 not_implemented.
   */
  async function run(args) {
    const projection = args.projection
      || (args.template && Array.isArray(args.template.projections) ? args.template.projections.find((entry) => entry.id === args.projectionId) : null);
    if (!projection || projection.kind !== 'rivendell' || !projection.map || typeof projection.map !== 'object') {
      throw problem('The projection is not a rivendell projection with a map.');
    }
    if (args.mode === 'live') throw new ProjectionError(501, 'not_implemented', NOT_IMPLEMENTED);
    if (args.mode !== 'preview') throw new ProjectionError(400, 'invalid_request', 'mode must be preview or live.');

    const record = args.record || {};
    const sampleRate = Number((args.audio || record.audio || {}).sampleRate);
    if (!(sampleRate > 0)) throw problem('The audio sample rate is needed to convert to milliseconds.');
    const markers = Array.isArray(record.markers) ? record.markers : [];
    const fields = {};

    for (const [markerId, mapped] of Object.entries(projection.map)) {
      const names = Array.isArray(mapped) ? mapped : [mapped];
      if (Array.isArray(mapped) && mapped.length !== 2) throw problem(`map.${markerId}: a pair must hold exactly two fields`);
      for (const name of names) if (!FIELDS.includes(name)) throw problem(`map.${markerId}: unknown Rivendell field "${String(name)}"`);
      const instances = markers.filter((marker) => marker.type === markerId);
      if (instances.length > 1) throw problem(`map.${markerId}: the marker has several instances`);
      const marker = instances[0];
      if (!marker) { // pairs go together; -1 clears/leaves unset
        for (const name of names) fields[name] = UNSET;
        continue;
      }
      if (Array.isArray(mapped)) {
        if (marker.kind !== 'region') throw problem(`map.${markerId}: a pair needs a region marker`);
        const start = toMs(marker.startSample, sampleRate);
        const end = toMs(marker.endSample, sampleRate);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
          throw problem(`map.${markerId}: the region must have start <= end`);
        }
        fields[mapped[0]] = start; // zero-length regions are allowed
        fields[mapped[1]] = end;
      } else {
        if (marker.kind !== 'point') throw problem(`map.${markerId}: a single field needs a point marker`);
        const ms = toMs(marker.sample, sampleRate);
        if (!Number.isInteger(ms) || ms < 0) throw problem(`map.${markerId}: the point must be a non-negative position`);
        fields[mapped] = ms;
      }
    }

    if (fields.FADEUP_POINT >= 0 && fields.FADEDOWN_POINT >= 0 && fields.FADEUP_POINT > fields.FADEDOWN_POINT) {
      throw problem('FADEUP_POINT must not be after FADEDOWN_POINT');
    }
    if (fields.END_POINT >= 0) {
      for (const [name, value] of Object.entries(fields)) {
        if (name !== 'START_POINT' && name !== 'END_POINT' && value > fields.END_POINT) {
          throw problem(`${name} exceeds the cut END_POINT`);
        }
      }
    }
    return { kind: 'rivendell', projectionId: projection.id, mode: 'preview', status: 'preview', fields };
  }

  return { kind: 'rivendell', run };
}

module.exports = { createRivendellProjection, RIVENDELL_FIELDS: FIELDS, NOT_IMPLEMENTED_MESSAGE: NOT_IMPLEMENTED };
