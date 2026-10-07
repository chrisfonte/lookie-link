'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateConstraints } = require('../lib/markers/constraints');

const RATE = 1000;
const FRAMES = 10000;

function template(markers, extra = {}) {
  return { unit: 'samples', groups: [{ id: 'g', label: 'G' }], markers, ...extra };
}

function run(markers, tpl, extra = {}) {
  return evaluateConstraints({ template: tpl, markers, frames: FRAMES, sampleRate: RATE, ...extra });
}

const point = (id, sample, type = id) => ({ id, type, kind: 'point', sample, label: null, note: null });
const region = (id, startSample, endSample, type = id) => ({ id, type, kind: 'region', startSample, endSample, label: null, note: null });

test('a valid set passes and returns no errors', () => {
  const tpl = template([{ id: 'alpha', kind: 'point' }, { id: 'span', kind: 'region', multiple: true }]);
  assert.deepEqual(run([point('alpha', 5), region('r1', 1, 9, 'span')], tpl), { ok: true, errors: [], warnings: [] });
});

test('positions must be integers within [0, frames]', () => {
  const tpl = template([{ id: 'alpha', kind: 'point', multiple: true }]);
  assert.equal(run([point('a1', 0, 'alpha'), point('a2', FRAMES, 'alpha')], tpl).ok, true);
  for (const bad of [-1, FRAMES + 1, 1.5, '3', null]) {
    const result = run([point('a1', bad, 'alpha')], tpl);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.errors[0].path, 'markers[0].sample');
    assert.equal(result.errors[0].markerId, 'a1');
  }
  const regionTpl = template([{ id: 'span', kind: 'region' }]);
  assert.equal(run([region('r', 0, FRAMES + 1, 'span')], regionTpl).errors[0].path, 'markers[0].endSample');
});

test('regions need start < end; zero length only with allowZeroLength', () => {
  const plain = template([{ id: 'span', kind: 'region', multiple: true }]);
  assert.equal(run([region('r', 10, 20, 'span')], plain).ok, true);
  assert.equal(run([region('r', 20, 10, 'span')], plain).ok, false);
  assert.equal(run([region('r', 10, 10, 'span')], plain).ok, false);
  const zero = template([{ id: 'span', kind: 'region', allowZeroLength: true }]);
  assert.equal(run([region('r', 10, 10, 'span')], zero).ok, true);
  assert.equal(run([region('r', 11, 10, 'span')], zero).ok, false);
});

test('type must be declared and kind must match', () => {
  const tpl = template([{ id: 'alpha', kind: 'point' }]);
  assert.match(run([point('x', 1, 'ghost')], tpl).errors[0].message, /unknown marker type/);
  assert.match(run([region('x', 1, 2, 'alpha')], tpl).errors[0].message, /point marker/);
});

test('required types must be present', () => {
  const tpl = template([{ id: 'alpha', kind: 'point', required: true }, { id: 'beta', kind: 'point' }]);
  assert.equal(run([point('b', 1, 'beta')], tpl).errors[0].markerId, 'alpha');
  assert.equal(run([point('a', 1, 'alpha')], tpl).ok, true);
});

test('multiple false allows one; maxCount caps multiple types', () => {
  const single = template([{ id: 'alpha', kind: 'point' }]);
  const two = [point('a1', 1, 'alpha'), point('a2', 2, 'alpha')];
  const failed = run(two, single);
  assert.equal(failed.ok, false);
  assert.equal(failed.errors[0].markerId, 'a2');
  const capped = template([{ id: 'alpha', kind: 'point', multiple: true, constraints: { maxCount: 2 } }]);
  assert.equal(run(two, capped).ok, true);
  assert.equal(run([...two, point('a3', 3, 'alpha')], capped).errors[0].markerId, 'a3');
});

test('min and max convert the template unit to samples', () => {
  const ms = template([{ id: 'alpha', kind: 'point', constraints: { min: 1000, max: 2000 } }], { unit: 'ms' });
  assert.equal(run([point('a', 1000, 'alpha')], ms, { sampleRate: 1000 }).ok, true);
  assert.equal(run([point('a', 999, 'alpha')], ms, { sampleRate: 1000 }).ok, false);
  assert.equal(run([point('a', 2000, 'alpha')], ms, { sampleRate: 1000 }).ok, true);
  assert.equal(run([point('a', 2001, 'alpha')], ms, { sampleRate: 1000 }).ok, false);
  const seconds = template([{ id: 'alpha', kind: 'point', constraints: { max: 2 } }], { unit: 'seconds' });
  assert.equal(run([point('a', 2000, 'alpha')], seconds, { sampleRate: 1000 }).ok, true);
  assert.equal(run([point('a', 2001, 'alpha')], seconds, { sampleRate: 1000 }).ok, false);
  const samples = template([{ id: 'span', kind: 'region', constraints: { min: 100, max: 200 } }]);
  assert.equal(run([region('r', 100, 200, 'span')], samples).ok, true);
  assert.equal(run([region('r', 99, 200, 'span')], samples).ok, false);
  assert.equal(run([region('r', 100, 201, 'span')], samples).ok, false);
  assert.throws(() => run([point('a', 1, 'alpha')], ms, { sampleRate: undefined }), TypeError);
});

