'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { renderDocumentPage, renderPreviewHtml } = require('../lib/renderer');

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

test('cross-repo and wiki links resolve while ambiguous wiki names remain unlinked', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-portable-links-'));
  const alphaRoot = path.join(fixtureRoot, 'alpha');
  const betaRoot = path.join(fixtureRoot, 'beta');

  try {
    await fs.mkdir(path.join(alphaRoot, 'docs'), { recursive: true });
    await fs.mkdir(path.join(alphaRoot, 'one'), { recursive: true });
    await fs.mkdir(path.join(alphaRoot, 'two'), { recursive: true });
    await fs.mkdir(betaRoot, { recursive: true });
    await fs.writeFile(path.join(alphaRoot, 'README.md'), '# Alpha\n');
    await fs.writeFile(path.join(alphaRoot, 'one', 'project-notes.md'), '# One\n');
    await fs.writeFile(path.join(alphaRoot, 'two', 'project-notes.md'), '# Two\n');
    await fs.writeFile(path.join(betaRoot, 'notes.md'), '# Notes\n');
    await fs.writeFile(path.join(betaRoot, 'beta-notes.md'), '# Beta Notes\n');

    const html = renderPreviewHtml({
      repo: 'alpha',
      repoRoot: alphaRoot,
      repoMappings: { alpha: alphaRoot, beta: betaRoot },
      relativePath: 'docs/guide.md',
      source: [
        '[cross relative](../../beta/notes.md#beta)',
        `[cross absolute](${path.join(betaRoot, 'notes.md')}?mode=full#beta)`,
        '[cross portable](~/beta/notes.md)',
        '[[beta-notes#beta|Beta wiki]]',
        '[[project-notes]]',
        '`[[beta-notes]]`',
      ].join('\n\n'),
    });

    assert.match(html, /href="\/view\/beta\/notes\.md#beta">cross relative<\/a>/);
    assert.match(html, /href="\/view\/beta\/notes\.md\?mode=full#beta">cross absolute<\/a>/);
    assert.match(html, /href="\/view\/beta\/notes\.md">cross portable<\/a>/);
    assert.match(html, /<a href="\/view\/beta\/beta-notes\.md#beta" class="cross-link">Beta wiki<\/a>/);
    assert.match(html, /<p>\[\[project-notes\]\]<\/p>/);
    assert.doesNotMatch(html, /href="[^"]+project-notes/);
    assert.match(html, /<code>\[\[beta-notes\]\]<\/code>/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('rendered output never discloses home paths or repository root mappings', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-link-disclosure-'));
  const betaRoot = path.join(fixtureRoot, 'beta');
  const genericHome = '/home/generic-user';
  const alphaRoot = `${genericHome}/projects/alpha`;

  try {
    await fs.mkdir(path.join(betaRoot, 'one'), { recursive: true });
    await fs.mkdir(path.join(betaRoot, 'two'), { recursive: true });
    await fs.writeFile(path.join(betaRoot, 'beta-notes.md'), '# Beta\n');
    await fs.writeFile(path.join(betaRoot, 'one', 'duplicate.md'), '# One\n');
    await fs.writeFile(path.join(betaRoot, 'two', 'duplicate.md'), '# Two\n');

    const source = [
      '[relative](../README.md)',
      `[absolute](${alphaRoot}/docs/guide.md)`,
      '[tilde](~/projects/alpha/README.md)',
      '[home]($HOME/projects/alpha/docs/guide.md)',
      `[cross repo](${path.join(betaRoot, 'beta-notes.md')})`,
      '[[beta-notes]]',
      '[[duplicate]]',
      `[host home](${path.join(os.homedir(), 'outside.md')})`,
      '[mac home](/Users/generic-user/outside.md)',
    ].join('\n\n');

    const html = renderDocumentPage({
      repo: 'alpha',
      repoRoot: alphaRoot,
      repoMappings: { alpha: alphaRoot, beta: betaRoot },
      relativePath: 'docs/guide.md',
      source,
      parentHref: '/view/alpha/docs',
      mtime: '2026-01-01',
      size: '1 KB',
      homePath: genericHome,
    });

    assert.match(html, /href="\/view\/beta\/beta-notes\.md" class="cross-link">beta-notes<\/a>/);
    assert.match(html, /<p>\[\[duplicate\]\]<\/p>/);
    assert.doesNotMatch(html, /\/home\//);
    assert.doesNotMatch(html, /\/Users\//);
    assert.doesNotMatch(html, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /repoMappings|repoRoot|rootPath/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
