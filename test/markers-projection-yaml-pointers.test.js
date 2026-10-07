'use strict';

// yaml-pointers projection, driven against an INVENTED record shape with a fake
// guarded CLI and a fake validator (test/fixtures/markers/projection/). The
// invented pointer set used throughout:
//   write:  start -> /result/start_sample and /result/windows/0/start_sample
//           end   -> /result/end_sample
//           body  -> /result/body_start_ms (edge start, ms), /result/body_end_s (edge end, seconds)
//   text:   /result/decision/reason     status: /result/status (onAccept "accepted")
//   history: /log     evidence: /proofs  referenceIn: /result/verification/proof_ids
// The CLI's declared set for a start move is therefore
//   /result/start_sample /result/windows /result/decision/reason /proofs /log /result/verification/proof_ids
// (plus the body pointers when the body region moves).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const { createYamlPointersProjection } = require('../lib/markers/projections/yaml-pointers');
const { createProjectionRunner } = require('../lib/markers/projections');

const FIXTURES = path.join(__dirname, 'fixtures', 'markers', 'projection');
const FAKE_CLI = path.join(FIXTURES, 'fake-ops-yaml.sh');
const FAKE_VALIDATOR = path.join(FIXTURES, 'fake-validator.sh');
const SOURCE = fs.readFileSync(path.join(FIXTURES, 'record.yaml'));
const AUDIO_SHA = 'a'.repeat(64);
const RECORD_ID = '6f1c2a3b-0000-4000-8000-000000000001';
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const PROJECTION = {
  id: 'demo-yaml',
  kind: 'yaml-pointers',
  root: 'demo',
  target: 'target',
  validator: 'demo-check',
  write: [
    { marker: 'start', pointer: '/result/start_sample' },
    { marker: 'start', pointer: '/result/windows/0/start_sample' },
    { marker: 'end', pointer: '/result/end_sample' },
    { marker: 'body', edge: 'start', unit: 'ms', pointer: '/result/body_start_ms' },
    { marker: 'body', edge: 'end', unit: 'seconds', pointer: '/result/body_end_s' },
  ],
  text: [{ pointer: '/result/decision/reason', template: 'Edited by {actor} ({date}): {reason}' }],
  status: { pointer: '/result/status', onAccept: 'accepted' },
  receipts: { dir: '{target.dir}/edits/{audio.basename}', snapshot: 'record-pre-{stamp}.yaml', receipt: 'edit-{stamp}.md' },
  history: { pointer: '/log', append: { record_path: '$snapshot.path', record_sha256: '$snapshot.sha256', reason: 'Edit {date} by {actor}: {reason}' } },
  evidence: {
    pointer: '/proofs',
    append: { id: 'edit-{n}-review', kind: 'review', path: '$receipt.path', sha256: '$receipt.sha256', source_sha256: '$audio.sha256' },
    referenceIn: '/result/verification/proof_ids',
  },
};

const TEMPLATE = {
  templateId: 'demo-markers',
  revision: 1,
  unit: 'samples',
  markers: [
    { id: 'start', kind: 'point' },
    { id: 'end', kind: 'point' },
    { id: 'body', kind: 'region' },
    { id: 'tag', kind: 'point', multiple: true },
  ],
  projections: [PROJECTION],
};

const FAKE_ENV = ['FAKE_LOG', 'FAKE_EXIT_DRY', 'FAKE_EXIT_LIVE', 'FAKE_LIVE_APPLY', 'FAKE_VALIDATOR_EXIT', 'FAKE_VALIDATOR_LOG', 'FAKE_VALIDATOR_FILES'];

function markers(overrides = {}) {
  const base = {
    start: { id: 'start', type: 'start', kind: 'point', sample: 50000 },
    end: { id: 'end', type: 'end', kind: 'point', sample: 240000 },
    body: { id: 'body', type: 'body', kind: 'region', startSample: 96000, endSample: 480000 },
  };
  return Object.values({ ...base, ...overrides }).filter(Boolean);
}

