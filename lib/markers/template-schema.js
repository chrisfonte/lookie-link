'use strict';

// Marker template validation (design §1.2, §3.1, §4). Closed key sets at every
// level; `sources`, `image` and projection configs are validated for shape only,
// they are resolved and executed by other modules.

const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ITEM_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const VALIDATOR_ID = /^[a-z0-9][a-z0-9._-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const STYLE = /^[a-z-]{1,24}$/;

const BUNDLED_IDS = Object.freeze(['freeform', 'radio-imaging', 'song-structure']);
const UNITS = Object.freeze(['samples', 'ms', 'seconds']);
const MARKER_KINDS = Object.freeze(['point', 'region']);
const SOURCE_KINDS = Object.freeze(['yaml', 'json']);
const PROJECTION_KINDS = Object.freeze(['yaml-pointers', 'rivendell']);
const RIVENDELL_FIELDS = Object.freeze([
  'START_POINT', 'END_POINT',
  'SEGUE_START_POINT', 'SEGUE_END_POINT',
  'HOOK_START_POINT', 'HOOK_END_POINT',
  'TALK_START_POINT', 'TALK_END_POINT',
  'FADEUP_POINT', 'FADEDOWN_POINT',
]);

const LIMITS = Object.freeze({
  markers: 100, groups: 50, pickers: 20, options: 200, sources: 50, projections: 10, writes: 100, texts: 50,
});

const TOP_KEYS = new Set([
  'contractVersion', 'resourceKind', 'templateId', 'revision', 'title', 'description', 'unit',
  'destinationId', 'groups', 'markers', 'keys', 'pickers', 'sources', 'image', 'projections',
]);
const GROUP_KEYS = new Set(['id', 'label']);
const MARKER_KEYS = new Set([
  'id', 'label', 'kind', 'group', 'color', 'multiple', 'required', 'tolerance', 'snap', 'snapWindow',
  'constraints', 'read',
]);
const CONSTRAINT_KEYS = new Set(['min', 'max', 'after', 'before', 'within', 'noOverlap', 'maxCount']);
const READ_KEYS = new Set(['source', 'pointer']);
const PICKER_KEYS = new Set(['id', 'label', 'options', 'required', 'writeTo']);
const OPTION_KEYS = new Set(['id', 'label', 'status']);
const SOURCE_KEYS = new Set(['id', 'kind', 'root', 'locate', 'pathFrom', 'from', 'select', 'as']);
const LOCATE_KEYS = new Set(['glob', 'match']);
const MATCH_KEYS = new Set(['pointer', 'equals']);
const PATH_FROM_KEYS = new Set(['source', 'pointer']);
const SELECT_KEYS = new Set(['pointer', 'unit', 'start', 'end', 'label']);
const AS_KEYS = new Set(['kind', 'label', 'color', 'style']);
const IMAGE_KEYS = new Set(['source', 'pathFrom', 'plot']);
const PLOT_KEYS = new Set(['left', 'right', 'top', 'bottom']);
const PROJECTION_COMMON_KEYS = ['id', 'kind'];
const YAML_POINTERS_KEYS = new Set([
  ...PROJECTION_COMMON_KEYS, 'root', 'target', 'validator', 'write', 'text', 'status', 'receipts', 'history', 'evidence',
]);
const RIVENDELL_KEYS = new Set([...PROJECTION_COMMON_KEYS, 'map']);
const WRITE_KEYS = new Set(['marker', 'pointer']);
const TEXT_KEYS = new Set(['pointer', 'template']);
const STATUS_KEYS = new Set(['pointer', 'onAccept']);
const RECEIPTS_KEYS = new Set(['dir', 'snapshot', 'receipt']);
const HISTORY_KEYS = new Set(['pointer', 'append']);
const EVIDENCE_KEYS = new Set(['pointer', 'append', 'referenceIn']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMarkerTemplateId(value) {
  return typeof value === 'string' && value.length <= 64 && DEFINITION_ID.test(value);
}

function createContext() {
  const errors = [];
  const add = (path, message) => { errors.push({ path, message }); };
  const closed = (value, allowed, path) => {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) add(path ? `${path}.${key}` : key, 'unknown property');
    }
  };
  const object = (value, path) => {
    if (isPlainObject(value)) return true;
    add(path, 'must be an object');
    return false;
  };
  const text = (value, path, { max = 200, optional = false } = {}) => {
    if (value === undefined && optional) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      add(path, `must be a non-empty string of at most ${max} characters`);
      return false;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      add(path, 'must not contain control characters');
      return false;
    }
    return true;
  };
  const bool = (value, path) => {
    if (value !== undefined && typeof value !== 'boolean') add(path, 'must be a boolean');
  };
  const int = (value, path, { min = 0 } = {}) => {
    if (!Number.isSafeInteger(value) || value < min) {
      add(path, `must be an integer of at least ${min}`);
      return false;
    }
    return true;
  };
  const list = (value, path, { min = 0, max }) => {
    if (!Array.isArray(value)) {
      add(path, 'must be an array');
      return false;
    }
    if (value.length < min || value.length > max) {
      add(path, `must contain ${min === 0 ? 'at most' : `${min} to`} ${max} entries`);
      return false;
    }
    return true;
  };
  const pointer = (value, path) => {
    if (text(value, path, { max: 512 }) && !value.startsWith('/')) add(path, 'must start with "/"');
  };
  const relativePath = (value, path) => {
    if (!text(value, path, { max: 512 })) return;
    if (value.startsWith('/') || value.includes('\\')) add(path, 'must be a relative path');
    else if (value.split('/').some((segment) => segment === '..')) add(path, 'must not contain ".."');
  };
  const fileName = (value, path) => {
    if (!text(value, path, { max: 200 })) return;
    if (/[\\/]/.test(value) || value === '.' || value === '..' || value.includes('..')) {
      add(path, 'must be a file name without separators or ".."');
    }
  };
  const id = (value, path, pattern = ITEM_ID) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !pattern.test(value)) {
      add(path, 'must be a lowercase identifier of at most 64 characters');
      return false;
    }
    return true;
  };
  return { errors, add, closed, object, text, bool, int, list, pointer, relativePath, fileName, id };
}

