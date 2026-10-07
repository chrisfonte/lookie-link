'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSourceResolver, normalizeRelative } = require('../lib/markers/sources');
const { validateMarkerTemplate } = require('../lib/markers/template-schema');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'markers', 'root');
const ALPHA = { sha256: 'a'.repeat(64), basename: 'alpha.wav', sampleRate: 48000, frames: 288000 };
const BETA = { sha256: 'b'.repeat(64), basename: 'beta.wav', sampleRate: 44100, frames: 100000 };

function template(overrides = {}) {
  return {
    contractVersion: 1,
    resourceKind: 'marker-template',
    templateId: 'sample',
    revision: 1,
    title: 'Sample',
    unit: 'samples',
    markers: [
      { id: 'first', label: 'First', kind: 'point', color: '#112233', read: { source: 'target', pointer: '/analysis/first_event_sample' } },
      { id: 'decision', label: 'Decision', kind: 'region', color: '#223344', read: { source: 'target', pointer: '/analysis/decision' } },
      { id: 'free', label: 'Free', kind: 'point', color: '#334455' },
    ],
    sources: [
      {
        id: 'target', kind: 'yaml', root: 'main',
        locate: { glob: 'pieces/*/record.yaml', match: { pointer: '/asset/digest', equals: '$audio.sha256' } },
      },
      {
        id: 'hits', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=measure-report]/path' },
        select: { pointer: '/hits/items[*]/at_sample', unit: 'samples' }, as: { kind: 'point', label: 'Hit', color: '#888888' },
      },
      {
        id: 'cue', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=cue-sheet]/path' },
        select: { pointer: '/cross_start', unit: 'seconds' }, as: { kind: 'point', label: 'Cue', style: 'dashed' },
      },
      {
        id: 'events', kind: 'yaml', from: 'target',
        select: { pointer: '/analysis/events[*]', start: 'begin', end: 'finish', label: 'kind', unit: 'ms' }, as: { kind: 'region' },
      },
    ],
    image: { source: 'target', pathFrom: '/evidence[id=plot-image]/path', plot: { left: 142, right: 1942, top: 64, bottom: 664 } },
    projections: [{ id: 'write-back', kind: 'yaml-pointers', root: 'main', target: 'target', write: [{ marker: 'first', pointer: '/analysis/first_event_sample' }],
      receipts: { dir: 'receipts', snapshot: 'snapshot.yaml', receipt: 'receipt.json' } }],
    ...overrides,
  };
}

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'marker-sources-'));
  const root = path.join(dir, 'root');
  await fs.cp(FIXTURE_ROOT, root, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const resolver = createSourceResolver({ roots: { main: { path: root, allowProjections: false } }, ...options });
  return { dir, root, resolver };
}

function noAbsolutePaths(value, dir) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(dir), 'output must not contain the root directory');
  assert.ok(!/"\/[A-Za-z]/.test(text) && !text.includes('/etc/passwd'), 'output must not contain an absolute path');
}

test('the fixture template is accepted by the schema (shape parity)', () => {
  const result = validateMarkerTemplate(template());
  assert.deepEqual(result.errors, []);
});

test('locates the target by sha256, resolves linked artifacts and converts units', async (t) => {
  const { dir, resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });

  assert.equal(context.target.root, 'main');
  assert.equal(context.target.relPath, 'pieces/alpha/record.yaml');
  assert.match(context.target.sha256, /^[0-9a-f]{64}$/);
  assert.equal(context.targetSha256, context.target.sha256);
  assert.ok(context.target.mtimeMs > 0);
  assert.deepEqual(context.problems.map((p) => p.sourceId).sort(), ['events']);

  const byId = Object.fromEntries(context.sources.map((source) => [source.id, source]));
  assert.deepEqual(byId.hits.points.map((p) => p.sample), [24000, 177888, 219456]);
  assert.deepEqual(byId.hits.as, { kind: 'point', label: 'Hit', color: '#888888' });
  assert.deepEqual(byId.cue.points, [{ sample: 235200 }]);
  assert.equal(byId.cue.as.style, 'dashed');
  assert.equal(context.sources.some((source) => source.id === 'target'), false);
  noAbsolutePaths(context, dir);
});

