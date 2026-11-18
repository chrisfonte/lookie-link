'use strict';

// `lookie forms` end to end: real managed API keys and static tokens carrying
// formsCapabilities (no injected authorizer), the CLI as a child process, and
// the pure event-time/value helpers it is built on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createApp } = require('../server');
const { ApiKeyStore } = require('../lib/api-key-store');
const { parseAccessConfig } = require('../lib/access-control');
const cliForms = require('../lib/cli-forms');

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '..', 'bin', 'lookie.js');
const STATIC_SECRET = 'cli-forms-static-placeholder';

const METER_TEMPLATE = {
  templateId: 'meter-log',
  grammarVersion: 1,
  title: 'Meter log',
  fields: [
    { id: 'read-at', type: 'datetime', label: 'Read at', required: true },
    {
      id: 'machine',
      type: 'select',
      label: 'Machine',
      required: true,
      default: 'unit-a',
      options: [{ id: 'unit-a', label: 'Unit A' }],
    },
    { id: 'reading', type: 'number', label: 'Reading', required: true },
    { id: 'note', type: 'short-text', label: 'Note', required: false },
  ],
};

async function startServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-cli-forms-'));
  const templatesPath = path.join(root, 'templates');
  const submissionsPath = path.join(root, 'submissions');
  const home = path.join(root, 'home');
  await Promise.all([fs.mkdir(templatesPath), fs.mkdir(home)]);
  const keyStore = new ApiKeyStore({
    storePath: path.join(root, 'api-keys.yaml'),
    adminTokens: [{ name: 'operator', secret: 'cli-forms-admin-placeholder' }],
  });
  const issue = (agentId, formsCapabilities) => keyStore.createKey({
    label: agentId,
    subject: { agentId, companyId: 'example' },
    permissions: { view: true },
    repos: 'all',
    ...(formsCapabilities ? { formsCapabilities } : {}),
  }, { name: 'operator' }).token;
  const tokens = {
    manager: issue('tracker-manager', ['forms.manage', 'forms.submit']),
    submitter: issue('tracker-logger', ['forms.submit']),
    plain: issue('plain-agent'),
  };
  const app = createApp({
    mappings: {},
    accessConfig: {
      humanDefault: 'restricted',
      tokens: {
        staticLogger: {
          secret: STATIC_SECRET,
          permissions: { view: true },
          repos: 'all',
          subject: { agentId: 'static-logger' },
          formsCapabilities: ['forms.submit'],
        },
      },
    },
    apiKeyStore: keyStore,
    formsConfig: { enabled: true, templatesPath, submissionsPath },
    formsPublicOrigin: 'http://forms.example.test',
    formsAudit: () => {},
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    submissionsPath,
    baseUrl,
    tokens,
    async cli(args, token, input) {
      const child = execFileAsync(process.execPath, [cliPath, '--base-url', baseUrl, ...args], {
        env: { ...process.env, HOME: home, LOOKIE_LINK_TOKEN: token || '', LOOKIE_LINK_ADMIN_TOKEN: '', LOOKIE_LINK_TIMEZONE: '' },
      });
      if (input !== undefined) {
        child.child.stdin.end(input);
      }
      try {
        const result = await child;
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

async function createMeterTemplate(server) {
  const response = await fetch(`${server.baseUrl}/api/forms/templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.tokens.manager}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(METER_TEMPLATE),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function snapshot(root) {
  const out = {};
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(root);
  return out;
}

test('event time trio uses the offset at the instant, east-positive (never getTimezoneOffset)', () => {
  const winter = cliForms.eventTimeFor(Date.parse('2026-11-18T14:30:00Z'), 'America/New_York');
  assert.deepEqual(winter, { eventAt: '2026-11-18T09:30:00-05:00', timezone: 'America/New_York', clientOffsetMinutes: -300 });
  const summer = cliForms.eventTimeFor(Date.parse('2026-07-20T13:30:00Z'), 'America/New_York');
  assert.deepEqual(summer, { eventAt: '2026-07-20T09:30:00-04:00', timezone: 'America/New_York', clientOffsetMinutes: -240 });
  // Naive wall time is read in the zone; a zoned instant is re-expressed in it.
  assert.equal(cliForms.eventTimeFor(cliForms.parseInstant('2026-11-18T09:30', 'America/New_York'), 'America/New_York').eventAt,
    '2026-11-18T09:30:00-05:00');
  assert.equal(cliForms.eventTimeFor(cliForms.parseInstant('2026-11-18T09:30', 'Asia/Kolkata'), 'Asia/Kolkata').clientOffsetMinutes, 330);
  assert.throws(() => cliForms.parseInstant('tomorrow', 'UTC'), cliForms.CliFormsError);
  assert.throws(() => cliForms.eventTimeFor(0, 'Not/AZone'), cliForms.CliFormsError);
});

test('buildSubmission nests values, fills defaults and datetime, and shapes supersedesRecord', () => {
  const fields = METER_TEMPLATE.fields;
  const { body, filled } = cliForms.buildSubmission({
    fields,
    assignments: ['reading=12.5', 'machine=Unit A'],
    at: '2026-11-18T09:30',
    timeZone: 'America/New_York',
    supersedes: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'k-1',
  });
  assert.deepEqual(body, {
    values: { reading: 12.5, machine: 'unit-a', 'read-at': '2026-11-18T09:30:00-05:00' },
    eventAt: '2026-11-18T09:30:00-05:00',
    timezone: 'America/New_York',
    clientOffsetMinutes: -300,
    supersedesRecord: { id: '11111111-1111-4111-8111-111111111111', resourceKind: 'form-submission' },
    idempotencyKey: 'k-1',
  });
  assert.deepEqual(filled, ['read-at']);
  // A single supplied datetime becomes eventAt when --at is absent.
  const derived = cliForms.buildSubmission({
    fields,
    assignments: ['reading=1', 'read-at=2026-07-20T09:30'],
    timeZone: 'America/New_York',
  }).body;
  assert.equal(derived.eventAt, '2026-07-20T09:30:00-04:00');
  assert.equal(derived.values.machine, 'unit-a');
  assert.throws(() => cliForms.buildSubmission({ fields, assignments: ['nope=1'], timeZone: 'UTC' }), /unknown field/);
  // Without a readable schema only unambiguous JSON literals are converted.
  const blind = cliForms.buildSubmission({ fields: null, assignments: ['n=3', 'flag=true', 's=hello'], timeZone: 'UTC', now: 0 }).body;
  assert.deepEqual(blind.values, { n: 3, flag: true, s: 'hello' });
  assert.equal(blind.eventAt, '1970-01-01T00:00:00+00:00');
});

test('formsCapabilities is an allowlist on API keys and static tokens', () => {
  assert.throws(() => parseAccessConfig({ tokens: { a: { secret: 's', formsCapabilities: ['forms.everything'] } } }),
    /access\.tokens\.a\.formsCapabilities/);
  assert.deepEqual(parseAccessConfig({ tokens: { a: { secret: 's', formsCapabilities: ['forms.manage', 'forms.view'] } } })
    .tokens[0].formsCapabilities, ['forms.view', 'forms.manage']);
});

test('lookie forms: scoped API keys list, show, submit, correct, patch, and publish without CSRF', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await createMeterTemplate(server);

  // whoami reports what each credential can do with forms.
  const whoManager = JSON.parse((await server.cli(['whoami'], server.tokens.manager)).stdout);
  assert.deepEqual(whoManager.formsCapabilities, ['forms.submit', 'forms.manage']);
  const whoPlain = JSON.parse((await server.cli(['whoami'], server.tokens.plain)).stdout);
  assert.deepEqual(whoPlain.formsCapabilities, []);

  // A key without forms capabilities sees nothing and cannot submit.
  const plainList = JSON.parse((await server.cli(['forms', 'list'], server.tokens.plain)).stdout);
  assert.deepEqual(plainList.templates, []);
  const plainSubmit = await server.cli(['forms', 'submit', 'meter-log', '--value', 'reading=1'], server.tokens.plain);
  assert.equal(plainSubmit.code, 4, plainSubmit.stderr);

  const list = JSON.parse((await server.cli(['forms', 'list'], server.tokens.submitter)).stdout);
  assert.deepEqual(list.templates.map((entry) => entry.templateId), ['meter-log']);

  const show = await server.cli(['forms', 'show', 'meter-log'], server.tokens.manager);
  assert.equal(show.code, 0, show.stderr);
  const shown = JSON.parse(show.stdout);
  assert.equal(shown.template.revision, 1);
  assert.deepEqual(shown.fields.find((field) => field.id === 'machine').options, [{ id: 'unit-a', label: 'Unit A' }]);
  // Submit-only keys read the serving fields too (no draft metadata).
  const submitterShow = await server.cli(['forms', 'show', 'meter-log'], server.tokens.submitter);
  assert.equal(submitterShow.code, 0, submitterShow.stderr);
  const submitterView = JSON.parse(submitterShow.stdout);
  assert.deepEqual(submitterView.fields.map((field) => field.id), ['read-at', 'machine', 'reading', 'note']);
  assert.equal(submitterView.template, undefined);
  const plainShow = await server.cli(['forms', 'show', 'meter-log'], server.tokens.plain);
  assert.equal(plainShow.code, 4);

  // Manager submit: the CLI fills the pinned default and the datetime field.
  const submitted = await server.cli([
    'forms', 'submit', 'meter-log', '--value', 'reading=12', '--at', '2026-11-18T09:30', '--tz', 'America/New_York',
  ], server.tokens.manager);
  assert.equal(submitted.code, 0, submitted.stderr);
  assert.match(submitted.stderr, /filled read-at, machine/);
  const receipt = JSON.parse(submitted.stdout);
  assert.equal(receipt.receipt.eventAt, '2026-11-18T09:30:00-05:00');
  assert.equal(receipt.receipt.clientOffsetMinutes, -300);
  const before = await snapshot(server.submissionsPath);

  // Correction: starts from the superseded entry, keeps its eventAt.
  const corrected = await server.cli([
    'forms', 'submit', 'meter-log', '--supersedes', receipt.submissionId, '--value', 'reading=13',
  ], server.tokens.manager);
  assert.equal(corrected.code, 0, corrected.stderr);
  const correction = JSON.parse(corrected.stdout);
  assert.equal(correction.receipt.eventAt, '2026-11-18T09:30:00-05:00');
  assert.deepEqual(correction.receipt.supersedesRecord, { resourceKind: 'form-submission', id: receipt.submissionId });
  // The original record is untouched: corrections only add files.
  const after = await snapshot(server.submissionsPath);
  for (const [file, content] of Object.entries(before)) assert.equal(after[file], content, file);

  const stale = await server.cli(['forms', 'submit', 'meter-log', '--supersedes', receipt.submissionId, '--value', 'reading=14'],
    server.tokens.manager);
  assert.equal(stale.code, 5, stale.stderr);

  const history = JSON.parse((await server.cli(['forms', 'history', 'meter-log', correction.submissionId], server.tokens.manager)).stdout);
  assert.deepEqual(history.submissions.map((record) => record.submissionId), [correction.submissionId, receipt.submissionId]);

  // Submit-only key: validation failures name the failing path.
  const missing = await server.cli(['forms', 'submit', 'meter-log', '--value', 'note=skipped'], server.tokens.submitter);
  assert.equal(missing.code, 6);
  assert.match(missing.stderr, /values\.reading/);
  const fromFile = await server.cli([
    'forms', 'submit', 'meter-log', '--values-file', '-', '--tz', 'America/New_York', '--idempotency-key', 'meter-2026-11-18',
  ], server.tokens.submitter, JSON.stringify({ values: { reading: 2, 'read-at': '2026-11-18T10:00' } }));
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(JSON.parse(fromFile.stdout).receipt.eventAt, '2026-11-18T10:00:00-05:00');

  const mine = JSON.parse((await server.cli(['forms', 'submissions', 'meter-log', '--limit', '5'], server.tokens.submitter)).stdout);
  assert.equal(mine.submissions.length, 1);
  assert.equal(mine.limit, 5);

  // Static token with formsCapabilities and a subject submits too.
  const viaStatic = await server.cli([
    'forms', 'submit', 'meter-log', '--value', 'machine=unit-a', '--value', 'reading=3', '--value', 'read-at=2026-11-18T11:00:00-05:00',
  ], STATIC_SECRET);
  assert.equal(viaStatic.code, 0, viaStatic.stderr);

  // Management: submit-only keys cannot patch; managers patch with CAS and publish.
  const denied = await server.cli(['forms', 'patch', 'meter-log', '--revision', '1', '--body', '{"title":"Meter readings"}'],
    server.tokens.submitter);
  assert.equal(denied.code, 4);
  const noRevision = await server.cli(['forms', 'patch', 'meter-log', '--body', '{"title":"Meter readings"}'], server.tokens.manager);
  assert.equal(noRevision.code, 2);
  const patched = await server.cli(['forms', 'patch', 'meter-log', '--revision', '1', '--body', '{"title":"Meter readings"}'],
    server.tokens.manager);
  assert.equal(patched.code, 0, patched.stderr);
  assert.equal(JSON.parse(patched.stdout).template.revision, 2);
  const conflict = await server.cli(['forms', 'patch', 'meter-log', '--revision', '1', '--body', '{"title":"Again"}'], server.tokens.manager);
  assert.equal(conflict.code, 5);
  const published = await server.cli(['forms', 'publish', 'meter-log', '--revision', '2'], server.tokens.manager);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(JSON.parse(published.stdout).version.templateVersion, 1);
});

test('lookie forms submit --dry-run prints the body without sending it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await createMeterTemplate(server);
  const dry = await server.cli(['forms', 'submit', 'meter-log', '--value', 'reading=4', '--at', '2026-07-20T13:30:00Z',
    '--tz', 'America/New_York', '--dry-run'], server.tokens.manager);
  assert.equal(dry.code, 0, dry.stderr);
  const parsed = JSON.parse(dry.stdout);
  assert.equal(parsed.body.eventAt, '2026-07-20T09:30:00-04:00');
  assert.equal(parsed.body.clientOffsetMinutes, -240);
  const mine = JSON.parse((await server.cli(['forms', 'submissions', 'meter-log'], server.tokens.manager)).stdout);
  assert.equal(mine.submissions.length, 0);
});

async function api(server, route, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

test('POST /api/agent-keys rejects unknown formsCapabilities and stores the allowlisted set', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const admin = 'cli-forms-admin-placeholder';
  const base = { label: 'probe', subject: { agentId: 'probe-agent', companyId: 'example' }, permissions: { view: true }, repos: 'all' };
  for (const formsCapabilities of [['forms.everything'], ['forms.submit', 'write'], 'forms.submit', [42]]) {
    const refused = await api(server, '/api/agent-keys', { token: admin, method: 'POST', body: { ...base, formsCapabilities } });
    assert.equal(refused.status, 400, `${JSON.stringify(formsCapabilities)}: ${refused.text}`);
    assert.match(refused.text, /formsCapabilities/);
    assert.ok(!/"token"/.test(refused.text), 'no secret is issued on refusal');
  }
  const listed = await api(server, '/api/agent-keys', { token: admin });
  assert.equal(listed.status, 200);
  assert.ok(!listed.json.keys.some((key) => key.label === 'probe'), 'refused creates leave no key behind');
  // Non-admin bearers cannot mint keys, with or without forms capabilities.
  const notAdmin = await api(server, '/api/agent-keys', { token: server.tokens.manager, method: 'POST', body: { ...base, formsCapabilities: ['forms.manage'] } });
  assert.ok([401, 403].includes(notAdmin.status), notAdmin.text);
  const created = await api(server, '/api/agent-keys', {
    token: admin, method: 'POST', body: { ...base, formsCapabilities: ['forms.manage', 'forms.view', 'forms.view'] },
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.key.formsCapabilities, ['forms.view', 'forms.manage']);
});

test('GET /api/forms/:id/fields refuses uniformly and never leaks invisible forms', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await createMeterTemplate(server);
  const manage = server.tokens.manager;
  const create = async (body) => {
    const result = await api(server, '/api/forms/templates', { token: manage, method: 'POST', body });
    assert.equal(result.status, 201, result.text);
    return result.json;
  };
  await create({ templateId: 'meter-group', grammarVersion: 1, title: 'Meters', kind: 'container' });
  await create({ templateId: 'meter-checklist', grammarVersion: 1, title: 'Checklist', kind: 'list' });
  const retired = await create({ ...METER_TEMPLATE, templateId: 'retired-meter', title: 'Retired meter' });
  const archived = await api(server, '/api/forms/templates/retired-meter/archive', {
    token: manage, method: 'POST', body: { revision: retired.template.revision },
  });
  assert.equal(archived.status, 200, archived.text);

  const ok = await api(server, '/api/forms/meter-log/fields', { token: server.tokens.submitter });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(Object.keys(ok.json).sort(), ['children', 'fields', 'kind', 'ok', 'schemaDigest', 'templateId', 'title']);
  assert.ok(!/ownerId|destinationId|revision|submissionsPath|templatesPath/.test(ok.text), 'no management metadata or storage detail');

  // Every refusal for a forms-less, unknown, archived, container or list
  // target is the same 404 envelope, so existence cannot be probed.
  const notFound = [
    ['plain key on a real form', '/api/forms/meter-log/fields', server.tokens.plain],
    ['unknown id', '/api/forms/no-such-form/fields', server.tokens.manager],
    ['invalid id', '/api/forms/..%2Fetc/fields', server.tokens.manager],
    ['archived', '/api/forms/retired-meter/fields', server.tokens.manager],
    ['container', '/api/forms/meter-group/fields', server.tokens.manager],
    ['list', '/api/forms/meter-checklist/fields', server.tokens.manager],
  ];
  const bodies = new Set();
  for (const [label, route, token] of notFound) {
    const result = await api(server, route, { token });
    assert.equal(result.status, 404, `${label}: ${result.text}`);
    assert.equal(result.json && result.json.ok, false, label);
    bodies.add(JSON.stringify({ code: result.json.error.code, message: result.json.error.message }));
  }
  assert.equal(bodies.size, 1, `404 bodies differ: ${[...bodies].join(' | ')}`);

  const anonymous = await api(server, '/api/forms/meter-log/fields');
  assert.equal(anonymous.status, 401, anonymous.text);
  const invalid = await api(server, '/api/forms/meter-log/fields', { token: 'not-a-real-token' });
  assert.ok([401, 403].includes(invalid.status), invalid.text);
  assert.ok(!/fields|Unit A/.test(invalid.text));
  const queryToken = await api(server, `/api/forms/meter-log/fields?token=${encodeURIComponent(server.tokens.submitter)}`);
  assert.equal(queryToken.status, 400, queryToken.text);
  assert.equal(queryToken.json.error.code, 'query_credentials_rejected');
  assert.ok(!queryToken.text.includes(server.tokens.submitter), 'query credential is not echoed');
  const ambiguous = await api(server, '/api/forms/meter-log/fields', {
    token: server.tokens.submitter, headers: { Cookie: 'lookie_forms_context=anything' },
  });
  assert.equal(ambiguous.status, 400, ambiguous.text);
  assert.match(ambiguous.json.error.message, /Ambiguous credentials/);
});
