'use strict';

// Pure helpers behind `lookie forms`: event-time math, value coercion, and
// submission-body assembly. No I/O here, so the rules are unit-testable.

class CliFormsError extends Error {}

function fail(message) {
  throw new CliFormsError(message);
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    fail(`--tz must be a valid IANA timezone (got ${JSON.stringify(timeZone)})`);
  }
  return timeZone;
}

function defaultTimeZone(env = process.env) {
  const fromEnv = env.LOOKIE_LINK_TIMEZONE && String(env.LOOKIE_LINK_TIMEZONE).trim();
  return fromEnv || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Minutes EAST of UTC at that instant in that zone, the sign RFC 3339 uses:
// America/New_York is -300 in winter and -240 in summer. Deliberately not
// Date#getTimezoneOffset, whose sign is inverted and which only knows the host zone.
function offsetMinutesAt(instantMs, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instantMs))
    .find((part) => part.type === 'timeZoneName').value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(name);
  if (!match) fail(`cannot resolve the UTC offset of ${timeZone}`);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === '-' ? -minutes : minutes;
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function wallClock(instantMs, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

const ZONED = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

// Accepts an RFC 3339 instant (`Z` or `±HH:MM`) or a naive wall time read in
// `timeZone`, and returns the instant in milliseconds (whole seconds).
function parseInstant(text, timeZone, label = '--at') {
  const value = String(text || '').trim();
  if (ZONED.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T'));
    if (!Number.isFinite(ms)) fail(`${label} is not a valid timestamp`);
    return Math.floor(ms / 1000) * 1000;
  }
  const naive = NAIVE.exec(value);
  if (!naive) fail(`${label} must be RFC 3339 (2026-11-18T09:30:00-05:00) or local wall time (2026-11-18T09:30)`);
  const [, y, mo, d, h, mi, s] = naive.map((part) => (part === undefined ? '0' : part));
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let instant = guess - offsetMinutesAt(guess, timeZone) * 60000;
  instant = guess - offsetMinutesAt(instant, timeZone) * 60000;
  return instant;
}

// The eventAt/timezone/clientOffsetMinutes trio the submission store checks:
// eventAt carries the zone's offset at that instant, and all three agree.
function eventTimeFor(instantMs, timeZone) {
  assertTimeZone(timeZone);
  const clientOffsetMinutes = offsetMinutesAt(instantMs, timeZone);
  return {
    eventAt: `${wallClock(instantMs, timeZone)}${formatOffset(clientOffsetMinutes)}`,
    timezone: timeZone,
    clientOffsetMinutes,
  };
}

function activeFields(template) {
  if (!template) return null;
  const fields = Array.isArray(template.resolvedFields) ? template.resolvedFields
    : template.template && Array.isArray(template.template.fields) ? template.template.fields
      : Array.isArray(template.fields) ? template.fields : null;
  return fields ? fields.filter((field) => field && field.isDestroyed !== true) : null;
}

// Agent-facing projection for `forms show`: the fields that actually serve
// (a child's resolvedFields), with option ids next to their labels.
function fieldSummary(fields) {
  return (fields || []).map((field) => ({
    id: field.id,
    type: field.type,
    label: field.label,
    required: field.required === true,
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(Array.isArray(field.options) ? {
      options: field.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.disabled ? { disabled: true } : {}),
      })),
    } : {}),
    ...(field.providerSlot ? { providerSlot: field.providerSlot } : {}),
  }));
}

function parseAssignment(text) {
  const value = String(text);
  const equals = value.indexOf('=');
  if (equals <= 0) fail(`--value expects key=value (got ${JSON.stringify(value)})`);
  return [value.slice(0, equals), value.slice(equals + 1)];
}

function optionId(field, raw) {
  const options = Array.isArray(field.options) ? field.options : [];
  if (options.some((option) => option.id === raw)) return raw;
  const byLabel = options.filter((option) => String(option.label).toLowerCase() === raw.toLowerCase());
  return byLabel.length === 1 ? byLabel[0].id : raw;
}

