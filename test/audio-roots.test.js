'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-audio-roots-'));
  const audioDir = path.join(root, 'audio');
  const repoDir = path.join(root, 'plain');
  await fs.mkdir(path.join(audioDir, 'sub'), { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(audioDir, 'tone.wav'), Buffer.from('RIFF0000WAVEfmt tiny-test-bytes'));
  await fs.writeFile(path.join(audioDir, 'notes.txt'), 'plain notes\n');
  await fs.writeFile(path.join(audioDir, 'sub', 'deep.md'), '# Deep\n');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Plain\n');
  return { root, audioDir, repoDir };
}

async function withServer(t, options) {
  const app = createApp(options);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function appOptions(fixture, extra = {}) {
  return {
    mappings: { plain: fixture.repoDir },
    audioRoots: { 'station-audio': { path: fixture.audioDir, label: 'Station audio' } },
    editingEnabled: true,
    annotationsEnabled: true,
    accessConfig: {},
    ...extra,
  };
}

test('Files picker lists the audio root with its label and plain repos stay unchanged', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const base = await withServer(t, appOptions(fixture));

  const picker = await fetch(`${base}/`);
  const html = await picker.text();
  assert.equal(picker.status, 200);
  assert.match(html, /station-audio/);
  assert.match(html, /plain/);

  const repos = await (await fetch(`${base}/api/repos`)).json();
  const audio = repos.repos.find((entry) => entry.repo === 'station-audio');
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.readOnly, true);
  assert.equal(audio.label, 'Station audio');
  assert.deepEqual(repos.repos.find((entry) => entry.repo === 'plain'), {
    repo: 'plain',
    viewUrl: '/view/plain/',
    assetUrl: '/asset/plain/',
  });
  assert.ok(!JSON.stringify(repos).includes(fixture.audioDir), 'no host paths in /api/repos');
});

test('/view lists the audio root files and shows non-audio files without serving them', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const base = await withServer(t, appOptions(fixture));

  const listing = await fetch(`${base}/view/station-audio/`);
  const listingHtml = await listing.text();
  assert.equal(listing.status, 200);
  assert.match(listingHtml, /tone\.wav/);
  assert.match(listingHtml, /notes\.txt/);

  const shown = await fetch(`${base}/view/station-audio/notes.txt`);
  const shownHtml = await shown.text();
  assert.equal(shown.status, 200);
  assert.match(shownHtml, /shown but not served from an audio root/);
  assert.match(shownHtml, /notes\.txt/);
  assert.doesNotMatch(shownHtml, /plain notes/);

  const markdown = await fetch(`${base}/view/station-audio/sub/deep.md`);
  assert.match(await markdown.text(), /shown but not served/);

  const audio = await fetch(`${base}/view/station-audio/tone.wav`);
  const audioHtml = await audio.text();
  assert.equal(audio.status, 200);
  assert.doesNotMatch(audioHtml, /shown but not served/);
  assert.match(audioHtml, /\/asset\/station-audio\/tone\.wav/);

  const plain = await fetch(`${base}/view/plain/README.md`);
  const plainHtml = await plain.text();
  assert.doesNotMatch(plainHtml, /shown but not served/);
  assert.match(plainHtml, />Plain</);
});

test('/asset serves audio from an audio root and refuses other files', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const base = await withServer(t, appOptions(fixture));

  const wav = await fetch(`${base}/asset/station-audio/tone.wav`);
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');
  assert.equal((await wav.arrayBuffer()).byteLength, 'RIFF0000WAVEfmt tiny-test-bytes'.length);

  const txt = await fetch(`${base}/asset/station-audio/notes.txt`);
  assert.equal(txt.status, 415);

  const plain = await fetch(`${base}/asset/plain/README.md`);
  assert.equal(plain.status, 200);
});

