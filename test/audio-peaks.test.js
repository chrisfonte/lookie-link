'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  reducePcmS16,
  probeAudio,
  generatePeaks,
  createPeaksService,
  readPeaks,
  peaksHeaderToHttpHeaders,
} = require('../lib/audio/peaks');
const pkg = require('../package.json');

const FFMPEG = '/usr/bin/ffmpeg';
const FFPROBE = '/usr/bin/ffprobe';

function toolsAvailable() {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_TOOLS = toolsAvailable();
const tools = HAVE_TOOLS ? false : 'ffmpeg/ffprobe not available';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let workDir;
let burstWav; // 2 s, 48 kHz stereo, 0.5 s burst on the left channel at t = 1.0 s
let monoWav; // 1 s, 44.1 kHz mono

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-peaks-test-'));
  if (!HAVE_TOOLS) return;
  burstWav = path.join(workDir, 'burst.wav');
  monoWav = path.join(workDir, 'mono.wav');
  execFileSync(FFMPEG, [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,1\\,1.5)\\,0.5*sin(2*PI*440*t)\\,0)|0:s=48000:d=2',
    '-c:a', 'pcm_s16le', burstWav,
  ]);
  execFileSync(FFMPEG, [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=1',
    '-ac', '1', '-c:a', 'pcm_s16le', monoWav,
  ]);
});

test.after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

