'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { SubmissionStore } = require('../lib/forms/submission-store');

const SCHEMA_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FIXED_TIME = '2026-07-20T17:42:19.123Z';

function submission(overrides = {}) {
  return {
    actor: { id: 'coach-one', type: 'user' },
    templateId: 'activity-log',
    templateVersion: 3,
    schemaDigest: SCHEMA_DIGEST,
    eventAt: '2026-07-20T09:30:00-04:00',
    timezone: 'America/New_York',
    clientOffsetMinutes: -240,
    values: [
      {
        fieldId: 'activity',
        fieldType: 'select',
        fieldLabel: 'Activity',
        value: 'walk',
        selectedOptions: [{ optionId: 'walk', optionLabel: 'Walk' }],
      },
      { fieldId: 'duration', fieldType: 'number', fieldLabel: 'Duration', value: 30 },
      { fieldId: 'notes', fieldType: 'long-text', fieldLabel: 'Notes', value: 'Easy pace' },
    ],
    ...overrides,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-submission-store-'));
  const storageRoot = path.join(root, 'submissions');
  return {
    root,
    storageRoot,
    store: new SubmissionStore({
      storageRoot,
      clock: () => new Date(FIXED_TIME),
    }),
  };
}

async function removeFixture(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('submission records round-trip with exact capture-time contract fields', async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.createSubmission(submission(), {
      idempotencyKey: 'round-trip-request-0001',
    });
    assert.match(created.submissionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(created).sort(), [
      'actor',
      'clientOffsetMinutes',
      'eventAt',
      'idempotencyKeyDigest',
      'receiptAt',
      'requestDigest',
      'schemaDigest',
      'submissionId',
      'templateId',
      'templateVersion',
      'timezone',
      'values',
    ]);
    assert.equal(created.receiptAt, FIXED_TIME);
    assert.deepEqual(created.actor, { id: 'coach-one', type: 'user' });
    assert.deepEqual(created.values, submission().values);
    assert.match(created.idempotencyKeyDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(created.requestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(created), /round-trip-request-0001/);

    const recordStat = await fs.stat(store.recordPath(created.submissionId));
    assert.equal(recordStat.mode & 0o777, 0o600);
    assert.equal(recordStat.nlink, 1);

    assert.deepEqual(await store.getSubmission(created.submissionId), created);
    const listed = await store.listSubmissions({ templateId: 'activity-log' });
    assert.deepEqual(listed, [{
      submissionId: created.submissionId,
      receiptAt: FIXED_TIME,
      eventAt: '2026-07-20T09:30:00-04:00',
      timezone: 'America/New_York',
      clientOffsetMinutes: -240,
      templateId: 'activity-log',
      templateVersion: 3,
      schemaDigest: SCHEMA_DIGEST,
    }]);
    assert.equal(Object.hasOwn(listed[0], 'actor'), false);
    assert.equal(Object.hasOwn(listed[0], 'values'), false);
  } finally {
    await removeFixture(root);
  }
});

test('idempotency metadata is omitted when no key is supplied', async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.createSubmission(submission({
      eventAt: undefined,
      timezone: undefined,
      clientOffsetMinutes: undefined,
    }));
    assert.equal(Object.hasOwn(created, 'idempotencyKeyDigest'), false);
    assert.equal(Object.hasOwn(created, 'requestDigest'), false);
    assert.equal(Object.hasOwn(created, 'eventAt'), false);
    assert.deepEqual(await store.getSubmission(created.submissionId), created);
  } finally {
    await removeFixture(root);
  }
});

test('an existing submission ID cannot be overwritten and its bytes remain identical', async () => {
  const { root, storageRoot, store } = await fixture();
  const submissionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    await store.createSubmission(submission({ submissionId }), {
      idempotencyKey: 'first-immutable-write-0001',
    });
    const recordPath = path.join(storageRoot, `${submissionId}.json`);
    const before = await fs.readFile(recordPath);

    await assert.rejects(
      store.createSubmission(submission({ submissionId, values: [
        { fieldId: 'notes', fieldType: 'long-text', fieldLabel: 'Notes', value: 'Replacement' },
      ] }), { idempotencyKey: 'second-immutable-write-0002' }),
      (error) => error.code === 'EEXIST'
    );
    const after = await fs.readFile(recordPath);
    assert.equal(Buffer.compare(before, after), 0);
  } finally {
    await removeFixture(root);
  }
});

