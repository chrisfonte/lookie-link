'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

const ORIGIN = 'http://markers.example.test';
const silent = { info() {}, warn() {}, error() {}, log() {} };

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-markers-int-'));
  const audio = path.join(root, 'audio');
  fs.mkdirSync(audio);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-ar', '8000', '-ac', '1', path.join(audio, 'tone.wav')]);
  return { root, audio };
}

function markersConfig(root) {
  return {
    enabled: true,
    templatesPaths: [path.join(root, 'templates')],
    destinations: { default: path.join(root, 'records') },
    roots: {},
    peaksCachePath: path.join(root, 'peaks'),
    blockSize: 64,
    publicOrigins: [ORIGIN],
    operatorName: 'Test Operator',
  };
}

async function start(root, audio, markers) {
  const app = createApp({
    mappings: {},
    accessConfig: {},
    apiKeyStore: null,
    grantStore: null,
    managedRepoStore: null,
    publishStore: null,
    formsConfig: { enabled: false },
    audioRoots: { 'station-audio': { path: audio, label: 'Station audio' } },
    markersConfig: markers ? markersConfig(root) : { enabled: false },
    logger: silent,
  });
  await app.locals.markersReady;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { app, server, base: `http://127.0.0.1:${server.address().port}` };
}

function bootOf(html) {
  const match = /<script id="audio-markers-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'boot blob present');
  return JSON.parse(match[1]);
}

const skip = hasFfmpeg() ? false : 'ffmpeg and ffprobe are not installed';

test('markers on: audio info, peaks, viewer page, templates, records and context', { skip }, async (t) => {
  const { root, audio } = stage();
  const { server, base } = await start(root, audio, true);
  t.after(() => new Promise((resolve) => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); resolve(); })));

  const info = await (await fetch(`${base}/api/audio/station-audio/tone.wav`)).json();
  assert.equal(info.ok, true);
  assert.equal(info.sampleRate, 8000);
  assert.equal(info.frames, 4000);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(info).includes(root), false, 'no absolute paths in the info response');

  const peaks = await fetch(`${base}/api/peaks/station-audio/tone.wav`);
  assert.equal(peaks.status, 200);
  assert.match(peaks.headers.get('content-type'), /application\/octet-stream/);
  assert.equal(peaks.headers.get('x-peaks-sample-rate'), '8000');
  assert.ok((await peaks.arrayBuffer()).byteLength > 0);

  const page = await fetch(`${base}/view/station-audio/tone.wav?template=freeform&t=0.1`);
  assert.equal(page.status, 200);
  const cookie = /lookie_markers_context=[^;]+/.exec(page.headers.get('set-cookie') || '');
  assert.ok(cookie, 'context cookie issued');
  const boot = bootOf(await page.text());
  assert.ok(boot.csrfToken && boot.csrfToken.length > 20);
  assert.equal(boot.infoUrl, '/api/audio/station-audio/tone.wav');
  assert.equal(boot.peaksUrl, '/api/peaks/station-audio/tone.wav');
  assert.equal(boot.templatesUrl, '/api/markers/templates');
  assert.equal(boot.recordsUrl, '/api/markers/records');
  assert.equal(boot.templateId, 'freeform');
  assert.equal(boot.startSeconds, 0.1);
  assert.equal(boot.operatorName, 'Test Operator');

  const templates = await (await fetch(`${base}/api/markers/templates`)).json();
  assert.equal(templates.ok, true);
  const ids = JSON.stringify(templates);
  assert.ok(ids.includes('freeform') && ids.includes('song-structure'), 'bundled templates are listed');

  const create = (body, headers = {}) => fetch(`${base}/api/markers/records`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', origin: ORIGIN, cookie: cookie[0], 'x-csrf-token': boot.csrfToken, ...headers,
    },
    body: JSON.stringify(body),
  });
  const body = {
    audio: { repo: 'station-audio', path: 'tone.wav' },
    templateId: 'freeform',
    templateRevision: 1,
    markers: [{ id: 'm1', type: 'note', kind: 'point', sample: 100 }],
  };
  const noToken = await create(body, { 'x-csrf-token': 'wrong' });
  assert.equal(noToken.status, 403);

  const first = await create(body);
  assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
  const saved = (await first.json()).record;
  assert.equal(saved.audio.sha256, info.sha256);
  assert.equal(saved.actor.name, 'Test Operator');

  const second = await create(body);
  assert.equal(second.status, 409);
  const conflict = await second.json();
  assert.equal(conflict.error.code, 'revision_conflict');
  assert.equal(conflict.error.currentRecordId || conflict.currentRecordId, saved.recordId);

  const list = await (await fetch(`${base}/api/markers/records?repo=station-audio&path=tone.wav`)).json();
  assert.equal(list.ok, true);
  assert.ok(JSON.stringify(list).includes(saved.recordId));

  const context = await (await fetch(`${base}/api/markers/context?repo=station-audio&path=tone.wav&template=song-structure`)).json();
  assert.equal(context.ok, true);
  assert.deepEqual(context.sources, []);
  assert.equal(context.target, null);
});

test('markers off: marker routes are absent and the viewer still renders the player', { skip }, async (t) => {
  const { root, audio } = stage();
  const { app, server, base } = await start(root, audio, false);
  t.after(() => new Promise((resolve) => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); resolve(); })));

  for (const route of ['/api/markers/templates', '/api/markers/records?repo=station-audio&path=tone.wav', '/api/markers/context?repo=station-audio&path=tone.wav&template=freeform']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  const post = await fetch(`${base}/api/markers/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 404);

  // Audio info and peaks stay available without markers.
  assert.equal((await fetch(`${base}/api/audio/station-audio/tone.wav`)).status, 200);
  assert.equal((await fetch(`${base}/api/peaks/station-audio/tone.wav`)).status, 200);

  const page = await fetch(`${base}/view/station-audio/tone.wav`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<audio'), 'player markup present');
  const boot = bootOf(html);
  assert.equal(boot.csrfToken, null);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.ok(app.locals.markersReady);
});

test('audio routes refuse non-audio files and unknown repositories', { skip }, async (t) => {
  const { root, audio } = stage();
  fs.writeFileSync(path.join(audio, 'notes.txt'), 'x');
  const { server, base } = await start(root, audio, false);
  t.after(() => new Promise((resolve) => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); resolve(); })));
  const notAudio = await fetch(`${base}/api/audio/station-audio/notes.txt`);
  assert.equal(notAudio.status, 415);
  assert.equal((await notAudio.json()).error.code, 'unsupported_media_type');
  assert.equal((await fetch(`${base}/api/audio/nowhere/tone.wav`)).status, 404);
  assert.equal((await fetch(`${base}/api/audio/station-audio/missing.wav`)).status, 404);
  assert.equal((await fetch(`${base}/api/peaks/station-audio/..%2F..%2Fetc%2Fpasswd.wav`)).status >= 400, true);
});