test('the target sha256 is the hash of the bytes on disk', async (t) => {
  const { root, resolver } = await setup(t);
  const bytes = await fs.readFile(path.join(root, 'pieces/alpha/record.yaml'));
  const expected = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.equal(context.target.sha256, expected);
  assert.equal(context.target.size, bytes.length);
});

test('region sources use start/end/label keys; ms converts at the audio rate; bad entries become a neutral problem', async (t) => {
  const { resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  const events = context.sources.find((source) => source.id === 'events');
  assert.deepEqual(events.regions, [
    { startSample: 4800, endSample: 19200, label: 'lead' },
    { startSample: 43200, endSample: 72000, label: 'tail' },
  ]);
  assert.deepEqual(events.points, []);
  assert.deepEqual(context.problems, [{ sourceId: 'events', message: '1 entry could not be converted to a position' }]);

  const atOtherRate = await resolver.resolveContext({ template: template(), audio: { ...ALPHA, sampleRate: 44100 } });
  assert.equal(atOtherRate.sources.find((s) => s.id === 'events').regions[0].startSample, 4410);
  assert.equal(atOtherRate.sources.find((s) => s.id === 'cue').points[0].sample, Math.round(4.9 * 44100));
});

test('[*] over nested arrays and pair-shaped regions', async (t) => {
  const { resolver } = await setup(t);
  const spans = template({
    sources: [
      template().sources[0],
      {
        id: 'spans', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=measure-report]/path' },
        select: { pointer: '/groups[*]/spans[*]', start: 'from', end: 'to', unit: 'samples' }, as: { kind: 'region', label: 'Span' },
      },
    ],
    markers: [{ id: 'free', label: 'Free', kind: 'point', color: '#334455' }],
    image: undefined,
    projections: undefined,
  });
  const context = await resolver.resolveContext({ template: spans, audio: ALPHA });
  assert.deepEqual(context.sources[0].regions.map((r) => [r.startSample, r.endSample]), [[10, 20], [30, 40], [50, 60]]);
  assert.deepEqual(context.problems, []);
});

test('reads and targetValues come from the target, in samples, for markers with a read', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.markers[1].read = { source: 'target', pointer: '/analysis/decision' };
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.deepEqual(context.reads, { first: 177888, decision: { startSample: 4800, endSample: 9600 } });
  assert.deepEqual(context.targetValues, context.reads);
  assert.notEqual(context.targetValues, context.reads);
  assert.equal('free' in context.reads, false);
});

test('a read of a pair array becomes a region; kind mismatches are neutral problems', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.markers = [
    { id: 'win', label: 'Win', kind: 'region', color: '#112233', read: { source: 'target', pointer: '/analysis/window' } },
    { id: 'wrong', label: 'Wrong', kind: 'point', color: '#112233', read: { source: 'target', pointer: '/analysis/window' } },
    { id: 'scalar', label: 'Scalar', kind: 'region', color: '#112233', read: { source: 'target', pointer: '/analysis/first_event_sample' } },
    { id: 'gone', label: 'Gone', kind: 'point', color: '#112233', read: { source: 'target', pointer: '/analysis/not_there' } },
  ];
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.deepEqual(context.reads, { win: { startSample: 1000, endSample: 2000 } });
  const messages = context.problems.filter((p) => p.markerId).map((p) => p.markerId).sort();
  assert.deepEqual(messages, ['gone', 'scalar', 'wrong']);
});

test('a read uses the unit declared by its source select, else samples', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.markers = [{ id: 'cross', label: 'Cross', kind: 'point', color: '#112233', read: { source: 'cue', pointer: '/cross_start' } }];
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.deepEqual(context.reads, { cross: 235200 });
});

