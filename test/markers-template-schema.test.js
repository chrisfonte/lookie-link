'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BUNDLED_IDS,
  isMarkerTemplateId,
  summarizeTemplate,
  validateMarkerTemplate,
} = require('../lib/markers/template-schema');

const BUNDLED_DIR = path.join(__dirname, '..', 'lib', 'markers', 'bundled');

function bundled(id) {
  return JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, `${id}.json`), 'utf8'));
}

function minimal(overrides = {}) {
  return {
    contractVersion: 1,
    resourceKind: 'marker-template',
    templateId: 'sample',
    revision: 1,
    title: 'Sample',
    unit: 'ms',
    markers: [
      { id: 'a', label: 'A', kind: 'point', color: '#112233' },
      { id: 'r', label: 'R', kind: 'region', color: '#445566', group: 'g' },
    ],
    groups: [{ id: 'g', label: 'G' }],
    ...overrides,
  };
}

function withSources() {
  return minimal({
    sources: [
      { id: 'target', kind: 'yaml', root: 'work', locate: { glob: 'items/*/item.yaml', match: { pointer: '/asset/sha256', equals: '$audio.sha256' } } },
      { id: 'hits', kind: 'json', root: 'work', pathFrom: { source: 'target', pointer: '/evidence[id=x]/path' },
        select: { pointer: '/hits[*]/at', unit: 'samples' }, as: { kind: 'point', label: 'Hit', color: '#888888', style: 'dashed' } },
      { id: 'events', kind: 'yaml', from: 'target', select: { pointer: '/events[*]', start: 's', end: 'e', label: 'kind' }, as: { kind: 'region' } },
    ],
    image: { source: 'target', pathFrom: '/evidence[id=img]/path', plot: { left: 10, right: 100, top: 5, bottom: 50 } },
    projections: [{
      id: 'yaml-out', kind: 'yaml-pointers', root: 'work', target: 'target', validator: 'check.record',
      write: [{ marker: 'a', pointer: '/x/y' }],
      text: [{ pointer: '/x/reason', template: 'by {actor}: {reason}' }],
      status: { pointer: '/x/status', onAccept: 'accepted' },
      receipts: { dir: 'sessions/{session}/edits/{audio.basename}', snapshot: 'pre-{stamp}.yaml', receipt: 'edit-{stamp}.md' },
      history: { pointer: '/history', append: { reason: 'edit {date}' } },
      evidence: { pointer: '/evidence', append: { id: 'e-{n}' }, referenceIn: '/x/ids' },
    }],
  });
}

function messages(doc) {
  return validateMarkerTemplate(doc).errors.map((error) => `${error.path}: ${error.message}`);
}

function assertRejected(doc, pathFragment) {
  const result = validateMarkerTemplate(doc);
  assert.equal(result.valid, false, 'expected invalid');
  assert.ok(result.errors.some((error) => error.path.includes(pathFragment)), `no error at ${pathFragment}: ${JSON.stringify(result.errors)}`);
}

test('every bundled template is valid and ids match BUNDLED_IDS', () => {
  assert.deepEqual([...BUNDLED_IDS].sort(), fs.readdirSync(BUNDLED_DIR).map((n) => n.replace(/\.json$/, '')).sort());
  for (const id of BUNDLED_IDS) {
    const result = validateMarkerTemplate(bundled(id));
    assert.deepEqual(result.errors, [], id);
    assert.equal(result.valid, true);
  }
});

test('bundled templates carry no client specifics', () => {
  const radio = bundled('radio-imaging');
  assert.equal(radio.sources, undefined);
  assert.ok(!(radio.projections || []).some((p) => p.kind === 'yaml-pointers'));
  assert.equal(radio.unit, 'samples');
  for (const id of BUNDLED_IDS) {
    assert.doesNotMatch(JSON.stringify(bundled(id)), /\/home\/|\/Users\/|@/);
  }
});

test('full sources, image and projection shapes validate', () => {
  assert.deepEqual(messages(withSources()), []);
});

test('rivendell projection map accepts known field names and pairs', () => {
  const doc = minimal({ projections: [{ id: 'rv', kind: 'rivendell', map: { a: 'TALK_END_POINT', r: ['START_POINT', 'END_POINT'] } }] });
  assert.deepEqual(messages(doc), []);
});