async function freshDir(name) {
  const dir = path.join(workDir, `${name}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function s16Buffer(frames) {
  const flat = frames.flat();
  const buf = Buffer.alloc(flat.length * 2);
  flat.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

// 10 stereo frames, block size 4 -> blocks of 4, 4 and 2 frames.
const SYNTH_FRAMES = [
  [100, -5], [-500, -6], [300, -7], [-200, -8],
  [-1000, 50], [-20, 60], [-30, -70], [-40, 80],
  [7, 0], [-32768, 32767],
];

test('reducer max-abs on hand-computed samples, clamped to 32767', () => {
  const r = reducePcmS16({ channels: 2, blockSize: 4 });
  r.push(s16Buffer(SYNTH_FRAMES));
  const out = r.finish();
  assert.equal(out.frames, 10);
  assert.equal(out.blocks, 3);
  assert.ok(out.peaks instanceof Uint16Array);
  assert.deepEqual(Array.from(out.peaks), [500, 8, 1000, 80, 32767, 32767]);
});

test('reducer max-positive drops negative samples (negative-dominant block is 0)', () => {
  const r = reducePcmS16({ channels: 2, blockSize: 4, peakMode: 'max-positive' });
  r.push(s16Buffer(SYNTH_FRAMES));
  const out = r.finish();
  // block 0 left 300 (not 500), right all negative -> 0; block 1 left negative-dominant -> 0
  assert.deepEqual(Array.from(out.peaks), [300, 0, 0, 80, 7, 32767]);
});

test('reducer handles pushes that split a sample and a frame', () => {
  const bytes = s16Buffer(SYNTH_FRAMES);
  const whole = reducePcmS16({ channels: 2, blockSize: 4 });
  whole.push(bytes);
  const expected = Array.from(whole.finish().peaks);

  const split = reducePcmS16({ channels: 2, blockSize: 4 });
  split.push(bytes.subarray(0, 1)); // inside the first sample
  split.push(bytes.subarray(1, 7)); // ends inside frame 2 (mid-frame, mid-sample)
  split.push(bytes.subarray(7, 7)); // empty
  split.push(bytes.subarray(7, 30));
  split.push(bytes.subarray(30));
  assert.deepEqual(Array.from(split.finish().peaks), expected);

  const bytewise = reducePcmS16({ channels: 2, blockSize: 4, peakMode: 'max-positive' });
  for (let i = 0; i < bytes.length; i += 1) bytewise.push(bytes.subarray(i, i + 1));
  const out = bytewise.finish();
  assert.equal(out.frames, 10);
  assert.deepEqual(Array.from(out.peaks), [300, 0, 0, 80, 7, 32767]);
});

test('reducer finish on empty input and bad arguments', () => {
  const empty = reducePcmS16({ channels: 1 }).finish();
  assert.deepEqual({ frames: empty.frames, blocks: empty.blocks, len: empty.peaks.length }, { frames: 0, blocks: 0, len: 0 });
  assert.throws(() => reducePcmS16({ channels: 0 }), TypeError);
  assert.throws(() => reducePcmS16({ channels: 1, peakMode: 'rms' }), TypeError);
});

test('reducer grows past its initial buffer', () => {
  const r = reducePcmS16({ channels: 1, blockSize: 1 });
  r.push(Buffer.alloc(2 * 1000, 1));
  const out = r.finish();
  assert.equal(out.blocks, 1000);
  assert.equal(out.peaks.length, 1000);
  assert.equal(out.peaks[999], 0x0101);
});

test('probeAudio reports rate, channels, codec and duration', { skip: tools }, async () => {
  const probe = await probeAudio({ ffprobePath: FFPROBE, filePath: burstWav });
  assert.equal(probe.sampleRate, 48000);
  assert.equal(probe.channels, 2);
  assert.equal(probe.codec, 'pcm_s16le');
  assert.equal(probe.durationTs, 96000);
});

test('probeAudio rejects a file with no audio', { skip: tools }, async () => {
  const bad = path.join(workDir, 'not-audio.wav');
  await fs.writeFile(bad, 'this is not audio');
  await assert.rejects(probeAudio({ ffprobePath: FFPROBE, filePath: bad }), (error) => error.code === 'peaks_unavailable');
});

test('generatePeaks: burst on the left channel only at t = 1.0 s', { skip: tools }, async () => {
  const { header, peaks } = await generatePeaks({
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, filePath: burstWav, blockSize: 1152, peakMode: 'max-abs',
  });
  const stat = await fs.stat(burstWav);
  assert.equal(header.version, 1);
  assert.equal(header.format, 'rivendell-levl-u16le');
  assert.equal(header.layout, 'block-major-channel-interleaved');
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.channels, 2);
  assert.equal(header.blockSize, 1152);
  assert.equal(header.frames, 96000);
  assert.equal(header.blocks, Math.ceil(header.frames / 1152));
  assert.equal(header.blocks, 84);
  assert.equal(header.peakMode, 'max-abs');
  assert.equal(header.valueMax, 32767);
  assert.equal(header.source.size, stat.size);
  assert.equal(header.source.mtimeMs, Math.round(stat.mtimeMs));
  assert.match(header.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(header.generator, `lookie-link/${pkg.version} ffmpeg`);
  assert.equal(peaks.length, header.blocks * header.channels);

  const left = (b) => peaks[b * 2];
  const right = (b) => peaks[b * 2 + 1];
  for (let b = 0; b < header.blocks; b += 1) assert.equal(right(b), 0, `right block ${b}`);
  for (let b = 0; b <= 40; b += 1) assert.equal(left(b), 0, `left block ${b} before burst`);
  for (let b = 63; b < header.blocks; b += 1) assert.equal(left(b), 0, `left block ${b} after burst`);
  // Blocks 42..61 lie wholly inside the burst (frames 48000..72000): amplitude 0.5 of full scale.
  for (let b = 42; b <= 61; b += 1) {
    assert.ok(Math.abs(left(b) - 16384) <= 300, `left block ${b} = ${left(b)}`);
  }
  // Edge blocks 41 and 62 straddle the burst boundaries and are nonzero.
  assert.ok(left(41) > 0 && left(62) > 0);
});

test('generatePeaks: 44.1 kHz mono, max-positive mode and a different block size', { skip: tools }, async () => {
  const { header, peaks } = await generatePeaks({
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, filePath: monoWav, blockSize: 1152, peakMode: 'max-positive',
  });
  assert.equal(header.sampleRate, 44100);
  assert.equal(header.channels, 1);
  assert.equal(header.frames, 44100);
  assert.equal(header.blocks, Math.ceil(44100 / 1152));
  assert.equal(peaks.length, header.blocks);
  assert.equal(header.peakMode, 'max-positive');
  // sine=... defaults to amplitude 1/8 of full scale
  assert.ok(Math.abs(peaks[5] - 4096) <= 100, `peak ${peaks[5]}`);

  const small = await generatePeaks({
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE, filePath: monoWav, blockSize: 4410, peakMode: 'max-abs',
  });
  assert.equal(small.header.blocks, 10);
  assert.equal(small.header.blockSize, 4410);
});

test('generatePeaks rejects when ffmpeg is missing or the file is not audio', { skip: tools }, async () => {
  await assert.rejects(
    generatePeaks({ ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: FFPROBE, filePath: monoWav }),
    (error) => error.code === 'peaks_unavailable',
  );
  await assert.rejects(
    generatePeaks({ ffmpegPath: FFMPEG, ffprobePath: '/nonexistent/ffprobe', filePath: monoWav }),
    (error) => error.code === 'peaks_unavailable',
  );
  await assert.rejects(
    generatePeaks({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, filePath: path.join(workDir, 'absent.wav') }),
    (error) => error.code === 'peaks_unavailable',
  );
});

test('peaksHeaderToHttpHeaders maps the header fields', () => {
  const headers = peaksHeaderToHttpHeaders({
    sampleRate: 48000, channels: 2, blockSize: 1152, frames: 96000, blocks: 84,
    peakMode: 'max-abs', source: { sha256: 'abc' },
  });
  assert.deepEqual(headers, {
    'X-Peaks-Sample-Rate': '48000',
    'X-Peaks-Channels': '2',
    'X-Peaks-Block-Size': '1152',
    'X-Peaks-Frames': '96000',
    'X-Peaks-Blocks': '84',
    'X-Peaks-Peak-Mode': 'max-abs',
    'X-Peaks-Source-Sha256': 'abc',
  });
});

function makeService(extra = {}) {
  const counter = { generations: 0 };
  const service = createPeaksService({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    blockSize: 1152,
    peakMode: 'max-abs',
    generate: (options) => {
      counter.generations += 1;
      return generatePeaks(options);
    },
    ...extra,
  });
  return { service, counter };
}

async function copyAudio(srcFile, dir, name) {
  const dest = path.join(dir, name);
  await fs.copyFile(srcFile, dest);
  return dest;
}

test('ensurePeaks writes both sidecars beside the audio, then reuses them', { skip: tools }, async () => {
  const dir = await freshDir('beside');
  const file = await copyAudio(burstWav, dir, 'take.wav');
  const { service, counter } = makeService();

  const first = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(first.generated, true);
  assert.equal(first.location, 0);
  assert.equal(first.dir, dir);
  assert.equal(first.peaksPath, path.join(dir, 'take.wav.peaks'));
  assert.equal(first.headerPath, path.join(dir, 'take.wav.peaks.json'));
  const data = await readPeaks(first.peaksPath);
  assert.equal(data.length, first.header.blocks * first.header.channels * 2);
  const onDisk = JSON.parse(await fs.readFile(first.headerPath, 'utf8'));
  assert.deepEqual(onDisk, first.header);
  assert.equal((await fs.stat(first.peaksPath)).mode & 0o777, 0o644);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['take.wav', 'take.wav.peaks', 'take.wav.peaks.json']);

  const second = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(second.generated, false);
  assert.equal(counter.generations, 1);
  assert.deepEqual(second.header, first.header);
});

test('ensurePeaks regenerates when the source mtime changes', { skip: tools }, async () => {
  const dir = await freshDir('stale');
  const file = await copyAudio(monoWav, dir, 'clip.wav');
  const { service, counter } = makeService();

  const first = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(first.generated, true);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(file, later, later);
  const second = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(second.generated, true);
  assert.equal(counter.generations, 2);
  assert.equal(second.header.source.mtimeMs, Math.round((await fs.stat(file)).mtimeMs));
  assert.notEqual(second.header.source.mtimeMs, first.header.source.mtimeMs);

  const third = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(third.generated, false);
});

test('ensurePeaks regenerates when the block size differs', { skip: tools }, async () => {
  const dir = await freshDir('blocksize');
  const file = await copyAudio(monoWav, dir, 'clip.wav');
  const a = makeService({ blockSize: 1152 });
  const b = makeService({ blockSize: 2304 });
  await a.service.ensurePeaks({ filePath: file, candidates: [dir] });
  const out = await b.service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(out.generated, true);
  assert.equal(out.header.blockSize, 2304);
});

test('ensurePeaks: a truncated peaks file is not trusted', { skip: tools }, async () => {
  const dir = await freshDir('truncated');
  const file = await copyAudio(monoWav, dir, 'clip.wav');
  const { service, counter } = makeService();
  const first = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  await fs.truncate(first.peaksPath, 10);
  const again = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(again.generated, true);
  assert.equal(counter.generations, 2);
});

test('ensurePeaks falls back to the next candidate when the first is read-only', { skip: tools || isRoot }, async () => {
  const roDir = await freshDir('readonly');
  const file = await copyAudio(monoWav, roDir, 'clip.wav');
  const destRoot = await freshDir('dest');
  const second = path.join(destRoot, 'peaks', 'abc'); // does not exist yet: created for non-first candidates
  const cache = await freshDir('cache');
  await fs.chmod(roDir, 0o555);
  try {
    const { service, counter } = makeService({ cachePath: cache });
    const out = await service.ensurePeaks({ filePath: file, candidates: [roDir, second] });
    assert.equal(out.generated, true);
    assert.equal(out.location, 1);
    assert.equal(out.kind, 'destination');
    assert.equal(out.dir, second);
    assert.deepEqual((await fs.readdir(second)).sort(), ['clip.wav.peaks', 'clip.wav.peaks.json']);
    assert.deepEqual((await fs.readdir(roDir)).sort(), ['clip.wav']);

    // A later lookup finds it in the second candidate without regenerating.
    const again = await service.ensurePeaks({ filePath: file, candidates: [roDir, second] });
    assert.equal(again.generated, false);
    assert.equal(again.location, 1);
    assert.equal(counter.generations, 1);

    // The first candidate becomes writable: the sidecar is copied forward.
    await fs.chmod(roDir, 0o755);
    const forward = await service.ensurePeaks({ filePath: file, candidates: [roDir, second] });
    assert.equal(forward.generated, false);
    assert.equal(forward.location, 0);
    assert.equal(forward.kind, 'beside');
    assert.equal(counter.generations, 1);
    assert.deepEqual((await fs.readdir(roDir)).sort(), ['clip.wav', 'clip.wav.peaks', 'clip.wav.peaks.json']);
    assert.deepEqual(await fs.readFile(path.join(roDir, 'clip.wav.peaks')), await fs.readFile(path.join(second, 'clip.wav.peaks')));
  } finally {
    await fs.chmod(roDir, 0o755);
  }
});

test('ensurePeaks uses cachePath last when every other candidate is unusable', { skip: tools || isRoot }, async () => {
  const roDir = await freshDir('readonly-only');
  const file = await copyAudio(monoWav, roDir, 'clip.wav');
  const cache = path.join(await freshDir('cache-parent'), 'peaks-cache');
  await fs.chmod(roDir, 0o555);
  try {
    const { service } = makeService({ cachePath: cache });
    const out = await service.ensurePeaks({ filePath: file, candidates: [roDir] });
    assert.equal(out.kind, 'cache');
    assert.equal(out.dir, cache);
    assert.equal(out.location, 1);
  } finally {
    await fs.chmod(roDir, 0o755);
  }
});

test('ensurePeaks reports peaks_unavailable when no candidate is writable', { skip: tools || isRoot }, async () => {
  const roDir = await freshDir('readonly-none');
  const file = await copyAudio(monoWav, roDir, 'clip.wav');
  await fs.chmod(roDir, 0o555);
  try {
    const { service } = makeService();
    await assert.rejects(service.ensurePeaks({ filePath: file, candidates: [roDir] }), (e) => e.code === 'peaks_unavailable');
  } finally {
    await fs.chmod(roDir, 0o755);
  }
});

test('ensurePeaks dedupes concurrent generations for one file', { skip: tools }, async () => {
  const dir = await freshDir('dedupe');
  const file = await copyAudio(burstWav, dir, 'take.wav');
  const { service, counter } = makeService();
  const [a, b, c] = await Promise.all([
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
  ]);
  assert.equal(counter.generations, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  // After settling, a fresh call does not hit the in-flight map and finds the sidecar.
  const d = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(d.generated, false);
  assert.equal(counter.generations, 1);
});

test('ensurePeaks counts ffmpeg spawns through the spawn hook', { skip: tools }, async () => {
  const dir = await freshDir('spawns');
  const file = await copyAudio(monoWav, dir, 'clip.wav');
  const { spawn } = require('node:child_process');
  const spawned = [];
  const service = createPeaksService({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    generate: (options) => generatePeaks({
      ...options,
      spawn: (command, args, spawnOptions) => {
        spawned.push(path.basename(command));
        return spawn(command, args, spawnOptions);
      },
    }),
  });
  await Promise.all([
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
  ]);
  assert.deepEqual(spawned.sort(), ['ffmpeg', 'ffprobe']);
});

test('ensurePeaks: failed generation is not cached and the in-flight entry clears', { skip: tools }, async () => {
  const dir = await freshDir('failure');
  const bad = path.join(dir, 'bad.wav');
  await fs.writeFile(bad, 'not audio at all');
  const { service } = makeService();
  await assert.rejects(service.ensurePeaks({ filePath: bad, candidates: [dir] }), (e) => e.code === 'peaks_unavailable');
  await assert.rejects(service.ensurePeaks({ filePath: bad, candidates: [dir] }), (e) => e.code === 'peaks_unavailable');
  assert.deepEqual(await fs.readdir(dir), ['bad.wav']);
});