test('image keeps the plot box unchanged (right and bottom exclusive) and returns a root-relative path', async (t) => {
  const { dir, resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.deepEqual(context.image, {
    root: 'main',
    relPath: 'pieces/alpha/measure/plot.png',
    plot: { left: 142, right: 1942, top: 64, bottom: 664 },
  });
  const noPlot = template();
  delete noPlot.image.plot;
  const without = await resolver.resolveContext({ template: noPlot, audio: ALPHA });
  assert.equal(without.image.plot, null);
  noAbsolutePaths(context, dir);
});

test('projections list id, kind and a label (id by default)', async (t) => {
  const { resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.deepEqual(context.projections, [{ id: 'write-back', kind: 'yaml-pointers', label: 'write-back' }]);
});

test('no matching target is a neutral problem and dependent sources stay quiet', async (t) => {
  const { resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: { ...ALPHA, sha256: 'c'.repeat(64) } });
  assert.equal(context.target, null);
  assert.equal(context.targetSha256, null);
  assert.deepEqual(context.sources, []);
  assert.deepEqual(context.reads, {});
  assert.equal(context.image, null);
  assert.equal(context.problems.length, 1);
  assert.equal(context.problems[0].sourceId, 'target');
  assert.match(context.problems[0].message, /^no target found \(1 candidate file could not be read\)$/);
});

test('sha256 matching ignores hex case', async (t) => {
  const { resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: { ...ALPHA, sha256: 'A'.repeat(64) } });
  assert.equal(context.target.relPath, 'pieces/alpha/record.yaml');
});

test('$audio.basename is the other substitution; a missing audio value is a problem, not a throw', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.sources[0].locate.match = { pointer: '/asset/name', equals: '$audio.basename' };
  const found = await resolver.resolveContext({ template: tpl, audio: { ...BETA, basename: 'beta.wav' } });
  assert.equal(found.target.relPath, 'pieces/beta/record.yaml');
  const missing = await resolver.resolveContext({ template: tpl, audio: { sampleRate: 48000 } });
  assert.equal(missing.target, null);
  assert.equal(missing.problems[0].sourceId, 'target');
});

test('more than one match throws 409 ambiguous_target', async (t) => {
  const { root, resolver } = await setup(t);
  await fs.mkdir(path.join(root, 'pieces/alpha-copy'));
  await fs.copyFile(path.join(root, 'pieces/alpha/record.yaml'), path.join(root, 'pieces/alpha-copy/record.yaml'));
  await assert.rejects(
    resolver.resolveContext({ template: template(), audio: ALPHA }),
    (error) => error.status === 409 && error.code === 'ambiguous_target',
  );
  await assert.rejects(
    resolver.locateTarget(template(), 'target', ALPHA),
    (error) => error.status === 409 && error.code === 'ambiguous_target',
  );
});

test('dot directories are not searched by the wildcard', async (t) => {
  const { resolver } = await setup(t);
  // pieces/.hidden/record.yaml carries the same digest as alpha; it must not make the match ambiguous.
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.equal(context.target.relPath, 'pieces/alpha/record.yaml');
});

test('a literal glob without a wildcard works; unsupported globs are problems', async (t) => {
  const { resolver } = await setup(t);
  const literal = template();
  literal.sources[0].locate.glob = 'pieces/alpha/record.yaml';
  assert.equal((await resolver.resolveContext({ template: literal, audio: ALPHA })).target.relPath, 'pieces/alpha/record.yaml');
  for (const glob of ['pieces/*/*/record.yaml', 'pie*/alpha/record.yaml', 'pieces/alpha/*.yaml', '**/record.yaml']) {
    const tpl = template();
    tpl.sources[0].locate.glob = glob;
    const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
    assert.equal(context.target, null, glob);
    assert.equal(context.problems.length, 1, glob);
  }
});

test('a glob with ".." or an absolute prefix is refused as a problem', async (t) => {
  const { resolver } = await setup(t);
  for (const glob of ['../*/record.yaml', '/pieces/*/record.yaml']) {
    const tpl = template();
    tpl.sources[0].locate.glob = glob;
    const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
    assert.equal(context.target, null, glob);
    assert.equal(context.problems.length, 1, glob);
  }
});

test('pathFrom refuses absolute and ".." paths and does not follow them', async (t) => {
  const { dir, root, resolver } = await setup(t);
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside/report.json'), '{"cross_start": 1}');
  const tpl = template();
  tpl.sources.push(
    { id: 'abs', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=absolute-link]/path' }, select: { pointer: '/x' }, as: { kind: 'point' } },
    { id: 'dots', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=escaping-link]/path' }, select: { pointer: '/cross_start', unit: 'seconds' }, as: { kind: 'point' } },
  );
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.equal(context.sources.some((s) => s.id === 'abs' || s.id === 'dots'), false);
  const refused = context.problems.filter((p) => p.sourceId === 'abs' || p.sourceId === 'dots');
  assert.equal(refused.length, 2);
  for (const problem of refused) assert.match(problem.message, /not followed/);
  noAbsolutePaths(context, dir);
  assert.ok(root);
});

