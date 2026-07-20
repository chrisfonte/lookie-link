'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderPreviewHtml } = require('../lib/renderer');

test('rendered links resolve repo-relative, absolute, tilde, and $HOME paths server-side', () => {
  const homePath = '/home/test-user';
  const repoRoot = `${homePath}/projects/alpha`;
  const source = [
    '[relative](../README.md)',
    '[same directory](./chapter/index.md)',
    `[absolute](${repoRoot}/docs/guide.md?mode=full#details)`,
    '[tilde](~/projects/alpha/README.md#top)',
    '[home]($HOME/projects/alpha/docs/guide.md)',
    '[external](https://example.test/guide.md)',
    '[fragment](#local)',
    '`$HOME/projects/alpha/private.md`',
  ].join('\n\n');

  const html = renderPreviewHtml({
    repo: 'alpha',
    repoRoot,
    relativePath: 'docs/guide.md',
    source,
    queryToken: 'viewer-token',
    homePath,
  });

  assert.match(html, /href="\/view\/alpha\/README\.md\?token=viewer-token">relative<\/a>/);
  assert.match(html, /href="\/view\/alpha\/docs\/chapter\/index\.md\?token=viewer-token">same directory<\/a>/);
  assert.match(html, /href="\/view\/alpha\/docs\/guide\.md\?mode=full&amp;token=viewer-token#details">absolute<\/a>/);
  assert.match(html, /href="\/view\/alpha\/README\.md\?token=viewer-token#top">tilde<\/a>/);
  assert.match(html, /href="\/view\/alpha\/docs\/guide\.md\?token=viewer-token">home<\/a>/);
  assert.match(html, /href="https:\/\/example\.test\/guide\.md">external<\/a>/);
  assert.match(html, /href="#local">fragment<\/a>/);
  assert.match(html, /<code>\$HOME\/projects\/alpha\/private\.md<\/code>/);
});