test('unknown key is rejected at each level', () => {
  const cases = [
    ['', (d) => { d.extra = 1; }, 'extra'],
    ['groups', (d) => { d.groups[0].extra = 1; }, 'groups[0].extra'],
    ['markers', (d) => { d.markers[0].extra = 1; }, 'markers[0].extra'],
    ['constraints', (d) => { d.markers[0].constraints = { extra: 1 }; }, 'constraints.extra'],
    ['pickers', (d) => { d.pickers = [{ id: 'p', label: 'P', options: [{ id: 'o', label: 'O' }], extra: 1 }]; }, 'pickers[0].extra'],
    ['options', (d) => { d.pickers = [{ id: 'p', label: 'P', options: [{ id: 'o', label: 'O', extra: 1 }] }]; }, 'options[0].extra'],
    ['source', (d) => { d.sources[0].extra = 1; }, 'sources[0].extra'],
    ['locate', (d) => { d.sources[0].locate.extra = 1; }, 'locate.extra'],
    ['match', (d) => { d.sources[0].locate.match.extra = 1; }, 'match.extra'],
    ['pathFrom', (d) => { d.sources[1].pathFrom.extra = 1; }, 'pathFrom.extra'],
    ['select', (d) => { d.sources[1].select.extra = 1; }, 'select.extra'],
    ['as', (d) => { d.sources[1].as.extra = 1; }, 'as.extra'],
    ['image', (d) => { d.image.extra = 1; }, 'image.extra'],
    ['plot', (d) => { d.image.plot.extra = 1; }, 'plot.extra'],
    ['projection', (d) => { d.projections[0].extra = 1; }, 'projections[0].extra'],
    ['write', (d) => { d.projections[0].write[0].extra = 1; }, 'write[0].extra'],
    ['text', (d) => { d.projections[0].text[0].extra = 1; }, 'text[0].extra'],
    ['status', (d) => { d.projections[0].status.extra = 1; }, 'status.extra'],
    ['receipts', (d) => { d.projections[0].receipts.extra = 1; }, 'receipts.extra'],
    ['history', (d) => { d.projections[0].history.extra = 1; }, 'history.extra'],
    ['evidence', (d) => { d.projections[0].evidence.extra = 1; }, 'evidence.extra'],
  ];
  for (const [name, mutate, fragment] of cases) {
    const doc = withSources();
    mutate(doc);
    assertRejected(doc, fragment);
    assert.ok(messages(doc).some((m) => m.includes('unknown property')), name);
  }
});

test('envelope fields are enforced', () => {
  assertRejected(minimal({ contractVersion: 2 }), 'contractVersion');
  assertRejected(minimal({ resourceKind: 'form-template' }), 'resourceKind');
  assertRejected(minimal({ templateId: 'Bad_Id' }), 'templateId');
  assertRejected(minimal({ templateId: `a${'b'.repeat(64)}` }), 'templateId');
  assertRejected(minimal({ revision: 0 }), 'revision');
  assertRejected(minimal({ unit: 'frames' }), 'unit');
  assertRejected(minimal({ markers: [] }), 'markers');
  assertRejected(minimal({ markers: undefined }), 'markers');
  assert.equal(validateMarkerTemplate(null).valid, false);
  assert.equal(validateMarkerTemplate([]).valid, false);
});

test('bad color, kind, duplicate ids and unknown group are rejected', () => {
  const doc = minimal();
  doc.markers[0].color = 'red';
  assertRejected(doc, 'markers[0].color');
  const kind = minimal();
  kind.markers[0].kind = 'span';
  assertRejected(kind, 'markers[0].kind');
  const duplicate = minimal();
  duplicate.markers[1].id = 'a';
  assertRejected(duplicate, 'markers[1].id');
  const group = minimal();
  group.markers[0].group = 'nope';
  assertRejected(group, 'markers[0].group');
});

test('keys must be unique single printable characters naming markers', () => {
  assertRejected(minimal({ keys: { a: '1', r: '1' } }), 'keys.r');
  assertRejected(minimal({ keys: { a: 'ab' } }), 'keys.a');
  assertRejected(minimal({ keys: { a: ' ' } }), 'keys.a');
  assertRejected(minimal({ keys: { ghost: '1' } }), 'keys.ghost');
  assert.deepEqual(messages(minimal({ keys: { a: 'm', r: '[' } })), []);
});

