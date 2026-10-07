'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const splice = require('../lib/markers/projections/yaml-splice');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'markers', 'projection', 'record.yaml'), 'utf8');

function apply(text, ops) {
  const result = splice.applyOps(text, ops);
  return { ...result, parsed: yaml.load(result.text) };
}

test('dq escapes quotes, newlines and the YAML 1.1 line separators', () => {
  assert.equal(splice.dq('a "b"\nc'), '"a \\"b\\"\\nc"');
  assert.equal(splice.dq('x\u0085y\u2028z\u2029'), '"x\\u0085y\\u2028z\\u2029"');
  assert.equal(yaml.load(`k: ${splice.dq('x\u0085y\u2028z: #\u2029')}`).k, 'x\u0085y\u2028z: #\u2029');
});

test('renderScalar quotes anything a YAML 1.1 loader could misread', () => {
  assert.equal(splice.renderScalar('owner-1-review'), 'owner-1-review');
  for (const risky of ['yes', 'No', 'null', '123', '1e3', '0x1f', 'a: b', 'x #y', '']) {
    assert.equal(yaml.load(`k: ${splice.renderScalar(risky)}`).k, risky);
    assert.ok(splice.renderScalar(risky).startsWith('"'), risky);
  }
  assert.equal(splice.renderScalar(42), '42');
  assert.equal(splice.renderScalar(null), 'null');
  assert.throws(() => splice.renderScalar({ a: 1 }), /scalar/);
});

test('setScalar replaces a single-line value and touches one line', () => {
  const lines = FIXTURE.split('\n');
  const out = splice.setScalar(lines, '/result/start_sample', '52000');
  assert.equal(out.length, lines.length);
  assert.equal(out.filter((line, i) => line !== lines[i]).length, 1);
  assert.equal(yaml.load(out.join('\n')).result.start_sample, 52000);
  assert.ok(lines === lines && lines.join('\n') === FIXTURE, 'input lines are not mutated');
});

test('setScalar replaces a wrapped single-quoted value including its continuation lines', () => {
  const { text, parsed, edits } = apply(FIXTURE, [{ op: 'set', pointer: '/result/decision/reason', token: splice.dq('New: "reason"') }]);
  assert.equal(parsed.result.decision.reason, 'New: "reason"');
  assert.equal(edits[0].deleteCount, 2);
  const proof = splice.proveCandidate(FIXTURE, text, parsed, { edits });
  assert.deepEqual([proof.equal, proof.bounded, proof.hunks.length], [true, true, 1]);
  assert.equal(proof.hunks[0].oldLines.length, 2);
  assert.equal(proof.hunks[0].newLines.length, 1);
});

test('setScalar handles a wrapped value with a doubled quote and a null value', () => {
  const { parsed } = apply(FIXTURE, [
    { op: 'set', pointer: '/result/notes', token: '"plain"' },
    { op: 'set', pointer: '/piece/derived_from', token: '"IMG-1"' },
  ]);
  assert.equal(parsed.result.notes, 'plain');
  assert.equal(parsed.piece.derived_from, 'IMG-1');
});

test('setScalar supports array index segments in the pointer', () => {
  const { parsed } = apply(FIXTURE, [{ op: 'set', pointer: '/result/windows/0/start_sample', token: '51000' }]);
  assert.equal(parsed.result.windows[0].start_sample, 51000);
  assert.equal(parsed.result.windows[0].end_sample, 240000);
  const second = apply(FIXTURE, [{ op: 'set', pointer: '/proofs/1/kind', token: 'review' }]);
  assert.equal(second.parsed.proofs[1].kind, 'review');
  assert.equal(second.parsed.proofs[0].kind, 'discovery');
});

test('setScalar replaces a scalar list item', () => {
  const { parsed } = apply(FIXTURE, [{ op: 'set', pointer: '/result/verification/proof_ids/0', token: 'p-99' }]);
  assert.deepEqual(parsed.result.verification.proof_ids, ['p-99']);
});

test('setScalar does not eat trailing blank or comment lines after a wrapped value', () => {
  const text = 'a:\n  b: \'one\n    two\'\n\n  # keep me\n  c: 1\n';
  const { text: out } = splice.applyOps(text, [{ op: 'set', pointer: '/a/b', token: '7' }]);
  assert.equal(out, 'a:\n  b: 7\n\n  # keep me\n  c: 1\n');
});

