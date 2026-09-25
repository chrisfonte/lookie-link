'use strict';

// Runs the unified `lookie` CLI as a child process against a real createApp
// instance (API review 2026-09-23 item 8: CLI parity with the HTTP API).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createApp } = require('../server');

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '..', 'bin', 'lookie.js');
const ADMIN = 'cli-appearance-admin-placeholder';
const MANAGED_ADMIN = 'cli-managed-admin-placeholder';

async function startServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-cli-commands-'));
  const docs = path.join(root, 'docs');
  const allowRoot = path.join(root, 'managed');
  const home = path.join(root, 'home');
  const kitsManaged = path.join(root, 'kits-managed');
  await Promise.all([fs.mkdir(docs), fs.mkdir(allowRoot), fs.mkdir(home), fs.mkdir(kitsManaged)]);
  await fs.writeFile(path.join(docs, 'guide.md'), '# Guide\n\nBody\n');
  const app = createApp({
    mappings: { docs },
    annotationsEnabled: true,
    appearanceOverlayPath: path.join(root, 'appearance.yaml'),
    managedReposConfig: {
      storePath: path.join(root, 'registry.yaml'),
      allowRoots: [allowRoot],
      adminTokens: { operator: { secret: MANAGED_ADMIN } },
    },
    accessConfig: { grants: { adminTokens: { t: { secret: ADMIN } } } },
    kitsConfig: { enabled: true, managedFolder: kitsManaged },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    allowRoot,
    baseUrl,
    async cli(args, env = {}) {
      try {
        const result = await execFileAsync(process.execPath, [cliPath, '--base-url', baseUrl, ...args], {
          env: { ...process.env, HOME: home, LOOKIE_LINK_TOKEN: '', LOOKIE_LINK_ADMIN_TOKEN: '', ...env },
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('lookie annotations add then list round-trips through the server', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const added = await s.cli(['annotations', 'add', 'docs/guide.md', '--anchor', '#guide', '--kind', 'heading', '--body', 'Tighten this', '--author', 'tester']);
  assert.equal(added.code, 0, added.stderr);
  const listed = await s.cli(['annotations', 'list', 'docs/guide.md']);
  assert.equal(listed.code, 0, listed.stderr);
  const doc = JSON.parse(listed.stdout);
  assert.equal(doc.annotations.length, 1);
  assert.equal(doc.annotations[0].body, 'Tighten this');
  const id = doc.annotations[0].id;
  const resolved = await s.cli(['annotations', 'resolve', 'docs/guide.md', id]);
  assert.equal(resolved.code, 0, resolved.stderr);
  const open = JSON.parse((await s.cli(['annotations', 'list', 'docs/guide.md', '--state', 'open'])).stdout);
  assert.equal(open.annotations.length, 0);
  const missing = await s.cli(['annotations', 'get', 'docs/guide.md', 'no-such-id']);
  assert.equal(missing.code, 4);
});

test('lookie appearance show exposes a revision and set PATCHes with expectedRevision', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const shown = await s.cli(['appearance', 'show']);
  assert.equal(shown.code, 0, shown.stderr);
  const before = JSON.parse(shown.stdout);
  assert.equal(Number.isInteger(before.revision), true);

  const denied = await s.cli(['appearance', 'set', '--revision', String(before.revision), '--blur', '4']);
  assert.equal(denied.code, 3);

  const set = await s.cli(['appearance', 'set', '--revision', String(before.revision), '--blur', '4', '--panel', '80'], { LOOKIE_LINK_ADMIN_TOKEN: ADMIN });
  assert.equal(set.code, 0, set.stderr);
  assert.doesNotMatch(set.stdout + set.stderr, new RegExp(ADMIN));
  const after = JSON.parse((await s.cli(['appearance', 'show'])).stdout);
  assert.notEqual(after.revision, before.revision);
  assert.match(await fs.readFile(path.join(s.root, 'appearance.yaml'), 'utf8'), /blur: 4/);

  const stale = await s.cli(['appearance', 'set', '--revision', String(before.revision), '--blur', '2'], { LOOKIE_LINK_TOKEN: ADMIN });
  assert.equal(stale.code, 5);
});

test('lookie kits / kit show / kit file round-trip the hosted kit API', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const listed = await s.cli(['kits']);
  assert.equal(listed.code, 0, listed.stderr);
  const list = JSON.parse(listed.stdout);
  assert.equal(list.ok, true);
  assert.ok(list.kits.some((kit) => kit.name === 'ops' && kit.version === '1.26'));

  const shown = await s.cli(['kit', 'show', 'ops']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).kit.name, 'ops');

  const file = await s.cli(['kit', 'file', 'ops', 'email-table-template.html']);
  assert.equal(file.code, 0, file.stderr);
  assert.match(file.stdout, /<!DOCTYPE html>|<html/i);

  const missing = await s.cli(['kit', 'show', 'no-such-kit']);
  assert.equal(missing.code, 4);
});

test('lookie kit create / set / upload / delete round-trip the admin kit API', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const cssPath = path.join(s.root, 'demo.css');
  const tplPath = path.join(s.root, 'card.html');
  await fs.writeFile(cssPath, ':root{--demo:1}\n');
  await fs.writeFile(tplPath, '<html>card</html>\n');

  const created = await s.cli([
    'kit', 'create',
    '--name', 'clidemo',
    '--label', 'CLI Demo',
    '--version', '0.1.0',
    '--stylesheet', cssPath,
    '--template', tplPath,
  ], { LOOKIE_LINK_TOKEN: ADMIN });
  assert.equal(created.code, 0, created.stderr);
  const createdBody = JSON.parse(created.stdout);
  assert.equal(createdBody.kit.name, 'clidemo');
  assert.equal(createdBody.kit.source, 'org');
  assert.equal(createdBody.kit.scope, 'org');

  const listed = JSON.parse((await s.cli(['kits'])).stdout);
  const set = await s.cli([
    'kit', 'set', 'clidemo',
    '--revision', listed.revision,
    '--token', '--radius=8px',
  ], { LOOKIE_LINK_TOKEN: ADMIN });
  assert.equal(set.code, 0, set.stderr);
  assert.match(JSON.parse(set.stdout).kit.effectiveVersion, /\+/) ;

  const extra = path.join(s.root, 'extra.html');
  await fs.writeFile(extra, '<p>extra</p>\n');
  const uploaded = await s.cli(['kit', 'upload', 'clidemo', extra], { LOOKIE_LINK_TOKEN: ADMIN });
  assert.equal(uploaded.code, 0, uploaded.stderr);

  const deleted = await s.cli(['kit', 'delete', 'clidemo'], { LOOKIE_LINK_TOKEN: ADMIN });
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal((await s.cli(['kit', 'show', 'clidemo'])).code, 4);
});

test('lookie changes accepts ISO --since and sends milliseconds; openapi and docs print', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const create = await fetch(`${s.baseUrl}/api/managed-repos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGED_ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId: 'notes', rootPath: path.join(s.allowRoot, 'notes') }),
  });
  assert.equal(create.status, 201);
  const write = await s.cli(['write', 'notes/a.md', '--content', 'hello']);
  assert.equal(write.code, 0, write.stderr);

  const past = JSON.parse((await s.cli(['changes', 'notes', '--since', '2000-01-01T00:00:00Z'])).stdout);
  assert.deepEqual(past.entries.map((e) => e.path), ['a.md']);
  const future = JSON.parse((await s.cli(['changes', 'notes', '--since', '2999-01-01T00:00:00Z'])).stdout);
  assert.equal(future.count, 0);
  const seconds = JSON.parse((await s.cli(['changes', 'notes', '--since', String(Math.floor(Date.now() / 1000) - 3600)])).stdout);
  assert.equal(seconds.count, 1);
  assert.equal((await s.cli(['changes', 'notes', '--since', 'not-a-date'])).code, 2);

  const openapi = await s.cli(['openapi']);
  assert.equal(openapi.code, 0, openapi.stderr);
  assert.ok(JSON.parse(openapi.stdout).openapi);
  const docs = await s.cli(['docs']);
  assert.equal(docs.stdout.trim(), `${s.baseUrl}/api/docs`);

  const trashList = await s.cli(['trash', 'list', 'notes']);
  assert.equal(trashList.code, 0, trashList.stderr);
  assert.deepEqual(JSON.parse(trashList.stdout).trash, [], 'the fixture repo has no soft-deleted records yet');
  assert.equal((await s.cli(['trash', 'restore', 'notes', '00000000-0000-4000-8000-000000000000'])).code, 4);
});
