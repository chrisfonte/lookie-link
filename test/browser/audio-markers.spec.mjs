import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const yaml = require('js-yaml');
const {createApp} = require('../../server.js');

// Audio marker viewer, end to end in headless Chromium. Everything is synthetic:
// ffmpeg writes a click WAV into a temp dir, the projection target is an invented
// record under a temp root, and the guarded YAML CLI and the validator are the test
// doubles under test/fixtures/markers/projection/. Nothing binary is committed.
// Headless Chromium has no sound card: the tap-sync checks (a) play the real tone and
// press at a detected click with latency injected as 0, and (b) assert the arithmetic
// exactly with injected clock values. Perceived (real-ear) timing is a manual measurement.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures', 'markers', 'projection');
const REPO = 'station-audio';
const FILE = 'clicks.wav';
const SAMPLE_RATE = 48000;
const DURATION_S = 6;
const CLICKS_S = [1, 2, 3];
const TAP_TOLERANCE_S = 0.030;

function haveFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], {stdio: 'ignore'});
    execFileSync('ffprobe', ['-version'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function writeClickWav(file) {
  // 5 ms bursts of a 1 kHz tone at 0.8 amplitude at 1.000, 2.000 and 3.000 s; 48 kHz stereo.
  const gate = CLICKS_S.map((t) => `between(t\\,${t}\\,${t + 0.005})`).join('+');
  const expr = `0.8*sin(2*PI*1000*t)*(${gate})`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}|${expr}:s=${SAMPLE_RATE}:d=${DURATION_S}`,
    '-c:a', 'pcm_s16le', file]);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const PROJECTION_TEMPLATE = (sourceRoot) => ({
  contractVersion: 1,
  resourceKind: 'marker-template',
  templateId: 'demo-projection',
  revision: 1,
  title: 'Demo projection',
  unit: 'samples',
  destinationId: 'default',
  groups: [],
  markers: [
    {id: 'start', label: 'Start', kind: 'point', color: '#4fd8e8', read: {source: 'target', pointer: '/result/start_sample'}},
    {id: 'end', label: 'End', kind: 'point', color: '#e1886e', read: {source: 'target', pointer: '/result/end_sample'}},
  ],
  keys: {start: 'f', end: 'e'},
  sources: [
    {id: 'target', kind: 'yaml', root: sourceRoot, locate: {glob: 'pieces/*/record.yaml', match: {pointer: '/asset/sha256', equals: '$audio.sha256'}}},
  ],
  pickers: [],
  projections: [{
    id: 'demo-yaml',
    kind: 'yaml-pointers',
    root: sourceRoot,
    target: 'target',
    validator: 'demo-check',
    write: [
      {marker: 'start', pointer: '/result/start_sample'},
      {marker: 'start', pointer: '/result/windows/0/start_sample'},
      {marker: 'end', pointer: '/result/end_sample'},
    ],
    text: [{pointer: '/result/decision/reason', template: 'Edited by {actor} ({date}): {reason}'}],
    receipts: {dir: '{target.dir}/edits/{audio.basename}', snapshot: 'record-pre-{stamp}.yaml', receipt: 'edit-{stamp}.md'},
    history: {pointer: '/log', append: {record_path: '$snapshot.path', record_sha256: '$snapshot.sha256', reason: 'Edit {date} by {actor}: {reason}'}},
    evidence: {
      pointer: '/proofs',
      append: {id: 'edit-{n}-review', kind: 'review', path: '$receipt.path', sha256: '$receipt.sha256', source_sha256: '$audio.sha256'},
      referenceIn: '/result/verification/proof_ids',
    },
  }],
});

/** A temp world: audio root, marker stores, projection root and a running app. */
async function stage(base) {
  const audioDir = path.join(base, 'audio');
  const templatesDir = path.join(base, 'templates');
  const projectionRoot = path.join(base, 'proj-root');
  await fs.mkdir(audioDir);
  await fs.mkdir(templatesDir);
  await fs.mkdir(path.join(projectionRoot, 'pieces', 'alpha'), {recursive: true});
  await fs.mkdir(path.join(projectionRoot, 'notes'));
  writeClickWav(path.join(audioDir, FILE));
  const audioSha = sha256(await fs.readFile(path.join(audioDir, FILE)));
  const source = (await fs.readFile(path.join(fixtures, 'record.yaml'), 'utf8')).replace(/^( {2}sha256: )0{63}1$/m, `$1${audioSha}`);
  assert.ok(source.includes(audioSha), 'the invented record carries the audio hash');
  const targetPath = path.join(projectionRoot, 'pieces', 'alpha', 'record.yaml');
  await fs.writeFile(targetPath, source);
  await fs.writeFile(path.join(projectionRoot, 'notes', 'first-pass.yaml'), 'earlier pass\n');
  await fs.writeFile(path.join(templatesDir, 'demo-projection.json'), JSON.stringify(PROJECTION_TEMPLATE('demo'), null, 2));
  const cliLog = path.join(base, 'cli.log');
  process.env.FAKE_LOG = cliLog;
  process.env.FAKE_VALIDATOR_LOG = path.join(base, 'validator.log');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    mappings: {},
    accessConfig: {humanDefault: 'full'},
    audioRoots: {[REPO]: {path: audioDir, label: 'Station audio'}},
    formsConfig: {enabled: false},
    markersConfig: {
      enabled: true,
      templatesPaths: [templatesDir],
      destinations: {default: path.join(base, 'records')},
      roots: {demo: {path: projectionRoot, allowProjections: true, requireValidator: true}},
      peaksCachePath: path.join(base, 'peaks'),
      blockSize: 1152,
      yamlToolPath: path.join(fixtures, 'fake-ops-yaml.sh'),
      validators: {'demo-check': [path.join(fixtures, 'fake-validator.sh'), '{candidate}', '{root}']},
      publicOrigins: [origin],
      operatorName: null,
      timezone: 'UTC',
    },
    logger: {info() {}, warn() {}, error() {}, log() {}},
  });
  await app.locals.markersReady;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {origin, server, targetPath, projectionRoot, audioSha, cliLog};
}

const TAP_PROBE = () => {
  // Route a second branch of the viewer's media-element source into an AnalyserNode, and expose
  // a detector that "presses" a key (a keydown dispatched in the page) the moment a click is seen.
  const original = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (element) {
    const source = original.call(this, element);
    const analyser = this.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    window.__tapProbe = {analyser, element};
    return source;
  };
  window.__startClickTapper = (key, target = 3) => {
    const {analyser, element} = window.__tapProbe;
    element.loop = true; // under load the detector can miss a click; let the clicks recur until `target` taps landed
    const buffer = new Float32Array(analyser.fftSize);
    const hits = [];
    window.__hits = hits;
    let armed = true;
    let quietSince = 0;
    const poll = () => {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (const value of buffer) peak = Math.max(peak, Math.abs(value));
      const now = performance.now();
      if (armed && peak > 0.1 && hits.length < target) {
        armed = false;
        hits.push({media: element.currentTime, perf: now});
        document.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}));
        if (hits.length >= target) { element.loop = false; }
      } else if (!armed && peak < 0.01) {
        quietSince = quietSince || now;
        if (now - quietSince > 200) { armed = true; quietSince = 0; }
      } else {
        quietSince = 0;
      }
      if (!element.ended) setTimeout(poll, 2);
    };
    poll();
  };
};

async function openViewer(browser, origin, viewport, query = '', {probe = false} = {}) {
  const context = await browser.newContext({viewport});
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  if (probe) await page.addInitScript(TAP_PROBE);
  const response = await page.goto(`${origin}/view/${REPO}/${FILE}${query}`);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => window.__audioMarkers && window.__audioMarkers.ready, null, {timeout: 30000});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  return {context, page, problems};
}

const markersOf = (page) => page.evaluate(() => window.__audioMarkers.state.markers.map((m) => ({
  id: m.id, type: m.type, kind: m.kind, sample: m.sample, startSample: m.startSample, endSample: m.endSample, label: m.label, origin: m.origin,
})));

async function statusIs(page, pattern) {
  try {
    await page.waitForFunction((source) => new RegExp(source).test(document.querySelector('[data-am="status"]').textContent),
      pattern.source, {timeout: 15000});
  } catch (error) {
    const seen = await page.evaluate(() => ({
      status: document.querySelector('[data-am="status"]').textContent,
      alert: document.querySelector('[data-am="alert"]').textContent,
      checks: document.querySelector('[data-am="checks"]')?.textContent || '',
    }));
    throw new Error(`status never matched ${pattern}: ${JSON.stringify(seen)}`, {cause: error});
  }
}

async function openInspector(page) {
  const toggle = page.locator('[data-am="inspector-toggle"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function dragAcross(page, locator, fromFraction, toFraction) {
  const box = await locator.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromFraction, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((fromFraction + toFraction) / 2), y, {steps: 6});
  await page.mouse.move(box.x + box.width * toFraction, y, {steps: 6});
  await page.mouse.up();
}

async function dragElement(page, locator, deltaX) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX / 2, y, {steps: 6});
  await page.mouse.move(x + deltaX, y, {steps: 6});
  await page.mouse.up();
}

// ---------------------------------------------------------------- scenarios

async function noTemplate(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport);
  assert.equal(await page.evaluate(() => window.__audioMarkers.state.template.templateId), 'freeform');
  const info = await page.evaluate(() => window.__audioMarkers.state.info);
  assert.equal(info.sampleRate, SAMPLE_RATE);
  assert.equal(info.frames, SAMPLE_RATE * DURATION_S);
  assert.equal(await page.locator('canvas[data-am="wave"]').isVisible(), true, 'waveform drawn');

  // press m while playing -> a point
  await page.locator('[data-am="play"]').click();
  await page.waitForFunction(() => window.__audioMarkers.audio.currentTime > 0.4, null, {timeout: 10000});
  await page.keyboard.press('m');
  await page.locator('[data-am="play"]').click();
  let markers = await markersOf(page);
  assert.equal(markers.length, 1, `${label}: m adds one marker`);
  assert.equal(markers[0].kind, 'point');
  assert.ok(markers[0].sample > 0 && markers[0].sample < SAMPLE_RATE * DURATION_S);

  // drag a region in the lane that holds the template's region type (freeform: "span")
  await dragAcross(page, page.locator('[data-lane="__other"]'), 0.45, 0.75);
  markers = await markersOf(page);
  const region = markers.find((m) => m.kind === 'region');
  assert.ok(region, `${label}: a drag creates a region`);
  assert.ok(region.endSample > region.startSample);

  // label it
  await openInspector(page);
  await page.locator('[data-am-field="label"]').fill('Second hit');
  assert.equal((await markersOf(page)).find((m) => m.kind === 'region').label, 'Second hit');

  // save, reload, find both
  await page.locator('[data-am="save"]').click();
  await statusIs(page, /Saved record/);
  await page.reload();
  await page.waitForFunction(() => window.__audioMarkers.ready);
  const reloaded = await markersOf(page);
  assert.equal(reloaded.length, 2, `${label}: both markers survive a reload`);
  assert.ok(reloaded.every((m) => m.origin === 'record'), 'drawn from the saved record');
  assert.equal(reloaded.find((m) => m.kind === 'region').label, 'Second hit');
  assert.equal(reloaded.find((m) => m.kind === 'point').sample, markers.find((m) => m.kind === 'point').sample);
  await context.close();
}

async function songStructure(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=song-structure');
  assert.equal(await page.evaluate(() => window.__audioMarkers.state.template.templateId), 'song-structure');
  await dragAcross(page, page.locator('[data-lane="structure"]'), 0.25, 0.45);
  await page.locator('[data-am="type"]').selectOption('verse');
  await dragAcross(page, page.locator('[data-lane="structure"]'), 0.55, 0.85);
  const drawn = (await markersOf(page)).filter((m) => m.kind === 'region');
  assert.deepEqual(drawn.map((m) => m.type), ['intro', 'verse'], `${label}: intro then verse`);
  await page.locator('[data-am-field="reason"]').fill('Structure by ear');
  await page.locator('[data-am="save"]').click();
  await statusIs(page, /Saved record/);
  await page.reload();
  await page.waitForFunction(() => window.__audioMarkers.ready);
  const reloaded = await markersOf(page);
  assert.equal(reloaded.length, 2);
  assert.deepEqual(reloaded.map((m) => m.type).sort(), ['intro', 'verse']);
  assert.ok(reloaded.every((m) => m.endSample > m.startSample && m.origin === 'record'));
  await context.close();
}

async function projection(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=demo-projection');
  let markers = await markersOf(page);
  const start = markers.find((m) => m.type === 'start');
  assert.equal(start.sample, 48000, `${label}: seeded from the target record`);
  assert.equal(start.origin, 'target');
  assert.equal(markers.find((m) => m.type === 'end').sample, 240000);

  await dragElement(page, page.locator('[data-marker-id] .am-flag', {hasText: 'Start'}), 70);
  markers = await markersOf(page);
  const moved = markers.find((m) => m.type === 'start').sample;
  assert.ok(moved > 48000, `${label}: the drag moved the start point (${moved})`);

  await page.locator('[data-am-field="reason"]').fill('Start by ear');
  await page.locator('[data-am-field="operator"]').fill('Test Operator');
  const before = sha256(await fs.readFile(env.targetPath));

  await page.locator('[data-am="preview"]').click();
  await page.locator('[data-am="preview-result"], [data-am="alert"]:not([hidden])').first().waitFor();
  assert.equal(await page.locator('[data-am="alert"]').isVisible(), false, `preview refused: ${await page.locator('[data-am="alert"]').textContent()}`);
  assert.match(await page.locator('[data-am="preview-result"]').innerText(), /\/result\/start_sample/);
  assert.equal(sha256(await fs.readFile(env.targetPath)), before, 'preview writes nothing');
  assert.deepEqual(await fs.readdir(path.join(env.projectionRoot, 'pieces', 'alpha')), ['record.yaml'], 'no receipts from a preview');

  await page.locator('[data-am="save-write"]').click();
  await statusIs(page, /write-back applied/);
  const after = yaml.load(await fs.readFile(env.targetPath, 'utf8'));
  assert.equal(after.result.start_sample, moved, 'target start changed to the saved marker');
  assert.equal(after.result.windows[0].start_sample, moved);
  assert.equal(after.result.end_sample, 240000, 'the untouched marker is not rewritten');
  assert.match(after.result.decision.reason, /Test Operator.*Start by ear/);
  assert.equal(after.log.length, 2, 'history entry appended');
  assert.ok(after.proofs.some((p) => p.id === 'edit-1-review'), 'evidence entry appended');
  const receipts = await fs.readdir(path.join(env.projectionRoot, 'pieces', 'alpha', 'edits', FILE));
  assert.equal(receipts.length, 2, 'snapshot and receipt written');
  assert.ok(receipts.some((name) => name.startsWith('record-pre-')) && receipts.some((name) => name.startsWith('edit-')));

  const projectionReceipt = await page.evaluate(() => window.__audioMarkers.state.record.projection);
  assert.equal(projectionReceipt.status, 'applied');
  assert.equal(projectionReceipt.targetPath, 'pieces/alpha/record.yaml');
  assert.ok(!JSON.stringify(projectionReceipt).includes(env.projectionRoot), 'receipt carries no absolute path');
  await page.keyboard.press('Escape');
  assert.match(await page.locator('[data-am="inspector"]').evaluate((el) => el.textContent), /Write-back\s*applied/);
  await context.close();
}

async function staleSecondTab(browser, env, viewport, label) {
  const first = await openViewer(browser, env.origin, viewport);
  const second = await openViewer(browser, env.origin, viewport);
  for (const {page} of [first, second]) {
    await page.locator('[data-am="add-point"]').click();
  }
  await first.page.locator('[data-am="save"]').click();
  await statusIs(first.page, /Saved record/);
  await second.page.locator('[data-am="save"]').click();
  const alert = second.page.locator('[data-am="alert"]');
  await alert.waitFor({state: 'visible'});
  assert.match(await alert.innerText(), /newer set was saved by someone else/i, `${label}: 409 message`);
  assert.equal(await alert.getByRole('button', {name: 'Reload'}).count(), 1);
  await first.context.close();
  await second.context.close();
}

async function tapRealTone(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=freeform', {probe: true});
  await page.evaluate(() => window.__audioMarkers.setClock({outputLatency: 0, baseLatency: 0, calibrationMs: 0}));
  const clock = await page.evaluate(() => window.__audioMarkers.getClock());
  assert.equal(clock.latency, 0, 'injected latency is zero');
  await page.locator('[data-am="play"]').click();
  await page.waitForFunction(() => window.__tapProbe, null, {timeout: 10000});
  await page.evaluate((n) => window.__startClickTapper('m', n), CLICKS_S.length);
  await page.waitForFunction((n) => window.__audioMarkers.state.markers.filter((m) => m.origin === 'new').length >= n, CLICKS_S.length, {timeout: 30000});
  await page.locator('[data-am="play"]').click();
  const markers = (await markersOf(page)).filter((m) => m.origin === 'new').sort((a, b) => a.sample - b.sample);
  const hits = await page.evaluate(() => window.__hits);
  assert.equal(markers.length, CLICKS_S.length, `${label}: one marker per click`);
  markers.forEach((marker, index) => {
    const markerS = marker.sample / SAMPLE_RATE;
    const clickS = CLICKS_S.reduce((best, c) => (Math.abs(c - markerS) < Math.abs(best - markerS) ? c : best), CLICKS_S[0]);
    const offsetMs = (markerS - clickS) * 1000;
    assert.ok(Math.abs(offsetMs) <= 30, `${label}: tap ${index} landed ${offsetMs.toFixed(1)} ms from the nearest click at ${clickS}s`);
  });
  await context.close();
}

async function tapArithmetic(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=freeform');
  await page.locator('[data-am="cal"]').fill('5');
  await page.locator('[data-am="cal"]').dispatchEvent('change');
  await page.keyboard.press('Escape'); // leave the number field so keys reach the viewer
  await page.evaluate(() => window.__audioMarkers.setClock({now: 2, outputLatency: 0.032, baseLatency: 0.01}));
  const clock = await page.evaluate(() => window.__audioMarkers.getClock());
  assert.equal(clock.calibrationMs, 5);
  assert.ok(Math.abs(clock.latency - 0.047) < 1e-9);
  await page.keyboard.press('m');
  // heard = 2 - (0.032 + 0.010 + 0.005) = 1.953 s = 93744 samples at 48 kHz
  assert.ok((await markersOf(page)).some((m) => m.origin === 'new' && m.sample === 93744), `${label}: exact sample`);
  assert.match(await page.locator('[data-am="latency"]').innerText(), /output 32\.0 ms \+ base 10\.0 ms \+ calibration 5\.0 ms = 47\.0 ms/);
  await page.evaluate(() => window.__audioMarkers.setClock({now: 2, outputLatency: 0, baseLatency: 0, calibrationMs: 0}));
  await page.keyboard.press('m');
  assert.ok((await markersOf(page)).some((m) => m.origin === 'new' && m.sample === 96000), 'zero latency lands on the media time');
  await page.evaluate(() => window.__audioMarkers.setClock({now: 2, outputLatency: 0.5, baseLatency: 0, calibrationMs: 0, playing: false}));
  await page.keyboard.press('m');
  assert.equal((await markersOf(page)).filter((m) => m.origin === 'new' && m.sample === 96000).length, 2, 'not playing means no compensation');
  await context.close();
}

const nearly = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

async function selectSeeks(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=freeform');
  // A point at exactly 1.000 s, made from the paused playhead.
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 1; });
  await page.locator('[data-am="add-point"]').click();
  const point = (await markersOf(page)).find((m) => m.origin === 'new' && m.kind === 'point');
  assert.equal(point.sample, SAMPLE_RATE, `${label}: paused Add point lands on the playhead exactly`);
  await page.keyboard.press('Escape'); // clear the selection that placing a marker made
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 4; });
  const flag = page.locator(`[data-marker-id="${point.id}"] .am-flag`);

  // Selecting seeks and leaves the player paused.
  await flag.click();
  let seen = await page.evaluate(() => ({t: window.__audioMarkers.audio.currentTime, paused: window.__audioMarkers.audio.paused}));
  assert.ok(nearly(seen.t, point.sample / SAMPLE_RATE), `${label}: select seeks to the point (${seen.t})`);
  assert.equal(seen.paused, true, `${label}: selecting does not start playback`);

  // Enter starts playback from the marker.
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 4; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__audioMarkers.audio.paused, null, {timeout: 10000});
  seen = await page.evaluate(() => window.__audioMarkers.audio.currentTime);
  assert.ok(seen >= point.sample / SAMPLE_RATE - 0.001 && seen < 3, `${label}: Enter plays from the marker (${seen})`);

  // Selecting while playing seeks and keeps playing.
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 4; });
  await flag.click();
  seen = await page.evaluate(() => ({t: window.__audioMarkers.audio.currentTime, paused: window.__audioMarkers.audio.paused}));
  assert.ok(seen.t < 3 && seen.paused === false, `${label}: selecting while playing seeks and keeps playing (${seen.t})`);

  // Enter while playing restarts from the marker.
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 4; });
  await page.keyboard.press('Enter');
  seen = await page.evaluate(() => ({t: window.__audioMarkers.audio.currentTime, paused: window.__audioMarkers.audio.paused}));
  assert.ok(seen.t < 3 && seen.paused === false, `${label}: Enter restarts from the marker (${seen.t})`);
  await page.locator('[data-am="play"]').click();
  assert.equal(await page.evaluate(() => window.__audioMarkers.audio.paused), true);

  // The inspector button does the same.
  await openInspector(page);
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 4; });
  await page.locator('[data-am="play-from"]').click();
  await page.waitForFunction(() => !window.__audioMarkers.audio.paused, null, {timeout: 10000});
  seen = await page.evaluate(() => window.__audioMarkers.audio.currentTime);
  assert.ok(seen >= point.sample / SAMPLE_RATE - 0.001 && seen < 3, `${label}: Play from here (${seen})`);
  await page.locator('[data-am="play"]').click();

  // A drag seeks once on selection, never on movement.
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 5; });
  const box = await flag.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 5; }); // the seek on selection has happened
  await page.mouse.move(x + 30, y, {steps: 6});
  await page.mouse.move(x + 60, y, {steps: 6});
  await page.mouse.up();
  seen = await page.evaluate(() => window.__audioMarkers.audio.currentTime);
  assert.ok(nearly(seen, 5), `${label}: dragging does not seek on every move (${seen})`);
  assert.ok((await markersOf(page)).find((m) => m.id === point.id).sample > point.sample, 'the drag still moved the point');

  // A region selects to its start.
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 2; });
  await page.locator('[data-am="add-region"]').click();
  const region = (await markersOf(page)).find((m) => m.kind === 'region' && m.origin === 'new');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 5; });
  await page.locator(`[data-marker-id="${region.id}"] .am-body`).click();
  seen = await page.evaluate(() => window.__audioMarkers.audio.currentTime);
  assert.ok(nearly(seen, region.startSample / SAMPLE_RATE), `${label}: selecting a region seeks to its start (${seen})`);
  await context.close();
}

async function tapEdgeModes(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=freeform');
  const newMarkers = async () => (await markersOf(page)).filter((m) => m.origin === 'new');
  const toggle = page.locator('[data-am="tap-release"]');
  assert.equal(await toggle.isChecked(), false, `${label}: tap on release defaults off`);
  assert.equal((await page.evaluate(() => window.__audioMarkers.getClock())).tapEdge, 'press');
  // keydown and keyup see different times
  await page.evaluate(() => window.__audioMarkers.setClock({
    now: (event) => (event && event.type === 'keyup' ? (event.key === ']' ? 3 : event.key === '[' ? 1 : 2.5) : 0.5),
    outputLatency: 0, baseLatency: 0, calibrationMs: 0,
  }));

  // off: the press is the tap
  await page.keyboard.press('m');
  assert.deepEqual((await newMarkers()).map((m) => m.sample), [24000], `${label}: press mode uses the keydown time`);

  // on: the release is the tap, auto-repeat is ignored
  await toggle.check();
  assert.equal((await page.evaluate(() => window.__audioMarkers.getClock())).tapEdge, 'release');
  assert.equal(await page.evaluate(() => window.localStorage.getItem('lookie.audio.tapOnRelease')), '1');
  await page.keyboard.down('m');
  assert.equal((await newMarkers()).length, 1, `${label}: nothing registers on press in release mode`);
  await page.keyboard.down('m'); // auto-repeat
  await page.keyboard.down('m');
  assert.equal((await newMarkers()).length, 1, 'repeats do not register');
  await page.keyboard.up('m');
  assert.deepEqual((await newMarkers()).map((m) => m.sample).sort((a, b) => a - b), [24000, 120000], `${label}: release mode uses the keyup time, once`);

  // regions: each press and release is its own tap
  await page.keyboard.down('[');
  await page.keyboard.up('[');
  await page.keyboard.down(']');
  await page.keyboard.up(']');
  const region = (await newMarkers()).find((m) => m.kind === 'region');
  assert.ok(region, `${label}: release-mode region closed`);
  assert.deepEqual([region.startSample, region.endSample], [48000, 144000], 'region edges use the keyup times');

  // the choice persists across a reload
  await page.reload();
  await page.waitForFunction(() => window.__audioMarkers.ready);
  assert.equal(await toggle.isChecked(), true, `${label}: the choice persists`);
  assert.equal((await page.evaluate(() => window.__audioMarkers.getClock())).tapEdge, 'release');
  await toggle.uncheck();
  assert.equal((await page.evaluate(() => window.__audioMarkers.getClock())).tapEdge, 'press');
  await context.close();
}

async function addButtonsUseHeardTime(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=freeform');
  await page.locator('[data-am="play"]').click();
  await page.waitForFunction(() => window.__audioMarkers.audio.currentTime > 0.3, null, {timeout: 10000});
  // heard = 2.5 - 0.1 = 2.4 s = 115200 samples, from the click event, not from currentTime
  await page.evaluate(() => window.__audioMarkers.setClock({
    now: (event) => (event && event.type === 'click' ? 2.5 : 0), outputLatency: 0.1, baseLatency: 0, calibrationMs: 0,
  }));
  await page.locator('[data-am="add-point"]').click();
  let added = (await markersOf(page)).filter((m) => m.origin === 'new');
  assert.deepEqual(added.map((m) => m.sample), [115200], `${label}: Add point uses the heard time`);
  assert.match(await page.locator('[data-am="latency"]').innerText(), /output 100\.0 ms/);
  await page.locator('[data-am="add-region"]').click();
  added = (await markersOf(page)).filter((m) => m.origin === 'new' && m.kind === 'region');
  assert.deepEqual(added.map((m) => [m.startSample, m.endSample]), [[115200, 115200 + SAMPLE_RATE]], `${label}: Add region starts at the heard time`);

  // paused: the playhead exactly
  await page.evaluate(() => window.__audioMarkers.setClock(null));
  await page.locator('[data-am="play"]').click();
  await page.evaluate(() => { window.__audioMarkers.audio.currentTime = 1.5; });
  await page.locator('[data-am="add-point"]').click();
  assert.ok((await markersOf(page)).some((m) => m.origin === 'new' && m.kind === 'point' && m.sample === 72000), `${label}: paused Add point is the playhead`);
    // Delta-review canary: after Add point, Enter must play from the new marker, not add another one.
  {
    const before = (await markersOf(page)).length;
    await page.locator('[data-am="add-point"]').click();
    const added = (await markersOf(page)).length;
    assert.equal(added, before + 1, `${label}: Add point adds one marker`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const after = (await markersOf(page)).length;
    assert.equal(after, added, `${label}: Enter after Add point adds nothing`);
    assert.equal(await page.evaluate(() => window.__audioMarkers.audio.paused), false, `${label}: Enter after Add point plays`);
  }
await context.close();
}

async function reasonHint(browser, env, viewport, label) {
  const {context, page} = await openViewer(browser, env.origin, viewport, '?template=song-structure');
  const hint = page.locator('[data-am="reason-hint"]');
  assert.equal(await hint.isVisible(), true, `${label}: hint shows while the reason is empty`);
  assert.equal((await hint.textContent()).trim(), 'Type a reason to enable Save.');
  assert.equal(await page.locator('[data-am="save"]').isDisabled(), true);
  await page.locator('[data-am-field="reason"]').fill('Because');
  assert.equal(await hint.isVisible(), false, `${label}: hint goes away once a reason is typed`);
  assert.equal(await hint.textContent(), '');
  await page.locator('[data-am-field="reason"]').fill('');
  assert.equal(await hint.isVisible(), true, `${label}: hint returns when the reason is cleared`);
  await context.close();

  const free = await openViewer(browser, env.origin, viewport, '?template=freeform');
  assert.equal(await free.page.locator('[data-am="reason-hint"]').isVisible(), false, `${label}: no hint for the freeform template`);
  await free.context.close();
}

// ---------------------------------------------------------------- run

if (!haveFfmpeg()) {
  console.log('SKIP audio markers browser spec: ffmpeg and ffprobe are not installed');
  process.exit(0);
}
let browser;
try {
  browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
} catch (error) {
  console.log(`SKIP audio markers browser spec: Chromium could not launch (${String(error.message).split('\n')[0]})`);
  process.exit(0);
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-audio-markers-'));
const servers = [];
let failed = false;
try {
  let index = 0;
  for (const viewport of [{width: 1280, height: 800}, {width: 390, height: 844}]) {
    const label = `${viewport.width}x${viewport.height}`;
    const world = path.join(base, `w${index += 1}`);
    await fs.mkdir(world);
    const env = await stage(world);
    servers.push(env.server);
    // Template sets first: a saved free-form "span" would ride along into a template save (known defect).
    await songStructure(browser, env, viewport, label);
    await projection(browser, env, viewport, label);
    await noTemplate(browser, env, viewport, label);
    await staleSecondTab(browser, env, viewport, label);
    await tapRealTone(browser, env, viewport, label);
    await tapArithmetic(browser, env, viewport, label);
    await selectSeeks(browser, env, viewport, label);
    await tapEdgeModes(browser, env, viewport, label);
    await addButtonsUseHeardTime(browser, env, viewport, label);
    await reasonHint(browser, env, viewport, label);
    console.log(`Audio markers ${label}: no-template point/region/label/save/reload, song-structure, projection write-back, stale tab 409, tap sync real tone and arithmetic, select-seeks, tap edge, Add buttons heard time, reason hint PASS`);
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const key of ['FAKE_LOG', 'FAKE_VALIDATOR_LOG']) delete process.env[key];
  await fs.rm(base, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