test('appendListItem appends to an indentless top-level list in its own indentation', () => {
  const out = splice.appendListItem(FIXTURE.split('\n'), '/proofs', { id: 'p-02', kind: 'review', path: 'notes/x: y.md', sha256: 'abc' });
  const parsed = yaml.load(out.join('\n'));
  assert.equal(parsed.proofs.length, 3);
  assert.deepEqual(parsed.proofs[2], { id: 'p-02', kind: 'review', path: 'notes/x: y.md', sha256: 'abc' });
  const joined = out.join('\n');
  assert.match(joined, /\n- id: p-02\n {2}kind: review\n {2}path: "notes\/x: y.md"\n {2}sha256: abc\n/);
});

test('appendListItem appends scalars to a nested indentless list and to an indented list', () => {
  const nested = splice.appendListItem(FIXTURE.split('\n'), '/result/verification/proof_ids', 'p-02');
  assert.deepEqual(yaml.load(nested.join('\n')).result.verification.proof_ids, ['p-00', 'p-02']);
  assert.ok(nested.includes('    - p-02'));
  const indented = 'top:\n  items:\n    - a\n    - b\n  other: 1\n';
  const out = splice.appendListItem(indented.split('\n'), '/top/items', 'c');
  assert.equal(out.join('\n'), 'top:\n  items:\n    - a\n    - b\n    - c\n  other: 1\n');
});

test('appendListItem expands an empty flow list into a block at the key indentation', () => {
  const out = splice.appendListItem(FIXTURE.split('\n'), '/extras', { name: 'n1', value: 'v1' });
  assert.deepEqual(yaml.load(out.join('\n')).extras, [{ name: 'n1', value: 'v1' }]);
  assert.ok(out.includes('extras:'));
  const nested = splice.appendListItem(FIXTURE.split('\n'), '/result/decision/conditions', 'only-if');
  assert.deepEqual(yaml.load(nested.join('\n')).result.decision.conditions, ['only-if']);
  assert.ok(nested.includes('    conditions:'));
  assert.ok(nested.includes('    - only-if'));
});

test('two appends to the same list land in operation order', () => {
  const { parsed } = apply(FIXTURE, [
    { op: 'append', pointer: '/log', item: { record_path: 'a', record_sha256: 'b', reason: 'one' } },
    { op: 'append', pointer: '/log', item: { record_path: 'c', record_sha256: 'd', reason: 'two' } },
  ]);
  assert.deepEqual(parsed.log.map((entry) => entry.reason), ['Initial pass.', 'one', 'two']);
});

test('refuses shapes it does not understand', () => {
  const refuse = (text, ops, pattern) => assert.throws(() => splice.applyOps(text, ops), (error) => {
    assert.equal(error.name, 'SpliceError');
    assert.match(error.message, pattern);
    return true;
  });
  const set = (pointer) => [{ op: 'set', pointer, token: '1' }];
  refuse('a: {b: 1}\n', set('/a/b'), /flow/);
  refuse('a: {b: 1}\n', set('/a'), /flow/);
  refuse('a: [1, 2]\n', [{ op: 'append', pointer: '/a', item: 3 }], /flow/);
  refuse('a: &x 1\n', set('/a'), /anchor/);
  refuse('a: *x\n', set('/a'), /alias/);
  refuse('a: !!str 1\n', set('/a'), /tag/);
  refuse('a: |\n  text\n', set('/a'), /block scalar/);
  refuse('a: 1 # note\n', set('/a'), /comment/);
  refuse('a: \'x\' # note\n', set('/a'), /comment/);
  refuse('a:\n  b: 1\n', set('/a'), /collection/);
  refuse('a: 1\n---\nb: 2\n', set('/a'), /multi-document/);
  refuse('a: 1\r\n', set('/a'), /CRLF/);
  refuse('a:\n\tb: 1\n', set('/a/b'), /tab/);
  refuse('a: plain\n  # c\n  more\n', set('/a'), /comment/);
  refuse('a: 1\n', set('/missing'), /does not exist/);
  refuse('a:\n  b: 1\n', set('/a/b/c'), /does not exist/);
  refuse('a: 1\n', [{ op: 'append', pointer: '/a', item: 1 }], /not a list/);
});

