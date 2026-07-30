'use strict';

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

const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

const TEMPLATE_KEYS = new Set([
  'contractVersion', 'resourceKind', 'templateId', 'ownerId', 'revision',
  'grammarVersion', 'destinationId', 'title', 'description', 'tags', 'lineage',
  'presentation', 'fields', 'archived', 'kind', 'containerId', 'memberOrder', 'parentId',
]);
const TEMPLATE_VERSION_KEYS = new Set([
  'contractVersion', 'resourceKind', 'templateId', 'ownerId', 'templateVersion',
  'sourceRevision', 'grammarVersion', 'publishedAt', 'publishedBy', 'title',
  'description', 'tags', 'lineage', 'presentation', 'fields', 'schemaDigest',
  'kind', 'containerId', 'memberOrder', 'parentId',
]);
const FIELD_KEYS = new Set([
  'id', 'type', 'label', 'help', 'required', 'default', 'component',
  'constraints', 'options', 'providerSlot', 'showInList', 'isDestroyed',
]);
const OPTION_KEYS = new Set(['id', 'label', 'disabled']);
const CONSTRAINT_KEYS = {
  'short-text': new Set(['minLength', 'maxLength']),
  'long-text': new Set(['minLength', 'maxLength']),
  number: new Set(['minimum', 'maximum', 'integer', 'step']),
  checkbox: new Set(),
  date: new Set(['minimum', 'maximum']),
  time: new Set(),
  datetime: new Set(['minimum', 'maximum']),
  select: new Set(),
  'multi-select': new Set(['minSelections', 'maxSelections']),
};

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function addError(errors, path, message) {
  errors.push({path, message});
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, path ? `${path}.${key}` : key, 'unknown property');
  }
}

function normalizedText(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateText(value, path, errors, {minimum = 0, maximum, requiredContent = false} = {}) {
  if (typeof value !== 'string') {
    addError(errors, path, 'must be a string');
    return null;
  }
  if (hasUnpairedSurrogate(value)) addError(errors, path, 'contains an unpaired Unicode surrogate');
  const normalized = normalizedText(value);
  if (CONTROL_CHARACTER.test(normalized)) addError(errors, path, 'contains a prohibited control character');
  const length = [...normalized].length;
  if (length < minimum) addError(errors, path, `must contain at least ${minimum} Unicode code points`);
  if (length > maximum) addError(errors, path, `must contain at most ${maximum} Unicode code points`);
  if (requiredContent && !/\S/u.test(normalized)) addError(errors, path, 'must contain a non-whitespace character');
  return normalized;
}

function validateId(value, path, errors) {
  if (typeof value !== 'string' || value.length > 64 || !DEFINITION_ID.test(value)) {
    addError(errors, path, 'must be a definition ID');
    return false;
  }
  return true;
}

function validateInteger(value, path, errors, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    addError(errors, path, `must be an integer from ${minimum} through ${maximum}`);
    return false;
  }
  return true;
}

function validateDate(value, path, errors) {
  if (typeof value !== 'string') {
    addError(errors, path, 'must be a date string');
    return false;
  }
  const match = DATE.exec(value);
  if (!match) {
    addError(errors, path, 'must use YYYY-MM-DD format');
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(0, 0, 0, 0);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    addError(errors, path, 'must represent a real calendar date');
    return false;
  }
  return true;
}

function validateDatetime(value, path, errors) {
  if (typeof value !== 'string' || !DATETIME.test(value)) {
    addError(errors, path, 'must be an RFC 3339 timestamp with an explicit offset');
    return false;
  }
  const datePart = value.slice(0, 10);
  if (!validateDate(datePart, path, errors)) return false;
  if (!Number.isFinite(Date.parse(value))) {
    addError(errors, path, 'must represent a valid RFC 3339 instant');
    return false;
  }
  return true;
}

function validateConstraintBoundPair(constraints, path, errors, compare = (a, b) => a > b) {
  if (own(constraints, 'minimum') && own(constraints, 'maximum') &&
      compare(constraints.minimum, constraints.maximum)) {
    addError(errors, `${path}.minimum`, 'must not exceed maximum');
  }
}

function isStepAligned(value, base, step) {
  const quotient = (value - base) / step;
  if (!Number.isFinite(quotient) || Math.abs(quotient) > Number.MAX_SAFE_INTEGER) return false;
  const nearest = Math.round(quotient);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
  return Math.abs(quotient - nearest) <= tolerance;
}

