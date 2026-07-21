'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const FIELD_TYPES = new Set([
  'short-text',
  'long-text',
  'number',
  'checkbox',
  'date',
  'time',
  'datetime',
  'select',
  'multi-select',
]);
const SELECTION_TYPES = new Set(['select', 'multi-select']);
const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/;
const INPUT_KEYS = new Set([
  'submissionId',
  'eventAt',
  'timezone',
  'clientOffsetMinutes',
  'actor',
  'templateId',
  'templateVersion',
  'schemaDigest',
  'values',
  'idempotencyKey',
  'supersedesRecord',
]);
const VALUE_KEYS = new Set(['fieldId', 'fieldType', 'fieldLabel', 'value', 'selectedOptions']);
const OPTION_KEYS = new Set(['optionId', 'optionLabel']);
const SUPERSEDES_KEYS = new Set(['resourceKind', 'id']);

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError(`${name} must be an object.`, 'EVALIDATION');
  }
}

function assertOnlyKeys(value, allowed, name) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw codedError(`${name}.${unknown} is not allowed.`, 'EVALIDATION');
  }
}

function normalizeJsonValue(value, name, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw codedError(`${name} must contain only finite JSON numbers.`, 'EVALIDATION');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw codedError(`${name} must be JSON-serializable.`, 'EVALIDATION');
  }
  if (seen.has(value)) {
    throw codedError(`${name} must not contain circular references.`, 'EVALIDATION');
  }

  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry, index) => normalizeJsonValue(entry, `${name}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw codedError(`${name} must contain only plain JSON objects.`, 'EVALIDATION');
    }
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJsonValue(value[key], `${name}.${key}`, seen);
    }
  }
  seen.delete(value);
  return normalized;
}

function stableJson(value, indentation = 0) {
  const normalized = normalizeJsonValue(value, 'value');
  return `${JSON.stringify(normalized, null, indentation)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function assertDefinitionId(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !DEFINITION_ID.test(value)) {
    throw codedError(`${name} must be a valid definition ID.`, 'EVALIDATION');
  }
  return value;
}

function assertRfc3339(value, name) {
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw codedError(`${name} must be an RFC 3339 timestamp with an explicit offset.`, 'EVALIDATION');
  }
  return value;
}

function offsetFromTimestamp(value) {
  if (value.endsWith('Z')) {
    return 0;
  }
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  const minutes = (Number(match[2]) * 60) + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function offsetForZone(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
  });
  const zoneName = formatter.formatToParts(new Date(timestamp))
    .find((part) => part.type === 'timeZoneName').value;
  if (zoneName === 'GMT') {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName);
  if (!match) {
    throw codedError('timezone offset could not be determined.', 'EVALIDATION');
  }
  const minutes = (Number(match[2]) * 60) + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function normalizeEventTime(input) {
  const supplied = ['eventAt', 'timezone', 'clientOffsetMinutes']
    .filter((key) => input[key] !== undefined);
  if (supplied.length === 0) {
    return {};
  }
  if (supplied.length !== 3) {
    throw codedError('eventAt, timezone, and clientOffsetMinutes must be supplied together.', 'EVALIDATION');
  }

  const eventAt = assertRfc3339(input.eventAt, 'eventAt');
  if (typeof input.timezone !== 'string' || input.timezone.length === 0) {
    throw codedError('timezone must be an IANA time zone name.', 'EVALIDATION');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(new Date(eventAt));
  } catch (_error) {
    throw codedError('timezone must be an IANA time zone name.', 'EVALIDATION');
  }
  if (!Number.isInteger(input.clientOffsetMinutes)
      || input.clientOffsetMinutes < -840
      || input.clientOffsetMinutes > 840) {
    throw codedError('clientOffsetMinutes must be an integer from -840 through 840.', 'EVALIDATION');
  }
  const timestampOffset = offsetFromTimestamp(eventAt);
  const zoneOffset = offsetForZone(eventAt, input.timezone);
  if (input.clientOffsetMinutes !== timestampOffset || zoneOffset !== timestampOffset) {
    throw codedError('eventAt, timezone, and clientOffsetMinutes offsets must agree.', 'EVALIDATION');
  }
  return {
    eventAt,
    timezone: input.timezone,
    clientOffsetMinutes: input.clientOffsetMinutes,
  };
}

