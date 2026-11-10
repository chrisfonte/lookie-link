'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRivendellProjection } = require('../lib/markers/projections/rivendell');
const { createProjectionRunner } = require('../lib/markers/projections');

const MAP = {
  cut: ['START_POINT', 'END_POINT'],
  talk: ['TALK_START_POINT', 'TALK_END_POINT'],
  segue: ['SEGUE_START_POINT', 'SEGUE_END_POINT'],
  fade_up: 'FADEUP_POINT',
  fade_down: 'FADEDOWN_POINT',
};
const PROJECTION = { id: 'rivendell-cut', kind: 'rivendell', map: MAP };
const AUDIO = { sha256: 'a'.repeat(64), sampleRate: 48000 };

function region(type, startSample, endSample) {
  return { id: type, type, kind: 'region', startSample, endSample };
}

function point(type, sample) {
  return { id: type, type, kind: 'point', sample };
}

async function preview(markers, projection = PROJECTION) {
  return createRivendellProjection().run({ projection, record: { markers }, audio: AUDIO, mode: 'preview' });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a ProjectionError');
}

test('preview converts samples to ms and sends pairs together, -1 for unset', async () => {
  const result = await preview([region('cut', 0, 480000), region('talk', 0, 0), point('fade_up', 48000)]);
  assert.equal(result.kind, 'rivendell');
  assert.equal(result.mode, 'preview');
  assert.deepEqual(result.fields, {
    START_POINT: 0,
    END_POINT: 10000,
    TALK_START_POINT: 0, // zero-length regions are allowed
    TALK_END_POINT: 0,
    SEGUE_START_POINT: -1,
    SEGUE_END_POINT: -1,
    FADEUP_POINT: 1000,
    FADEDOWN_POINT: -1,
  });
});

test('ms values are rounded', async () => {
  const result = await preview([region('cut', 48001, 96047)]);
  assert.equal(result.fields.START_POINT, 1000);
  assert.equal(result.fields.END_POINT, 2001);
});

test('pair and ordering rules', async () => {
  assert.match((await rejection(preview([region('cut', 480000, 48000)]))).message, /start <= end/);
  assert.match((await rejection(preview([region('cut', 0, 48000), region('talk', 0, 96000)]))).message, /exceeds the cut END_POINT/);
  assert.match((await rejection(preview([point('fade_up', 96000), point('fade_down', 48000)]))).message, /FADEUP_POINT must not be after FADEDOWN_POINT/);
  assert.match((await rejection(preview([point('cut', 100)]))).message, /needs a region/);
  assert.match((await rejection(preview([region('fade_up', 1, 2)]))).message, /needs a point/);
});

test('the map is validated against the known field names and pair shape', async () => {
  const bad = (map) => ({ ...PROJECTION, map });
  assert.match((await rejection(preview([], bad({ cut: ['START_POINT', 'NOPE'] })))).message, /unknown Rivendell field/);
  assert.match((await rejection(preview([], bad({ cut: ['START_POINT'] })))).message, /exactly two/);
  assert.equal((await rejection(preview([], { id: 'x', kind: 'rivendell' }))).status, 422);
});

test('live is an honest 501 not_implemented', async () => {
  const error = await rejection(createRivendellProjection().run({ projection: PROJECTION, record: { markers: [] }, audio: AUDIO, mode: 'live' }));
  assert.equal(error.status, 501);
  assert.equal(error.code, 'not_implemented');
  assert.match(error.message, /needs a live Rivendell adapter/);
});

test('the dispatcher routes a rivendell projection by id', async () => {
  const runner = createProjectionRunner({ rivendell: createRivendellProjection() });
  const template = { templateId: 't', projections: [PROJECTION] };
  const result = await runner.project({ template, projectionId: 'rivendell-cut', record: { markers: [region('cut', 0, 48000)] }, audio: AUDIO, mode: 'preview' });
  assert.equal(result.fields.END_POINT, 1000);
  const live = await rejection(runner.project({ template, projectionId: 'rivendell-cut', record: { markers: [] }, audio: AUDIO, mode: 'live' }));
  assert.equal(live.status, 501);
});