function validateConstraints(field, path, errors) {
  if (!own(field, 'constraints')) return;
  const constraintsPath = `${path}.constraints`;
  if (!isRecord(field.constraints)) {
    addError(errors, constraintsPath, 'must be an object');
    return;
  }
  const allowed = CONSTRAINT_KEYS[field.type] || new Set();
  rejectUnknownKeys(field.constraints, allowed, constraintsPath, errors);
  const constraints = field.constraints;

  if (field.type === 'short-text' || field.type === 'long-text') {
    const ceiling = field.type === 'short-text' ? 256 : 10000;
    if (own(constraints, 'minLength')) validateInteger(constraints.minLength, `${constraintsPath}.minLength`, errors, 0, ceiling);
    if (own(constraints, 'maxLength')) validateInteger(constraints.maxLength, `${constraintsPath}.maxLength`, errors, 1, ceiling);
    if (Number.isInteger(constraints.minLength) && Number.isInteger(constraints.maxLength) &&
        constraints.minLength > constraints.maxLength) {
      addError(errors, `${constraintsPath}.minLength`, 'must not exceed maxLength');
    }
  } else if (field.type === 'number') {
    for (const key of ['minimum', 'maximum', 'step']) {
      if (own(constraints, key) && (typeof constraints[key] !== 'number' || !Number.isFinite(constraints[key]) || Object.is(constraints[key], -0))) {
        addError(errors, `${constraintsPath}.${key}`, 'must be a finite JSON number other than negative zero');
      }
    }
    if (Number.isFinite(constraints.step) && constraints.step <= 0) {
      addError(errors, `${constraintsPath}.step`, 'must be greater than zero');
    }
    if (own(constraints, 'integer') && typeof constraints.integer !== 'boolean') {
      addError(errors, `${constraintsPath}.integer`, 'must be a boolean');
    }
    if (Number.isFinite(constraints.minimum) && Number.isFinite(constraints.maximum)) {
      validateConstraintBoundPair(constraints, constraintsPath, errors);
      if (constraints.maximum >= constraints.minimum && constraints.step > 0
          && !isStepAligned(constraints.maximum, constraints.minimum, constraints.step)) {
        addError(errors, `${constraintsPath}.step`, 'must divide the minimum-to-maximum range evenly');
      }
    }
  } else if (field.type === 'date') {
    for (const key of ['minimum', 'maximum']) {
      if (own(constraints, key)) validateDate(constraints[key], `${constraintsPath}.${key}`, errors);
    }
    if (DATE.test(constraints.minimum || '') && DATE.test(constraints.maximum || '')) {
      validateConstraintBoundPair(constraints, constraintsPath, errors);
    }
  } else if (field.type === 'datetime') {
    for (const key of ['minimum', 'maximum']) {
      if (own(constraints, key)) validateDatetime(constraints[key], `${constraintsPath}.${key}`, errors);
    }
    if (DATETIME.test(constraints.minimum || '') && DATETIME.test(constraints.maximum || '')) {
      validateConstraintBoundPair(constraints, constraintsPath, errors, (a, b) => Date.parse(a) > Date.parse(b));
    }
  } else if (field.type === 'multi-select') {
    for (const key of ['minSelections', 'maxSelections']) {
      if (own(constraints, key)) validateInteger(constraints[key], `${constraintsPath}.${key}`, errors, 0, 1000);
    }
    if (Number.isInteger(constraints.minSelections) && Number.isInteger(constraints.maxSelections) &&
        constraints.minSelections > constraints.maxSelections) {
      addError(errors, `${constraintsPath}.minSelections`, 'must not exceed maxSelections');
    }
  }
}