function normalizeSelectedOptions(entry, index) {
  const name = `values[${index}].selectedOptions`;
  if (!Array.isArray(entry.selectedOptions)) {
    throw codedError(`${name} must be an array for selection fields.`, 'EVALIDATION');
  }
  return entry.selectedOptions.map((option, optionIndex) => {
    const optionName = `${name}[${optionIndex}]`;
    assertPlainObject(option, optionName);
    assertOnlyKeys(option, OPTION_KEYS, optionName);
    const optionId = assertDefinitionId(option.optionId, `${optionName}.optionId`);
    if (typeof option.optionLabel !== 'string' || option.optionLabel.length === 0 || option.optionLabel.length > 200) {
      throw codedError(`${optionName}.optionLabel must be a non-empty string of at most 200 characters.`, 'EVALIDATION');
    }
    return { optionId, optionLabel: option.optionLabel };
  });
}

function normalizeCapturedValue(entry, index) {
  const name = `values[${index}]`;
  assertPlainObject(entry, name);
  assertOnlyKeys(entry, VALUE_KEYS, name);
  const fieldId = assertDefinitionId(entry.fieldId, `${name}.fieldId`);
  if (!FIELD_TYPES.has(entry.fieldType)) {
    throw codedError(`${name}.fieldType is not supported.`, 'EVALIDATION');
  }
  if (typeof entry.fieldLabel !== 'string' || entry.fieldLabel.length === 0 || entry.fieldLabel.length > 200) {
    throw codedError(`${name}.fieldLabel must be a non-empty string of at most 200 characters.`, 'EVALIDATION');
  }

  let value;
  switch (entry.fieldType) {
    case 'short-text':
    case 'long-text':
      if (typeof entry.value !== 'string') {
        throw codedError(`${name}.value must be a string.`, 'EVALIDATION');
      }
      value = entry.value;
      break;
    case 'number':
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || Object.is(entry.value, -0)) {
        throw codedError(`${name}.value must be a finite JSON number.`, 'EVALIDATION');
      }
      value = entry.value;
      break;
    case 'checkbox':
      if (typeof entry.value !== 'boolean') {
        throw codedError(`${name}.value must be a boolean.`, 'EVALIDATION');
      }
      value = entry.value;
      break;
    case 'date':
      if (typeof entry.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.value)) {
        throw codedError(`${name}.value must be a date string.`, 'EVALIDATION');
      }
      value = entry.value;
      break;
    case 'time':
      if (typeof entry.value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(entry.value)) {
        throw codedError(`${name}.value must be a 24-hour time string.`, 'EVALIDATION');
      }
      value = entry.value;
      break;
    case 'datetime':
      value = assertRfc3339(entry.value, `${name}.value`);
      break;
    case 'select':
      value = assertDefinitionId(entry.value, `${name}.value`);
      break;
    case 'multi-select':
      if (!Array.isArray(entry.value)) {
        throw codedError(`${name}.value must be an array.`, 'EVALIDATION');
      }
      value = entry.value.map((optionId, optionIndex) => (
        assertDefinitionId(optionId, `${name}.value[${optionIndex}]`)
      ));
      if (new Set(value).size !== value.length) {
        throw codedError(`${name}.value must not contain duplicate option IDs.`, 'EVALIDATION');
      }
      break;
    default:
      throw codedError(`${name}.fieldType is not supported.`, 'EVALIDATION');
  }

  const normalized = { fieldId, fieldType: entry.fieldType, fieldLabel: entry.fieldLabel, value };
  if (SELECTION_TYPES.has(entry.fieldType)) {
    const selectedOptions = normalizeSelectedOptions(entry, index);
    const optionIds = selectedOptions.map((option) => option.optionId);
    const expectedIds = entry.fieldType === 'select' ? [value] : value;
    if (optionIds.length !== expectedIds.length
        || optionIds.some((optionId, optionIndex) => optionId !== expectedIds[optionIndex])) {
      throw codedError(`${name}.selectedOptions must snapshot the selected value IDs in order.`, 'EVALIDATION');
    }
    normalized.selectedOptions = selectedOptions;
  } else if (entry.selectedOptions !== undefined) {
    throw codedError(`${name}.selectedOptions is allowed only for selection fields.`, 'EVALIDATION');
  }
  return normalized;
}