function validateGroups(doc, c) {
  const groupIds = new Set();
  if (doc.groups === undefined) return groupIds;
  if (!c.list(doc.groups, 'groups', { max: LIMITS.groups })) return groupIds;
  doc.groups.forEach((group, index) => {
    const path = `groups[${index}]`;
    if (!c.object(group, path)) return;
    c.closed(group, GROUP_KEYS, path);
    if (c.id(group.id, `${path}.id`)) {
      if (groupIds.has(group.id)) c.add(`${path}.id`, 'duplicate group id');
      groupIds.add(group.id);
    }
    c.text(group.label, `${path}.label`);
  });
  return groupIds;
}

function validateConstraints(constraints, path, marker, ctx) {
  const { c, markerById, groupIds } = ctx;
  if (!c.object(constraints, path)) return;
  c.closed(constraints, CONSTRAINT_KEYS, path);
  for (const key of ['min', 'max']) {
    if (constraints[key] !== undefined && !(typeof constraints[key] === 'number' && Number.isFinite(constraints[key]))) {
      c.add(`${path}.${key}`, 'must be a finite number');
    }
  }
  if (typeof constraints.min === 'number' && typeof constraints.max === 'number' && constraints.min > constraints.max) {
    c.add(`${path}.max`, 'must not be less than min');
  }
  for (const key of ['after', 'before', 'within']) {
    if (constraints[key] === undefined) continue;
    const target = markerById.get(constraints[key]);
    if (typeof constraints[key] !== 'string' || !target) {
      c.add(`${path}.${key}`, 'must name a declared marker');
    } else if (constraints[key] === marker.id) {
      c.add(`${path}.${key}`, 'must not name the marker itself');
    } else if (key === 'within' && target.kind !== 'region') {
      c.add(`${path}.${key}`, 'must name a region marker');
    }
  }
  if (constraints.noOverlap !== undefined && !groupIds.has(constraints.noOverlap)) {
    c.add(`${path}.noOverlap`, 'must name a declared group');
  }
  if (constraints.maxCount !== undefined) c.int(constraints.maxCount, `${path}.maxCount`, { min: 1 });
}