function validateOptions(field, path, errors) {
  const isSelection = field.type === 'select' || field.type === 'multi-select';
  const hasOptions = own(field, 'options');
  const hasProvider = own(field, 'providerSlot');
  if (!isSelection) {
    if (hasOptions) addError(errors, `${path}.options`, 'is allowed only for selection fields');
    if (hasProvider) addError(errors, `${path}.providerSlot`, 'is allowed only for selection fields');
    return;
  }
  if (hasOptions === hasProvider) {
    addError(errors, hasOptions ? `${path}.providerSlot` : `${path}.options`, 'exactly one option source is required');
  }
  if (hasProvider) validateId(field.providerSlot, `${path}.providerSlot`, errors);
  if (!hasOptions) return;
  if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 1000) {
    addError(errors, `${path}.options`, 'must be an array containing 1 through 1000 options');
    return;
  }
  const ids = new Set();
  field.options.forEach((option, index) => {
    const optionPath = `${path}.options[${index}]`;
    if (!isRecord(option)) {
      addError(errors, optionPath, 'must be an object');
      return;
    }
    rejectUnknownKeys(option, OPTION_KEYS, optionPath, errors);
    if (!own(option, 'id')) addError(errors, `${optionPath}.id`, 'is required');
    else if (validateId(option.id, `${optionPath}.id`, errors)) {
      if (ids.has(option.id)) addError(errors, `${optionPath}.id`, 'must be unique within the field');
      ids.add(option.id);
    }
    if (!own(option, 'label')) addError(errors, `${optionPath}.label`, 'is required');
    else validateText(option.label, `${optionPath}.label`, errors, {minimum: 1, maximum: 200});
    if (own(option, 'disabled') && typeof option.disabled !== 'boolean') {
      addError(errors, `${optionPath}.disabled`, 'must be a boolean');
    }
  });
}

function valueForField(field, value, path, errors) {
  const constraints = isRecord(field.constraints) ? field.constraints : {};
  if (field.type === 'short-text' || field.type === 'long-text') {
    const ceiling = field.type === 'short-text' ? 256 : 10000;
    const normalized = validateText(value, path, errors, {
      minimum: constraints.minLength ?? 0,
      maximum: constraints.maxLength ?? ceiling,
      requiredContent: field.required,
    });
    return normalized;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
      addError(errors, path, 'must be a finite JSON number other than negative zero');
      return value;
    }
    if (constraints.integer && (!Number.isSafeInteger(value))) addError(errors, path, 'must be a safe integer');
    if (typeof constraints.minimum === 'number' && value < constraints.minimum) addError(errors, path, `must be at least ${constraints.minimum}`);
    if (typeof constraints.maximum === 'number' && value > constraints.maximum) addError(errors, path, `must be at most ${constraints.maximum}`);
    if (typeof constraints.step === 'number'
        && !isStepAligned(value, typeof constraints.minimum === 'number' ? constraints.minimum : 0, constraints.step)) {
      addError(errors, path, `must align to step ${constraints.step}`);
    }
    return value;
  }
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') addError(errors, path, 'must be a boolean');
    return value;
  }
  if (field.type === 'date') {
    if (validateDate(value, path, errors)) {
      if (typeof constraints.minimum === 'string' && value < constraints.minimum) addError(errors, path, 'must be on or after minimum');
      if (typeof constraints.maximum === 'string' && value > constraints.maximum) addError(errors, path, 'must be on or before maximum');
    }
    return value;
  }
  if (field.type === 'time') {
    if (typeof value !== 'string' || !TIME.test(value)) addError(errors, path, 'must be HH:MM or HH:MM:SS in 24-hour time');
    return value;
  }
  if (field.type === 'datetime') {
    if (validateDatetime(value, path, errors)) {
      const instant = Date.parse(value);
      if (typeof constraints.minimum === 'string' && instant < Date.parse(constraints.minimum)) addError(errors, path, 'must be at or after minimum');
      if (typeof constraints.maximum === 'string' && instant > Date.parse(constraints.maximum)) addError(errors, path, 'must be at or before maximum');
    }
    return value;
  }
  if (field.type === 'select') {
    if (!validateId(value, path, errors)) return value;
    if (Array.isArray(field.options)) {
      const option = field.options.find((entry) => isRecord(entry) && entry.id === value);
      if (!option) addError(errors, path, 'must identify one declared option');
      else if (option.disabled) addError(errors, path, 'must not identify a disabled option');
    }
    return value;
  }
  if (field.type === 'multi-select') {
    if (!Array.isArray(value)) {
      addError(errors, path, 'must be an ordered option-ID array');
      return value;
    }
    const seen = new Set();
    const optionMap = new Map(Array.isArray(field.options) ? field.options.map((option) => [option.id, option]) : []);
    value.forEach((id, index) => {
      const itemPath = `${path}[${index}]`;
      if (!validateId(id, itemPath, errors)) return;
      if (seen.has(id)) addError(errors, itemPath, 'must not duplicate a selection');
      seen.add(id);
      if (Array.isArray(field.options)) {
        const option = optionMap.get(id);
        if (!option) addError(errors, itemPath, 'must identify a declared option');
        else if (option.disabled) addError(errors, itemPath, 'must not identify a disabled option');
      }
    });
    if (Number.isInteger(constraints.minSelections) && value.length < constraints.minSelections) addError(errors, path, 'contains fewer than minSelections');
    if (Number.isInteger(constraints.maxSelections) && value.length > constraints.maxSelections) addError(errors, path, 'contains more than maxSelections');
    return value.slice();
  }
  return value;
}