function recordFor(extra = {}) {
  return {
    recordId: RECORD_ID,
    receiptAt: '2026-10-07T18:40:12.000Z',
    actor: { id: 'operator', type: 'operator', name: 'Pat', nameSource: 'self-asserted' },
    reason: 'Floor by ear.\nSecond line.',
    templateId: 'demo-markers',
    templateRevision: 1,
    markers: markers(),
    ...extra,
  };
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    out.push(`${path.relative(base, abs)}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) walk(abs, base, out);
  }
  return out.sort();
}

function setup(t, options = {}) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'projection-yp-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'record.yaml'), SOURCE);
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes', 'first-pass.yaml'), 'earlier pass\n');
  const logFile = path.join(base, 'cli.log');
  const validatorLog = path.join(base, 'validator.log');
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_VALIDATOR_LOG = validatorLog;
  t.after(() => {
    for (const key of FAKE_ENV) delete process.env[key];
    fs.rmSync(base, { recursive: true, force: true });
  });
  const projection = createYamlPointersProjection({
    roots: { demo: { path: root, allowProjections: true, requireValidator: true, ...(options.root || {}) } },
    yamlToolPath: 'yamlToolPath' in options ? options.yamlToolPath : FAKE_CLI,
    validators: { 'demo-check': [FAKE_VALIDATOR, '{candidate}', '{root}'] },
    timezone: 'UTC',
    locateTarget: async () => ({ target: { root: 'demo', relPath: 'data/record.yaml' }, problem: null }),
    ...(options.deps || {}),
  });
  const target = path.join(root, 'data', 'record.yaml');
  return {
    base, root, target, projection, logFile, validatorLog,
    cliLines: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []),
    run: (args = {}) => projection.run({
      template: TEMPLATE,
      projection: PROJECTION,
      record: recordFor(),
      audio: { sha256: AUDIO_SHA, path: 'folder/demo.wav', sampleRate: 48000 },
      mode: 'preview',
      ...args,
    }),
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a ProjectionError');
}

const START_MOVE_POINTERS = [
  '/log', '/proofs', '/result/body_end_s', '/result/body_start_ms', '/result/decision/reason',
  '/result/start_sample', '/result/verification/proof_ids', '/result/windows',
];

test('preview: returns diff, pointers and an advisory validator result, and leaves the tree untouched', async (t) => {
  const s = setup(t);
  const before = walk(s.root);
  const result = await s.run();
  assert.deepEqual(walk(s.root), before);
  assert.deepEqual(fs.readFileSync(s.target), SOURCE);
  assert.equal(result.kind, 'yaml-pointers');
  assert.equal(result.mode, 'preview');
  assert.equal(result.targetPath, 'data/record.yaml');
  assert.equal(result.before, sha(SOURCE));
  assert.deepEqual(result.pointers, START_MOVE_POINTERS);
  assert.deepEqual(result.written, ['start', 'body']);
  assert.equal(result.appends, 'validated on save');
  assert.deepEqual(result.validator, { exit: 0, scope: 'markers-only', advisory: true });
  assert.ok(result.diff.length >= 5);
  assert.ok(result.diff.some((hunk) => hunk.newLines.includes('  start_sample: 50000')));
  assert.match(result.candidateSha256, /^[0-9a-f]{64}$/);
  // The CLI saw one dry run carrying exactly the declared set; never `edit`.
  const lines = s.cliLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^apply live=0 expected=[0-9a-f]{64} allow=/);
  assert.deepEqual(lines[0].split('allow=')[1].trim().split(' ').sort(), START_MOVE_POINTERS);
  assert.match(fs.readFileSync(s.validatorLog, 'utf8'), /validate record.yaml root=yes/);
  assert.equal(JSON.stringify(result).includes(s.root), false, 'no absolute path in the result');
});

test('preview: a failing validator is advisory, never a refusal', async (t) => {
  const s = setup(t);
  process.env.FAKE_VALIDATOR_EXIT = '3';
  const result = await s.run();
  assert.equal(result.validator.exit, 3);
  assert.equal(result.validator.advisory, true);
  assert.deepEqual(walk(s.root).filter((entry) => entry.startsWith('data/edits')), []);
});

test('live: writes snapshot and receipt, applies, reads back, and returns a path-free receipt', async (t) => {
  const s = setup(t);
  process.env.FAKE_VALIDATOR_FILES = '1';
  const result = await s.run({
    mode: 'live', expectedTargetSha256: sha(SOURCE), record: recordFor(),
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.mode, 'live');
  assert.equal(result.kind, 'yaml-pointers');
  assert.equal(result.before, sha(SOURCE));
  assert.deepEqual(result.pointers, START_MOVE_POINTERS);
  assert.deepEqual(result.written, ['start', 'body']);
  assert.deepEqual(result.cli, { dryRunExit: 0, liveExit: 0 });
  assert.equal(result.validator.scope, 'full');
  assert.equal(result.validator.exit, 0);

  const liveBytes = fs.readFileSync(s.target);
  assert.equal(result.targetSha256After, sha(liveBytes));
  assert.equal(result.after, sha(liveBytes));

  // Snapshot is the verbatim preimage; names carry the first 8 characters of the record id.
  assert.equal(result.snapshot.path, 'data/edits/demo.wav/record-pre-20261007T184012Z-6f1c2a3b.yaml');
  assert.equal(result.receipt.path, 'data/edits/demo.wav/edit-20261007T184012Z-6f1c2a3b.md');
  assert.deepEqual(fs.readFileSync(path.join(s.root, result.snapshot.path)), SOURCE);
  assert.equal(result.snapshot.sha256, sha(SOURCE));
  const receiptBytes = fs.readFileSync(path.join(s.root, result.receipt.path));
  assert.equal(result.receipt.sha256, sha(receiptBytes));
  const receiptText = receiptBytes.toString('utf8');
  for (const needle of ['Pat (self-asserted)', '2026-10-07T18:40:12+00:00', RECORD_ID, 'demo-markers r1', sha(SOURCE),
    '> Floor by ear.', '> Second line.', 'samples 48000 -> 50000', 'seconds 1.000000 -> 1.041667', 'data/edits/demo.wav/record-pre']) {
    assert.ok(receiptText.includes(needle), `receipt mentions ${needle}`);
  }

  const doc = yaml.load(liveBytes.toString('utf8'));
  assert.equal(doc.result.start_sample, 50000);
  assert.equal(doc.result.windows[0].start_sample, 50000);
  assert.equal(doc.result.end_sample, 240000);
  assert.equal(doc.result.body_start_ms, 2000); // edge start, ms
  assert.equal(doc.result.body_end_s, 10); // edge end, seconds
  assert.equal(doc.result.decision.reason, 'Edited by Pat (2026-10-07T18:40:12+00:00): Floor by ear. Second line.');
  assert.equal(doc.result.status, 'candidate');
  assert.deepEqual(doc.result.verification.proof_ids, ['p-00', 'edit-1-review']);
  assert.deepEqual(doc.proofs.at(-1), {
    id: 'edit-1-review', kind: 'review', path: result.receipt.path, sha256: result.receipt.sha256, source_sha256: AUDIO_SHA,
  });
  assert.deepEqual(doc.log.at(-1), {
    record_path: result.snapshot.path, record_sha256: result.snapshot.sha256, reason: 'Edit 2026-10-07T18:40:12+00:00 by Pat: Floor by ear. Second line.',
  });

  // Byte surgery: the untouched head of the file is identical, wrapped scalars elsewhere are intact.
  assert.ok(liveBytes.toString('utf8').includes("  notes: 'A wrapped single-quoted scalar that continues\n    onto a second line"));

  // The CLI saw a dry run then --live, with the same declared set; no stdout, no absolute path.
  const lines = s.cliLines();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /live=0/);
  assert.match(lines[1], /live=1/);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(s.root), false);
  assert.equal(serialized.includes('applied:'), false);
  assert.equal(serialized.includes(s.base), false);
  // Nothing transient is left under the root.
  assert.deepEqual(walk(s.root).filter((entry) => entry.includes('lookie-tmp')), []);
});

test('live: the {n} counter continues across edits and a stale expected hash is refused', async (t) => {
  const s = setup(t);
  const first = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) });
  const second = await s.run({
    mode: 'live',
    expectedTargetSha256: first.targetSha256After,
    record: recordFor({ recordId: '7a2b3c4d-0000-4000-8000-000000000002', receiptAt: '2026-10-07T18:41:00.000Z', markers: markers({ start: { id: 'start', type: 'start', kind: 'point', sample: 60000 } }) }),
    predecessor: recordFor(),
  });
  assert.equal(second.status, 'applied');
  const doc = yaml.load(fs.readFileSync(s.target, 'utf8'));
  assert.deepEqual(doc.result.verification.proof_ids, ['p-00', 'edit-1-review', 'edit-2-review']);
  assert.equal(doc.result.start_sample, 60000);
  assert.equal(second.snapshot.sha256, first.targetSha256After);
  assert.deepEqual(second.pointers, ['/log', '/proofs', '/result/decision/reason', '/result/start_sample', '/result/verification/proof_ids', '/result/windows']);
});

test('live: a stale expectedTargetSha256 is 409 target_conflict and nothing is written', async (t) => {
  const s = setup(t);
  const before = walk(s.root);
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(Buffer.from('other')) }));
  assert.equal(error.status, 409);
  assert.equal(error.code, 'target_conflict');
  assert.deepEqual(error.extra, { currentTargetSha256: sha(SOURCE) });
  assert.deepEqual(walk(s.root), before);
  assert.deepEqual(s.cliLines(), []);
});

test('live without expectedTargetSha256 is 400 invalid_request', async (t) => {
  const s = setup(t);
  const error = await rejection(s.run({ mode: 'live' }));
  assert.equal(error.status, 400);
  assert.equal(error.code, 'invalid_request');
});

test('live: a failing validator is 422 and both files (and their directories) are removed', async (t) => {
  const s = setup(t);
  process.env.FAKE_VALIDATOR_EXIT = '3';
  const before = walk(s.root);
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) }));
  assert.equal(error.status, 422);
  assert.equal(error.code, 'validation_error');
  assert.equal(error.details.step, 'validator');
  assert.deepEqual(walk(s.root), before);
  assert.deepEqual(fs.readFileSync(s.target), SOURCE);
  assert.deepEqual(s.cliLines(), [], 'the CLI never ran');
});

test('live: the validator runs with the snapshot and receipt already under the root', async (t) => {
  const s = setup(t);
  process.env.FAKE_VALIDATOR_FILES = '1';
  const ok = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) });
  assert.equal(ok.status, 'applied');
});

test('live: dry-run refusals map to the documented statuses and delete the files', async (t) => {
  const cases = [
    ['4', 409, 'target_conflict'],
    ['5', 500, 'projection_bug'],
    ['3', 422, 'validation_error'],
    ['2', 500, 'projection_unavailable'],
    ['6', 500, 'projection_unavailable'],
  ];
  for (const [exit, status, code] of cases) {
    const s = setup(t);
    process.env.FAKE_EXIT_DRY = exit;
    const before = walk(s.root);
    const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) }));
    assert.equal(error.status, status, `exit ${exit}`);
    assert.equal(error.code, code, `exit ${exit}`);
    assert.deepEqual(walk(s.root), before, `exit ${exit} leaves no files`);
    assert.equal(JSON.stringify(error).includes(s.root), false);
    delete process.env.FAKE_EXIT_DRY;
  }
});

test('preview: a dry-run exit 4 is 409 target_conflict, exit 5 is projection_bug', async (t) => {
  const s = setup(t);
  process.env.FAKE_EXIT_DRY = '4';
  const conflict = await rejection(s.run());
  assert.equal(conflict.code, 'target_conflict');
  assert.equal(conflict.extra.currentTargetSha256, sha(SOURCE));
  process.env.FAKE_EXIT_DRY = '5';
  assert.equal((await rejection(s.run())).code, 'projection_bug');
  assert.deepEqual(walk(s.root).filter((entry) => entry.includes('lookie-tmp')), []);
});

test('live: --live exit 4 is a refusal (no record) and the snapshot and receipt are KEPT', async (t) => {
  const s = setup(t);
  process.env.FAKE_EXIT_LIVE = '4';
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) }));
  assert.equal(error.status, 409);
  assert.equal(error.code, 'target_conflict');
  assert.deepEqual(fs.readFileSync(s.target), SOURCE);
  const kept = walk(s.root).filter((entry) => entry.startsWith('data/edits/demo.wav/') && !entry.endsWith('/'));
  assert.equal(kept.length, 2);
});

test('live: --live exit 6 after the replace is a receipt with status uncertain and the files kept', async (t) => {
  const s = setup(t);
  process.env.FAKE_EXIT_LIVE = '6';
  process.env.FAKE_LIVE_APPLY = '1';
  const result = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.cli.liveExit, 6);
  assert.equal(result.targetSha256After, sha(fs.readFileSync(s.target)));
  assert.equal(result.targetSha256After, result.after, 'the replace did happen');
  assert.ok(fs.existsSync(path.join(s.root, result.snapshot.path)));
  assert.ok(fs.existsSync(path.join(s.root, result.receipt.path)));
  assert.ok(result.note);
});

test('live: --live exit 6 without a replace is uncertain with the actual readback hash', async (t) => {
  const s = setup(t);
  process.env.FAKE_EXIT_LIVE = '6';
  const result = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.targetSha256After, sha(SOURCE));
  assert.notEqual(result.targetSha256After, result.after);
  assert.ok(fs.existsSync(path.join(s.root, result.snapshot.path)));
});

test('live: --live exit 9 is uncertain and nothing is deleted', async (t) => {
  const s = setup(t);
  process.env.FAKE_EXIT_LIVE = '9';
  process.env.FAKE_LIVE_APPLY = '1';
  const result = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.cli.liveExit, 9);
  assert.match(result.note, /nothing restored/);
  assert.ok(fs.existsSync(path.join(s.root, result.receipt.path)));
});

test('live: a validator that fails after the apply makes the receipt uncertain, not an error', async (t) => {
  const s = setup(t);
  // The pre-apply validator run passes; flip the exit for the post-apply run via a wrapper.
  const marker = path.join(s.base, 'validator-calls');
  const wrapper = path.join(s.base, 'validator-wrapper.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nn=$(cat "${marker}" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "${marker}"\n[ "$n" -ge 2 ] && exit 3\nexit 0\n`, { mode: 0o755 });
  const projection = createYamlPointersProjection({
    roots: { demo: { path: s.root, allowProjections: true } },
    yamlToolPath: FAKE_CLI,
    validators: { 'demo-check': [wrapper, '{candidate}'] },
    timezone: 'UTC',
    locateTarget: async () => ({ target: { root: 'demo', relPath: 'data/record.yaml' } }),
  });
  const result = await projection.run({
    template: TEMPLATE, projection: PROJECTION, record: recordFor(), audio: { sha256: AUDIO_SHA, path: 'folder/demo.wav', sampleRate: 48000 },
    mode: 'live', expectedTargetSha256: sha(SOURCE),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.validator.exit, 3);
  assert.equal(result.validator.candidateExit, 0);
});

