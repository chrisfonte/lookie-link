'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getAudioRootsConfig, getMarkersConfig, reloadConfig } = require('../lib/config');

const ORIGINAL_CONFIG_ENV = process.env.LOOKIE_LINK_CONFIG;

function withConfig(t, yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-link-audio-config-'));
  const file = path.join(dir, 'lookie-link.yaml');
  fs.writeFileSync(file, yamlText);
  process.env.LOOKIE_LINK_CONFIG = file;
  reloadConfig();
  t.after(() => {
    if (ORIGINAL_CONFIG_ENV === undefined) delete process.env.LOOKIE_LINK_CONFIG;
    else process.env.LOOKIE_LINK_CONFIG = ORIGINAL_CONFIG_ENV;
    reloadConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('getAudioRootsConfig reads string and object entries and expands ~', (t) => {
  withConfig(t, [
    'audioRoots:',
    '  station-audio:',
    '    path: /path/to/share',
    '    label: Station audio',
    '  home-audio: ~/audio',
    '',
  ].join('\n'));
  assert.deepEqual(getAudioRootsConfig(), {
    'station-audio': { path: '/path/to/share', label: 'Station audio' },
    'home-audio': { path: path.join(os.homedir(), 'audio'), label: 'home-audio' },
  });
});

test('getAudioRootsConfig returns an empty object when absent', (t) => {
  withConfig(t, 'server:\n  port: 1234\n');
  assert.deepEqual(getAudioRootsConfig(), {});
});

test('getAudioRootsConfig rejects bad ids and bad shapes', (t) => {
  withConfig(t, 'audioRoots:\n  Bad_ID: /path/to/share\n');
  assert.throws(() => getAudioRootsConfig(), /audioRoots id "Bad_ID"/);

  withConfig(t, 'audioRoots:\n  ok: 42\n');
  assert.throws(() => getAudioRootsConfig(), /audioRoots "ok" must be a path/);

  withConfig(t, 'audioRoots:\n  ok:\n    path: /path/to/share\n    label: [1]\n');
  assert.throws(() => getAudioRootsConfig(), /label must be a string/);

  withConfig(t, 'audioRoots: [a, b]\n');
  assert.throws(() => getAudioRootsConfig(), /audioRoots must be a map/);
});

test('getMarkersConfig defaults when the block is absent', (t) => {
  withConfig(t, 'server:\n  port: 1234\n');
  const markers = getMarkersConfig();
  assert.equal(markers.enabled, false);
  assert.equal(markers.blockSize, 1152);
  assert.equal(markers.ffmpegPath, 'ffmpeg');
  assert.equal(markers.ffprobePath, 'ffprobe');
  assert.equal(markers.yamlToolPath, null);
  assert.equal(markers.peaksCachePath, path.join(os.homedir(), '.local/share/lookie-link/peaks'));
  assert.deepEqual(markers.validators, {});
  assert.equal(markers.destinations, undefined);
  assert.equal(markers.publicOrigins, undefined);
  assert.equal(markers.templatesPath, undefined);
  assert.deepEqual(markers.templatesPaths, []);
  assert.deepEqual(markers.roots, {});
  assert.equal(markers.maxAudioBytes, 2147483648);
  assert.equal(markers.operatorName, null);
  assert.equal(markers.timezone, undefined);
});

test('getMarkersConfig reads a full block, expanding ~ and validator paths', (t) => {
  withConfig(t, [
    'markers:',
    '  enabled: true',
    '  templatesPath: ~/marker-templates',
    '  destinations:',
    '    default: ~/marker-records',
    '    imaging: /path/to/client-repo',
    '  peaksCachePath: ~/peaks',
    '  blockSize: 576',
    '  maxAudioBytes: 1048576',
    '  operatorName: Operator One',
    '  timezone: America/Chicago',
    '  ffmpegPath: /usr/local/bin/ffmpeg',
    '  yamlToolPath: ~/bin/yaml-tool',
    '  validators:',
    '    record-check: ["python3", "~/validate.py", "{candidate}"]',
    '  publicOrigins: ["https://lookie.example.test"]',
    '',
  ].join('\n'));
  const home = os.homedir();
  const markers = getMarkersConfig();
  assert.equal(markers.enabled, true);
  assert.equal(markers.templatesPath, path.join(home, 'marker-templates'));
  assert.deepEqual(markers.destinations, {
    default: path.join(home, 'marker-records'),
    imaging: '/path/to/client-repo',
  });
  assert.equal(markers.peaksCachePath, path.join(home, 'peaks'));
  assert.equal(markers.blockSize, 576);
  assert.equal(markers.maxAudioBytes, 1048576);
  assert.equal(markers.operatorName, 'Operator One');
  assert.equal(markers.timezone, 'America/Chicago');
  assert.deepEqual(markers.templatesPaths, [path.join(home, 'marker-templates')]);
  assert.equal(markers.ffmpegPath, '/usr/local/bin/ffmpeg');
  assert.equal(markers.yamlToolPath, path.join(home, 'bin/yaml-tool'));
  assert.deepEqual(markers.validators, {
    'record-check': ['python3', path.join(home, 'validate.py'), '{candidate}'],
  });
  assert.deepEqual(markers.publicOrigins, ['https://lookie.example.test']);
});

test('getMarkersConfig falls back to forms.publicOrigins', (t) => {
  withConfig(t, [
    'forms:',
    '  publicOrigins: ["https://forms.example.test"]',
    'markers:',
    '  enabled: false',
    '',
  ].join('\n'));
  assert.deepEqual(getMarkersConfig().publicOrigins, ['https://forms.example.test']);
});

test('getMarkersConfig refuses enabled markers without templates or destinations', (t) => {
  withConfig(t, 'markers:\n  enabled: true\n  destinations:\n    default: /path/to/records\n');
  assert.throws(() => getMarkersConfig(), /markers\.templatesPath is required/);

  withConfig(t, 'markers:\n  enabled: true\n  templatesPath: /path/to/templates\n');
  assert.throws(() => getMarkersConfig(), /markers\.destinations must configure at least one destination/);

  withConfig(t, 'markers:\n  enabled: true\n  templatesPath: /path/to/templates\n  destinations: {}\n');
  assert.throws(() => getMarkersConfig(), /markers\.destinations must configure at least one destination/);
});

test('getMarkersConfig rejects malformed destinations, validators, and blockSize', (t) => {
  withConfig(t, 'markers:\n  destinations: [a]\n');
  assert.throws(() => getMarkersConfig(), /markers\.destinations must be a map/);

  withConfig(t, 'markers:\n  destinations:\n    default: 7\n');
  assert.throws(() => getMarkersConfig(), /Storage root for marker destination "default"/);

  withConfig(t, 'markers:\n  validators:\n    check: "python3 run.py"\n');
  assert.throws(() => getMarkersConfig(), /markers\.validators "check" must be a non-empty array of strings/);

  withConfig(t, 'markers:\n  validators:\n    check: ["python3", 5]\n');
  assert.throws(() => getMarkersConfig(), /markers\.validators "check"/);

  withConfig(t, 'markers:\n  validators:\n    Bad Id: ["x"]\n');
  assert.throws(() => getMarkersConfig(), /markers\.validators id "Bad Id"/);

  withConfig(t, 'markers:\n  blockSize: 0\n');
  assert.throws(() => getMarkersConfig(), /markers\.blockSize must be a positive integer/);
});

test('getMarkersConfig accepts a list of templatesPath entries', (t) => {
  withConfig(t, [
    'markers:',
    '  enabled: true',
    '  templatesPath:',
    '    - ~/marker-templates',
    '    - /path/to/client-repo/marker-templates',
    '  destinations:',
    '    default: /path/to/records',
    '',
  ].join('\n'));
  const markers = getMarkersConfig();
  assert.deepEqual(markers.templatesPaths, [
    path.join(os.homedir(), 'marker-templates'),
    '/path/to/client-repo/marker-templates',
  ]);
  assert.equal(markers.templatesPath, markers.templatesPaths[0]);
});

test('getMarkersConfig rejects malformed templatesPath and an empty list when enabled', (t) => {
  withConfig(t, 'markers:\n  templatesPath: [7]\n');
  assert.throws(() => getMarkersConfig(), /markers\.templatesPath must be a path or a list of paths/);

  withConfig(t, 'markers:\n  templatesPath: {a: b}\n');
  assert.throws(() => getMarkersConfig(), /markers\.templatesPath must be a path or a list of paths/);

  withConfig(t, 'markers:\n  enabled: true\n  templatesPath: []\n  destinations:\n    default: /path/to/records\n');
  assert.throws(() => getMarkersConfig(), /markers\.templatesPath is required/);
});

test('getMarkersConfig reads roots as strings or objects with defaults', (t) => {
  withConfig(t, [
    'markers:',
    '  roots:',
    '    evidence: ~/evidence',
    '    records-repo:',
    '      path: /path/to/client-repo',
    '      allowProjections: true',
    '    loose-repo:',
    '      path: /path/to/other-repo',
    '      requireValidator: false',
    '',
  ].join('\n'));
  assert.deepEqual(getMarkersConfig().roots, {
    evidence: { path: path.join(os.homedir(), 'evidence'), allowProjections: false, requireValidator: true },
    'records-repo': { path: '/path/to/client-repo', allowProjections: true, requireValidator: true },
    'loose-repo': { path: '/path/to/other-repo', allowProjections: false, requireValidator: false },
  });
});

test('getMarkersConfig rejects malformed roots', (t) => {
  withConfig(t, 'markers:\n  roots: [a]\n');
  assert.throws(() => getMarkersConfig(), /markers\.roots must be a map/);

  withConfig(t, 'markers:\n  roots:\n    Bad_Alias: /path/to/repo\n');
  assert.throws(() => getMarkersConfig(), /markers\.roots alias "Bad_Alias"/);

  withConfig(t, 'markers:\n  roots:\n    ok: 5\n');
  assert.throws(() => getMarkersConfig(), /markers\.roots "ok" must be a path/);

  withConfig(t, 'markers:\n  roots:\n    ok:\n      allowProjections: true\n');
  assert.throws(() => getMarkersConfig(), /markers\.roots "ok" must be a path/);

  withConfig(t, 'markers:\n  roots:\n    ok:\n      path: /path/to/repo\n      allowProjections: "yes"\n');
  assert.throws(() => getMarkersConfig(), /allowProjections must be true or false/);

  withConfig(t, 'markers:\n  roots:\n    ok:\n      path: /path/to/repo\n      requireValidator: 1\n');
  assert.throws(() => getMarkersConfig(), /requireValidator must be true or false/);
});

test('getMarkersConfig rejects bad maxAudioBytes, operatorName and timezone', (t) => {
  withConfig(t, 'markers:\n  maxAudioBytes: 0\n');
  assert.throws(() => getMarkersConfig(), /markers\.maxAudioBytes must be a positive integer/);

  withConfig(t, 'markers:\n  maxAudioBytes: 1.5\n');
  assert.throws(() => getMarkersConfig(), /markers\.maxAudioBytes must be a positive integer/);

  withConfig(t, 'markers:\n  operatorName: [x]\n');
  assert.throws(() => getMarkersConfig(), /markers\.operatorName must be a string/);

  withConfig(t, 'markers:\n  timezone: 5\n');
  assert.throws(() => getMarkersConfig(), /markers\.timezone must be a string/);
});
