'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'generated', 'skill-packages');

test('generated skill packages stay in exact sync with the source spec', async () => {
  await execFileAsync(process.execPath, [path.join(root, 'scripts', 'generate-skill-packages.js'), '--check'], {
    cwd: root,
  });
});

test('generated runtime files use valid wrappers and implemented commands only', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.outputs, [...manifest.outputs].sort());
  assert.deepEqual(manifest.outputs, [
    'claude-code/lookie-link/SKILL.md',
    'codex/lookie-link/SKILL.md',
    'cursor/lookie-link/.cursorrules',
  ]);

  for (const runtime of ['claude-code', 'codex']) {
    const content = await fs.readFile(path.join(outputRoot, runtime, 'lookie-link', 'SKILL.md'), 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, `${runtime} skill has YAML frontmatter`);
    const frontmatter = yaml.load(match[1]);
    assert.equal(frontmatter.name, 'lookie-link');
    assert.equal(typeof frontmatter.description, 'string');
  }

  const generated = await Promise.all(manifest.outputs.map((relativePath) => fs.readFile(path.join(outputRoot, relativePath), 'utf8')));
  const combined = generated.join('\n').toLowerCase();
  for (const unimplemented of ['lookie share', 'lookie list', 'lookie move', 'lookie cache', '--no-cache']) {
    assert.doesNotMatch(combined, new RegExp(unimplemented));
  }
});