test('skipped: nothing differs from the predecessor, nothing is written and the CLI never runs', async (t) => {
  const s = setup(t);
  const before = walk(s.root);
  const result = await s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE), predecessor: recordFor() });
  assert.deepEqual([result.kind, result.mode, result.status], ['yaml-pointers', 'live', 'skipped']);
  assert.deepEqual(walk(s.root), before);
  assert.deepEqual(s.cliLines(), []);
});

test('skipped: with no predecessor the marker values are compared with the target', async (t) => {
  const s = setup(t);
  const equalToTarget = markers({
    start: { id: 'start', type: 'start', kind: 'point', sample: 48000 },
    body: { id: 'body', type: 'body', kind: 'region', startSample: 48000, endSample: 240000 },
  });
  const result = await s.run({ record: recordFor({ markers: equalToTarget }) });
  assert.equal(result.status, 'skipped');
});

test('touched-but-unchanged marker: the pointer self-check does not trip (no 500)', async (t) => {
  const s = setup(t);
  // `end` equals the target value; it is touched, so the effective set is non-empty and the
  // text and appends apply, but /result/end_sample is not in the declared set.
  const result = await s.run({ predecessor: recordFor(), touched: ['end'] });
  assert.equal(result.status, 'preview');
  assert.deepEqual(result.pointers, ['/log', '/proofs', '/result/decision/reason', '/result/verification/proof_ids']);
  assert.deepEqual(result.written, ['end']);
});

