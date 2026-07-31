'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  decodeEmbedHtmlBuffer,
  transformEmbedHtml,
} = require('../lib/embed-html');
const { renderDocumentPage } = require('../lib/renderer');

const CURRENT_ANNOTATION_SELECTORS = [
  '[data-annotations-mount]',
  '[data-annotate-trigger]',
  '[data-annotations-stale]',
  '[data-annotations-toggle]',
  '[data-rendered-view]',
];

function assertCurrentAnnotationContract(html) {
  const document = new JSDOM(html).window.document;
  for (const selector of CURRENT_ANNOTATION_SELECTORS) {
    assert.ok(document.querySelector(selector), `missing current annotation selector ${selector}`);
  }

  const mounts = Array.from(document.querySelectorAll('[data-annotations-mount][data-anchor-id]'));
  const triggers = Array.from(document.querySelectorAll('[data-annotate-trigger][data-anchor-id]'));
  const anchors = Array.from(document.querySelectorAll('[data-lookie-annotation-anchor]'));
  assert.ok(mounts.length > 0, 'current annotation contract requires at least one anchored mount');
  assert.equal(mounts.length, anchors.length, 'each declared annotation anchor must have a mount');
  assert.equal(triggers.length, mounts.length, 'each annotation mount must have an annotate trigger');
  for (const mount of mounts) {
    const anchorId = mount.getAttribute('data-anchor-id');
    assert.ok(document.getElementById(anchorId), `annotation mount ${anchorId} must resolve to an anchor node`);
    assert.ok(
      triggers.some((trigger) => trigger.getAttribute('data-anchor-id') === anchorId),
      `annotation mount ${anchorId} must have a matching annotate trigger`
    );
  }

  const oldAnchors = Array.from(document.querySelectorAll('a.anchor-link[data-anchor-id]'));
  const isOldAnchorLinkOnlyContract = oldAnchors.length > 0 && mounts.length === 0 && triggers.length === 0;
  assert.equal(isOldAnchorLinkOnlyContract, false, 'obsolete anchor-link-only markup must not be the annotation mount');
}

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
    // Authored viewer-routed absolute paths pass through untouched — never
    // double-prefixed into /asset/<repo>/asset/<repo>/... (404).
    assert.doesNotMatch(html, /\/asset\/alpha\/asset\//);
    assert.match(html, /id="same" href="\/view\/alpha\/docs\/guide\.html#part" target="_top"/);
    assert.match(html, /id="fragment" href="\/view\/alpha\/docs\/page\.html#hello" target="_top"/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed runtime self-reports content height and gates messages on the framing window', async () => {
  const fixture = await makeFixture();
  try {
    const html = transformEmbedHtml('<p>short</p>', options(fixture));
    // The frame is sandboxed without allow-same-origin, so the parent cannot
    // measure the document; the injected runtime must self-report its height.
    assert.match(html, /lookie-link:content-height/);
    assert.match(html, /ResizeObserver/);
    // Inbound messages are gated on event.source — an origin-string comparison
    // is unreliable from an opaque origin and the old guard must be gone.
    assert.match(html, /event\.source !== window\.parent/);
    assert.doesNotMatch(html, /event\.origin !== window\.location\.origin/);
    // Content-height frames cannot scroll internally: the runtime marks the
    // document as embedded (styling hook for in-flow overlay variants), reports
    // fragment-target offsets, and forwards Escape as a close-link navigation.
    assert.match(html, /lookie-embedded/);
    assert.match(html, /lookie-link:scroll-to/);
    assert.match(html, /lookie-link:set-hash/);
    assert.match(html, /'Escape'/);
    // Photo zoom is forwarded to the VIEWER's own lightbox (markdown parity):
    // clicks on photo-lightbox stage links become open-image requests, Escape
    // becomes close-image.
    assert.match(html, /lookie-link:open-image/);
    assert.match(html, /lookie-link:close-image/);
    assert.match(html, /photo-lightbox/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('embed transformation leaves authored viewer-routed absolute paths untouched', async () => {
  const fixture = await makeFixture();
  try {
    const html = transformEmbedHtml(
      '<img id="a" src="/asset/alpha/docs/image.png"><a id="v" href="/view/beta/unique.html">V</a><img id="r" src="image.png">',
      options(fixture)
    );
    // Authored /asset and /view paths already address the viewer — re-resolving
    // them double-prefixes the route (regression seen live 2026-07-29 on the
    // venue catalog: /asset/<repo>/asset/<repo>/... → broken images).
    assert.match(html, /id="a" src="\/asset\/alpha\/docs\/image\.png"/);
    assert.match(html, /id="v" href="\/view\/beta\/unique\.html"/);
    assert.doesNotMatch(html, /\/asset\/[^"]*\/asset\//);
    // Same for the forms surface: launcher/dashboard pages link /forms/... and
    // those must survive embedding untouched.
    const formsHtml = transformEmbedHtml('<a id="f" href="/forms/gym-strength-entry">Log</a>', options(fixture));
    assert.match(formsHtml, /id="f" href="\/forms\/gym-strength-entry"/);
    // Relative references still resolve to the asset route.
    assert.match(html, /id="r" src="\/asset\/alpha\/docs\/image\.png"/);
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
      '<h1>Annotate me</h1><h2 id="second-target">Second target</h2><img src="image.png"><a href="guide.html?token=authored-token&mode=print">Guide</a><p data-secret="bearer&amp;example">Credential</p>',
      options(fixture, {
        annotationsEnabled: true,
        queryToken: 'query-example',
        sensitiveValues: ['bearer&example'],
      })
    );
    assertCurrentAnnotationContract(enabled);
    assert.match(enabled, /lookie-link-annotations-bootstrap/);
    assert.match(enabled, /"queryToken":"query-example"/);
    assert.match(enabled, /src="\/asset\/alpha\/docs\/image\.png\?token=query-example"/);
    assert.match(enabled, /href="\/view\/alpha\/docs\/guide\.html\?mode=print&amp;token=query-example"/);
    assert.doesNotMatch(enabled, /authored-token/);
    assert.doesNotMatch(enabled, /bearer(?:&|&amp;)example/);

    const disabled = transformEmbedHtml('<h1>Plain</h1>', options(fixture, { annotationsEnabled: false }));
    assert.doesNotMatch(disabled, /lookie-link-annotations-bootstrap/);
    for (const selector of CURRENT_ANNOTATION_SELECTORS) {
      assert.equal(new JSDOM(disabled).window.document.querySelector(selector), null);
    }
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('annotation contract negative canary rejects obsolete anchor-link-only markup', () => {
  const obsolete = '<!doctype html><body><h1 id="legacy">Legacy<a class="anchor-link" href="#legacy" data-anchor-id="legacy">🔗</a></h1></body>';
  assert.throws(
    () => assertCurrentAnnotationContract(obsolete),
    /missing current annotation selector \[data-annotations-mount\]/
  );
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

  const embedFrame = html.match(/<iframe[^>]*data-embedded-html[^>]*>/);
  assert.ok(embedFrame, 'the viewer should frame the embed route');
  // No static src (#139): an eager unthemed navigation raced the themed one the
  // sync script issues, and a warm cache could surface the unthemed paint. The
  // script performs the single themed navigation after its load handler.
  assert.doesNotMatch(embedFrame[0], /\ssrc=/);
  assert.match(html, /frame\.src = frameUrl\(\)/);
  assert.ok(
    html.indexOf("frame.addEventListener('load'") < html.indexOf('frame.src = frameUrl()'),
    'the load handler must be registered before the themed navigation'
  );
  assert.match(embedFrame[0], /sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"/);
  assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/);
  assert.match(html, /href="\/embed\/alpha\/docs\/page\.html"[^>]*>Open embedded<\/a>/);
  assert.match(html, /href="\/raw\/alpha\/docs\/page\.html"[^>]*>Open raw<\/a>/);
  assert.match(html, /lookie-link:set-theme/);
  assert.match(html, /MutationObserver/);
  // The sandboxed frame's height arrives by message; the viewer must listen for
  // it from exactly our frame and must not rely on a same-origin targetOrigin
  // (an opaque-origin frame can never match one).
  assert.match(html, /lookie-link:content-height/);
  assert.match(html, /event\.source !== frame\.contentWindow/);
  assert.doesNotMatch(html, /postMessage\((?:[^)]*?), window\.location\.origin\)/);
  // Anchor jumps and Escape-close arrive as messages too: the viewer scrolls the
  // top window to embed-reported offsets and applies only same-document,
  // strictly-validated fragment navigations.
  assert.match(html, /lookie-link:scroll-to/);
  assert.match(html, /lookie-link:set-hash/);
  assert.match(html, /\^#\[A-Za-z0-9_-\]\*\$/);
  // Every inline script the viewer emits must be syntactically valid JS — the
  // wrapper script lives in a template literal where escaped regex slashes
  // silently collapse (\/ -> /), which once shipped a parse error that killed
  // height sizing, theme delivery, and zoom all at once.
  const { Script } = require('node:vm');
  const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim() && !/^\s*\{/.test(s.trim()));
  assert.ok(inlineScripts.length >= 1, 'expected inline scripts to check');
  for (const body of inlineScripts) {
    new Script(body); // throws on any syntax error
  }
  // Protocol-relative smuggling (//host and /\host) must fail the open-image
  // src validation; the string-prefix check handles the backslash variant.
  assert.match(html, /fromCharCode\(92\)/);
  // Embed image zoom drives the page's own [data-lightbox] overlay — the same
  // one markdown files use — for identical viewport-centered behavior.
  assert.match(html, /lookie-link:open-image/);
  assert.match(html, /lookie-link:close-image/);
  assert.doesNotMatch(html, /<iframe[\s\S]*src="\/raw\/alpha\/docs\/page\.html"/);
  assert.doesNotMatch(html, /lookie-link-annotations-bootstrap/);
});

test('embed theme tokens track the mode, not just color-scheme', async () => {
  const fixture = await makeFixture();
  try {
    const source = '<!doctype html><html data-lookie-follow-theme><head><title>T</title></head><body><h1>Hi</h1></body></html>';

    const light = transformEmbedHtml(source, options(fixture, { themeMode: 'light', themeScheme: 'slate' }));
    const dark = transformEmbedHtml(source, options(fixture, { themeMode: 'dark', themeScheme: 'slate' }));

    // Both palettes ship in either render so the runtime set-theme message can
    // re-theme without a reload; they are keyed on the attribute.
    for (const html of [light, dark]) {
      assert.match(html, /:root\[data-lookie-link-theme="light"\][^}]*--lookie-bg:\s*#f4f6f8/,
        'light palette must be emitted and keyed on the theme attribute');
      assert.match(html, /:root\[data-lookie-link-theme="dark"\][^}]*--lookie-bg:\s*#111827/,
        'dark palette must be emitted and keyed on the theme attribute');
    }

    // Negative canary: the pre-fix bug was a single hardcoded dark palette, so a
    // light render must NOT resolve --lookie-text to the dark value on bare :root.
    assert.doesNotMatch(light, /:root\s*\{[^}]*--lookie-text:\s*#e5e7eb/,
      'light render must not pin dark text tokens onto bare :root');
    assert.match(light, /data-lookie-link-theme="light"/);
    assert.match(light, /:root \{ color-scheme: light; \}/);
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('annotate buttons are hidden in the embed until annotation mode is on', async () => {
  const fixture = await makeFixture();
  try {
    const source = '<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1><h2>Section</h2></body></html>';
    const html = transformEmbedHtml(source, options(fixture, {
      themeMode: 'dark',
      annotationsEnabled: true,
    }));

    // The embedded document never loads the viewer's public/style.css, so the
    // gate has to travel with the embed itself.
    assert.match(html, /id="lookie-link-embed-annotation-gate"/, 'embed must carry the annotation gate');
    assert.match(html, /\.lookie-annotate-btn \{ display: none; \}/,
      'annotate buttons must default to hidden');
    assert.match(html, /\.lookie-annotations-active \.lookie-annotate-btn \{[^}]*display: inline-flex/,
      'annotate buttons must appear only under the active class');

    // Negative canary: buttons are still injected, so a regression that drops the
    // gate would leave them visible rather than absent.
    assert.ok(/lookie-annotate-btn/.test(html), 'annotate buttons should still be injected');
  } finally {
    await fsPromises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
