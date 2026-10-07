'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createSourceResolver } = require('../lib/markers/sources');
const { registerMarkerContextRoute } = require('../lib/markers/routes-context');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'markers', 'root');
const AUDIO = {
  'station/alpha.wav': { sha256: 'a'.repeat(64), basename: 'alpha.wav', sampleRate: 48000, frames: 288000 },
  'station/nobody.wav': { sha256: 'c'.repeat(64), basename: 'nobody.wav', sampleRate: 48000, frames: 1000 },
};

function fullTemplate() {
  return {
    templateId: 'sample',
    revision: 3,
    unit: 'ms',
    source: 'stored',
    writable: true,
    markers: [
      { id: 'first', label: 'First', kind: 'point', color: '#112233', read: { source: 'target', pointer: '/analysis/first_event_sample' } },
    ],
    sources: [
      {
        id: 'target', kind: 'yaml', root: 'main',
        locate: { glob: 'pieces/*/record.yaml', match: { pointer: '/asset/digest', equals: '$audio.sha256' } },
      },
      {
        id: 'hits', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=measure-report]/path' },
        select: { pointer: '/hits/items[*]/at_sample' }, as: { kind: 'point', label: 'Hit' },
      },
    ],
    image: { source: 'target', pathFrom: '/evidence[id=plot-image]/path', plot: { left: 142, right: 1942, top: 64, bottom: 664 } },
    projections: [{ id: 'write-back', kind: 'rivendell', map: { first: 'START_POINT' } }],
  };
}

async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-context-routes-'));
  const root = path.join(dir, 'root');
  await fs.cp(FIXTURE_ROOT, root, { recursive: true });
  const templates = new Map([
    ['sample', fullTemplate()],
    ['plain', { templateId: 'plain', revision: 1, unit: 'ms', markers: [] }],
  ]);
  const state = { allowed: true, calls: [], assetUrl: (rootId, rel) => `/asset/served/${rel}` };
  const deps = {
    resolver: createSourceResolver({ roots: { main: { path: root } } }),
    templateStore: { get: async (id) => templates.get(id) || null },
    authorizeRead: (req, repo, relPath) => { state.calls.push(['authorize', repo, relPath]); return state.allowed; },
    resolveAudio: async (req, repo, relPath) => { state.calls.push(['audio', repo, relPath]); return AUDIO[relPath] || null; },
    assetUrlFor: (rootId, rel) => state.assetUrl(rootId, rel),
    ...overrides,
  };
  const app = express();
  registerMarkerContextRoute(app, deps);
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, boom: error.message }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(query) {
    const response = await fetch(`${base}/api/markers/context?${new URLSearchParams(query)}`);
    return { status: response.status, body: await response.json() };
  }
  return { get, state, dir, root, templates };
}

test('returns the resolved context with root-relative paths and an asset url', async (t) => {
  const { get, state, dir } = await setup(t);
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.template, { templateId: 'sample', revision: 3, unit: 'ms' });
  assert.equal(body.target.path, 'pieces/alpha/record.yaml');
  assert.deepEqual(Object.keys(body.target).sort(), ['mtimeMs', 'path', 'sha256']);
  assert.equal(body.targetSha256, body.target.sha256);
  assert.deepEqual(body.sources.map((source) => source.id), ['hits']);
  assert.deepEqual(body.sources[0].points.map((point) => point.sample), [24000, 177888, 219456]);
  assert.deepEqual(body.reads, { first: 177888 });
  assert.deepEqual(body.targetValues, { first: 177888 });
  assert.deepEqual(body.image, {
    url: '/asset/served/pieces/alpha/measure/plot.png',
    plot: { left: 142, right: 1942, top: 64, bottom: 664 },
  });
  assert.deepEqual(body.projections, [{ id: 'write-back', kind: 'rivendell', label: 'write-back', acceptable: false }]);
  assert.deepEqual(body.problems, []);
  assert.deepEqual(state.calls, [['authorize', 'station', 'station/alpha.wav'], ['audio', 'station', 'station/alpha.wav']]);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(dir) && !text.includes('"main"'), 'no root path or alias in the response');
});

test('assetUrlFor receives the root alias and root-relative path', async (t) => {
  const seen = [];
  const { get } = await setup(t, { assetUrlFor: (root, rel) => { seen.push([root, rel]); return null; } });
  const { body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.deepEqual(seen, [['main', 'pieces/alpha/measure/plot.png']]);
  assert.equal(body.image, null);
  assert.deepEqual(body.problems, [{ sourceId: 'image', message: 'the image is not available to the viewer' }]);
});

test('no target is a neutral 200 with a problem', async (t) => {
  const { get } = await setup(t);
  const { status, body } = await get({ repo: 'station', path: 'station/nobody.wav', template: 'sample' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.target, null);
  assert.equal(body.targetSha256, null);
  assert.deepEqual(body.sources, []);
  assert.deepEqual(body.reads, {});
  assert.equal(body.problems[0].sourceId, 'target');
});

test('a template without sources returns empty arrays and still succeeds', async (t) => {
  const { get } = await setup(t);
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'plain' });
  assert.equal(status, 200);
  assert.deepEqual(
    { ...body, template: undefined },
    {
      ok: true, template: undefined, target: null, targetSha256: null, sources: [], reads: {}, targetValues: {},
      image: null, details: [], documents: [], projections: [], problems: [],
    },
  );
});