function validateField(field, index, errors) {
  const path = `fields[${index}]`;
  if (!isRecord(field)) {
    addError(errors, path, 'must be an object');
    return;
  }
  rejectUnknownKeys(field, FIELD_KEYS, path, errors);
  for (const key of ['id', 'type', 'label', 'required']) {
    if (!own(field, key)) addError(errors, `${path}.${key}`, 'is required');
  }
  if (own(field, 'id')) validateId(field.id, `${path}.id`, errors);
  if (own(field, 'type') && !FIELD_TYPES.has(field.type)) addError(errors, `${path}.type`, 'is not a supported field type');
  if (own(field, 'label')) validateText(field.label, `${path}.label`, errors, {minimum: 1, maximum: 200});
  if (own(field, 'help')) validateText(field.help, `${path}.help`, errors, {minimum: 1, maximum: 1000});
  if (own(field, 'required') && typeof field.required !== 'boolean') addError(errors, `${path}.required`, 'must be a boolean');
  if (own(field, 'showInList') && typeof field.showInList !== 'boolean') addError(errors, `${path}.showInList`, 'must be a boolean');
  if (own(field, 'isDestroyed') && typeof field.isDestroyed !== 'boolean') addError(errors, `${path}.isDestroyed`, 'must be a boolean');
  if (own(field, 'component')) validateId(field.component, `${path}.component`, errors);
  validateConstraints(field, path, errors);
  validateOptions(field, path, errors);
  if (own(field, 'default')) {
    if (own(field, 'providerSlot')) addError(errors, `${path}.default`, 'is prohibited with a dynamic option provider');
    if (FIELD_TYPES.has(field.type)) valueForField(field, field.default, `${path}.default`, errors);
  }
}

function validateLineage(lineage, errors) {
  if (!isRecord(lineage)) {
    addError(errors, 'lineage', 'must be an object');
    return;
  }
  rejectUnknownKeys(lineage, new Set(['relation', 'templateId', 'templateVersion']), 'lineage', errors);
  if (lineage.relation !== 'clone' && lineage.relation !== 'fork') addError(errors, 'lineage.relation', 'must be clone or fork');
  if (!own(lineage, 'templateId')) addError(errors, 'lineage.templateId', 'is required');
  else validateId(lineage.templateId, 'lineage.templateId', errors);
  if (own(lineage, 'templateVersion')) validateInteger(lineage.templateVersion, 'lineage.templateVersion', errors, 1, Number.MAX_SAFE_INTEGER);
}

function validatePresentation(presentation, errors) {
  if (!isRecord(presentation)) {
    addError(errors, 'presentation', 'must be an object');
    return;
  }
  rejectUnknownKeys(presentation, new Set(['submitLabel', 'component', 'theme', 'themeMode']), 'presentation', errors);
  if (own(presentation, 'submitLabel')) validateText(presentation.submitLabel, 'presentation.submitLabel', errors, {minimum: 1, maximum: 80});
  if (own(presentation, 'component')) validateId(presentation.component, 'presentation.component', errors);
  // A theme is named, never defined here: the template selects an operator-installed
  // theme slug, and the deployment decides what that slug means. Same indirection as
  // destinationId. Unknown slugs are cosmetic rather than dangerous, so the renderer
  // falls back to the viewer default instead of refusing to serve the form.
  if (own(presentation, 'theme')) validateId(presentation.theme, 'presentation.theme', errors);
  if (own(presentation, 'themeMode') && presentation.themeMode !== 'dark' && presentation.themeMode !== 'light') {
    addError(errors, 'presentation.themeMode', 'must equal dark or light');
  }
}