test('the same lines cannot be edited twice', () => {
  assert.throws(() => splice.applyOps('a: 1\n', [
    { op: 'set', pointer: '/a', token: '2' },
    { op: 'set', pointer: '/a', token: '3' },
  ]), /same lines/);
});

test('a leading document marker is accepted', () => {
  const { parsed } = apply('---\na: 1\nb: 2\n', [{ op: 'set', pointer: '/b', token: '3' }]);
  assert.deepEqual(parsed, { a: 1, b: 3 });
});

test('proveCandidate reports a semantic mismatch and an out-of-bounds change', () => {
  const { text, parsed, edits } = apply(FIXTURE, [{ op: 'set', pointer: '/result/start_sample', token: '1' }]);
  const wrong = structuredClone(parsed);
  wrong.result.end_sample = 5;
  assert.equal(splice.proveCandidate(FIXTURE, text, wrong, { edits }).equal, false);
  const tampered = text.replace('kind: continuous', 'kind: other');
  const proof = splice.proveCandidate(FIXTURE, tampered, yaml.load(tampered), { edits });
  assert.equal(proof.equal, true);
  assert.equal(proof.bounded, false);
  assert.equal(splice.proveCandidate(FIXTURE, 'a: [\n', parsed).equal, false);
});

test('diffLines reports separate hunks with 1-based positions', () => {
  const hunks = splice.diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'd', 'x', 'y', 'e']);
  assert.deepEqual(hunks, [
    { oldStart: 2, oldLines: ['b'], newStart: 2, newLines: ['B'] },
    { oldStart: 5, oldLines: [], newStart: 5, newLines: ['x', 'y'] },
  ]);
  assert.deepEqual(splice.diffLines(['a'], ['a']), []);
});

test('declaredPointers follows the CLI rule: mappings recurse, any list difference is the list', () => {
  const before = yaml.load(FIXTURE);
  const after = structuredClone(before);
  after.result.start_sample = 50000;
  after.result.windows[0].start_sample = 50000;
  after.result.decision.reason = 'changed';
  after.result.verification.proof_ids.push('p-02');
  after.proofs.push({ id: 'p-02' });
  after.log.push({ record_path: 'x', record_sha256: 'y', reason: 'z' });
  assert.deepEqual(splice.declaredPointers(before, after), [
    '/log',
    '/proofs',
    '/result/decision/reason',
    '/result/start_sample',
    '/result/verification/proof_ids',
    '/result/windows',
  ]);
});

test('declaredPointers: keys added or removed, type changes and escapes', () => {
  assert.deepEqual(splice.declaredPointers({ a: 1, b: { c: 1 }, e: 1 }, { a: '1', d: 2, b: { c: 1 } }), ['/a', '/d', '/e']);
  assert.deepEqual(splice.declaredPointers({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 2 }), ['/a~1b', '/c~0d']);
  assert.deepEqual(splice.declaredPointers({ a: 1 }, { a: 1 }), []);
});

test('collapseToListUnit maps a leaf inside a list to the list pointer', () => {
  const doc = yaml.load(FIXTURE);
  assert.equal(splice.collapseToListUnit(doc, '/result/windows/0/start_sample'), '/result/windows');
  assert.equal(splice.collapseToListUnit(doc, '/result/start_sample'), '/result/start_sample');
  assert.equal(splice.collapseToListUnit(doc, '/proofs'), '/proofs');
});

test('setAt and appendAt never create paths', () => {
  const doc = yaml.load(FIXTURE);
  assert.throws(() => splice.setAt(doc, '/result/missing', 1), /does not exist/);
  assert.throws(() => splice.setAt(doc, '/nowhere/deep', 1), /does not exist/);
  assert.throws(() => splice.setAt(doc, '/result/decision', 1), /scalar/);
  assert.throws(() => splice.appendAt(doc, '/result/start_sample', 1), /list/);
  splice.setAt(doc, '/result/windows/0/end_sample', 7);
  assert.equal(doc.result.windows[0].end_sample, 7);
});