test('a symlink that escapes the root is refused, for pathFrom, image and target glob', async (t) => {
  const { dir, root, resolver } = await setup(t);
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside/report.json'), JSON.stringify({ hits: { items: [{ at_sample: 1 }] } }));
  await fs.writeFile(path.join(dir, 'outside/plot.png'), 'x');
  await fs.rm(path.join(root, 'pieces/alpha/measure/report.json'));
  await fs.symlink(path.join(dir, 'outside/report.json'), path.join(root, 'pieces/alpha/measure/report.json'));
  await fs.rm(path.join(root, 'pieces/alpha/measure/plot.png'));
  await fs.symlink(path.join(dir, 'outside/plot.png'), path.join(root, 'pieces/alpha/measure/plot.png'));
  // A directory symlink under the wildcard level that points outside must not be read as a candidate.
  await fs.mkdir(path.join(dir, 'outside/piece'));
  await fs.writeFile(path.join(dir, 'outside/piece/record.yaml'), `asset:\n  digest: ${'d'.repeat(64)}\n`);
  await fs.symlink(path.join(dir, 'outside/piece'), path.join(root, 'pieces/linked'));

  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.equal(context.sources.some((s) => s.id === 'hits'), false);
  assert.equal(context.image, null);
  assert.ok(context.problems.some((p) => p.sourceId === 'hits' && /leaves the root/.test(p.message)));
  assert.ok(context.problems.some((p) => p.sourceId === 'image' && /leaves the root/.test(p.message)));
  noAbsolutePaths(context, dir);

  const escaped = await resolver.resolveContext({ template: template(), audio: { ...ALPHA, sha256: 'd'.repeat(64) } });
  assert.equal(escaped.target, null);
});

test('an in-root symlink is allowed', async (t) => {
  const { root, resolver } = await setup(t);
  await fs.rm(path.join(root, 'pieces/alpha/measure/cue.json'));
  await fs.symlink(path.join(root, 'pieces/beta/measure/report.json'), path.join(root, 'pieces/alpha/measure/cue.json'));
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.ok(context.problems.some((p) => p.sourceId === 'cue' && /no values/.test(p.message)));
});

test('a missing linked file and empty selections are neutral problems, never throws', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.sources.push(
    { id: 'gone', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=missing-link]/path' }, select: { pointer: '/x' }, as: { kind: 'point' } },
    { id: 'nokey', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=measure-report]/path' }, select: { pointer: '/onsets/hits[*]/attack' }, as: { kind: 'point' } },
    { id: 'nolink', kind: 'json', root: 'main', pathFrom: { source: 'target', pointer: '/evidence[id=nope]/path' }, select: { pointer: '/x' }, as: { kind: 'point' } },
  );
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  const byId = Object.fromEntries(context.problems.map((p) => [p.sourceId, p.message]));
  assert.equal(byId.gone, 'file not found');
  assert.equal(byId.nokey, 'no values found in the source file');
  assert.equal(byId.nolink, 'no linked file path found in the source file');
  assert.equal(context.sources.find((s) => s.id === 'nokey').points.length, 0);
  assert.ok(context.target);
});

test('unparseable linked files and oversized files are problems', async (t) => {
  const { root, resolver } = await setup(t, { maxFileBytes: 2000 });
  await fs.writeFile(path.join(root, 'pieces/alpha/measure/cue.json'), '{ not json');
  await fs.writeFile(path.join(root, 'pieces/alpha/measure/report.json'), JSON.stringify({ pad: 'x'.repeat(3000) }));
  const context = await resolver.resolveContext({ template: template(), audio: ALPHA });
  const byId = Object.fromEntries(context.problems.map((p) => [p.sourceId, p.message]));
  assert.equal(byId.cue, 'file could not be parsed');
  assert.equal(byId.hits, 'file is too large to read');
});

test('a non-image path for image.pathFrom is a problem', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.image.pathFrom = '/evidence[id=cue-sheet]/path';
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.equal(context.image, null);
  assert.ok(context.problems.some((p) => p.sourceId === 'image'));
});