function validateTemplate(doc) {
  const errors = [];
  if (!isRecord(doc)) return {valid: false, errors: [{path: '', message: 'template must be an object'}]};
  rejectUnknownKeys(doc, TEMPLATE_KEYS, '', errors);
  const isContainer = doc.kind === 'container';
  const required = ['contractVersion', 'resourceKind', 'templateId', 'ownerId', 'revision', 'grammarVersion', 'title'];
  // #245: a child form may inherit every field from its parent — own fields optional.
  if (!isContainer && !own(doc, 'parentId')) required.push('fields');
  for (const key of required) if (!own(doc, key)) addError(errors, key, 'is required');
  // #234: containers are templates of kind 'container' — same lifecycle, no fields,
  // no destination, no nesting. Their page renders member navigation instead.
  if (own(doc, 'kind') && doc.kind !== 'form' && doc.kind !== 'container') {
    addError(errors, 'kind', "must be 'form' or 'container'");
  }
  if (isContainer) {
    if (own(doc, 'fields') && (!Array.isArray(doc.fields) || doc.fields.length > 0)) {
      addError(errors, 'fields', 'must be absent or empty for a container');
    }
    if (own(doc, 'destinationId')) addError(errors, 'destinationId', 'must be absent for a container');
    if (own(doc, 'containerId')) addError(errors, 'containerId', 'containers cannot be nested');
    if (own(doc, 'parentId')) addError(errors, 'parentId', 'is only valid on a form');
    if (own(doc, 'memberOrder')) {
      if (!Array.isArray(doc.memberOrder) || doc.memberOrder.length > 200) {
        addError(errors, 'memberOrder', 'must be an array of at most 200 definition IDs');
      } else {
        const seen = new Set();
        doc.memberOrder.forEach((memberId, index) => {
          validateId(memberId, `memberOrder[${index}]`, errors);
          if (seen.has(memberId)) addError(errors, `memberOrder[${index}]`, 'must not repeat a member');
          seen.add(memberId);
        });
      }
    }
  } else {
    if (own(doc, 'memberOrder')) addError(errors, 'memberOrder', 'is only valid on a container');
    if (own(doc, 'containerId')) validateId(doc.containerId, 'containerId', errors);
    if (own(doc, 'parentId')) {
      validateId(doc.parentId, 'parentId', errors);
      if (doc.parentId === doc.templateId) addError(errors, 'parentId', 'must not reference the template itself');
    }
  }
  if (own(doc, 'contractVersion') && doc.contractVersion !== 1) addError(errors, 'contractVersion', 'must equal 1');
  if (own(doc, 'resourceKind') && doc.resourceKind !== 'form-template') addError(errors, 'resourceKind', 'must equal form-template');
  if (own(doc, 'templateId')) validateId(doc.templateId, 'templateId', errors);
  if (own(doc, 'ownerId')) validateId(doc.ownerId, 'ownerId', errors);
  if (own(doc, 'revision')) validateInteger(doc.revision, 'revision', errors, 1, Number.MAX_SAFE_INTEGER);
  if (own(doc, 'grammarVersion') && doc.grammarVersion !== 1) addError(errors, 'grammarVersion', 'must equal 1');
  if (own(doc, 'archived') && doc.archived !== true) addError(errors, 'archived', 'must equal true when present');
  if (own(doc, 'destinationId')) validateId(doc.destinationId, 'destinationId', errors);
  if (own(doc, 'title')) validateText(doc.title, 'title', errors, {minimum: 1, maximum: 200});
  if (own(doc, 'description')) validateText(doc.description, 'description', errors, {maximum: 2000});
  if (own(doc, 'tags')) {
    if (!Array.isArray(doc.tags) || doc.tags.length > 32) addError(errors, 'tags', 'must be an array of at most 32 definition IDs');
    else {
      doc.tags.forEach((tag, index) => validateId(tag, `tags[${index}]`, errors));
      for (let index = 1; index < doc.tags.length; index += 1) {
        if (doc.tags[index - 1] >= doc.tags[index]) addError(errors, `tags[${index}]`, 'must be unique and lexicographically sorted');
      }
    }
  }
  if (own(doc, 'lineage')) validateLineage(doc.lineage, errors);
  if (own(doc, 'presentation')) validatePresentation(doc.presentation, errors);
  if (isContainer) {
    // container field rules handled above
  } else if (own(doc, 'parentId') && Array.isArray(doc.fields) && doc.fields.length === 0) {
    // #245: a child may carry zero own fields — everything inherits from the parent.
  } else if (!Array.isArray(doc.fields) || doc.fields.length < 1 || doc.fields.length > 200) {
    if (own(doc, 'fields')) addError(errors, 'fields', 'must be an array containing 1 through 200 fields');
  } else {
    const ids = new Set();
    doc.fields.forEach((field, index) => {
      validateField(field, index, errors);
      if (isRecord(field) && typeof field.id === 'string') {
        if (ids.has(field.id)) addError(errors, `fields[${index}].id`, 'must be unique within the template');
        ids.add(field.id);
      }
    });
  }
  return {valid: errors.length === 0, errors};
}