test('after and before are non-strict: equal positions are accepted', () => {
  const tpl = template([
    { id: 'first', kind: 'point' },
    { id: 'second', kind: 'point', constraints: { after: 'first' } },
    { id: 'zeroth', kind: 'point', constraints: { before: 'first' } },
  ]);
  assert.equal(run([point('first', 100), point('second', 100), point('zeroth', 100)], tpl).ok, true);
  assert.equal(run([point('first', 100), point('second', 101), point('zeroth', 99)], tpl).ok, true);
  const late = run([point('first', 100), point('second', 99)], tpl);
  assert.equal(late.ok, false);
  assert.equal(late.errors[0].markerId, 'second');
  const early = run([point('first', 100), point('zeroth', 101)], tpl);
  assert.equal(early.ok, false);
  assert.equal(early.errors[0].markerId, 'zeroth');
  // A reference that is not placed is skipped.
  assert.equal(run([point('second', 5)], tpl).ok, true);
});

test('after and before compare points with region edges and regions with regions', () => {
  const tpl = template([
    { id: 'span', kind: 'region' },
    { id: 'tail', kind: 'point', constraints: { after: 'span' } },
    { id: 'head', kind: 'point', constraints: { before: 'span' } },
    { id: 'next', kind: 'region', constraints: { after: 'span' } },
  ]);
  const base = region('s', 100, 200, 'span');
  assert.equal(run([base, point('t', 200, 'tail'), point('h', 100, 'head'), region('n', 200, 300, 'next')], tpl).ok, true);
  assert.equal(run([base, point('t', 199, 'tail')], tpl).ok, false);
  assert.equal(run([base, point('h', 101, 'head')], tpl).ok, false);
  assert.equal(run([base, region('n', 199, 300, 'next')], tpl).ok, false);
});

test('within is inclusive at both ends', () => {
  const tpl = template([
    { id: 'outer', kind: 'region' },
    { id: 'dot', kind: 'point', constraints: { within: 'outer' } },
    { id: 'inner', kind: 'region', constraints: { within: 'outer' } },
  ]);
  const outer = region('o', 100, 200, 'outer');
  assert.equal(run([outer, point('d', 100, 'dot'), region('i', 100, 200, 'inner')], tpl).ok, true);
  assert.equal(run([outer, point('d', 200, 'dot')], tpl).ok, true);
  assert.equal(run([outer, point('d', 201, 'dot')], tpl).ok, false);
  assert.equal(run([outer, region('i', 99, 150, 'inner')], tpl).ok, false);
  assert.equal(run([point('d', 5, 'dot')], tpl).ok, true);
});

test('noOverlap per group allows touching and refuses overlap', () => {
  const tpl = template([
    { id: 'verse', kind: 'region', multiple: true, group: 'g', constraints: { noOverlap: 'g' } },
    { id: 'chorus', kind: 'region', multiple: true, group: 'g', constraints: { noOverlap: 'g' } },
    { id: 'aside', kind: 'region', multiple: true },
  ]);
  assert.equal(run([region('a', 0, 100, 'verse'), region('b', 100, 200, 'chorus')], tpl).ok, true);
  const bad = run([region('a', 0, 101, 'verse'), region('b', 100, 200, 'chorus')], tpl);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].markerId, 'b');
  // Regions outside the group are free to overlap it.
  assert.equal(run([region('a', 0, 100, 'verse'), region('c', 50, 150, 'aside')], tpl).ok, true);
});

test('tags are checked against pickers when supplied', () => {
  const tpl = template([{ id: 'alpha', kind: 'point' }], {
    pickers: [
      { id: 'scene', label: 'Scene', options: [{ id: 'one', label: 'One' }], required: true },
      { id: 'free', label: 'Free', options: [] },
    ],
  });
  assert.equal(run([], tpl, { tags: { scene: 'one', free: 'anything' } }).ok, true);
  assert.equal(run([], tpl).ok, true);
  assert.equal(run([], tpl, { tags: {} }).errors[0].path, 'tags.scene');
  assert.equal(run([], tpl, { tags: { scene: 'two' } }).ok, false);
  assert.equal(run([], tpl, { tags: { scene: 'one', other: 'x' } }).ok, false);
});

test('overrides turn after/before/within violations of that marker into warnings only', () => {
  const tpl = template([
    { id: 'first', kind: 'point' },
    { id: 'second', kind: 'point', constraints: { after: 'first', max: 150 } },
    { id: 'outer', kind: 'region' },
    { id: 'dot', kind: 'point', constraints: { within: 'outer' } },
  ]);
  const markers = [point('first', 100), point('second', 50), region('o', 10, 20, 'outer'), point('d', 500, 'dot')];
  assert.equal(run(markers, tpl).errors.length, 2);
  const result = run(markers, tpl, { overrides: [{ markerId: 'second', reason: 'r' }] });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].markerId, 'd');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].rule, 'after');
  const both = run(markers, tpl, { overrides: new Set(['second', 'd']) });
  assert.equal(both.ok, true);
  assert.equal(both.warnings.length, 2);
  // Other rules are never excused.
  const range = run([point('first', 100), point('second', FRAMES + 5)], tpl, { overrides: new Map([['second', 'r']]) });
  assert.equal(range.ok, false);
  assert.deepEqual(range.warnings, []);
});