test('a unit conversion with no sample rate is a problem, not a throw', async (t) => {
  const { resolver } = await setup(t);
  const context = await resolver.resolveContext({ template: template(), audio: { sha256: ALPHA.sha256, basename: 'alpha.wav' } });
  assert.ok(context.target);
  assert.ok(context.problems.some((p) => p.sourceId === 'cue' && /sample rate/.test(p.message)));
  assert.deepEqual(context.sources.find((s) => s.id === 'hits').points.length, 3);
});

test('an unknown root alias is a problem; templates without sources resolve to empty', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template();
  tpl.sources[0].root = 'nowhere';
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.equal(context.target, null);
  assert.equal(context.problems[0].sourceId, 'target');

  const empty = await resolver.resolveContext({ template: { templateId: 'plain', markers: [] }, audio: ALPHA });
  assert.deepEqual(empty, {
    target: null, targetSha256: null, sources: [], reads: {}, targetValues: {}, image: null, projections: [], problems: [],
  });
});

test('every request re-reads the files: mtime and content changes are visible', async (t) => {
  const { root, resolver } = await setup(t);
  const first = await resolver.resolveContext({ template: template(), audio: ALPHA });
  const file = path.join(root, 'pieces/alpha/record.yaml');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('first_event_sample: 177888', 'first_event_sample: 180000'));
  const future = new Date(Date.now() + 5000);
  await fs.utimes(file, future, future);
  const second = await resolver.resolveContext({ template: template(), audio: ALPHA });
  assert.equal(first.reads.first, 177888);
  assert.equal(second.reads.first, 180000);
  assert.notEqual(second.targetSha256, first.targetSha256);
  assert.ok(second.target.mtimeMs > first.target.mtimeMs);
});

test('locateTarget returns the located file with a server-only absolute path and parsed document', async (t) => {
  const { root, resolver } = await setup(t);
  const result = await resolver.locateTarget(template(), 'target', ALPHA);
  assert.equal(result.problem, null);
  assert.equal(result.target.relPath, 'pieces/alpha/record.yaml');
  assert.equal(result.target.absPath, await fs.realpath(path.join(root, 'pieces/alpha/record.yaml')));
  assert.equal(result.target.doc.asset.name, 'alpha.wav');
  assert.ok(!JSON.stringify(result).includes(root), 'absPath and doc are non-enumerable');
  assert.deepEqual(Object.keys(result.target).sort(), ['mtimeMs', 'relPath', 'root', 'sha256', 'size']);

  const byObject = await resolver.locateTarget(template(), template().sources[0], ALPHA);
  assert.equal(byObject.target.sha256, result.target.sha256);

  const none = await resolver.locateTarget(template(), 'target', { ...ALPHA, sha256: 'c'.repeat(64) });
  assert.equal(none.target, null);
  assert.match(none.problem, /^no target found/);
  assert.deepEqual(await resolver.locateTarget(template(), 'nope', ALPHA), { target: null, problem: 'unknown source' });
});

test('circular pathFrom chains terminate with a problem', async (t) => {
  const { resolver } = await setup(t);
  const tpl = template({
    sources: [
      { id: 'one', kind: 'json', root: 'main', pathFrom: { source: 'two', pointer: '/a' }, select: { pointer: '/x' }, as: { kind: 'point' } },
      { id: 'two', kind: 'json', root: 'main', pathFrom: { source: 'one', pointer: '/a' }, select: { pointer: '/x' }, as: { kind: 'point' } },
    ],
    markers: [], image: undefined, projections: undefined,
  });
  const context = await resolver.resolveContext({ template: tpl, audio: ALPHA });
  assert.deepEqual(context.sources, []);
});

test('normalizeRelative accepts only safe relative paths', () => {
  assert.equal(normalizeRelative('a/b/c.json'), 'a/b/c.json');
  assert.equal(normalizeRelative('./a//b.json'), 'a/b.json');
  for (const bad of ['', '/a', '../a', 'a/../b', 'a/..', 'C:/a', 'a\\b', 'a\0b', 5, null, undefined, '.']) {
    assert.equal(normalizeRelative(bad), null, String(bad));
  }
});

const DELTA = { sha256: 'd'.repeat(64), basename: 'delta.wav', sampleRate: 48000, frames: 96000 };

function receiptsTemplate(glob, dir) {
  const tpl = template();
  tpl.sources[0].locate.glob = glob;
  tpl.projections[0].receipts.dir = dir;
  return tpl;
}