test('/api/repos/:repo/files refuses non-text files in an audio root', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const base = await withServer(t, appOptions(fixture));

  const wav = await fetch(`${base}/api/repos/station-audio/files/tone.wav`);
  assert.equal(wav.status, 415);
  assert.equal((await wav.json()).ok, false);

  const txt = await fetch(`${base}/api/repos/station-audio/files/notes.txt`);
  assert.equal(txt.status, 200);
  assert.equal((await txt.json()).content, 'plain notes\n');

  const tree = await (await fetch(`${base}/api/repos/station-audio/tree`)).json();
  assert.ok(tree.entries.some((entry) => entry.path === 'tone.wav'));
});

test('editing, saving and annotating an audio root answer 403', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const base = await withServer(t, appOptions(fixture));
  const headers = { 'content-type': 'application/json' };

  const edit = await fetch(`${base}/edit/station-audio/notes.txt`);
  assert.equal(edit.status, 403);

  const save = await fetch(`${base}/api/save/station-audio/notes.txt`, {
    method: 'POST', headers, body: JSON.stringify({ content: 'changed' }),
  });
  assert.equal(save.status, 403);
  assert.equal((await save.json()).ok, false);
  assert.equal(await fs.readFile(path.join(fixture.audioDir, 'notes.txt'), 'utf8'), 'plain notes\n');

  const annotate = await fetch(`${base}/api/annotations/station-audio/notes.txt`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(annotate.status, 403);
  const patch = await fetch(`${base}/api/annotations/station-audio/notes.txt`, {
    method: 'PATCH', headers, body: JSON.stringify({ id: 'a', text: 'x' }),
  });
  assert.equal(patch.status, 403);

  const plainEdit = await fetch(`${base}/edit/plain/README.md`);
  assert.equal(plainEdit.status, 200);
});

test('an audio root id that collides with a repository throws at createApp', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => createApp(appOptions(fixture, { mappings: { 'station-audio': fixture.repoDir } })),
    /audioRoots id "station-audio" conflicts with a configured repository mapping/
  );
  assert.throws(
    () => createApp(appOptions(fixture, { audioRoots: { 'Bad Id': { path: fixture.audioDir } } })),
    /audioRoots id "Bad Id"/
  );
});

test('/raw and /embed refuse an .html file in an audio root with 415', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.audioDir, 'page.html'), '<h1>audio root page</h1>');
  await fs.writeFile(path.join(fixture.repoDir, 'page.html'), '<h1>plain page</h1>');
  const base = await withServer(t, appOptions(fixture, { rawHtmlEnabled: true }));

  for (const route of ['raw', 'embed']) {
    const refused = await fetch(`${base}/${route}/station-audio/page.html`);
    assert.equal(refused.status, 415, route);
    assert.match(refused.headers.get('content-type'), /text\/plain/);
    assert.equal(await refused.text(), 'Not served from an audio root.');
  }

  const plain = await fetch(`${base}/raw/plain/page.html`);
  assert.equal(plain.status, 200);
  assert.match(await plain.text(), /plain page/);
});

for (const ripgrep of [false, 'auto']) {
  test(`fleet search does not list audio root files (ripgrep: ${ripgrep})`, async (t) => {
    const fixture = await makeFixture();
    t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    await fs.writeFile(path.join(fixture.audioDir, 'notes.txt'), 'fleet-wide needle in audio\n');
    await fs.writeFile(path.join(fixture.repoDir, 'README.md'), '# Plain\nfleet-wide needle in plain\n');
    const base = await withServer(t, appOptions(fixture, { searchConfig: { ripgrep } }));

    const search = await (await fetch(`${base}/api/search?q=${encodeURIComponent('fleet-wide needle')}`)).json();
    assert.equal(search.ok, true);
    const hits = search.results.map((entry) => entry.repo);
    assert.ok(hits.includes('plain'));
    assert.ok(!hits.includes('station-audio'), 'audio root files are not search results');
    assert.ok(!JSON.stringify(search).includes('station-audio'));

    const scoped = await fetch(`${base}/api/search?q=needle&scope=station-audio`);
    assert.equal(scoped.status, 400);

    const suggest = await (await fetch(`${base}/api/search/suggest?q=notes`)).json();
    assert.ok(!JSON.stringify(suggest).includes('station-audio'));
  });
}