test('idempotent replay returns the original record after restart and writes no new file', async () => {
  const { root, storageRoot, store } = await fixture();
  try {
    const input = submission();
    const original = await store.createSubmission(input, {
      idempotencyKey: 'stable-replay-key-0001',
    });
    const restartedStore = new SubmissionStore({
      storageRoot,
      clock: () => new Date('2026-07-20T18:00:00.000Z'),
    });
    const replay = await restartedStore.createSubmission(input, {
      idempotencyKey: 'stable-replay-key-0001',
    });

    assert.deepEqual(replay, original);
    assert.equal(replay.submissionId, original.submissionId);
    assert.deepEqual(
      (await fs.readdir(storageRoot)).filter((name) => name.endsWith('.json')),
      [`${original.submissionId}.json`]
    );
  } finally {
    await removeFixture(root);
  }
});

test('reusing an idempotency key for different payload is a side-effect-free conflict', async () => {
  const { root, storageRoot, store } = await fixture();
  try {
    const original = await store.createSubmission(submission(), {
      idempotencyKey: 'conflict-request-key-0001',
    });
    const recordPath = path.join(storageRoot, `${original.submissionId}.json`);
    const before = await fs.readFile(recordPath);

    await assert.rejects(
      store.createSubmission(submission({ values: [
        { fieldId: 'notes', fieldType: 'long-text', fieldLabel: 'Notes', value: 'Different intent' },
      ] }), { idempotencyKey: 'conflict-request-key-0001' }),
      (error) => error.code === 'ECONFLICT'
    );
    assert.deepEqual(await fs.readdir(storageRoot), [`${original.submissionId}.json`]);
    assert.equal(Buffer.compare(before, await fs.readFile(recordPath)), 0);
  } finally {
    await removeFixture(root);
  }
});

test('selected option labels are immutable snapshots of capture-time template meaning', async () => {
  const { root, store } = await fixture();
  try {
    const template = {
      fields: [{
        id: 'activity',
        type: 'select',
        options: [{ id: 'walk', label: 'Walk' }],
      }],
    };
    const input = submission({
      values: [{
        fieldId: template.fields[0].id,
        fieldType: template.fields[0].type,
        fieldLabel: 'Activity',
        value: template.fields[0].options[0].id,
        selectedOptions: [{
          optionId: template.fields[0].options[0].id,
          optionLabel: template.fields[0].options[0].label,
        }],
      }],
    });
    const created = await store.createSubmission(input, {
      idempotencyKey: 'label-snapshot-key-0001',
    });

    template.fields[0].options[0].label = 'Outdoor walk';
    input.values[0].selectedOptions[0].optionLabel = 'Changed caller object';
    const stored = await store.getSubmission(created.submissionId);
    assert.equal(stored.values[0].selectedOptions[0].optionLabel, 'Walk');
  } finally {
    await removeFixture(root);
  }
});

test('a simulated mid-write failure removes the sibling temp file and never publishes partial JSON', async () => {
  const { root, storageRoot, store } = await fixture();
  try {
    store.writeTempContents = async (handle) => {
      await handle.writeFile('{"partial":', 'utf8');
      throw new Error('injected mid-write failure');
    };

    await assert.rejects(
      store.createSubmission(submission(), { idempotencyKey: 'failed-write-key-0001' }),
      /injected mid-write failure/
    );
    assert.deepEqual(await fs.readdir(storageRoot), []);
  } finally {
    await removeFixture(root);
  }
});

test('a rejected invalid write has no filesystem side effects', async () => {
  const { root, storageRoot, store } = await fixture();
  try {
    await assert.rejects(
      store.createSubmission(submission({
        values: [{
          fieldId: 'activity',
          fieldType: 'select',
          fieldLabel: 'Activity',
          value: 'walk',
          selectedOptions: [{ optionId: 'walk', optionLabel: 'Walk' }],
          unexpected: 'rejected',
        }],
      }), { idempotencyKey: 'invalid-write-key-0001' }),
      (error) => error.code === 'EVALIDATION'
    );
    await assert.rejects(fs.access(storageRoot), { code: 'ENOENT' });
  } finally {
    await removeFixture(root);
  }
});