function normalizeSubmission(input) {
  assertPlainObject(input, 'submission');
  assertOnlyKeys(input, INPUT_KEYS, 'submission');
  if (input.submissionId !== undefined
      && (typeof input.submissionId !== 'string' || !UUID.test(input.submissionId))) {
    throw codedError('submissionId must be a lowercase UUIDv4.', 'EVALIDATION');
  }
  assertPlainObject(input.actor, 'actor');
  const actor = normalizeJsonValue(input.actor, 'actor');
  if (Object.keys(actor).length === 0) {
    throw codedError('actor must not be empty.', 'EVALIDATION');
  }
  const templateId = assertDefinitionId(input.templateId, 'templateId');
  if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1) {
    throw codedError('templateVersion must be a positive integer.', 'EVALIDATION');
  }
  if (typeof input.schemaDigest !== 'string' || !DIGEST.test(input.schemaDigest)) {
    throw codedError('schemaDigest must be a SHA-256 digest.', 'EVALIDATION');
  }
  if (!Array.isArray(input.values)) {
    throw codedError('values must be an array.', 'EVALIDATION');
  }
  const values = input.values.map(normalizeCapturedValue);
  const fieldIds = values.map((entry) => entry.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) {
    throw codedError('values must not contain duplicate field IDs.', 'EVALIDATION');
  }

  return {
    ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
    ...normalizeEventTime(input),
    actor,
    templateId,
    templateVersion: input.templateVersion,
    schemaDigest: input.schemaDigest,
    values,
    ...(input.supersedesRecord === undefined ? {} : {
      supersedesRecord: normalizeSupersedesRecord(input.supersedesRecord),
    }),
  };
}

function normalizeSupersedesRecord(value) {
  assertPlainObject(value, 'supersedesRecord');
  assertOnlyKeys(value, SUPERSEDES_KEYS, 'supersedesRecord');
  if (value.resourceKind !== 'form-submission') {
    throw codedError('supersedesRecord.resourceKind must be form-submission.', 'EVALIDATION');
  }
  if (typeof value.id !== 'string' || !UUID.test(value.id)) {
    throw codedError('supersedesRecord.id must be a lowercase UUIDv4.', 'EVALIDATION');
  }
  return { resourceKind: value.resourceKind, id: value.id };
}

function normalizeIdempotencyKey(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) {
    throw codedError('idempotencyKey must contain 1-128 visible ASCII characters.', 'EVALIDATION');
  }
  return value;
}

function metadataFor(record) {
  return {
    submissionId: record.submissionId,
    receiptAt: record.receiptAt,
    ...(record.eventAt === undefined ? {} : {
      eventAt: record.eventAt,
      timezone: record.timezone,
      clientOffsetMinutes: record.clientOffsetMinutes,
    }),
    templateId: record.templateId,
    templateVersion: record.templateVersion,
    schemaDigest: record.schemaDigest,
    values: normalizeJsonValue(record.values, 'values'),
    ...(record.supersedesRecord === undefined ? {} : {
      supersedesRecord: normalizeJsonValue(record.supersedesRecord, 'supersedesRecord'),
    }),
  };
}

function sameActor(left, right) {
  return Boolean(left && right && left.id === right.id && left.type === right.type);
}

class SubmissionStore {
  constructor(config) {
    const options = typeof config === 'string' ? { storageRoot: config } : config;
    if (!options || typeof options.storageRoot !== 'string' || !options.storageRoot.trim()) {
      throw new Error('storageRoot is required.');
    }
    this.storageRoot = path.resolve(options.storageRoot);
    this.clock = options.clock || (() => new Date());
    this.idempotencyLocks = new Map();
    this.supersessionLocks = new Map();
  }

  recordPath(submissionId) {
    if (typeof submissionId !== 'string' || !UUID.test(submissionId)) {
      throw codedError('submissionId must be a lowercase UUIDv4.', 'EVALIDATION');
    }
    return path.join(this.storageRoot, `${submissionId}.json`);
  }

  async ensureStorageRoot() {
    await fs.mkdir(this.storageRoot, { recursive: true });
    const stat = await fs.lstat(this.storageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw codedError('storageRoot must be a directory and not a symbolic link.', 'EACCES');
    }
  }