test('markers unchanged against the predecessor are not written even when the target differs', async (t) => {
  const s = setup(t);
  const predecessor = recordFor({ markers: markers({ start: { id: 'start', type: 'start', kind: 'point', sample: 50000 } }) });
  const record = recordFor({ markers: markers({ end: { id: 'end', type: 'end', kind: 'point', sample: 250000 } }) });
  const result = await s.run({ record: { ...record, markers: record.markers.map((m) => (m.id === 'start' ? { ...m, sample: 50000 } : m)) }, predecessor });
  assert.deepEqual(result.written, ['end']);
  assert.ok(result.pointers.includes('/result/end_sample'));
  assert.equal(result.pointers.includes('/result/start_sample'), false);
});

test('absent markers are skipped, never written as null', async (t) => {
  const s = setup(t);
  const result = await s.run({ record: recordFor({ markers: markers({ body: null, end: null }) }) });
  assert.deepEqual(result.written, ['start']);
  assert.equal(result.pointers.includes('/result/body_start_ms'), false);
});

test('accept sets the status pointer and applies the text even when no marker moved', async (t) => {
  const s = setup(t);
  const equalToTarget = markers({
    start: { id: 'start', type: 'start', kind: 'point', sample: 48000 },
    body: { id: 'body', type: 'body', kind: 'region', startSample: 48000, endSample: 240000 },
  });
  const result = await s.run({
    mode: 'live', expectedTargetSha256: sha(SOURCE), accept: true, record: recordFor({ markers: equalToTarget }),
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.written, []);
  const doc = yaml.load(fs.readFileSync(s.target, 'utf8'));
  assert.equal(doc.result.status, 'accepted');
  assert.match(doc.result.decision.reason, /^Edited by Pat/);
  assert.ok(result.pointers.includes('/result/status'));
});

test('accept without a status.onAccept in the projection is 422', async (t) => {
  const s = setup(t);
  const { status, ...withoutStatus } = PROJECTION;
  const error = await rejection(s.run({ projection: withoutStatus, accept: true }));
  assert.equal(error.status, 422);
});

test('write entries: region edge is required, points take no edge, multiple types are refused', async (t) => {
  const s = setup(t);
  const variant = (write) => ({ ...PROJECTION, write });
  let error = await rejection(s.run({ projection: variant([{ marker: 'body', pointer: '/result/body_start_ms' }]) }));
  assert.equal(error.status, 422);
  assert.match(error.message, /edge/);
  error = await rejection(s.run({ projection: variant([{ marker: 'start', edge: 'start', pointer: '/result/start_sample' }]) }));
  assert.equal(error.status, 422);
  error = await rejection(s.run({
    projection: variant([{ marker: 'tag', pointer: '/result/start_sample' }]),
    record: recordFor({ markers: [...markers(), { id: 't1', type: 'tag', kind: 'point', sample: 5 }] }),
  }));
  assert.equal(error.status, 422);
  assert.match(error.message, /several instances/);
  error = await rejection(s.run({ projection: variant([{ marker: 'start', unit: 'furlongs', pointer: '/result/start_sample' }]) }));
  assert.equal(error.status, 422);
});

test('unit conversion: ms rounds, seconds keeps six decimals', async (t) => {
  const s = setup(t);
  const result = await s.run({
    mode: 'live', expectedTargetSha256: sha(SOURCE),
    record: recordFor({ markers: markers({ body: { id: 'body', type: 'body', kind: 'region', startSample: 48001, endSample: 48001 + 24000 } }) }),
  });
  const doc = yaml.load(fs.readFileSync(s.target, 'utf8'));
  assert.equal(doc.result.body_start_ms, 1000); // 48001 samples = 1000.02 ms
  assert.equal(doc.result.body_end_s, 1.500021);
  assert.equal(result.status, 'applied');
});

test('a write pointer that does not exist in the target is 422 and the projection never creates paths', async (t) => {
  const s = setup(t);
  for (const pointer of ['/result/not_there', '/nowhere/start', '/result/windows/5/start_sample']) {
    const error = await rejection(s.run({
      projection: { ...PROJECTION, write: [{ marker: 'start', pointer }] },
    }));
    assert.equal(error.status, 422, pointer);
    assert.match(error.message, /pointer does not exist in target/);
  }
});

test('unknown substitutions and unsafe receipts paths are 422', async (t) => {
  const s = setup(t);
  let error = await rejection(s.run({ projection: { ...PROJECTION, text: [{ pointer: '/result/decision/reason', template: 'x {nope}' }] } }));
  assert.equal(error.status, 422);
  assert.match(error.message, /unknown substitution \{nope\}/);
  error = await rejection(s.run({ projection: { ...PROJECTION, receipts: { ...PROJECTION.receipts, dir: '{actor}/x' } } }));
  assert.equal(error.status, 422, '{actor} is not a path substitution');
  error = await rejection(s.run({ projection: { ...PROJECTION, receipts: { ...PROJECTION.receipts, dir: '../outside' } } }));
  assert.equal(error.status, 422);
});

test('a symlinked receipts directory that escapes the root is 422 and nothing is written outside', async (t) => {
  const s = setup(t);
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.root, 'data', 'edits'));
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) }));
  assert.equal(error.status, 422);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an existing snapshot name is a projection_bug (the record id suffix makes names unique)', async (t) => {
  const s = setup(t);
  const dir = path.join(s.root, 'data', 'edits', 'demo.wav');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record-pre-20261007T184012Z-6f1c2a3b.yaml'), 'x');
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(SOURCE) }));
  assert.equal(error.status, 500);
  assert.equal(error.code, 'projection_bug');
  assert.equal(fs.readFileSync(path.join(dir, 'record-pre-20261007T184012Z-6f1c2a3b.yaml'), 'utf8'), 'x', 'the pre-existing file is not deleted');
});

