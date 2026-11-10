'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderAudioPage } = require('../lib/renderer');

const OPTIONS = {
  repo: 'station-audio',
  relativePath: 'folder/clip one.wav',
  audioHref: '/asset/station-audio/folder/clip%20one.wav',
  mimeType: 'audio/wav',
  size: '1.5 MB',
  mtime: '2026-10-07',
};

function bootOf(html) {
  const match = /<script id="audio-markers-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'boot blob present');
  return { raw: match[1], value: JSON.parse(match[1]) };
}

test('the audio page carries the boot blob, the script and the skeleton', () => {
  const html = renderAudioPage({ ...OPTIONS, csrfToken: 'tok', templateId: 'song-structure', recordId: 'rec-1', startSeconds: '12.5' });
  const { value } = bootOf(html);

  assert.match(html, /<article class="content audio-markers" id="audio-markers"/);
  assert.match(html, /<script src="\/public\/audio-viewer\.js" defer><\/script>/);
  assert.match(html, /<main class="layout layout-audio">/);
  assert.match(html, /data-am="wave"/);
  assert.match(html, /data-am="lanes"/);
  assert.match(html, /data-am="inspector"/);
  assert.match(html, /data-am="status"/);
  assert.match(html, /data-am="cal"/);
  assert.equal(value.repo, 'station-audio');
  assert.equal(value.path, 'folder/clip one.wav');
  assert.equal(value.fileName, 'clip one.wav');
  assert.equal(value.assetUrl, OPTIONS.audioHref);
  assert.equal(value.infoUrl, '/api/audio/station-audio/folder/clip%20one.wav');
  assert.equal(value.peaksUrl, '/api/peaks/station-audio/folder/clip%20one.wav');
  assert.equal(value.templatesUrl, '/api/markers/templates');
  assert.equal(value.recordsUrl, '/api/markers/records');
  assert.equal(value.contextUrl, '/api/markers/context');
  assert.equal(value.previewUrl, '/api/markers/preview');
  assert.equal(value.csrfToken, 'tok');
  assert.equal(value.templateId, 'song-structure');
  assert.equal(value.recordId, 'rec-1');
  assert.equal(value.startSeconds, 12.5);
  assert.equal(value.queryToken, null);
  assert.equal(value.operatorName, null);
});

test('defaults: freeform template, no record, no start, route paths from repo and path', () => {
  const { value } = bootOf(renderAudioPage(OPTIONS));
  assert.equal(value.templateId, 'freeform');
  assert.equal(value.recordId, null);
  assert.equal(value.startSeconds, null);
  assert.equal(value.csrfToken, null);
});

test('options override the default routes and pass the token and name through', () => {
  const { value } = bootOf(renderAudioPage({
    ...OPTIONS, infoUrl: '/x/info', peaksUrl: '/x/peaks', templatesUrl: '/x/t', recordsUrl: '/x/r', contextUrl: '/x/c', previewUrl: '/x/p',
    queryToken: 'q-1', operatorName: 'Operator One',
  }));
  assert.deepEqual([value.infoUrl, value.peaksUrl, value.templatesUrl, value.recordsUrl, value.contextUrl, value.previewUrl],
    ['/x/info', '/x/peaks', '/x/t', '/x/r', '/x/c', '/x/p']);
  assert.equal(value.queryToken, 'q-1');
  assert.equal(value.operatorName, 'Operator One');
});

test('the noscript fallback keeps a plain audio element', () => {
  const html = renderAudioPage(OPTIONS);
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  assert.ok(noscript, 'noscript present');
  assert.match(noscript[1], /<audio controls preload="metadata" src="\/asset\/station-audio\/folder\/clip%20one\.wav" type="audio\/wav">/);
  assert.match(noscript[1], /<a href="[^"]+" download>Download<\/a>/);
});

test('a hostile file name cannot break out of the JSON blob or the markup', () => {
  const html = renderAudioPage({
    ...OPTIONS,
    relativePath: 'a/</script><img src=x onerror=alert(1)>.wav',
    audioHref: '/asset/station-audio/a/%3C.wav?x="><b>',
    templateId: '</script><script>alert(2)</script>',
  });
  const { raw, value } = bootOf(html);

  assert.ok(!raw.includes('<'), 'no raw < inside the JSON blob');
  assert.equal(value.fileName, 'script><img src=x onerror=alert(1)>.wav');
  assert.equal(value.path, 'a/</script><img src=x onerror=alert(1)>.wav');
  assert.equal(value.templateId, '</script><script>alert(2)</script>');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'file name never appears as live markup');
  assert.ok(!html.includes('<script>alert(2)</script>'));
  assert.match(html, /data-file="script&gt;&lt;img src=x onerror=alert\(1\)&gt;\.wav"/);
  assert.ok(!html.includes('src="/asset/station-audio/a/%3C.wav?x="><b>"'), 'asset href is attribute-escaped');
});