function validateMarkers(doc, c, groupIds, sourceIds) {
  const markerById = new Map();
  if (!c.list(doc.markers, 'markers', { min: 1, max: LIMITS.markers })) return markerById;
  const entries = [];
  doc.markers.forEach((marker, index) => {
    const path = `markers[${index}]`;
    if (!c.object(marker, path)) return;
    c.closed(marker, MARKER_KEYS, path);
    if (c.id(marker.id, `${path}.id`)) {
      if (markerById.has(marker.id)) c.add(`${path}.id`, 'duplicate marker id');
      else markerById.set(marker.id, marker);
    }
    entries.push([marker, path]);
  });
  for (const [marker, path] of entries) {
    c.text(marker.label, `${path}.label`);
    if (!MARKER_KINDS.includes(marker.kind)) c.add(`${path}.kind`, `must be one of ${MARKER_KINDS.join(', ')}`);
    if (marker.group !== undefined && !groupIds.has(marker.group)) c.add(`${path}.group`, 'must name a declared group');
    if (typeof marker.color !== 'string' || !COLOR.test(marker.color)) c.add(`${path}.color`, 'must be a #rrggbb color');
    c.bool(marker.multiple, `${path}.multiple`);
    c.bool(marker.required, `${path}.required`);
    if (marker.tolerance !== undefined) c.int(marker.tolerance, `${path}.tolerance`);
    if (marker.snapWindow !== undefined) c.int(marker.snapWindow, `${path}.snapWindow`);
    if (marker.snap !== undefined && marker.snap !== 'none' && !sourceIds.has(marker.snap)) {
      c.add(`${path}.snap`, 'must be "none" or name a declared source');
    }
    if (marker.constraints !== undefined) {
      validateConstraints(marker.constraints, `${path}.constraints`, marker, { c, markerById, groupIds });
    }
    if (marker.read !== undefined && c.object(marker.read, `${path}.read`)) {
      c.closed(marker.read, READ_KEYS, `${path}.read`);
      if (!sourceIds.has(marker.read.source)) c.add(`${path}.read.source`, 'must name a declared source');
      c.pointer(marker.read.pointer, `${path}.read.pointer`);
    }
  }
  return markerById;
}

function validateKeys(doc, c, markerById) {
  if (doc.keys === undefined || !c.object(doc.keys, 'keys')) return;
  const used = new Map();
  for (const [markerId, key] of Object.entries(doc.keys)) {
    const path = `keys.${markerId}`;
    if (!markerById.has(markerId)) c.add(path, 'must name a declared marker');
    if (typeof key !== 'string' || [...key].length !== 1 || !/^[^\s\p{C}]$/u.test(key)) {
      c.add(path, 'must be a single printable non-space character');
      continue;
    }
    if (used.has(key)) c.add(path, `key "${key}" is already used by "${used.get(key)}"`);
    else used.set(key, markerId);
  }
}

function validatePickers(doc, c) {
  if (doc.pickers === undefined || !c.list(doc.pickers, 'pickers', { max: LIMITS.pickers })) return;
  const ids = new Set();
  doc.pickers.forEach((picker, index) => {
    const path = `pickers[${index}]`;
    if (!c.object(picker, path)) return;
    c.closed(picker, PICKER_KEYS, path);
    if (c.id(picker.id, `${path}.id`)) {
      if (ids.has(picker.id)) c.add(`${path}.id`, 'duplicate picker id');
      ids.add(picker.id);
    }
    c.text(picker.label, `${path}.label`);
    c.bool(picker.required, `${path}.required`);
    if (picker.writeTo !== undefined) c.pointer(picker.writeTo, `${path}.writeTo`);
    if (!c.list(picker.options, `${path}.options`, { min: 1, max: LIMITS.options })) return;
    const optionIds = new Set();
    picker.options.forEach((option, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!c.object(option, optionPath)) return;
      c.closed(option, OPTION_KEYS, optionPath);
      if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 100
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(option.id)) {
        c.add(`${optionPath}.id`, 'must be an identifier of at most 100 characters');
      } else {
        if (optionIds.has(option.id)) c.add(`${optionPath}.id`, 'duplicate option id');
        optionIds.add(option.id);
      }
      c.text(option.label, `${optionPath}.label`);
      c.text(option.status, `${optionPath}.status`, { max: 64, optional: true });
    });
  });
}