test('authority: yamlToolPath absent, root not flagged, validator required', async (t) => {
  let error = await rejection(setup(t, { yamlToolPath: undefined }).run());
  assert.equal(error.status, 409);
  assert.equal(error.code, 'feature_disabled');
  error = await rejection(setup(t, { root: { allowProjections: false } }).run());
  assert.equal(error.status, 403);
  assert.equal(error.code, 'projection_not_allowed');
  const { validator, ...noValidator } = PROJECTION;
  error = await rejection(setup(t).run({ projection: noValidator }));
  assert.equal(error.status, 422);
  const relaxed = setup(t, { root: { requireValidator: false } });
  const result = await relaxed.run({ projection: noValidator });
  assert.deepEqual(result.validator, { exit: null, scope: 'markers-only', advisory: true });
  error = await rejection(setup(t).run({ projection: { ...PROJECTION, validator: 'unknown-id' } }));
  assert.equal(error.code, 'feature_disabled');
  error = await rejection(setup(t).run({ projection: { ...PROJECTION, root: 'elsewhere' } }));
  assert.equal(error.status, 422);
});

test('target resolution: missing target is 404, an explicit target bypasses the locator', async (t) => {
  const missing = setup(t, { deps: { locateTarget: async () => ({ target: null, problem: 'no target found' }) } });
  assert.equal((await rejection(missing.run())).status, 404);
  const noLocator = setup(t, { deps: { locateTarget: undefined } });
  assert.equal((await rejection(noLocator.run())).code, 'feature_disabled');
  const explicit = await noLocator.run({ target: { root: 'demo', relPath: 'data/record.yaml' } });
  assert.equal(explicit.status, 'preview');
  const escaping = await rejection(noLocator.run({ target: { root: 'demo', relPath: '../record.yaml' } }));
  assert.equal(escaping.status, 422);
});

