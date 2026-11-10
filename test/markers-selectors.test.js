'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSelector, select, selectFirst, toSamples } = require('../lib/markers/selectors');

const doc = {
  name: 'doc',
  count: 3,
  nested: { deep: { value: 7 } },
  items: [
    { id: 'one', n: 1, pos: 10 },
    { id: 'two', n: 2, pos: 20 },
    { id: 'three', n: 2, pos: 30 },
  ],
  groups: [
    { tag: 'g1', spans: [{ from: 1 }, { from: 2 }] },
    { tag: 'g2', spans: [{ from: 3 }] },
    { tag: 'g3' },
  ],
  'a/b': { 'c~d': 'escaped' },
  list: ['x', 'y', 'z'],
  empty: [],
};

test('pointer basics: keys, nesting, array index', () => {
  assert.deepEqual(select(doc, '/name'), [{ value: 'doc', path: '/name' }]);
  assert.deepEqual(select(doc, '/nested/deep/value'), [{ value: 7, path: '/nested/deep/value' }]);
  assert.deepEqual(select(doc, '/list/1'), [{ value: 'y', path: '/list/1' }]);
  assert.deepEqual(select(doc, '/'), [{ value: doc, path: '' }]);
  assert.equal(selectFirst(doc, '/count'), 3);
});

test('[*] expands every item and reports concrete paths', () => {
  const hits = select(doc, '/items[*]/pos');
  assert.deepEqual(hits.map((hit) => hit.value), [10, 20, 30]);
  assert.deepEqual(hits.map((hit) => hit.path), ['/items/0/pos', '/items/1/pos', '/items/2/pos']);
  assert.deepEqual(select(doc, '/list[*]').map((hit) => hit.value), ['x', 'y', 'z']);
});

test('[*] works at several levels (nested arrays) and skips items without the child', () => {
  const hits = select(doc, '/groups[*]/spans[*]/from');
  assert.deepEqual(hits.map((hit) => hit.value), [1, 2, 3]);
  assert.deepEqual(hits.map((hit) => hit.path), ['/groups/0/spans/0/from', '/groups/0/spans/1/from', '/groups/1/spans/0/from']);
});

test('[key=value] filters by string equality, including numbers compared as strings', () => {
  assert.deepEqual(select(doc, '/items[id=two]/pos').map((hit) => hit.value), [20]);
  assert.deepEqual(select(doc, '/items[n=2]/id').map((hit) => hit.value), ['two', 'three']);
  assert.deepEqual(select(doc, '/items[id=nope]/pos'), []);
  assert.deepEqual(select(doc, '/items[id=one][n=1]/pos').map((hit) => hit.value), [10]);
  assert.deepEqual(select(doc, '/items[id=one][n=2]/pos'), []);
});

test('filter can be followed by [*] and by further filters', () => {
  assert.deepEqual(select(doc, '/groups[tag=g1]/spans[*]/from').map((hit) => hit.value), [1, 2]);
  assert.deepEqual(select(doc, '/groups[tag=g1]/spans[from=2]/from').map((hit) => hit.value), [2]);
});

test('~0 and ~1 unescape in keys and filter parts', () => {
  assert.equal(selectFirst(doc, '/a~1b/c~0d'), 'escaped');
  const tricky = { rows: [{ 'k/1': 'v~1', val: 'hit' }] };
  assert.deepEqual(select(tricky, '/rows[k~11=v~01]/val').map((hit) => hit.value), ['hit']);
  assert.deepEqual(select({ 'a/b': [1] }, '/a~1b[*]')[0].path, '/a~1b/0');
});

test('missing data and malformed selectors return [] and never throw', () => {
  assert.deepEqual(select(doc, '/nope'), []);
  assert.deepEqual(select(doc, '/nested/missing/value'), []);
  assert.deepEqual(select(doc, '/name[*]'), []);
  assert.deepEqual(select(doc, '/empty[*]/x'), []);
  assert.deepEqual(select(doc, '/list/9'), []);
  assert.deepEqual(select(doc, '/list/-1'), []);
  assert.deepEqual(select(doc, '/items[id=]'), []);
  assert.deepEqual(select(doc, '/items[broken'), []);
  assert.deepEqual(select(doc, 'items'), []);
  assert.deepEqual(select(doc, null), []);
  assert.deepEqual(select(null, '/a'), []);
  assert.deepEqual(select(undefined, '/a'), []);
  assert.deepEqual(select(5, '/a'), []);
  assert.equal(selectFirst(doc, '/nope'), undefined);
  assert.equal(parseSelector('/a[*'), null);
});

test('inherited properties are not selectable', () => {
  assert.deepEqual(select({}, '/constructor'), []);
  assert.deepEqual(select({}, '/__proto__'), []);
  assert.deepEqual(select([], '/length'), []);
});

test('toSamples converts samples, ms and seconds with rounding', () => {
  assert.equal(toSamples(4.9, 'seconds', 48000), 235200);
  assert.equal(toSamples(3.706, 'seconds', 48000), 177888);
  assert.equal(toSamples(3.706, 'seconds', 44100), Math.round(3.706 * 44100));
  assert.equal(toSamples(1000, 'ms', 48000), 48000);
  assert.equal(toSamples(1, 'ms', 44100), 44);
  assert.equal(toSamples(1234.4, 'samples'), 1234);
  assert.equal(toSamples('2', 'seconds', 100), 200);
});

test('toSamples refuses what it cannot convert', () => {
  assert.equal(toSamples('abc', 'samples'), null);
  assert.equal(toSamples('', 'samples'), null);
  assert.equal(toSamples(NaN, 'samples'), null);
  assert.equal(toSamples(Infinity, 'seconds', 48000), null);
  assert.equal(toSamples(null, 'samples'), null);
  assert.equal(toSamples({}, 'samples'), null);
  assert.equal(toSamples(1, 'seconds'), null);
  assert.equal(toSamples(1, 'seconds', 0), null);
  assert.equal(toSamples(1, 'furlongs', 48000), null);
});