function validateSources(doc, c) {
  const sourceIds = new Set();
  if (doc.sources === undefined) return sourceIds;
  if (!c.list(doc.sources, 'sources', { max: LIMITS.sources })) return sourceIds;
  const entries = [];
  doc.sources.forEach((source, index) => {
    const path = `sources[${index}]`;
    if (!c.object(source, path)) return;
    c.closed(source, SOURCE_KEYS, path);
    if (c.id(source.id, `${path}.id`)) {
      if (sourceIds.has(source.id)) c.add(`${path}.id`, 'duplicate source id');
      sourceIds.add(source.id);
    }
    entries.push([source, path]);
  });
  for (const [source, path] of entries) validateSource(source, path, c, sourceIds);
  return sourceIds;
}

function validateSource(source, path, c, sourceIds) {
  if (!SOURCE_KINDS.includes(source.kind)) c.add(`${path}.kind`, `must be one of ${SOURCE_KINDS.join(', ')}`);
  if (source.root !== undefined) c.id(source.root, `${path}.root`, DEFINITION_ID);
  if (source.locate === undefined && source.pathFrom === undefined && source.from === undefined) {
    c.add(path, 'needs one of locate, pathFrom or from');
  }
  if (source.locate !== undefined && c.object(source.locate, `${path}.locate`)) {
    c.closed(source.locate, LOCATE_KEYS, `${path}.locate`);
    c.relativePath(source.locate.glob, `${path}.locate.glob`);
    if (c.object(source.locate.match, `${path}.locate.match`)) {
      c.closed(source.locate.match, MATCH_KEYS, `${path}.locate.match`);
      c.pointer(source.locate.match.pointer, `${path}.locate.match.pointer`);
      c.text(source.locate.match.equals, `${path}.locate.match.equals`);
    }
  }
  if (source.pathFrom !== undefined) {
    if (typeof source.pathFrom === 'string') {
      c.pointer(source.pathFrom, `${path}.pathFrom`);
    } else if (c.object(source.pathFrom, `${path}.pathFrom`)) {
      c.closed(source.pathFrom, PATH_FROM_KEYS, `${path}.pathFrom`);
      if (!sourceIds.has(source.pathFrom.source) || source.pathFrom.source === source.id) {
        c.add(`${path}.pathFrom.source`, 'must name another declared source');
      }
      c.pointer(source.pathFrom.pointer, `${path}.pathFrom.pointer`);
    }
  }
  if (source.from !== undefined && (!sourceIds.has(source.from) || source.from === source.id)) {
    c.add(`${path}.from`, 'must name another declared source');
  }
  if (source.select !== undefined && c.object(source.select, `${path}.select`)) {
    c.closed(source.select, SELECT_KEYS, `${path}.select`);
    c.pointer(source.select.pointer, `${path}.select.pointer`);
    if (source.select.unit !== undefined && !UNITS.includes(source.select.unit)) {
      c.add(`${path}.select.unit`, `must be one of ${UNITS.join(', ')}`);
    }
    for (const key of ['start', 'end', 'label']) c.text(source.select[key], `${path}.select.${key}`, { optional: true });
  }
  if (source.as !== undefined && c.object(source.as, `${path}.as`)) {
    c.closed(source.as, AS_KEYS, `${path}.as`);
    if (!MARKER_KINDS.includes(source.as.kind)) c.add(`${path}.as.kind`, `must be one of ${MARKER_KINDS.join(', ')}`);
    c.text(source.as.label, `${path}.as.label`, { optional: true });
    if (source.as.color !== undefined && (typeof source.as.color !== 'string' || !COLOR.test(source.as.color))) {
      c.add(`${path}.as.color`, 'must be a #rrggbb color');
    }
    if (source.as.style !== undefined && (typeof source.as.style !== 'string' || !STYLE.test(source.as.style))) {
      c.add(`${path}.as.style`, 'must be a short lowercase style name');
    }
  }
}