// --value strings become typed JSON. With a readable schema the field type
// decides; without one, only unambiguous JSON literals (numbers, booleans,
// arrays) are converted and everything else stays a string.
function coerceValue(field, raw, timeZone) {
  if (!field) {
    if (/^-?\d+(\.\d+)?$/.test(raw) || raw === 'true' || raw === 'false' || /^\[.*\]$/.test(raw)) {
      try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
  }
  switch (field.type) {
    case 'number': {
      const number = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(number)) fail(`${field.id} must be a number`);
      return number;
    }
    case 'checkbox':
      if (/^(true|yes|1|on)$/i.test(raw)) return true;
      if (/^(false|no|0|off)$/i.test(raw)) return false;
      return fail(`${field.id} must be true or false`);
    case 'select':
      return optionId(field, raw);
    case 'multi-select': {
      let items;
      if (/^\[.*\]$/.test(raw.trim())) {
        try { items = JSON.parse(raw); } catch { fail(`${field.id} must be a JSON array or comma list`); }
      } else {
        items = raw === '' ? [] : raw.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return items.map((item) => optionId(field, String(item)));
    }
    case 'datetime':
      return eventTimeFor(parseInstant(raw, timeZone, field.id), timeZone).eventAt;
    default:
      return raw;
  }
}

function valuesFromRecord(record) {
  if (!record || record.values === undefined) return {};
  if (Array.isArray(record.values)) {
    return Object.fromEntries(record.values
      .filter((entry) => entry && typeof entry.fieldId === 'string')
      .map((entry) => [entry.fieldId, entry.value]));
  }
  return { ...record.values };
}

function unwrapValuesFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('--values-file must hold a JSON object of field id to value');
  const keys = Object.keys(parsed);
  if (keys.length === 1 && keys[0] === 'values' && parsed.values && typeof parsed.values === 'object') return { ...parsed.values };
  return { ...parsed };
}

// Assembles the JSON submit body. Order of precedence for each value:
// --value, then --values-file, then the superseded entry, then the field's
// declared default (the JSON API itself does not apply defaults). A datetime
// field left empty takes eventAt; with no --at, a single supplied datetime
// value becomes eventAt, as the browser form does.
function buildSubmission({
  fields,
  fileValues = {},
  assignments = [],
  at,
  timeZone,
  now = Date.now(),
  predecessor = null,
  supersedes,
  idempotencyKey,
}) {
  assertTimeZone(timeZone);
  const byId = new Map((fields || []).map((field) => [field.id, field]));
  const filled = [];
  const values = predecessor ? valuesFromRecord(predecessor) : {};
  if (fields && predecessor) {
    for (const key of Object.keys(values)) if (!byId.has(key)) delete values[key];
  }
  // File values are typed JSON already; only a datetime given as local wall
  // time is resolved in the zone, as --value does.
  for (const [key, value] of Object.entries(fileValues)) {
    const field = byId.get(key);
    values[key] = field && field.type === 'datetime' && typeof value === 'string'
      ? coerceValue(field, value, timeZone)
      : value;
  }
  const assigned = new Set();
  for (const text of assignments) {
    const [key, raw] = parseAssignment(text);
    if (fields && !byId.has(key)) fail(`unknown field ${JSON.stringify(key)}; run \`lookie forms show\` for field ids`);
    values[key] = coerceValue(byId.get(key), raw, timeZone);
    assigned.add(key);
  }

  let event;
  if (at !== undefined) {
    event = eventTimeFor(parseInstant(at, timeZone), timeZone);
  } else if (predecessor && predecessor.eventAt) {
    event = {
      eventAt: predecessor.eventAt,
      timezone: predecessor.timezone,
      clientOffsetMinutes: predecessor.clientOffsetMinutes,
    };
  } else {
    const datetimeIds = fields
      ? fields.filter((field) => field.type === 'datetime' && typeof values[field.id] === 'string').map((field) => field.id)
      : [];
    event = datetimeIds.length === 1
      ? eventTimeFor(parseInstant(values[datetimeIds[0]], timeZone, datetimeIds[0]), timeZone)
      : eventTimeFor(Math.floor(now / 1000) * 1000, timeZone);
  }

  if (fields) {
    const explicit = new Set([...Object.keys(fileValues), ...assigned]);
    for (const field of fields) {
      // --at re-times a correction: an inherited datetime follows it.
      const inherited = at !== undefined && predecessor && !explicit.has(field.id);
      if (values[field.id] !== undefined && !(inherited && field.type === 'datetime')) continue;
      if (field.type === 'datetime') {
        values[field.id] = event.eventAt;
        filled.push(field.id);
      } else if (field.default !== undefined) {
        values[field.id] = structuredClone(field.default);
        filled.push(field.id);
      }
    }
  }

  const body = { values, ...event };
  if (supersedes) body.supersedesRecord = { id: supersedes, resourceKind: 'form-submission' };
  if (idempotencyKey !== undefined) body.idempotencyKey = idempotencyKey;
  return { body, filled, assigned: [...assigned] };
}

module.exports = {
  CliFormsError,
  activeFields,
  buildSubmission,
  coerceValue,
  defaultTimeZone,
  eventTimeFor,
  fieldSummary,
  offsetMinutesAt,
  parseInstant,
  unwrapValuesFile,
  valuesFromRecord,
};