function validateTemplateVersion(doc) {
  const errors = [];
  if (!isRecord(doc)) return {valid: false, errors: [{path: '', message: 'template version must be an object'}]};
  rejectUnknownKeys(doc, TEMPLATE_VERSION_KEYS, '', errors);
  const required = [
    'contractVersion', 'resourceKind', 'templateId', 'ownerId', 'templateVersion',
    'sourceRevision', 'grammarVersion', 'publishedAt', 'publishedBy', 'title',
    'schemaDigest',
  ];
  // #257: containers version without fields (they have none to freeze).
  if (doc.kind !== 'container') required.push('fields');
  for (const key of required) if (!own(doc, key)) addError(errors, key, 'is required');

  const draftProjection = {
    ...doc,
    resourceKind: 'form-template',
    revision: doc.sourceRevision,
  };
  for (const key of [
    'templateVersion', 'sourceRevision', 'publishedAt', 'publishedBy', 'schemaDigest',
  ]) delete draftProjection[key];
  for (const error of validateTemplate(draftProjection).errors) addError(errors, error.path, error.message);

  if (own(doc, 'resourceKind') && doc.resourceKind !== 'form-template-version') {
    addError(errors, 'resourceKind', 'must equal form-template-version');
  }
  if (own(doc, 'templateVersion')) {
    validateInteger(doc.templateVersion, 'templateVersion', errors, 1, Number.MAX_SAFE_INTEGER);
  }
  if (own(doc, 'sourceRevision')) {
    validateInteger(doc.sourceRevision, 'sourceRevision', errors, 1, Number.MAX_SAFE_INTEGER);
  }
  if (own(doc, 'publishedAt') && (typeof doc.publishedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(doc.publishedAt)
      || !Number.isFinite(Date.parse(doc.publishedAt)))) {
    addError(errors, 'publishedAt', 'must be a UTC RFC 3339 timestamp with millisecond precision');
  }
  if (own(doc, 'publishedBy') && doc.publishedBy !== null) {
    if (!isRecord(doc.publishedBy)) {
      addError(errors, 'publishedBy', 'must be a principal reference or null');
    } else {
      rejectUnknownKeys(doc.publishedBy, new Set(['id', 'type']), 'publishedBy', errors);
      if (!own(doc.publishedBy, 'id')) addError(errors, 'publishedBy.id', 'is required');
      else validateId(doc.publishedBy.id, 'publishedBy.id', errors);
      if (!own(doc.publishedBy, 'type')) addError(errors, 'publishedBy.type', 'is required');
      else validateId(doc.publishedBy.type, 'publishedBy.type', errors);
    }
  }
  if (own(doc, 'schemaDigest') && (typeof doc.schemaDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(doc.schemaDigest))) {
    addError(errors, 'schemaDigest', 'must be a sha256 digest');
  }
  return {valid: errors.length === 0, errors};
}

function validateSubmissionValues(template, values) {
  const errors = [];
  const normalized = {};
  const templateResult = validateTemplate(template);
  if (!templateResult.valid) {
    return {
      valid: false,
      errors: templateResult.errors.map((error) => ({path: `template${error.path ? `.${error.path}` : ''}`, message: error.message})),
      normalized,
    };
  }
  if (!isRecord(values)) return {valid: false, errors: [{path: 'values', message: 'must be an object'}], normalized};
  const activeFields = template.fields.filter((field) => field.isDestroyed !== true);
  const fields = new Map(activeFields.map((field) => [field.id, field]));
  for (const key of Object.keys(values)) {
    if (!fields.has(key)) addError(errors, `values.${key}`, 'does not identify a template field');
  }
  for (const field of activeFields) {
    const path = `values.${field.id}`;
    if (!own(values, field.id)) {
      if (field.required) addError(errors, path, 'is required');
      continue;
    }
    normalized[field.id] = valueForField(field, values[field.id], path, errors);
  }
  return {valid: errors.length === 0, errors, normalized};
}

module.exports = {
  validateTemplate,
  validateTemplateVersion,
  validateSubmissionValues,
};
