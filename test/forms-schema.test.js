'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {validateTemplate, validateSubmissionValues} = require('../lib/forms/schema');

function templateWith(fields) {
  return {
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'activity-log',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    title: 'Activity log',
    fields,
  };
}

function field(id, type, extra = {}) {
  return {id, type, label: id, required: true, ...extra};
}

function paths(result) {
  return result.errors.map((error) => error.path);
}

const everyTypeTemplate = templateWith([
  field('summary', 'short-text', {constraints: {minLength: 2, maxLength: 40}, default: 'Warm up'}),
  field('notes', 'long-text', {required: false, constraints: {minLength: 0, maxLength: 1000}}),
  field('repetitions', 'number', {constraints: {minimum: 1, maximum: 100, integer: true}, default: 8}),
  field('completed', 'checkbox', {default: false}),
  field('activity-date', 'date', {constraints: {minimum: '2020-01-01', maximum: '2030-12-31'}}),
  field('activity-time', 'time'),
  field('recorded-at', 'datetime', {constraints: {minimum: '2020-01-01T00:00:00Z', maximum: '2030-12-31T23:59:59+00:00'}}),
  field('effort', 'select', {options: [{id: 'easy', label: 'Easy'}, {id: 'hard', label: 'Hard'}]}),
  field('muscles', 'multi-select', {
    constraints: {minSelections: 1, maxSelections: 2},
    options: [{id: 'legs', label: 'Legs'}, {id: 'core', label: 'Core'}, {id: 'arms', label: 'Arms'}],
  }),
]);

