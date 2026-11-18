'use strict';

// JSON submit conveniences: a pinned select (exactly one enabled option) is
// stamped on the page and filled when omitted from JSON, field defaults are NOT applied, and the
// event-time trio is derived from an offset-bearing datetime field value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

const { createApp } = require('../server');
const { TemplateRegistry } = require('../lib/forms/template-registry');
const { SubmissionStore } = require('../lib/forms/submission-store');
const { SubmissionService } = require('../lib/forms/submission-service');

const PUBLIC_ORIGIN = 'http://forms.example.test';

function template(templateId, fields) {
  return {
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId,
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: templateId,
    fields,
  };
}

const TEMPLATES = [
  template('machine-log', [
    { id: 'logged-at', type: 'datetime', label: 'Logged at', required: true },
    { id: 'machine', type: 'select', label: 'Machine', required: true, options: [{ id: 'rower', label: 'Rower' }] },
    { id: 'minutes', type: 'number', label: 'Minutes', required: true },
    {
      id: 'effort', type: 'select', label: 'Effort', required: true, default: 'easy',
      options: [{ id: 'easy', label: 'Easy' }, { id: 'hard', label: 'Hard' }],
    },
  ]),
  template('retired-option-log', [
    {
      id: 'station', type: 'select', label: 'Station', required: true,
      options: [{ id: 'old', label: 'Old', disabled: true }, { id: 'new', label: 'New' }],
    },
  ]),
  template('two-choice-log', [
    {
      id: 'station', type: 'select', label: 'Station', required: true,
      options: [{ id: 'old', label: 'Old', disabled: true }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    },
  ]),
  template('edge-select-log', [
    { id: 'count', type: 'number', label: 'Count', required: true },
    { id: 'room', type: 'select', label: 'Room', required: false, options: [{ id: 'east', label: 'East' }] },
    { id: 'retired', type: 'select', label: 'Retired', required: false, options: [{ id: 'gone', label: 'Gone', disabled: true }] },
    { id: 'tags', type: 'multi-select', label: 'Tags', required: false, options: [{ id: 'solo', label: 'Solo' }] },
  ]),
  template('two-clock-log', [
    { id: 'started-at', type: 'datetime', label: 'Started', required: true },
    { id: 'ended-at', type: 'datetime', label: 'Ended', required: true },
  ]),
];

async function makeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-forms-json-'));
  const templatesPath = path.join(root, 'templates');
  const submissionsPath = path.join(root, 'submissions');
  await fs.mkdir(templatesPath);
  for (const entry of TEMPLATES) {
    await fs.writeFile(path.join(templatesPath, `${entry.templateId}.yaml`), yaml.dump(entry), 'utf8');
  }
  const app = createApp({
    mappings: {},
    accessConfig: { humanDefault: 'full' },
    formsConfig: { enabled: true, templatesPath, submissionsPath },
    formsPublicOrigin: PUBLIC_ORIGIN,
    formsAudit: () => {},
    formsTimezone: 'America/New_York',
  });
  return {
    root,
    templatesPath,
    submissionsPath,
    request: (route, init) => inject(app, route, init),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function inject(app, route, init = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const request = new http.IncomingMessage(socket);
    request.method = init.method || 'GET';
    request.url = route;
    request.headers = { host: 'forms.example.test' };
    for (const [name, value] of Object.entries(init.headers || {})) request.headers[name.toLowerCase()] = value;
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(String(init.body));
    if (body.length > 0) request.headers['content-length'] = String(body.length);
    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    const chunks = [];
    response.write = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      return true;
    };
    response.end = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      response.emit('finish');
      return response;
    };
    response.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const headers = response.getHeaders();
      resolve({
        status: response.statusCode,
        header: (name) => {
          const value = headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        },
        text,
        json: () => JSON.parse(text),
      });
    });
    response.on('error', reject);
    app.handle(request, response, reject);
    request.push(body);
    request.push(null);
  });
}