test('the predecessor is loaded through deps.loadRecord when the record supersedes one', async (t) => {
  const loaded = [];
  const s = setup(t, { deps: { loadRecord: async (id) => { loaded.push(id); return recordFor(); } } });
  const result = await s.run({ record: recordFor({ supersedesRecord: { resourceKind: 'marker-record', id: 'prev-id' } }) });
  assert.deepEqual(loaded, ['prev-id']);
  assert.equal(result.status, 'skipped');
});

test('an unsupported target shape is refused with 422, never reflowed', async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.target, SOURCE.toString('utf8').replace('  start_sample: 48000\n  end_sample', '  start_sample: 48000 # why\n  end_sample'));
  const bytes = fs.readFileSync(s.target);
  const error = await rejection(s.run({ mode: 'live', expectedTargetSha256: sha(bytes) }));
  assert.equal(error.status, 422);
  assert.match(error.message, /comment/);
  assert.deepEqual(fs.readFileSync(s.target), bytes);
  assert.deepEqual(walk(s.root).filter((entry) => entry.startsWith('data/edits')), []);
});

test('dispatcher: unknown projection is 404, kinds route to their handler', async (t) => {
  const s = setup(t);
  const runner = createProjectionRunner({ yamlPointers: s.projection });
  const base = { template: TEMPLATE, record: recordFor(), audio: { sha256: AUDIO_SHA, path: 'folder/demo.wav', sampleRate: 48000 }, mode: 'preview' };
  assert.equal((await rejection(runner.project({ ...base, projectionId: 'nope' }))).status, 404);
  const result = await runner.project({ ...base, projectionId: 'demo-yaml' });
  assert.equal(result.status, 'preview');
  const rivendell = { id: 'r', kind: 'rivendell', map: { start: ['START_POINT', 'END_POINT'] } };
  const error = await rejection(runner.project({ ...base, template: { ...TEMPLATE, projections: [rivendell] }, projectionId: 'r' }));
  assert.equal(error.code, 'feature_disabled');
});