test('missing or unknown template is 404; malformed ids are 404 not 500', async (t) => {
  const { get } = await setup(t);
  for (const template of ['nope', 'UPPER', '../x']) {
    const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template });
    assert.equal(status, 404, template);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not_found');
  }
});

test('missing query parameters are 400', async (t) => {
  const { get } = await setup(t);
  for (const query of [{ path: 'a', template: 'sample' }, { repo: 'r', template: 'sample' }, { repo: 'r', path: 'a' }, {}]) {
    const { status, body } = await get(query);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  }
});

test('an unauthorized caller gets 403 and nothing is resolved', async (t) => {
  const { get, state } = await setup(t);
  state.allowed = false;
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'forbidden');
  assert.deepEqual(state.calls, [['authorize', 'station', 'station/alpha.wav']]);
});

test('unknown audio is 404; resolveAudio errors with a status pass through', async (t) => {
  const { get } = await setup(t);
  const missing = await get({ repo: 'station', path: 'station/ghost.wav', template: 'sample' });
  assert.equal(missing.status, 404);

  const tooBig = await setup(t, {
    resolveAudio: async () => { throw Object.assign(new Error('Audio is too large.'), { status: 413, code: 'payload_too_large' }); },
  });
  const { status, body } = await tooBig.get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 413);
  assert.equal(body.error.code, 'payload_too_large');
});

test('an ambiguous locator answers 409 ambiguous_target without paths', async (t) => {
  const { get, root, dir } = await setup(t);
  await fs.mkdir(path.join(root, 'pieces/alpha-copy'));
  await fs.copyFile(path.join(root, 'pieces/alpha/record.yaml'), path.join(root, 'pieces/alpha-copy/record.yaml'));
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 409);
  assert.equal(body.error.code, 'ambiguous_target');
  assert.ok(!JSON.stringify(body).includes(dir));
});

test('unexpected resolver failures reach the error handler, not the client as data', async (t) => {
  const { get } = await setup(t, { resolver: { resolveContext: async () => { throw new Error('disk on fire'); } } });
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 500);
  assert.equal(body.boom, 'disk on fire');
});

test('registration requires its dependencies', () => {
  const app = express();
  const ok = {
    resolver: { resolveContext() {} }, templateStore: { get() {} }, authorizeRead() {}, resolveAudio() {},
  };
  assert.throws(() => registerMarkerContextRoute(app, {}), TypeError);
  for (const key of Object.keys(ok)) {
    assert.throws(() => registerMarkerContextRoute(app, { ...ok, [key]: undefined }), TypeError, key);
  }
  assert.doesNotThrow(() => registerMarkerContextRoute(app, ok));
});

test('the response carries details and documents next to the existing fields', async (t) => {
  const { get, root, templates } = await setup(t);
  await fs.writeFile(path.join(root, 'pieces/alpha/notes.md'), 'Short notes.\n');
  await fs.appendFile(path.join(root, 'pieces/alpha/record.yaml'), '  - id: notes\n    path: pieces/alpha/notes.md\n');
  const tpl = fullTemplate();
  tpl.details = [
    { id: 'name', label: 'Name', source: 'target', pointer: '/asset/name' },
    { id: 'kinds', label: 'Kinds', source: 'target', pointer: '/analysis/events[*]/kind', kind: 'list' },
  ];
  tpl.documents = [{ id: 'notes', label: 'Notes', source: 'target', pathFrom: '/evidence[id=notes]/path' }];
  templates.set('sample', tpl);
  const { status, body } = await get({ repo: 'station', path: 'station/alpha.wav', template: 'sample' });
  assert.equal(status, 200);
  assert.deepEqual(body.details, [
    { id: 'name', label: 'Name', kind: 'text', value: 'alpha.wav' },
    { id: 'kinds', label: 'Kinds', kind: 'list', value: ['lead', 'tail', 'broken'] },
  ]);
  assert.deepEqual(body.documents, [{ id: 'notes', label: 'Notes', text: 'Short notes.\n', truncated: false, path: 'pieces/alpha/notes.md' }]);
  assert.ok(!JSON.stringify(body).includes(root));
});
