'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  decodeEmbedHtmlBuffer,
  transformEmbedHtml,
} = require('../lib/embed-html');
const { renderDocumentPage } = require('../lib/renderer');

async function makeFixture() {
  const fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'lookie-embed-html-'));
  const alphaRoot = path.join(fixtureRoot, 'alpha');
  const betaRoot = path.join(fixtureRoot, 'beta');
  await fsPromises.mkdir(path.join(alphaRoot, 'docs'), { recursive: true });
  await fsPromises.mkdir(path.join(betaRoot, 'one'), { recursive: true });
  await fsPromises.mkdir(path.join(betaRoot, 'two'), { recursive: true });
  await fsPromises.writeFile(path.join(alphaRoot, 'docs', 'guide.html'), '<h1>Guide</h1>');
  await fsPromises.writeFile(path.join(alphaRoot, 'docs', 'image.png'), 'image');
  await fsPromises.writeFile(path.join(alphaRoot, 'docs', 'theme.css'), 'body {}');
  await fsPromises.writeFile(path.join(betaRoot, 'unique.html'), '<h1>Unique</h1>');
  await fsPromises.writeFile(path.join(betaRoot, 'one', 'duplicate.html'), '<h1>One</h1>');
  await fsPromises.writeFile(path.join(betaRoot, 'two', 'duplicate.html'), '<h1>Two</h1>');
  return { fixtureRoot, alphaRoot, betaRoot };
}

function options(fixture, overrides = {}) {
  return {
    repo: 'alpha',
    rootPath: fixture.alphaRoot,
    relativePath: 'docs/page.html',
    mappings: { alpha: fixture.alphaRoot, beta: fixture.betaRoot },
    canAccess: () => true,
    ...overrides,
  };
}