test('aif and aiff are served by the audio viewer', () => {
  const html = renderAudioPage({ ...OPTIONS, relativePath: 'take.aiff', audioHref: '/asset/station-audio/take.aiff', mimeType: 'audio/aiff' });
  assert.match(html, /type="audio\/aiff"/);
});

test('the viewer client script parses as a standalone script', () => {
  const vm = require('node:vm');
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const source = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'public', 'audio-viewer.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'audio-viewer.js' }));
});

test('the toolbar carries the tap-on-release checkbox, off by default and unchecked in the markup', () => {
  const html = renderAudioPage(OPTIONS);
  const control = /<input type="checkbox"[^>]*data-am="tap-release"[^>]*>/.exec(html);
  assert.ok(control, 'tap-release checkbox present');
  assert.ok(!/\bchecked\b/.test(control[0]), 'not checked in the server markup');
  assert.match(html, /Tap on release/);
  assert.match(html, /data-am="add-point"/);
  assert.match(html, /data-am="add-region"/);
});

test('the client builds the reason hint and the play-from-here action with textContent paths', () => {
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const source = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'public', 'audio-viewer.js'), 'utf8');
  assert.match(source, /data-am': 'reason-hint'/);
  assert.match(source, /Type a reason to enable Save\./);
  assert.match(source, /data-am': 'play-from'/);
  assert.match(source, /lookie\.audio\.tapOnRelease/);
  assert.ok(!/\.innerHTML\s*=/.test(source), 'no innerHTML assignment');
});

test('the page carries the record panel, the skipped-template notice and the problems list', () => {
  const html = renderAudioPage(OPTIONS);
  assert.match(html, /<section class="am-recordpanel" aria-label="Record details">/);
  assert.match(html, /<button[^>]*data-am="record-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="am-record-body"/);
  assert.match(html, /<div class="am-record-body" id="am-record-body" data-am="record-details"><\/div>/);
  assert.match(html, /<p class="am-notice" data-am="skipped" role="status" hidden><\/p>/);
  assert.match(html, /data-am="checks" hidden/);
  // The record panel sits in the side column, under the inspector.
  assert.ok(html.indexOf('data-am="inspector"') < html.indexOf('data-am="record-details"'));
  // The status line has no block-size note; that moved to the help panel and the waveform title.
  assert.ok(!/data-am="resnote"/.test(html));
});

test('the toolbar groups transport, view and tap controls on one row', () => {
  const html = renderAudioPage(OPTIONS);
  const first = html.indexOf('aria-label="Playback and view"');
  const second = html.indexOf('aria-label="Marker set"');
  const row = html.slice(first, second);
  for (const group of ['am-transport', 'am-view', 'am-taps']) {
    assert.ok(row.includes(group), `${group} group in the first row`);
  }
  for (const hook of ['play', 'loop', 'rate', 'zoom-out', 'zoom-fit', 'zoom-in', 'cal', 'tap-release', 'snap', 'help']) {
    assert.ok(row.includes(`data-am="${hook}"`), `${hook} in the first row`);
  }
  for (const hook of ['template', 'record', 'type', 'add-point', 'add-region']) {
    assert.ok(html.slice(second).includes(`data-am="${hook}"`), `${hook} in the second row`);
  }
});

test('the client renders details, documents, notes and the skipped notice through textContent', () => {
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const source = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'public', 'audio-viewer.js'), 'utf8');
  assert.match(source, /function renderRecordPanel\(/);
  assert.match(source, /function renderSkipped\(/);
  assert.match(source, /template file\$\{list\.length === 1 \? '' : 's'\} skipped: /);
  assert.match(source, /No record notes\./);
  assert.match(source, /'truncated'/);
  assert.match(source, /Saving\\u2026/);
  assert.match(source, /No record found for this file; save without write-back or pick another template\./);
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML/.test(source), 'no HTML injection');
});