function validateImage(doc, c, sourceIds) {
  if (doc.image === undefined || !c.object(doc.image, 'image')) return;
  c.closed(doc.image, IMAGE_KEYS, 'image');
  if (!sourceIds.has(doc.image.source)) c.add('image.source', 'must name a declared source');
  c.pointer(doc.image.pathFrom, 'image.pathFrom');
  if (doc.image.plot === undefined || !c.object(doc.image.plot, 'image.plot')) return;
  c.closed(doc.image.plot, PLOT_KEYS, 'image.plot');
  const plot = doc.image.plot;
  const ok = ['left', 'right', 'top', 'bottom'].map((key) => c.int(plot[key], `image.plot.${key}`));
  if (ok[0] && ok[1] && plot.left >= plot.right) c.add('image.plot.right', 'must be greater than left');
  if (ok[2] && ok[3] && plot.top >= plot.bottom) c.add('image.plot.bottom', 'must be greater than top');
}

function validateAppend(value, path, c) {
  if (!c.object(value, path)) return;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 50) c.add(path, 'must hold 1 to 50 entries');
  for (const key of keys) {
    if (key.length === 0 || key.length > 100) c.add(`${path}.${key}`, 'key must be 1 to 100 characters');
    c.text(value[key], `${path}.${key}`, { max: 500 });
  }
}

function validateYamlPointers(projection, path, c, ctx) {
  c.closed(projection, YAML_POINTERS_KEYS, path);
  c.id(projection.root, `${path}.root`, DEFINITION_ID);
  if (!ctx.sourceIds.has(projection.target)) c.add(`${path}.target`, 'must name a declared source');
  if (projection.validator !== undefined) c.id(projection.validator, `${path}.validator`, VALIDATOR_ID);
  if (c.list(projection.write, `${path}.write`, { min: 1, max: LIMITS.writes })) {
    projection.write.forEach((entry, index) => {
      const entryPath = `${path}.write[${index}]`;
      if (!c.object(entry, entryPath)) return;
      c.closed(entry, WRITE_KEYS, entryPath);
      if (!ctx.markerById.has(entry.marker)) c.add(`${entryPath}.marker`, 'must name a declared marker');
      c.pointer(entry.pointer, `${entryPath}.pointer`);
    });
  }
  if (projection.text !== undefined && c.list(projection.text, `${path}.text`, { max: LIMITS.texts })) {
    projection.text.forEach((entry, index) => {
      const entryPath = `${path}.text[${index}]`;
      if (!c.object(entry, entryPath)) return;
      c.closed(entry, TEXT_KEYS, entryPath);
      c.pointer(entry.pointer, `${entryPath}.pointer`);
      c.text(entry.template, `${entryPath}.template`, { max: 1000 });
    });
  }
  if (projection.status !== undefined && c.object(projection.status, `${path}.status`)) {
    c.closed(projection.status, STATUS_KEYS, `${path}.status`);
    c.pointer(projection.status.pointer, `${path}.status.pointer`);
    c.text(projection.status.onAccept, `${path}.status.onAccept`, { max: 100 });
  }
  if (c.object(projection.receipts, `${path}.receipts`)) {
    c.closed(projection.receipts, RECEIPTS_KEYS, `${path}.receipts`);
    c.relativePath(projection.receipts.dir, `${path}.receipts.dir`);
    c.fileName(projection.receipts.snapshot, `${path}.receipts.snapshot`);
    c.fileName(projection.receipts.receipt, `${path}.receipts.receipt`);
  }
  if (projection.history !== undefined && c.object(projection.history, `${path}.history`)) {
    c.closed(projection.history, HISTORY_KEYS, `${path}.history`);
    c.pointer(projection.history.pointer, `${path}.history.pointer`);
    validateAppend(projection.history.append, `${path}.history.append`, c);
  }
  if (projection.evidence !== undefined && c.object(projection.evidence, `${path}.evidence`)) {
    c.closed(projection.evidence, EVIDENCE_KEYS, `${path}.evidence`);
    c.pointer(projection.evidence.pointer, `${path}.evidence.pointer`);
    validateAppend(projection.evidence.append, `${path}.evidence.append`, c);
    if (projection.evidence.referenceIn !== undefined) c.pointer(projection.evidence.referenceIn, `${path}.evidence.referenceIn`);
  }
}