test('a template and submission covering every field type validate', () => {
  assert.deepEqual(validateTemplate(everyTypeTemplate), {valid: true, errors: []});
  const result = validateSubmissionValues(everyTypeTemplate, {
    summary: 'Cafe\u0301\r\nwork',
    notes: 'steady',
    repetitions: 12,
    completed: false,
    'activity-date': '2026-07-20',
    'activity-time': '08:15:30',
    'recorded-at': '2026-07-20T08:15:30-04:00',
    effort: 'hard',
    muscles: ['legs', 'core'],
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.summary, 'Caf\u00e9\nwork');
  assert.deepEqual(result.normalized.muscles, ['legs', 'core']);
});

test('unknown template and field keys report their exact paths', () => {
  const unknownRoot = {...everyTypeTemplate, surprise: true};
  assert.ok(paths(validateTemplate(unknownRoot)).includes('surprise'));

  const fields = structuredClone(everyTypeTemplate.fields);
  fields[2].surprise = true;
  assert.ok(paths(validateTemplate(templateWith(fields))).includes('fields[2].surprise'));
});

test('unknown field types and duplicate field and option IDs are rejected', () => {
  const fields = [
    field('same', 'mystery'),
    field('same', 'select', {options: [{id: 'one', label: 'One'}, {id: 'one', label: 'Again'}]}),
  ];
  const result = validateTemplate(templateWith(fields));
  assert.ok(paths(result).includes('fields[0].type'));
  assert.ok(paths(result).includes('fields[1].id'));
  assert.ok(paths(result).includes('fields[1].options[1].id'));
});

test('field and constraint allowlists are type-specific', () => {
  const fields = [field('enabled', 'checkbox', {constraints: {minimum: 1}})];
  const result = validateTemplate(templateWith(fields));
  assert.ok(paths(result).includes('fields[0].constraints.minimum'));
});

test('invalid constraint declarations report the individual constraint paths', () => {
  const cases = [
    [field('text', 'short-text', {constraints: {minLength: -1}}), 'fields[0].constraints.minLength'],
    [field('text', 'long-text', {constraints: {maxLength: 10001}}), 'fields[0].constraints.maxLength'],
    [field('text', 'short-text', {constraints: {minLength: 3, maxLength: 2}}), 'fields[0].constraints.minLength'],
    [field('count', 'number', {constraints: {minimum: NaN}}), 'fields[0].constraints.minimum'],
    [field('count', 'number', {constraints: {maximum: Infinity}}), 'fields[0].constraints.maximum'],
    [field('count', 'number', {constraints: {step: 0}}), 'fields[0].constraints.step'],
    [field('count', 'number', {constraints: {step: -1}}), 'fields[0].constraints.step'],
    [field('count', 'number', {constraints: {step: Infinity}}), 'fields[0].constraints.step'],
    [field('count', 'number', {constraints: {minimum: 0, maximum: 10, step: 3}}), 'fields[0].constraints.step'],
    [field('count', 'number', {constraints: {integer: 'yes'}}), 'fields[0].constraints.integer'],
    [field('day', 'date', {constraints: {minimum: '2026-02-30'}}), 'fields[0].constraints.minimum'],
    [field('day', 'date', {constraints: {minimum: '2027-01-01', maximum: '2026-01-01'}}), 'fields[0].constraints.minimum'],
    [field('instant', 'datetime', {constraints: {minimum: '2026-01-01T00:00:00'}}), 'fields[0].constraints.minimum'],
    [field('items', 'multi-select', {constraints: {minSelections: -1}, options: [{id: 'one', label: 'One'}]}), 'fields[0].constraints.minSelections'],
    [field('items', 'multi-select', {constraints: {maxSelections: 1001}, options: [{id: 'one', label: 'One'}]}), 'fields[0].constraints.maxSelections'],
    [field('items', 'multi-select', {constraints: {minSelections: 2, maxSelections: 1}, options: [{id: 'one', label: 'One'}]}), 'fields[0].constraints.minSelections'],
  ];
  for (const [candidate, expectedPath] of cases) {
    assert.ok(paths(validateTemplate(templateWith([candidate]))).includes(expectedPath), expectedPath);
  }
});

test('defaults use submission validation and dynamic selection defaults are prohibited', () => {
  const invalidNumber = validateTemplate(templateWith([
    field('count', 'number', {constraints: {integer: true}, default: 1.5}),
  ]));
  assert.ok(paths(invalidNumber).includes('fields[0].default'));

  const dynamic = validateTemplate(templateWith([
    field('choice', 'select', {providerSlot: 'catalog', default: 'one'}),
  ]));
  assert.ok(paths(dynamic).includes('fields[0].default'));
});

test('number steps accept decimal ranges and reject submitted values off the step', () => {
  const stepped = templateWith([
    field('load', 'number', {
      component: 'stepped-select',
      constraints: { minimum: 0.5, maximum: 2, step: 0.5 },
    }),
  ]);
  assert.deepEqual(validateTemplate(stepped), {valid: true, errors: []});
  assert.equal(validateSubmissionValues(stepped, {load: 1.5}).valid, true);
  assert.ok(paths(validateSubmissionValues(stepped, {load: 1.6})).includes('values.load'));
});

test('submission values reject every type constraint with exact value paths', () => {
  const valid = {
    summary: 'okay',
    repetitions: 2,
    completed: true,
    'activity-date': '2026-01-01',
    'activity-time': '10:30',
    'recorded-at': '2026-01-01T10:30:00Z',
    effort: 'easy',
    muscles: ['legs'],
  };
  const cases = [
    [{...valid, summary: 'x'}, 'values.summary'],
    [{...valid, summary: 'x'.repeat(41)}, 'values.summary'],
    [{...valid, repetitions: 0}, 'values.repetitions'],
    [{...valid, repetitions: 101}, 'values.repetitions'],
    [{...valid, repetitions: 1.5}, 'values.repetitions'],
    [{...valid, completed: 1}, 'values.completed'],
    [{...valid, 'activity-date': '2026-02-30'}, 'values.activity-date'],
    [{...valid, 'activity-time': '24:00'}, 'values.activity-time'],
    [{...valid, 'recorded-at': '2026-01-01T10:30:00'}, 'values.recorded-at'],
    [{...valid, effort: 'unknown'}, 'values.effort'],
    [{...valid, muscles: []}, 'values.muscles'],
    [{...valid, muscles: ['legs', 'core', 'arms']}, 'values.muscles'],
  ];
  for (const [values, expectedPath] of cases) {
    assert.ok(paths(validateSubmissionValues(everyTypeTemplate, values)).includes(expectedPath), expectedPath);
  }
});

test('negative number and multi-select canaries are rejected', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const result = validateSubmissionValues(everyTypeTemplate, {
      summary: 'okay', repetitions: invalid, completed: true,
      'activity-date': '2026-01-01', 'activity-time': '10:30',
      'recorded-at': '2026-01-01T10:30:00Z', effort: 'easy', muscles: ['legs'],
    });
    assert.ok(paths(result).includes('values.repetitions'));
  }
  const duplicate = validateSubmissionValues(everyTypeTemplate, {
    summary: 'okay', repetitions: 2, completed: true,
    'activity-date': '2026-01-01', 'activity-time': '10:30',
    'recorded-at': '2026-01-01T10:30:00Z', effort: 'easy', muscles: ['legs', 'legs'],
  });
  assert.ok(paths(duplicate).includes('values.muscles[1]'));
});

test('missing required and unknown submitted values are rejected without applying defaults', () => {
  const result = validateSubmissionValues(everyTypeTemplate, {unknown: true});
  assert.ok(paths(result).includes('values.unknown'));
  assert.ok(paths(result).includes('values.summary'));
  assert.equal(Object.hasOwn(result.normalized, 'summary'), false);
});

test('selection fields require exactly one option source and non-selection fields prohibit one', () => {
  const missing = validateTemplate(templateWith([field('choice', 'select')]));
  assert.ok(paths(missing).includes('fields[0].options'));
  const extra = validateTemplate(templateWith([field('text', 'short-text', {options: [{id: 'one', label: 'One'}]})]));
  assert.ok(paths(extra).includes('fields[0].options'));
});
