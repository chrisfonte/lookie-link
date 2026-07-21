'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const {canonicalize, schemaDigest} = require('../lib/forms/canonical');

test('canonical JSON has code-point key order, exact escaping, NFC, LF, and one final newline', () => {
  const value = {
    '\ue000': 'private',
    '\ud83d\ude00': 'astral',
    z: 'Cafe\u0301\r\n\b\t\f\u0001/\\"',
    a: true,
  };
  assert.equal(
    canonicalize(value),
    '{"a":true,"z":"Caf\u00e9\\r\\n\\b\\t\\f\\u0001/\\\\\\"","\ue000":"private","\ud83d\ude00":"astral"}\n',
  );
});

test('canonical numbers use binary64 shortest-round-trip spellings', () => {
  assert.equal(
    canonicalize([1, 1e-7, 1e-6, 1e20, 1e21, 333333333.33333329]),
    '[1,1e-7,0.000001,100000000000000000000,1e+21,333333333.3333333]\n',
  );
});

test('canonicalization rejects non-finite numbers, negative zero, invalid Unicode, and non-JSON structures', () => {
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    assert.throws(() => canonicalize(value), TypeError);
  }
  assert.throws(() => canonicalize('\ud800'), /surrogate/);
  assert.throws(() => canonicalize({a: undefined}), /unsupported/);
  assert.throws(() => canonicalize(new Date()), /plain objects/);
  const sparse = [];
  sparse[1] = true;
  assert.throws(() => canonicalize(sparse), /sparse/);
});

test('object keys that collide after Unicode normalization are rejected', () => {
  assert.throws(() => canonicalize({'\u00e9': 1, 'e\u0301': 2}), /unique after normalization/);
});

test('equivalent YAML and JSON templates have the same schema digest', () => {
  const yamlTemplate = yaml.load(`
contractVersion: 1
resourceKind: form-template
templateId: example
ownerId: operator
revision: 1
grammarVersion: 1
title: Example
fields:
  - id: count
    type: number
    label: Count
    required: true
    constraints:
      integer: true
      minimum: 1.0
      maximum: 1e2
  - id: mood
    type: select
    label: Mood
    required: false
    options:
      - id: calm
        label: Calm
      - id: energized
        label: Energized
`, {schema: yaml.JSON_SCHEMA});
  const jsonTemplate = JSON.parse(`{
    "fields": [
      {"constraints":{"maximum":100,"minimum":1,"integer":true},"required":true,"label":"Count","type":"number","id":"count"},
      {"options":[{"label":"Calm","id":"calm"},{"label":"Energized","id":"energized"}],"required":false,"label":"Mood","type":"select","id":"mood"}
    ],
    "title":"Different human title does not affect the schema",
    "grammarVersion":1,
    "revision":9,
    "ownerId":"operator",
    "templateId":"example",
    "resourceKind":"form-template",
    "contractVersion":1
  }`);
  const yamlDigest = schemaDigest(yamlTemplate);
  assert.match(yamlDigest, /^[0-9a-f]{64}$/);
  assert.equal(yamlDigest, schemaDigest(jsonTemplate));

  const changed = structuredClone(jsonTemplate);
  changed.fields[0].constraints.maximum = 101;
  assert.notEqual(schemaDigest(changed), yamlDigest);
});

test('schema digest includes the canonical terminal newline and only grammarVersion plus fields', () => {
  const template = {grammarVersion: 1, fields: []};
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha256')
    .update('{"fields":[],"grammarVersion":1}\n', 'utf8')
    .digest('hex');
  assert.equal(schemaDigest(template), expected);
  assert.equal(schemaDigest({...template, title: 'Ignored'}), expected);
});

test('field list and destruction flags participate in the schema digest', () => {
  const template = {
    grammarVersion: 1,
    fields: [{id: 'value', type: 'short-text', label: 'Value', required: false}],
  };
  const baseline = schemaDigest(template);
  for (const flag of ['showInList', 'isDestroyed']) {
    const changed = structuredClone(template);
    changed.fields[0][flag] = true;
    assert.notEqual(schemaDigest(changed), baseline, flag);
  }
});
