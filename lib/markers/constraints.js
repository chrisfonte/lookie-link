'use strict';

// Marker constraint evaluation (design §1.2, §1.3). Pure: no I/O. Positions are
// integer sample indexes; regions are half-open [startSample, endSample).
// Ordering rules compare inclusively, so touching positions satisfy them.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toSamples(value, unit, sampleRate) {
  if (unit === 'samples') return Math.round(value);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError('sampleRate is required to evaluate min/max in a non-sample unit.');
  }
  if (unit === 'ms') return Math.round((value * sampleRate) / 1000);
  return Math.round(value * sampleRate);
}

function isSample(value, frames) {
  return Number.isSafeInteger(value) && value >= 0 && value <= frames;
}

// Start/end of a marker in samples; a point has start === end === sample.
function extent(marker) {
  if (marker.kind === 'region') return { start: marker.startSample, end: marker.endSample };
  return { start: marker.sample, end: marker.sample };
}

function checkPosition(marker, index, frames, definition, errors) {
  const push = (field, message) => errors.push({ markerId: marker.id ?? null, path: `markers[${index}].${field}`, message });
  if (marker.kind === 'region') {
    const { startSample: start, endSample: end } = marker;
    let usable = true;
    if (!isSample(start, frames)) { push('startSample', `startSample must be an integer from 0 to ${frames}`); usable = false; }
    if (!isSample(end, frames)) { push('endSample', `endSample must be an integer from 0 to ${frames}`); usable = false; }
    if (usable) {
      if (start > end) push('endSample', 'endSample must not be before startSample');
      else if (start === end && !(definition && definition.allowZeroLength === true)) push('endSample', 'a zero-length region is not allowed for this marker type');
    }
    return usable && start <= end;
  }
  if (!isSample(marker.sample, frames)) {
    push('sample', `sample must be an integer from 0 to ${frames}`);
    return false;
  }
  return true;
}

function checkCounts(template, entries, errors) {
  for (const definition of template.markers) {
    const instances = entries.filter((entry) => entry.marker.type === definition.id);
    const constraints = definition.constraints || {};
    if (definition.required && instances.length === 0) {
      errors.push({ markerId: definition.id, path: 'markers', message: `${definition.id} is required` });
    }
    let limit = definition.multiple ? Infinity : 1;
    if (definition.multiple && Number.isSafeInteger(constraints.maxCount)) limit = constraints.maxCount;
    instances.slice(limit).forEach((entry) => {
      errors.push({
        markerId: entry.marker.id ?? null,
        path: `markers[${entry.index}]`,
        message: definition.multiple ? `at most ${limit} ${definition.id} markers are allowed` : `only one ${definition.id} marker is allowed`,
      });
    });
  }
}

function checkBounds(template, sampleRate, entry, definition, errors) {
  const constraints = definition.constraints || {};
  const { start, end } = extent(entry.marker);
  const push = (message) => errors.push({ markerId: entry.marker.id ?? null, path: `markers[${entry.index}]`, message });
  if (Number.isFinite(constraints.min)) {
    const min = toSamples(constraints.min, template.unit, sampleRate);
    if (start < min) push(`${definition.id} must not start before ${constraints.min} ${template.unit}`);
  }
  if (Number.isFinite(constraints.max)) {
    const max = toSamples(constraints.max, template.unit, sampleRate);
    if (end > max) push(`${definition.id} must not end after ${constraints.max} ${template.unit}`);
  }
}

// after/before/within against every placed instance of the referenced type;
// a reference that is not placed is skipped (use `required` to demand it).
function checkOrdering(entries, entry, definition, errors) {
  const constraints = definition.constraints || {};
  const mine = extent(entry.marker);
  const push = (message, rule) => errors.push({ markerId: entry.marker.id ?? null, path: `markers[${entry.index}]`, message, rule });
  const references = (typeId) => entries.filter((other) => other !== entry && other.marker.type === typeId);
  if (constraints.after) {
    for (const other of references(constraints.after)) {
      if (mine.start < extent(other.marker).end) push(`${definition.id} must be after ${constraints.after}`, 'after');
    }
  }
  if (constraints.before) {
    for (const other of references(constraints.before)) {
      if (mine.end > extent(other.marker).start) push(`${definition.id} must be before ${constraints.before}`, 'before');
    }
  }
  if (constraints.within) {
    const regions = references(constraints.within).filter((other) => other.marker.kind === 'region');
    if (regions.length > 0 && !regions.some((other) => {
      const outer = extent(other.marker);
      return mine.start >= outer.start && mine.end <= outer.end;
    })) {
      push(`${definition.id} must be inside ${constraints.within}`, 'within');
    }
  }
}