async function copyRecord(root, from, to) {
  await fs.mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await fs.copyFile(path.join(root, from), path.join(root, to));
}

test('a receipt copy of the target under the target directory is not a second match', async (t) => {
  const { resolver } = await setup(t);
  const tpl = receiptsTemplate('owned/*/record.yaml', '{target.dir}/passes/owner-edits');
  const context = await resolver.resolveContext({ template: tpl, audio: DELTA });
  assert.equal(context.target.relPath, 'owned/delta/record.yaml');
  const located = await resolver.locateTarget(tpl, 'target', DELTA);
  assert.equal(located.target.relPath, 'owned/delta/record.yaml');
});

test('receipt copies reached by the glob are dropped, wildcard substitutions match one segment', async (t) => {
  const { root, resolver } = await setup(t);
  await copyRecord(root, 'owned/delta/record.yaml', 'rec/a/record.yaml');
  await copyRecord(root, 'owned/delta/record.yaml', 'rec/snap/record.yaml');
  const literal = receiptsTemplate('rec/*/record.yaml', '{target.dir}/../snap');
  assert.equal((await resolver.locateTarget(literal, 'target', DELTA)).target.relPath, 'rec/a/record.yaml');
  // Without a receipts directory covering the copy, the same files are ambiguous.
  const unrelated = receiptsTemplate('rec/*/record.yaml', '{target.dir}/passes/owner-edits');
  await assert.rejects(resolver.locateTarget(unrelated, 'target', DELTA), (error) => error.status === 409 && error.code === 'ambiguous_target');
  await copyRecord(root, 'owned/delta/record.yaml', 'wild/a/record.yaml');
  await copyRecord(root, 'owned/delta/record.yaml', 'wild/20260101-snap/record.yaml');
  const wild = receiptsTemplate('wild/*/record.yaml', '{target.dir}/../{stamp}-snap');
  assert.equal((await resolver.locateTarget(wild, 'target', DELTA)).target.relPath, 'wild/a/record.yaml');
  // A wildcard stands for one path segment only.
  await copyRecord(root, 'owned/delta/record.yaml', 'deep/a/record.yaml');
  await copyRecord(root, 'owned/delta/record.yaml', 'deep/b/record.yaml');
  const segment = receiptsTemplate('deep/*/record.yaml', 'deep/{stamp}/x');
  await assert.rejects(resolver.locateTarget(segment, 'target', DELTA), (error) => error.code === 'ambiguous_target');
});

test('two genuine records with the same match value stay ambiguous with a receipts directory declared', async (t) => {
  const { root, resolver } = await setup(t);
  await copyRecord(root, 'owned/delta/record.yaml', 'owned/delta-copy/record.yaml');
  const tpl = receiptsTemplate('owned/*/record.yaml', '{target.dir}/passes/owner-edits');
  await assert.rejects(resolver.locateTarget(tpl, 'target', DELTA), (error) => error.status === 409 && error.code === 'ambiguous_target');
  await assert.rejects(resolver.resolveContext({ template: tpl, audio: DELTA }), (error) => error.code === 'ambiguous_target');
});

test('matches inside .history or .lookie-tmp directories are never targets', async (t) => {
  const { root, resolver } = await setup(t);
  for (const reserved of ['.history', '.lookie-tmp']) {
    await copyRecord(root, 'owned/delta/record.yaml', `keep/${reserved}/one/record.yaml`);
    await copyRecord(root, 'owned/delta/record.yaml', `keep/${reserved}/two/record.yaml`);
    const tpl = receiptsTemplate(`keep/${reserved}/*/record.yaml`, '{target.dir}/passes/owner-edits');
    const located = await resolver.locateTarget(tpl, 'target', DELTA);
    assert.equal(located.target, null, reserved);
    assert.match(located.problem, /no target found/, reserved);
  }
  // A live record next to such a directory is the only target.
  await copyRecord(root, 'owned/delta/record.yaml', 'mix/live/record.yaml');
  await copyRecord(root, 'owned/delta/record.yaml', 'mix/live/.history/record.yaml');
  const tpl = receiptsTemplate('mix/live/record.yaml', '{target.dir}/passes/owner-edits');
  assert.equal((await resolver.locateTarget(tpl, 'target', DELTA)).target.relPath, 'mix/live/record.yaml');
});
