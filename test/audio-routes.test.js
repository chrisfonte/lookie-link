'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

const { registerAudioRoutes } = require('../lib/audio/routes');
const { createPeaksService } = require('../lib/audio/peaks');
const { apiError } = require('../lib/api-error');
const { buildHref: buildViewHref, buildAssetHref } = require('../lib/path-utils');

const FFMPEG = '/usr/bin/ffmpeg';
const FFPROBE = '/usr/bin/ffprobe';

function toolsAvailable() {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_TOOLS = toolsAvailable();
const skip = HAVE_TOOLS ? false : 'ffmpeg/ffprobe not available';

let workDir;
let audioDir;
let cacheDir;
let server;
let base;

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-routes-test-'));
  audioDir = path.join(workDir, 'audio');
  cacheDir = path.join(workDir, 'cache');
  await fs.mkdir(audioDir);
  if (!HAVE_TOOLS) return;

  execFileSync(FFMPEG, [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,1\\,1.5)\\,0.5*sin(2*PI*440*t)\\,0)|0:s=48000:d=2',
    '-c:a', 'pcm_s16le', path.join(audioDir, 'burst.wav'),
  ]);
  await fs.mkdir(path.join(audioDir, 'sub dir'));
  await fs.copyFile(path.join(audioDir, 'burst.wav'), path.join(audioDir, 'sub dir', 'copy #1.wav'));
  await fs.writeFile(path.join(audioDir, 'broken.wav'), 'definitely not audio');

  const app = express();
  const peaksService = createPeaksService({
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, blockSize: 1152, peakMode: 'max-abs', cachePath: cacheDir,
  });
  registerAudioRoutes(app, {
    resolveAudioFile: (req, repo, relPath) => {
      if (repo !== 'station-audio') {
        return { ok: false, status: 404, code: 'repo_not_found', message: 'Unknown repository.' };
      }
      if (relPath === 'denied.wav') {
        return { ok: false, status: 403, code: 'forbidden', message: 'No access.' };
      }
      if (relPath === 'missing.wav') {
        return { ok: false, status: 404, code: 'not_found', message: 'File not found.' };
      }
      const absPath = path.join(audioDir, ...relPath.split('/'));
      return { ok: true, absPath, extension: '.wav', mimeType: 'audio/wav' };
    },
    peaksCandidates: (repo, relPath, absPath) => [path.dirname(absPath), cacheDir],
    peaksService,
    apiError,
    buildViewHref,
    buildAssetHref,
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

test('registerAudioRoutes registers exactly the two audio routes', { skip }, () => {
  const app = express();
  registerAudioRoutes(app, {});
  const routes = app._router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.deepEqual(routes.sort(), ['/api/audio/:repo/*', '/api/peaks/:repo/*']);
});

test('GET /api/audio returns the info shape and no absolute path', { skip }, async () => {
  const res = await fetch(`${base}/api/audio/station-audio/burst.wav`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), [
    'assetUrl', 'blockSize', 'blocks', 'channels', 'durationSeconds', 'frames', 'infoUrl', 'limits', 'ok',
    'path', 'peakMode', 'peaksUrl', 'repo', 'sampleRate', 'sha256', 'sidecar', 'viewUrl',
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.repo, 'station-audio');
  assert.equal(body.path, 'burst.wav');
  assert.equal(body.viewUrl, '/view/station-audio/burst.wav');
  assert.equal(body.assetUrl, '/asset/station-audio/burst.wav');
  assert.equal(body.peaksUrl, '/api/peaks/station-audio/burst.wav');
  assert.equal(body.infoUrl, '/api/audio/station-audio/burst.wav');
  assert.equal(body.sampleRate, 48000);
  assert.equal(body.channels, 2);
  assert.equal(body.frames, 96000);
  assert.equal(body.durationSeconds, 2);
  assert.deepEqual(body.limits, { blockSize: 1152 });
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(body.blockSize, 1152);
  assert.equal(body.blocks, 84);
  assert.equal(body.peakMode, 'max-abs');
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(body.sidecar, { location: 'beside' });
  assert.ok(!text.includes(workDir), 'no absolute path in the response');
  // sidecars landed beside the audio
  const names = await fs.readdir(audioDir);
  assert.ok(names.includes('burst.wav.peaks') && names.includes('burst.wav.peaks.json'));
});

test('GET /api/audio encodes URLs for names with spaces and a hash', { skip }, async () => {
  const res = await fetch(`${base}/api/audio/station-audio/${encodeURIComponent('sub dir')}/${encodeURIComponent('copy #1.wav')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, 'sub dir/copy #1.wav');
  assert.equal(body.peaksUrl, '/api/peaks/station-audio/sub%20dir/copy%20%231.wav');
  assert.equal(body.infoUrl, '/api/audio/station-audio/sub%20dir/copy%20%231.wav');
  const peaks = await fetch(`${base}${body.peaksUrl}`);
  assert.equal(peaks.status, 200);
});

test('GET /api/peaks streams the binary with X-Peaks headers', { skip }, async () => {
  const res = await fetch(`${base}/api/peaks/station-audio/burst.wav`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const info = await (await fetch(`${base}/api/audio/station-audio/burst.wav`)).json();
  assert.equal(res.headers.get('etag'), `W/"${info.sha256}"`);
  assert.equal(res.headers.get('x-peaks-sample-rate'), '48000');
  assert.equal(res.headers.get('x-peaks-channels'), '2');
  assert.equal(res.headers.get('x-peaks-block-size'), '1152');
  assert.equal(res.headers.get('x-peaks-frames'), '96000');
  assert.equal(res.headers.get('x-peaks-blocks'), '84');
  assert.equal(res.headers.get('x-peaks-peak-mode'), 'max-abs');
  assert.equal(res.headers.get('x-peaks-source-sha256'), info.sha256);
  const data = Buffer.from(await res.arrayBuffer());
  assert.equal(data.length, 84 * 2 * 2);
  assert.equal(res.headers.get('content-length'), String(data.length));
  // right channel silent, left channel carries the burst
  for (let b = 0; b < 84; b += 1) assert.equal(data.readUInt16LE((b * 2 + 1) * 2), 0);
  assert.ok(data.readUInt16LE(50 * 2 * 2) > 16000);
  assert.equal(data.readUInt16LE(10 * 2 * 2), 0);
});

test('GET /api/peaks honours If-None-Match with 304', { skip }, async () => {
  const first = await fetch(`${base}/api/peaks/station-audio/burst.wav`);
  const etag = first.headers.get('etag');
  await first.arrayBuffer();
  const res = await fetch(`${base}/api/peaks/station-audio/burst.wav`, { headers: { 'If-None-Match': etag } });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('GET /api/peaks?header=1 returns the JSON header', { skip }, async () => {
  const res = await fetch(`${base}/api/peaks/station-audio/burst.wav?header=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const header = await res.json();
  assert.equal(header.version, 1);
  assert.equal(header.format, 'rivendell-levl-u16le');
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.channels, 2);
  assert.equal(header.blocks, 84);
  assert.equal(header.valueMax, 32767);
  assert.match(header.source.sha256, /^[0-9a-f]{64}$/);
  const onDisk = JSON.parse(await fs.readFile(path.join(audioDir, 'burst.wav.peaks.json'), 'utf8'));
  assert.deepEqual(header, onDisk);
});

test('deps failures pass through as API errors on both routes', { skip }, async () => {
  for (const kind of ['audio', 'peaks']) {
    const missing = await fetch(`${base}/api/${kind}/station-audio/missing.wav`);
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.deepEqual(body, { ok: false, error: { code: 'not_found', message: 'File not found.' } });

    const denied = await fetch(`${base}/api/${kind}/station-audio/denied.wav`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'forbidden');

    const repo = await fetch(`${base}/api/${kind}/elsewhere/burst.wav`);
    assert.equal(repo.status, 404);
    assert.equal((await repo.json()).error.code, 'repo_not_found');
  }
});

test('a file that cannot be decoded gives 503 peaks_unavailable without a path', { skip }, async () => {
  for (const kind of ['audio', 'peaks']) {
    const res = await fetch(`${base}/api/${kind}/station-audio/broken.wav`);
    assert.equal(res.status, 503);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'peaks_unavailable');
    assert.ok(!text.includes(workDir), 'message names no path');
    assert.ok(!text.includes('broken.wav'), 'message names no file');
  }
});

test('a missing ffmpeg gives 503 peaks_unavailable', { skip }, async () => {
  const app = express();
  registerAudioRoutes(app, {
    resolveAudioFile: () => ({ ok: true, absPath: path.join(audioDir, 'sub dir', 'copy #1.wav'), extension: '.wav', mimeType: 'audio/wav' }),
    peaksCandidates: () => [path.join(workDir, 'no-ffmpeg-sidecars')],
    peaksService: createPeaksService({ ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe' }),
    apiError,
    buildViewHref,
    buildAssetHref,
  });
  const local = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${local.address().port}/api/audio/r/x.wav`;
    const res = await fetch(url);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(JSON.parse(text).error.code, 'peaks_unavailable');
    assert.ok(!text.includes('ffmpeg') && !text.includes(workDir));
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

async function withApp(deps, fn) {
  const app = express();
  registerAudioRoutes(app, { apiError, buildViewHref, buildAssetHref, ...deps });
  const local = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${local.address().port}`);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
}

test('durationSeconds is rounded to 6 decimals', async () => {
  const header = {
    sampleRate: 44100, channels: 1, frames: 100000, blockSize: 1152, blocks: 87, peakMode: 'max-abs',
    source: { sha256: 'a'.repeat(64) },
  };
  await withApp({
    resolveAudioFile: () => ({ ok: true, absPath: '/path/to/share/x.wav', extension: '.wav', mimeType: 'audio/wav' }),
    peaksCandidates: () => [],
    peaksService: { ensurePeaks: async () => ({ header, kind: 'cache', peaksPath: '/unused' }) },
  }, async (url) => {
    const body = await (await fetch(`${url}/api/audio/r/x.wav`)).json();
    assert.equal(body.durationSeconds, 2.267574); // 100000 / 44100 = 2.2675736961...
    assert.equal(body.sidecar.location, 'cache');
  });
});

test('a source over the size cap gives 413 audio_too_large without a path', { skip }, async () => {
  const capped = createPeaksService({
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, cachePath: cacheDir, maxAudioBytes: 10,
  });
  await withApp({
    resolveAudioFile: () => ({
      ok: true, absPath: path.join(audioDir, 'sub dir', 'copy #1.wav'), extension: '.wav', mimeType: 'audio/wav',
    }),
    peaksCandidates: () => [{ dir: path.join(workDir, 'unwritten'), readOnly: true }],
    peaksService: capped,
  }, async (url) => {
    for (const kind of ['audio', 'peaks']) {
      const res = await fetch(`${url}/api/${kind}/r/x.wav`);
      assert.equal(res.status, 413);
      const text = await res.text();
      const body = JSON.parse(text);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'audio_too_large');
      assert.ok(!text.includes(workDir) && !text.includes('copy'), 'message names no path');
    }
  });
});

test('a timed-out generation gives 503 peaks_unavailable', async () => {
  const { PeaksError } = require('../lib/audio/peaks');
  await withApp({
    resolveAudioFile: () => ({ ok: true, absPath: '/path/to/share/x.wav', extension: '.wav', mimeType: 'audio/wav' }),
    peaksCandidates: () => [],
    peaksService: { ensurePeaks: async () => { throw new PeaksError('audio decode timed out'); } },
  }, async (url) => {
    const res = await fetch(`${url}/api/audio/r/x.wav`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'peaks_unavailable');
  });
});