// ---- real CLI (opt in) ------------------------------------------------------------

const REAL_CLI = process.env.LOOKIE_TEST_OPS_YAML || '';

test('real ops-yaml: preview, live apply and a stale refusal against a copy', { skip: !fs.existsSync(REAL_CLI) && 'set LOOKIE_TEST_OPS_YAML to the ops-yaml launcher' }, async (t) => {
  const s = setup(t, { yamlToolPath: REAL_CLI, root: { requireValidator: false } });
  const noValidator = (({ validator, ...rest }) => rest)(PROJECTION);
  const preview = await s.run({ projection: noValidator });
  assert.equal(preview.status, 'preview');
  assert.deepEqual(fs.readFileSync(s.target), SOURCE);
  const live = await s.run({ projection: noValidator, mode: 'live', expectedTargetSha256: sha(SOURCE) });
  assert.equal(live.status, 'applied');
  assert.equal(live.cli.liveExit, 0);
  assert.equal(live.targetSha256After, live.after);
  assert.equal(sha(fs.readFileSync(s.target)), live.after);
  // The CLI keeps its own preimage beside the destination; ours is the explicit copy.
  assert.deepEqual(fs.readFileSync(path.join(s.root, live.snapshot.path)), SOURCE);
  const stale = await rejection(s.run({
    projection: noValidator, mode: 'live', expectedTargetSha256: sha(SOURCE),
    record: recordFor({ recordId: '9b8a7c6d-0000-4000-8000-000000000003', markers: markers({ start: { id: 'start', type: 'start', kind: 'point', sample: 60000 } }) }),
  }));
  assert.equal(stale.code, 'target_conflict');
});