async function jsonClient(server, templateId) {
  const page = await server.request(`/forms/${templateId}`);
  assert.equal(page.status, 200);
  const cookie = page.header('set-cookie').split(';', 1)[0];
  const token = new JSDOM(page.text).window.document.querySelector('input[name="_csrf"]').value;
  return (payload) => server.request(`/api/forms/${templateId}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: PUBLIC_ORIGIN, 'X-CSRF-Token': token },
    body: JSON.stringify(payload),
  });
}

async function storedRecords(submissionsPath) {
  const names = (await fs.readdir(submissionsPath).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(submissionsPath, name), 'utf8'))));
}

function eventTrio(record) {
  return { eventAt: record.eventAt, timezone: record.timezone, clientOffsetMinutes: record.clientOffsetMinutes };
}

test('an omitted pinned select is filled exactly as if the caller had sent it', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const base = { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 20, effort: 'easy' };
    const omitted = await submit({ values: base, idempotencyKey: 'pinned-omitted-0001' });
    assert.equal(omitted.status, 201, omitted.text);
    const stated = await submit({ values: { ...base, machine: 'rower' }, idempotencyKey: 'pinned-stated-0001' });
    assert.equal(stated.status, 201, stated.text);
    const [first, second] = [omitted.json().receipt, stated.json().receipt];
    assert.deepEqual(first.values, second.values, 'same stored values whether the pinned value is sent or not');
    assert.deepEqual(first.values.find((entry) => entry.fieldId === 'machine').selectedOptions, [
      { optionId: 'rower', optionLabel: 'Rower' },
    ]);

    // A stated value is never overridden: an undeclared option still fails.
    const wrong = await submit({ values: { ...base, machine: 'bike' } });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.json().error.details.some((entry) => entry.path === 'values.machine'));
    assert.equal((await storedRecords(server.submissionsPath)).length, 2);
  } finally {
    await server.cleanup();
  }
});

test('field defaults are not applied on the JSON path', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const response = await submit({ values: { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 20 } });
    assert.equal(response.status, 422);
    const details = response.json().error.details;
    assert.deepEqual(details.map((entry) => entry.path), ['values.effort']);
    assert.equal(details[0].message, 'is required');
    assert.deepEqual(await storedRecords(server.submissionsPath), []);
  } finally {
    await server.cleanup();
  }
});

test('one enabled option beside disabled leftovers is pinned on the page and in JSON', async () => {
  const server = await makeServer();
  try {
    // The page stamps the enabled option and posts it as a hidden input.
    const page = await server.request('/forms/retired-option-log');
    const document = new JSDOM(page.text).window.document;
    assert.equal(document.querySelector('.field-pinned').textContent, 'New');
    assert.equal(document.querySelector('input[type="hidden"][name="station"]').value, 'new');
    assert.equal(document.querySelector('select[name="station"]'), null, 'no picker for a pinned select');

    // JSON submit fills the same option when it is omitted.
    const submit = await jsonClient(server, 'retired-option-log');
    const filled = await submit({ values: {} });
    assert.equal(filled.status, 201, filled.text);
    assert.deepEqual(filled.json().receipt.values[0].selectedOptions, [{ optionId: 'new', optionLabel: 'New' }]);

    // The disabled leftover is still refused when it is stated.
    const stale = await submit({ values: { station: 'old' } });
    assert.equal(stale.status, 422);
    assert.equal(stale.json().error.details[0].path, 'values.station');
  } finally {
    await server.cleanup();
  }
});

test('two enabled options are a question even beside a disabled one', async () => {
  const server = await makeServer();
  try {
    const page = await server.request('/forms/two-choice-log');
    assert.doesNotMatch(page.text, /field-pinned/);
    const submit = await jsonClient(server, 'two-choice-log');
    const response = await submit({ values: {} });
    assert.equal(response.status, 422);
    assert.equal(response.json().error.details[0].path, 'values.station');
  } finally {
    await server.cleanup();
  }
});

test('the event-time trio is derived from an offset-bearing datetime value', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const values = (loggedAt) => ({ 'logged-at': loggedAt, minutes: 20, effort: 'hard' });
    const cases = [
      // Server zone agrees at that instant (summer and winter).
      ['2026-07-20T09:30:00-04:00', { timezone: 'America/New_York', clientOffsetMinutes: -240 }],
      ['2026-01-20T09:30:00-05:00', { timezone: 'America/New_York', clientOffsetMinutes: -300 }],
      // Server zone disagrees: a fixed IANA zone for whole hours.
      ['2026-07-20T22:30:00+09:00', { timezone: 'Etc/GMT-9', clientOffsetMinutes: 540 }],
      ['2026-07-20T13:30:00Z', { timezone: 'UTC', clientOffsetMinutes: 0 }],
    ];
    for (const [loggedAt, expected] of cases) {
      const response = await submit({ values: values(loggedAt) });
      assert.equal(response.status, 201, response.text);
      const receipt = response.json().receipt;
      assert.deepEqual(eventTrio(receipt), { eventAt: loggedAt, ...expected });
      assert.equal(receipt.values.find((entry) => entry.fieldId === 'logged-at').value, loggedAt);
    }

    // Half-hour offset outside the server zone: current behaviour is that no
    // zone is invented and eventAt stays absent (display falls back to
    // receiptAt). The fallback is an open owner decision; this pins today.
    const unnamed = await submit({ values: values('2026-07-20T19:00:00+05:30') });
    assert.equal(unnamed.status, 201, unnamed.text);
    assert.equal(unnamed.json().receipt.eventAt, undefined);

    const records = await storedRecords(server.submissionsPath);
    assert.equal(records.length, cases.length + 1);
    assert.equal(records.filter((record) => record.eventAt !== undefined).length, cases.length);
  } finally {
    await server.cleanup();
  }
});

test('an explicit trio fills an omitted sole datetime field and stays all-or-none', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const trio = { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240 };
    const filled = await submit({ values: { minutes: 20, effort: 'easy' }, ...trio });
    assert.equal(filled.status, 201, filled.text);
    const receipt = filled.json().receipt;
    assert.deepEqual(eventTrio(receipt), trio);
    assert.equal(receipt.values.find((entry) => entry.fieldId === 'logged-at').value, trio.eventAt);

    // An explicit trio beside an explicit datetime keeps both as sent.
    const both = await submit({ values: { 'logged-at': '2026-07-19T08:00:00-04:00', minutes: 20, effort: 'easy' }, ...trio });
    assert.equal(both.status, 201, both.text);
    assert.equal(both.json().receipt.eventAt, trio.eventAt);
    assert.equal(both.json().receipt.values.find((entry) => entry.fieldId === 'logged-at').value, '2026-07-19T08:00:00-04:00');

    // Partial trios are still refused, even with a datetime value to derive from.
    const partial = await submit({
      values: { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 20, effort: 'easy' },
      timezone: 'America/New_York',
    });
    assert.equal(partial.status, 422);
    assert.equal(partial.json().error.details[0].path, 'eventTime');
    assert.equal((await storedRecords(server.submissionsPath)).length, 2);
  } finally {
    await server.cleanup();
  }
});

test('with two datetime fields the trio fills neither, and derivation uses the first value', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'two-clock-log');
    const trio = { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240 };
    const ambiguous = await submit({ values: {}, ...trio });
    assert.equal(ambiguous.status, 422);
    assert.deepEqual(ambiguous.json().error.details.map((entry) => entry.path).sort(), ['values.ended-at', 'values.started-at']);

    const derived = await submit({ values: { 'started-at': '2026-07-20T09:00:00-04:00', 'ended-at': '2026-07-20T10:00:00-04:00' } });
    assert.equal(derived.status, 201, derived.text);
    assert.equal(derived.json().receipt.eventAt, '2026-07-20T09:00:00-04:00');
  } finally {
    await server.cleanup();
  }
});

test('an idempotent retry of a request stored before the fills replays instead of conflicting', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    // Learn the caller's recorded actor from an ordinary entry.
    const first = await submit({ values: { 'logged-at': '2026-07-18T09:30:00-04:00', minutes: 5, effort: 'easy' } });
    assert.equal(first.status, 201, first.text);
    const actor = first.json().receipt.actor;

    // Store the request the way the JSON path did before this change: the
    // pinned value sent, no event-time trio derived.
    const legacyValues = { 'logged-at': '2026-07-20T09:30:00-04:00', machine: 'rower', minutes: 20, effort: 'easy' };
    const legacyService = new SubmissionService({
      registry: new TemplateRegistry({ templatesPath: server.templatesPath }),
      store: new SubmissionStore({ storageRoot: server.submissionsPath }),
    });
    const legacy = await legacyService.submit({
      templateId: 'machine-log', values: legacyValues, actor, idempotencyKey: 'pre-upgrade-0001',
    });
    assert.equal(legacy.error, undefined, JSON.stringify(legacy.error));
    assert.equal(legacy.receipt.eventAt, undefined);
    const before = await storedRecords(server.submissionsPath);

    // The identical retry now gets the original receipt back, unchanged.
    const replay = await submit({ values: legacyValues, idempotencyKey: 'pre-upgrade-0001' });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.json().submissionId, legacy.submissionId);
    assert.equal(replay.json().receipt.eventAt, undefined);
    // ...and so does the same retry with the pinned value left out.
    const omitted = { ...legacyValues };
    delete omitted.machine;
    const replayOmitted = await submit({ values: omitted, idempotencyKey: 'pre-upgrade-0001' });
    assert.equal(replayOmitted.status, 201, replayOmitted.text);
    assert.equal(replayOmitted.json().submissionId, legacy.submissionId);

    // A changed request under the same key is still a conflict.
    const changed = await submit({ values: { ...legacyValues, minutes: 21 }, idempotencyKey: 'pre-upgrade-0001' });
    assert.equal(changed.status, 409);
    assert.deepEqual(await storedRecords(server.submissionsPath), before, 'stored records untouched');
  } finally {
    await server.cleanup();
  }
});

test('a retry after the fills replays whether or not the filled values are sent', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const values = { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 20, effort: 'easy' };
    const created = await submit({ values, idempotencyKey: 'post-upgrade-0001' });
    assert.equal(created.status, 201, created.text);
    const id = created.json().submissionId;
    const same = await submit({ values, idempotencyKey: 'post-upgrade-0001' });
    assert.equal(same.json().submissionId, id);
    const explicit = await submit({
      values: { ...values, machine: 'rower' },
      eventAt: values['logged-at'], timezone: 'America/New_York', clientOffsetMinutes: -240,
      idempotencyKey: 'post-upgrade-0001',
    });
    assert.equal(explicit.status, 201, explicit.text);
    assert.equal(explicit.json().submissionId, id);
    assert.equal((await storedRecords(server.submissionsPath)).length, 1);
  } finally {
    await server.cleanup();
  }
});

test('minute-precision offsets are accepted, stored with :00 seconds, and drive event time', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    for (const [sent, stored, timezone, offset] of [
      ['2026-07-20T09:30-04:00', '2026-07-20T09:30:00-04:00', 'America/New_York', -240],
      ['2026-07-20T13:30Z', '2026-07-20T13:30:00Z', 'UTC', 0],
    ]) {
      const response = await submit({ values: { 'logged-at': sent, minutes: 20, effort: 'easy' } });
      assert.equal(response.status, 201, response.text);
      const receipt = response.json().receipt;
      assert.equal(receipt.values.find((entry) => entry.fieldId === 'logged-at').value, stored);
      assert.deepEqual(eventTrio(receipt), { eventAt: stored, timezone, clientOffsetMinutes: offset });
    }
  } finally {
    await server.cleanup();
  }
});

test('naive datetimes (no offset) are refused, not guessed', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    for (const naive of ['2026-07-20T09:30:00', '2026-07-20T09:30']) {
      const response = await submit({ values: { 'logged-at': naive, minutes: 20, effort: 'easy' } });
      assert.equal(response.status, 422, naive);
      assert.equal(response.json().error.details[0].path, 'values.logged-at');
    }
    assert.deepEqual(await storedRecords(server.submissionsPath), []);
  } finally {
    await server.cleanup();
  }
});

test('null or empty for a pinned select is a 422, not a fill', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    for (const empty of [null, '']) {
      const response = await submit({ values: { 'logged-at': '2026-07-20T09:30:00-04:00', machine: empty, minutes: 20, effort: 'easy' } });
      assert.equal(response.status, 422, JSON.stringify(empty));
      assert.equal(response.json().error.details[0].path, 'values.machine');
    }
    assert.deepEqual(await storedRecords(server.submissionsPath), []);
  } finally {
    await server.cleanup();
  }
});

test('optional pinned selects are recorded; multi-selects and all-disabled selects are not filled', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'edge-select-log');
    const response = await submit({ values: { count: 1 } });
    assert.equal(response.status, 201, response.text);
    const values = response.json().receipt.values;
    assert.deepEqual(values.map((entry) => entry.fieldId), ['count', 'room']);
    assert.deepEqual(values[1].selectedOptions, [{ optionId: 'east', optionLabel: 'East' }]);
  } finally {
    await server.cleanup();
  }
});

test('a correction that omits the pinned value gets it filled like a new entry', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'machine-log');
    const created = await submit({ values: { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 20, effort: 'easy' } });
    assert.equal(created.status, 201, created.text);
    const corrected = await submit({
      values: { 'logged-at': '2026-07-20T09:30:00-04:00', minutes: 25, effort: 'easy' },
      supersedesRecord: { resourceKind: 'form-submission', id: created.json().submissionId },
    });
    assert.equal(corrected.status, 201, corrected.text);
    const receipt = corrected.json().receipt;
    assert.equal(receipt.values.find((entry) => entry.fieldId === 'machine').value, 'rower');
    assert.equal(receipt.eventAt, '2026-07-20T09:30:00-04:00');
  } finally {
    await server.cleanup();
  }
});

test('a legacy retry that left an optional pinned select out replays, for entries and corrections', async () => {
  const server = await makeServer();
  try {
    const submit = await jsonClient(server, 'edge-select-log');
    const probe = await submit({ values: { count: 99, room: 'east' } });
    assert.equal(probe.status, 201, probe.text);
    const actor = probe.json().receipt.actor;
    const legacyService = new SubmissionService({
      registry: new TemplateRegistry({ templatesPath: server.templatesPath }),
      store: new SubmissionStore({ storageRoot: server.submissionsPath }),
    });

    // Before this change an optional pinned select could be left out, and the
    // entry was stored without it.
    const legacy = await legacyService.submit({
      templateId: 'edge-select-log', values: { count: 1 }, actor, idempotencyKey: 'legacy-optional-pinned',
    });
    assert.equal(legacy.error, undefined, JSON.stringify(legacy.error));
    assert.deepEqual(legacy.receipt.values.map((entry) => entry.fieldId), ['count']);
    const legacyCorrection = await legacyService.submit({
      templateId: 'edge-select-log', values: { count: 2 }, actor, idempotencyKey: 'legacy-optional-pinned-fix',
      supersedesRecord: { resourceKind: 'form-submission', id: legacy.submissionId },
    });
    assert.equal(legacyCorrection.error, undefined, JSON.stringify(legacyCorrection.error));
    const before = await storedRecords(server.submissionsPath);

    const replay = await submit({ values: { count: 1 }, idempotencyKey: 'legacy-optional-pinned' });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.json().submissionId, legacy.submissionId);
    assert.deepEqual(replay.json().receipt.values.map((entry) => entry.fieldId), ['count'], 'original receipt, unfilled');

    const replayCorrection = await submit({
      values: { count: 2 }, idempotencyKey: 'legacy-optional-pinned-fix',
      supersedesRecord: { resourceKind: 'form-submission', id: legacy.submissionId },
    });
    assert.equal(replayCorrection.status, 201, replayCorrection.text);
    assert.equal(replayCorrection.json().submissionId, legacyCorrection.submissionId);

    // Changed values under either key still conflict.
    assert.equal((await submit({ values: { count: 3 }, idempotencyKey: 'legacy-optional-pinned' })).status, 409);
    assert.equal((await submit({
      values: { count: 3 }, idempotencyKey: 'legacy-optional-pinned-fix',
      supersedesRecord: { resourceKind: 'form-submission', id: legacy.submissionId },
    })).status, 409);
    assert.deepEqual(await storedRecords(server.submissionsPath), before, 'stored records untouched');
  } finally {
    await server.cleanup();
  }
});