function checkNoOverlap(template, entries, errors) {
  const groups = new Set();
  for (const definition of template.markers) {
    if (definition.constraints && definition.constraints.noOverlap) groups.add(definition.constraints.noOverlap);
  }
  for (const group of groups) {
    const typeIds = new Set(template.markers.filter((definition) => definition.group === group).map((definition) => definition.id));
    const regions = entries
      .filter((entry) => entry.marker.kind === 'region' && typeIds.has(entry.marker.type))
      .sort((left, right) => left.marker.startSample - right.marker.startSample || left.index - right.index);
    regions.forEach((current, position) => {
      for (const earlier of regions.slice(0, position)) {
        if (earlier.marker.startSample < current.marker.endSample && current.marker.startSample < earlier.marker.endSample) {
          errors.push({
            markerId: current.marker.id ?? null,
            path: `markers[${current.index}]`,
            message: `${current.marker.id ?? current.marker.type} overlaps ${earlier.marker.id ?? earlier.marker.type} in group ${group}`,
          });
          break;
        }
      }
    });
  }
}

const OVERRIDABLE = new Set(['after', 'before', 'within']);

// Accepts a Set or array of marker ids, a Map of id -> reason, or an array of { markerId, reason }.
function overrideIds(overrides) {
  if (!overrides) return new Set();
  if (overrides instanceof Map) return new Set(overrides.keys());
  if (overrides instanceof Set) return new Set(overrides);
  if (Array.isArray(overrides)) return new Set(overrides.map((entry) => (typeof entry === 'string' ? entry : entry && entry.markerId)));
  return new Set();
}

function evaluateTags(template, tags, errors) {
  const pickers = template.pickers || [];
  if (!isPlainObject(tags)) {
    errors.push({ markerId: null, path: 'tags', message: 'tags must be an object' });
    return;
  }
  for (const [key, value] of Object.entries(tags)) {
    const picker = pickers.find((candidate) => candidate.id === key);
    if (!picker) {
      errors.push({ markerId: null, path: `tags.${key}`, message: `${key} is not a declared picker` });
    } else if (typeof value !== 'string') {
      errors.push({ markerId: null, path: `tags.${key}`, message: 'tag values must be strings' });
    } else if (Array.isArray(picker.options) && picker.options.length > 0
        && !picker.options.some((option) => option.id === value)) {
      errors.push({ markerId: null, path: `tags.${key}`, message: `${value} is not an option of ${key}` });
    }
  }
  for (const picker of pickers) {
    if (picker.required && !(typeof tags[picker.id] === 'string' && tags[picker.id])) {
      errors.push({ markerId: null, path: `tags.${picker.id}`, message: `${picker.id} is required` });
    }
  }
}

/**
 * @param {object} args
 * @param {object} args.template marker template document
 * @param {object[]} args.markers record markers ({id, type, kind, sample | startSample + endSample})
 * @param {number} args.frames audio length in sample frames
 * @param {number} [args.sampleRate] needed when min/max are declared in ms or seconds
 * @param {object} [args.tags] checked against the template's pickers when given
 * @param {Set<string>|Map<string, string>|object[]} [args.overrides] marker ids allowed to violate after/before/within;
 *   those violations are reported as warnings, not errors
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
function evaluateConstraints({ template, markers, frames, sampleRate, tags, overrides } = {}) {
  let errors = [];
  if (!isPlainObject(template) || !Array.isArray(template.markers)) throw new TypeError('template is required.');
  if (!Number.isSafeInteger(frames) || frames < 0) throw new TypeError('frames must be a non-negative integer.');
  if (!Array.isArray(markers)) {
    return { ok: false, errors: [{ markerId: null, path: 'markers', message: 'markers must be an array' }], warnings: [] };
  }
  const definitions = new Map(template.markers.map((definition) => [definition.id, definition]));
  const entries = [];
  const typed = [];
  markers.forEach((marker, index) => {
    const push = (field, message) => errors.push({ markerId: (marker && marker.id) ?? null, path: `markers[${index}].${field}`, message });
    if (!isPlainObject(marker)) {
      errors.push({ markerId: null, path: `markers[${index}]`, message: 'marker must be an object' });
      return;
    }
    const definition = definitions.get(marker.type);
    if (!definition) {
      push('type', `unknown marker type ${String(marker.type)}`);
      return;
    }
    if (marker.kind !== definition.kind) {
      push('kind', `${definition.id} is a ${definition.kind} marker`);
      return;
    }
    typed.push({ marker, index, definition });
    if (!checkPosition(marker, index, frames, definition, errors)) return;
    entries.push({ marker, index, definition });
  });
  checkCounts(template, typed, errors);
  for (const entry of entries) {
    checkBounds(template, sampleRate, entry, entry.definition, errors);
    checkOrdering(entries, entry, entry.definition, errors);
  }
  checkNoOverlap(template, entries, errors);
  if (tags !== undefined) evaluateTags(template, tags, errors);
  const overridden = overrideIds(overrides);
  const warnings = errors.filter((error) => OVERRIDABLE.has(error.rule) && overridden.has(error.markerId));
  errors = errors.filter((error) => !warnings.includes(error));
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { evaluateConstraints };