  receiptTimestamp() {
    const now = this.clock();
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) {
      throw codedError('The server clock returned an invalid time.', 'ECLOCK');
    }
    return date.toISOString();
  }

  idempotencyDigest(actor, templateId, idempotencyKey) {
    const actorScope = typeof actor.id === 'string' ? actor.id : stableJson(actor, 0);
    return sha256(`${actorScope}\0${templateId}\0${idempotencyKey}`);
  }

  requestDigest(normalized) {
    return sha256(stableJson(normalized, 0));
  }

  async withIdempotencyLock(key, operation) {
    const previous = this.idempotencyLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.idempotencyLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.idempotencyLocks.get(key) === current) {
        this.idempotencyLocks.delete(key);
      }
    }
  }

  async withSupersessionLock(reference, operation) {
    if (!reference) return operation();
    const key = `${reference.resourceKind}:${reference.id}`;
    const previous = this.supersessionLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.supersessionLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.supersessionLocks.get(key) === current) this.supersessionLocks.delete(key);
    }
  }

  async submissionFiles() {
    try {
      const entries = await fs.readdir(this.storageRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && UUID.test(entry.name.slice(0, -5)) && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async findIdempotentRecord(idempotencyKeyDigest) {
    let match = null;
    for (const fileName of await this.submissionFiles()) {
      const record = JSON.parse(await fs.readFile(path.join(this.storageRoot, fileName), 'utf8'));
      if (record.idempotencyKeyDigest !== idempotencyKeyDigest) {
        continue;
      }
      if (match) {
        throw codedError('Multiple records claim the same idempotency key digest.', 'EINTEGRITY');
      }
      match = record;
    }
    return match;
  }

  async allRecords() {
    const records = [];
    for (const fileName of await this.submissionFiles()) {
      records.push(normalizeJsonValue(
        JSON.parse(await fs.readFile(path.join(this.storageRoot, fileName), 'utf8')),
        'record'
      ));
    }
    return records;
  }

  async assertSupersessionAvailable(normalized, allowForeignSupersede) {
    const reference = normalized.supersedesRecord;
    if (!reference) return;
    const records = await this.allRecords();
    const predecessor = records.find((record) => record.submissionId === reference.id);
    if (!predecessor
        || predecessor.templateId !== normalized.templateId
        || (!allowForeignSupersede && !sameActor(predecessor.actor, normalized.actor))) {
      throw codedError('Submission not found.', 'ENOTFOUND');
    }
    if (records.some((record) => record.supersedesRecord
        && record.supersedesRecord.resourceKind === reference.resourceKind
        && record.supersedesRecord.id === reference.id)) {
      throw codedError('The submission has already been superseded.', 'ESUPERSEDED');
    }
  }

  async writeTempContents(handle, bytes) {
    await handle.writeFile(bytes, 'utf8');
  }

  async syncDirectory() {
    const directory = await fs.open(this.storageRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async durableCreate(record) {
    const finalPath = this.recordPath(record.submissionId);
    const tempPath = path.join(
      this.storageRoot,
      `.${record.submissionId}.${crypto.randomUUID()}.tmp`
    );
    const bytes = stableJson(record, 2);
    let handle;
    let published = false;

    try {
      handle = await fs.open(tempPath, 'wx', 0o600);
      await this.writeTempContents(handle, bytes);
      await handle.sync();
      await handle.close();
      handle = null;

      try {
        // link(2) is the portable Node primitive that atomically publishes a
        // sibling file without replacing an existing immutable record.
        await fs.link(tempPath, finalPath);
        published = true;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw codedError(`Submission ${record.submissionId} already exists.`, 'EEXIST');
        }
        throw error;
      }
      await fs.unlink(tempPath);
      await this.syncDirectory();
      return record;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await fs.unlink(tempPath).catch(() => {});
      if (published) {
        await fs.unlink(finalPath).catch(() => {});
        await this.syncDirectory().catch(() => {});
      }
      throw error;
    }
  }

  async createSubmission(input, options = {}) {
    assertPlainObject(options, 'options');
    assertOnlyKeys(options, new Set(['idempotencyKey', 'allowForeignSupersede']), 'options');
    if (options.allowForeignSupersede !== undefined && typeof options.allowForeignSupersede !== 'boolean') {
      throw codedError('options.allowForeignSupersede must be a boolean.', 'EVALIDATION');
    }
    const inputKey = input && input.idempotencyKey;
    if (inputKey !== undefined && options.idempotencyKey !== undefined && inputKey !== options.idempotencyKey) {
      throw codedError('Conflicting idempotencyKey values were supplied.', 'EVALIDATION');
    }
    const idempotencyKey = normalizeIdempotencyKey(
      options.idempotencyKey === undefined ? inputKey : options.idempotencyKey
    );
    const normalized = normalizeSubmission(input);
    const buildRecord = (idempotency = {}) => ({
      submissionId: normalized.submissionId || crypto.randomUUID(),
      receiptAt: this.receiptTimestamp(),
      ...(normalized.eventAt === undefined ? {} : {
        eventAt: normalized.eventAt,
        timezone: normalized.timezone,
        clientOffsetMinutes: normalized.clientOffsetMinutes,
      }),
      actor: normalized.actor,
      templateId: normalized.templateId,
      templateVersion: normalized.templateVersion,
      schemaDigest: normalized.schemaDigest,
      values: normalized.values,
      ...(normalized.supersedesRecord === undefined ? {} : {
        supersedesRecord: normalized.supersedesRecord,
      }),
      ...idempotency,
    });
    const createRecord = (idempotency = {}) => this.withSupersessionLock(
      normalized.supersedesRecord,
      async () => {
        await this.assertSupersessionAvailable(normalized, options.allowForeignSupersede === true);
        return this.durableCreate(buildRecord(idempotency));
      }
    );
    if (idempotencyKey === null) {
      await this.ensureStorageRoot();
      return createRecord();
    }
    const idempotencyKeyDigest = this.idempotencyDigest(
      normalized.actor,
      normalized.templateId,
      idempotencyKey
    );
    const requestDigest = this.requestDigest(normalized);

    return this.withIdempotencyLock(idempotencyKeyDigest, async () => {
      await this.ensureStorageRoot();
      const original = await this.findIdempotentRecord(idempotencyKeyDigest);
      if (original) {
        if (original.requestDigest !== requestDigest) {
          throw codedError('The idempotency key was already used for a different submission.', 'ECONFLICT');
        }
        return normalizeJsonValue(original, 'record');
      }

      return createRecord({
        idempotencyKeyDigest,
        requestDigest,
      });
    });
  }

  async getSubmission(submissionId) {
    try {
      const record = JSON.parse(await fs.readFile(this.recordPath(submissionId), 'utf8'));
      return normalizeJsonValue(record, 'record');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async resolveLatest(submissionId) {
    let current = await this.getSubmission(submissionId);
    if (!current) return null;
    const records = await this.allRecords();
    const successors = new Map();
    for (const record of records) {
      if (!record.supersedesRecord) continue;
      const key = `${record.supersedesRecord.resourceKind}:${record.supersedesRecord.id}`;
      if (successors.has(key)) throw codedError('The supersession chain has multiple successors.', 'EINTEGRITY');
      successors.set(key, record);
    }
    const visited = new Set();
    while (current) {
      if (visited.has(current.submissionId)) throw codedError('The supersession chain contains a cycle.', 'EINTEGRITY');
      visited.add(current.submissionId);
      const successor = successors.get(`form-submission:${current.submissionId}`);
      if (!successor) return current;
      current = successor;
    }
    return null;
  }

  async getSubmissionHistory(submissionId) {
    const latest = await this.resolveLatest(submissionId);
    if (!latest) return null;
    const predecessors = [];
    const visited = new Set([latest.submissionId]);
    let current = latest;
    while (current.supersedesRecord) {
      const predecessor = await this.getSubmission(current.supersedesRecord.id);
      if (!predecessor || visited.has(predecessor.submissionId)) {
        throw codedError('The supersession chain is incomplete or cyclic.', 'EINTEGRITY');
      }
      predecessors.push(predecessor);
      visited.add(predecessor.submissionId);
      current = predecessor;
    }
    return { latest, predecessors };
  }

  async listSubmissions({ templateId, actor, limit = 100 } = {}) {
    if (templateId !== undefined) {
      assertDefinitionId(templateId, 'templateId');
    }
    if (actor !== undefined) {
      assertPlainObject(actor, 'actor');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw codedError('limit must be an integer from 1 through 100.', 'EVALIDATION');
    }
    const records = await this.allRecords();
    const superseded = new Set(records
      .filter((record) => record.supersedesRecord)
      .map((record) => `${record.supersedesRecord.resourceKind}:${record.supersedesRecord.id}`));
    return records
      .filter((record) => (templateId === undefined || record.templateId === templateId)
        && (actor === undefined || sameActor(record.actor, actor))
        && !superseded.has(`form-submission:${record.submissionId}`))
      .sort((left, right) => (
        right.receiptAt.localeCompare(left.receiptAt)
        || right.submissionId.localeCompare(left.submissionId)
      ))
      .slice(0, limit)
      .map(metadataFor);
  }

  async countSubmissions({templateId} = {}) {
    if (templateId !== undefined) assertDefinitionId(templateId, 'templateId');
    const records = await this.allRecords();
    const superseded = new Set(records
      .filter((record) => record.supersedesRecord)
      .map((record) => `${record.supersedesRecord.resourceKind}:${record.supersedesRecord.id}`));
    return records.filter((record) => (templateId === undefined || record.templateId === templateId)
      && !superseded.has(`form-submission:${record.submissionId}`)).length;
  }
}

module.exports = {
  SubmissionStore,
};