test('embed transformation preserves scripts and injects base, theme, local assets, and navigation', async () => {
  const fixture = await makeFixture();
  try {
    const source = `<!doctype html>
<html><head><title>Authored</title><link rel="stylesheet" href="theme.css"><script>window.authoredScript = true;</script></head>
<body><h1>Hello</h1><img src="image.png"><a id="same" href="guide.html#part">Same</a><a id="fragment" href="#hello">Fragment</a></body></html>`;
    const html = transformEmbedHtml(source, options(fixture, {
      themeMode: 'light',
      themeScheme: 'teal',
    }));

    assert.match(html, /<base href="\/asset\/alpha\/docs\/">/);
    assert.match(html, /id="lookie-link-embed-theme"/);
    assert.match(html, /data-lookie-link-theme="light"/);
    assert.match(html, /data-lookie-link-scheme="teal"/);
    assert.match(html, /<script>window\.authoredScript = true;<\/script>/);
    assert.match(html, /src="\/asset\/alpha\/docs\/image\.png"/);
    assert.match(html, /href="\/asset\/alpha\/docs\/theme\.css"/);
    assert.match(html, /id="same" href="\/view\/alpha\/docs\/guide\.html#part" target="_top"/);
    assert.match(html, /id="fragment" href="\/view\/alpha\/docs\/page\.html#hello" target="_top"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed transformation wraps fragments and full documents that omit head', async () => {
  const fixture = await makeFixture();
  try {
    const fragment = transformEmbedHtml('<section>Fragment<script>window.fragment = 1;</script></section>', options(fixture));
    assert.match(fragment, /^<!doctype html>/i);
    assert.match(fragment, /<head><base href="\/asset\/alpha\/docs\/">/);
    assert.match(fragment, /<body><section>Fragment<script>window\.fragment = 1;<\/script><\/section><\/body>/);

    const missingHead = transformEmbedHtml('<html><body><p>No head</p></body></html>', options(fixture));
    assert.match(missingHead, /<html[^>]*><head><base href="\/asset\/alpha\/docs\/">/);
    assert.match(missingHead, /<body><p>No head<\/p><\/body>/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed navigation resolves cross-repo and unique wiki links while containing ambiguity', async () => {
  const fixture = await makeFixture();
  try {
    const html = transformEmbedHtml(
      '<a id="cross" href="~/beta/unique.html">Cross</a><a id="wiki" href="[[unique]]">Wiki</a><a id="ambiguous" href="[[duplicate]]">Ambiguous</a>',
      options(fixture)
    );
    assert.match(html, /id="cross" href="\/view\/beta\/unique\.html" target="_top"/);
    assert.match(html, /id="wiki" href="\/view\/beta\/unique\.html" target="_top"/);
    assert.match(html, /id="ambiguous" href="#unresolved-wiki-link"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed annotations are opt-in and query credentials are limited to required generated URLs', async () => {
  const fixture = await makeFixture();
  try {
    const enabled = transformEmbedHtml(
      '<h1>Annotate me</h1><img src="image.png"><a href="guide.html?token=authored-token&mode=print">Guide</a><p data-secret="bearer&amp;example">Credential</p>',
      options(fixture, {
        annotationsEnabled: true,
        queryToken: 'query-example',
        sensitiveValues: ['bearer&example'],
      })
    );
    assert.match(enabled, /<h1 id="annotate-me">Annotate me<a class="anchor-link"/);
    assert.match(enabled, /lookie-link-annotations-bootstrap/);
    assert.match(enabled, /"queryToken":"query-example"/);
    assert.match(enabled, /src="\/asset\/alpha\/docs\/image\.png\?token=query-example"/);
    assert.match(enabled, /href="\/view\/alpha\/docs\/guide\.html\?mode=print&amp;token=query-example"/);
    assert.doesNotMatch(enabled, /authored-token/);
    assert.doesNotMatch(enabled, /bearer(?:&|&amp;)example/);

    const disabled = transformEmbedHtml('<h1>Plain</h1>', options(fixture, { annotationsEnabled: false }));
    assert.doesNotMatch(disabled, /lookie-link-annotations-bootstrap/);
    assert.doesNotMatch(disabled, /class="anchor-link"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed output redacts host roots and inaccessible cross-repo targets', async () => {
  const fixture = await makeFixture();
  try {
    const authoredPrivatePath = path.join(fixture.alphaRoot, 'docs', 'guide.html');
    const html = transformEmbedHtml(
      `<p>${fixture.alphaRoot}</p><script>window.privateRoot = ${JSON.stringify(fixture.betaRoot)};</script><a href="${authoredPrivatePath}">Mapped</a><a href="~/beta/unique.html">Denied</a>`,
      options(fixture, { canAccess: (repo) => repo === 'alpha' })
    );
    assert.doesNotMatch(html, new RegExp(fixture.fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /rootPath|repoMappings/);
    assert.match(html, /href="\/view\/alpha\/docs\/guide\.html"/);
    assert.match(html, /href="#unavailable-link"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed decoding rejects binary and invalid UTF-8 while accepting valid UTF-8', () => {
  assert.equal(decodeEmbedHtmlBuffer(Buffer.from('<p>valid ✓</p>')), '<p>valid ✓</p>');
  assert.throws(() => decodeEmbedHtmlBuffer(Buffer.from([0x3c, 0x00, 0x3e])), /binary data/);
  assert.throws(() => decodeEmbedHtmlBuffer(Buffer.from([0x3c, 0xff, 0x3e])), /valid UTF-8/);
});

test('embed module does not depend on authored files being writable', async () => {
  const fixture = await makeFixture();
  try {
    fs.chmodSync(path.join(fixture.alphaRoot, 'docs', 'guide.html'), 0o444);
    const html = transformEmbedHtml('<a href="guide.html">Guide</a>', options(fixture));
    assert.match(html, /href="\/view\/alpha\/docs\/guide\.html"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('document viewer frames HTML through embed while retaining a distinct raw-source action', () => {
  const html = renderDocumentPage({
    repo: 'alpha',
    repoRoot: '/srv/example/alpha',
    relativePath: 'docs/page.html',
    source: '<script>window.authored = true;</script>',
    parentHref: '/view/alpha/docs',
    mtime: '2026-01-01',
    size: '1 KB',
    rawHtmlHref: '/raw/alpha/docs/page.html',
    embedHtmlHref: '/embed/alpha/docs/page.html',
    annotationsEnabled: true,
  });

  assert.match(html, /<iframe[\s\S]*data-embedded-html[\s\S]*src="\/embed\/alpha\/docs\/page\.html"/);
  assert.match(html, /href="\/embed\/alpha\/docs\/page\.html"[^>]*>Open embedded<\/a>/);
  assert.match(html, /href="\/raw\/alpha\/docs\/page\.html"[^>]*>Open raw<\/a>/);
  assert.match(html, /lookie-link:set-theme/);
  assert.match(html, /MutationObserver/);
  assert.doesNotMatch(html, /<iframe[\s\S]*src="\/raw\/alpha\/docs\/page\.html"/);
  assert.doesNotMatch(html, /lookie-link-annotations-bootstrap/);
});