test('constraint references must resolve', () => {
  const after = minimal();
  after.markers[0].constraints = { after: 'ghost' };
  assertRejected(after, 'constraints.after');
  const before = minimal();
  before.markers[0].constraints = { before: 'ghost' };
  assertRejected(before, 'constraints.before');
  const within = minimal();
  within.markers[1].constraints = { within: 'a' };
  assertRejected(within, 'constraints.within');
  const self = minimal();
  self.markers[0].constraints = { after: 'a' };
  assertRejected(self, 'constraints.after');
  const overlap = minimal();
  overlap.markers[1].constraints = { noOverlap: 'ghost' };
  assertRejected(overlap, 'constraints.noOverlap');
  const range = minimal();
  range.markers[0].constraints = { min: 10, max: 5 };
  assertRejected(range, 'constraints.max');
  const good = minimal();
  good.markers[1].constraints = { noOverlap: 'g', after: 'a', maxCount: 3, min: 0 };
  assert.deepEqual(messages(good), []);
});

test('snap and read must name declared sources', () => {
  const snap = withSources();
  snap.markers[0].snap = 'ghost';
  assertRejected(snap, 'markers[0].snap');
  const ok = withSources();
  ok.markers[0].snap = 'hits';
  ok.markers[0].snapWindow = 48;
  ok.markers[1].snap = 'none';
  ok.markers[0].read = { source: 'target', pointer: '/analysis/x' };
  assert.deepEqual(messages(ok), []);
  ok.markers[0].read.source = 'ghost';
  assertRejected(ok, 'read.source');
});

test('projection kind, write markers, pointers and receipts are checked', () => {
  const kind = withSources();
  kind.projections[0].kind = 'shell';
  assertRejected(kind, 'projections[0].kind');
  const marker = withSources();
  marker.projections[0].write[0].marker = 'ghost';
  assertRejected(marker, 'write[0].marker');
  const pointer = withSources();
  pointer.projections[0].write[0].pointer = 'x/y';
  assertRejected(pointer, 'write[0].pointer');
  const dir = withSources();
  dir.projections[0].receipts.dir = '../outside';
  assertRejected(dir, 'receipts.dir');
  const abs = withSources();
  abs.projections[0].receipts.dir = '/abs';
  assertRejected(abs, 'receipts.dir');
  const name = withSources();
  name.projections[0].receipts.snapshot = '../x.yaml';
  assertRejected(name, 'receipts.snapshot');
  const target = withSources();
  target.projections[0].target = 'ghost';
  assertRejected(target, 'projections[0].target');
  const glob = withSources();
  glob.sources[0].locate.glob = 'a/../../b';
  assertRejected(glob, 'locate.glob');
  const rv = minimal({ projections: [{ id: 'rv', kind: 'rivendell', map: { a: 'NOPE_POINT' } }] });
  assertRejected(rv, 'map.a');
  const rvPair = minimal({ projections: [{ id: 'rv', kind: 'rivendell', map: { a: ['START_POINT'] } }] });
  assertRejected(rvPair, 'map.a');
  const rvMarker = minimal({ projections: [{ id: 'rv', kind: 'rivendell', map: { ghost: 'START_POINT' } }] });
  assertRejected(rvMarker, 'map.ghost');
});

test('image and source references must resolve; plot must be ordered', () => {
  const image = withSources();
  image.image.source = 'ghost';
  assertRejected(image, 'image.source');
  const plot = withSources();
  plot.image.plot.right = 5;
  assertRejected(plot, 'image.plot.right');
  const from = withSources();
  from.sources[2].from = 'ghost';
  assertRejected(from, 'sources[2].from');
  const bare = withSources();
  bare.sources.push({ id: 'bare', kind: 'json' });
  assertRejected(bare, 'sources[3]');
});

test('isMarkerTemplateId and summarizeTemplate', () => {
  assert.equal(isMarkerTemplateId('song-structure'), true);
  assert.equal(isMarkerTemplateId('Song'), false);
  assert.equal(isMarkerTemplateId('../x'), false);
  assert.equal(isMarkerTemplateId(5), false);
  assert.deepEqual(summarizeTemplate(bundled('song-structure'), { source: 'bundled', writable: false }), {
    templateId: 'song-structure', revision: 1, title: 'Song structure', unit: 'ms', markerCount: 5, source: 'bundled', writable: false,
  });
  assert.equal(summarizeTemplate(minimal()).writable, true);
});