function validateRivendell(projection, path, c, ctx) {
  c.closed(projection, RIVENDELL_KEYS, path);
  if (!c.object(projection.map, `${path}.map`)) return;
  const entries = Object.entries(projection.map);
  if (entries.length === 0) c.add(`${path}.map`, 'must map at least one marker');
  for (const [markerId, fields] of entries) {
    const fieldPath = `${path}.map.${markerId}`;
    if (!ctx.markerById.has(markerId)) c.add(fieldPath, 'must name a declared marker');
    const names = Array.isArray(fields) ? fields : [fields];
    if (Array.isArray(fields) && fields.length !== 2) c.add(fieldPath, 'a pair must hold exactly two field names');
    for (const name of names) {
      if (!RIVENDELL_FIELDS.includes(name)) c.add(fieldPath, `unknown Rivendell field "${String(name)}"`);
    }
  }
}

function validateProjections(doc, c, markerById, sourceIds) {
  if (doc.projections === undefined || !c.list(doc.projections, 'projections', { max: LIMITS.projections })) return;
  const ids = new Set();
  doc.projections.forEach((projection, index) => {
    const path = `projections[${index}]`;
    if (!c.object(projection, path)) return;
    if (c.id(projection.id, `${path}.id`)) {
      if (ids.has(projection.id)) c.add(`${path}.id`, 'duplicate projection id');
      ids.add(projection.id);
    }
    const ctx = { markerById, sourceIds };
    if (projection.kind === 'yaml-pointers') validateYamlPointers(projection, path, c, ctx);
    else if (projection.kind === 'rivendell') validateRivendell(projection, path, c, ctx);
    else {
      c.add(`${path}.kind`, `must be one of ${PROJECTION_KINDS.join(', ')}`);
      c.closed(projection, new Set([...YAML_POINTERS_KEYS, ...RIVENDELL_KEYS]), path);
    }
  });
}

/**
 * @param {unknown} doc
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 */
function validateMarkerTemplate(doc) {
  const c = createContext();
  if (!isPlainObject(doc)) {
    c.add('', 'template must be an object');
    return { valid: false, errors: c.errors };
  }
  c.closed(doc, TOP_KEYS, '');
  if (doc.contractVersion !== 1) c.add('contractVersion', 'must be 1');
  if (doc.resourceKind !== 'marker-template') c.add('resourceKind', 'must be "marker-template"');
  if (!isMarkerTemplateId(doc.templateId)) c.add('templateId', 'must be a lowercase hyphenated identifier of at most 64 characters');
  c.int(doc.revision, 'revision', { min: 1 });
  c.text(doc.title, 'title');
  c.text(doc.description, 'description', { max: 2000, optional: true });
  if (!UNITS.includes(doc.unit)) c.add('unit', `must be one of ${UNITS.join(', ')}`);
  if (doc.destinationId !== undefined) c.id(doc.destinationId, 'destinationId', DEFINITION_ID);

  const groupIds = validateGroups(doc, c);
  const sourceIds = validateSources(doc, c);
  const markerById = validateMarkers(doc, c, groupIds, sourceIds);
  validateKeys(doc, c, markerById);
  validatePickers(doc, c);
  validateImage(doc, c, sourceIds);
  validateProjections(doc, c, markerById, sourceIds);
  return { valid: c.errors.length === 0, errors: c.errors };
}

/**
 * List-response projection of a template. `source`/`writable` come from the
 * store entry (or the second argument).
 */
function summarizeTemplate(doc, meta = {}) {
  const source = meta.source !== undefined ? meta.source : doc.source;
  const writable = meta.writable !== undefined ? meta.writable : doc.writable;
  return {
    templateId: doc.templateId,
    revision: doc.revision,
    title: doc.title,
    unit: doc.unit,
    markerCount: Array.isArray(doc.markers) ? doc.markers.length : 0,
    source: source === undefined ? 'stored' : source,
    writable: writable === undefined ? source !== 'bundled' : writable,
  };
}

module.exports = {
  BUNDLED_IDS,
  RIVENDELL_FIELDS,
  isMarkerTemplateId,
  validateMarkerTemplate,
  summarizeTemplate,
};
