'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
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
  EXTENSION_DEMUXERS,
  PeaksError,
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

// ---- hardening: argv, limits, write order, read-only candidates ----

const PROBE_JSON = JSON.stringify({ streams: [{ sample_rate: '8000', channels: 1, codec_name: 'pcm_s16le' }] });

function fakeChild({ stdout = null, exitCode = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal;
    return true;
  };
  if (!hang) {
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', exitCode);
    });
  }
  return child;
}

// Fake ffprobe/ffmpeg: records every call; the decoder emits 4 mono frames, or hangs.
function fakeSpawn({ hangProbe = false, hangDecode = false } = {}) {
  const calls = [];
  const children = [];
  const spawn = (command, args) => {
    const probe = path.basename(command) === 'ffprobe';
    const child = probe
      ? fakeChild({ stdout: Buffer.from(PROBE_JSON), hang: hangProbe })
      : fakeChild({ stdout: s16Buffer([[1], [2], [3], [-4]]), hang: hangDecode });
    calls.push({ command, args, probe });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

async function tinyAudio(name, bytes = 'RIFF-not-real') {
  const dir = await freshDir('tiny');
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { dir, file };
}

test('demuxer table maps every supported extension', () => {
  assert.deepEqual({ ...EXTENSION_DEMUXERS }, {
    '.wav': 'wav', '.mp3': 'mp3', '.flac': 'flac', '.ogg': 'ogg', '.oga': 'ogg', '.opus': 'ogg',
    '.m4a': 'mov', '.aac': 'aac', '.aif': 'aiff', '.aiff': 'aiff',
  });
  assert.ok(Object.isFrozen(EXTENSION_DEMUXERS));
});

test('ffmpeg and ffprobe argv: protocol whitelist and the demuxer forced before -i', async () => {
  const { file } = await tinyAudio('Clip.WAV');
  const fake = fakeSpawn();
  const out = await generatePeaks({ filePath: file, spawn: fake.spawn, blockSize: 2 });
  assert.equal(out.header.frames, 4);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    const { args } = call;
    const wl = args.indexOf('-protocol_whitelist');
    assert.ok(wl >= 0 && args[wl + 1] === 'file,pipe', `${call.command} whitelist`);
    const input = args.indexOf('-i');
    const fmt = args.indexOf('-f');
    assert.ok(fmt >= 0 && fmt < input, `${call.command} -f before -i`);
    assert.equal(args[fmt + 1], 'wav');
    assert.ok(wl < input, 'whitelist before -i');
    assert.equal(args[input + 1], file);
  }
});

test('each supported extension picks its demuxer', async () => {
  for (const [ext, demuxer] of Object.entries(EXTENSION_DEMUXERS)) {
    const { file } = await tinyAudio(`song${ext}`);
    const fake = fakeSpawn();
    await generatePeaks({ filePath: file, spawn: fake.spawn });
    const decode = fake.calls.find((c) => !c.probe).args;
    assert.equal(decode[decode.indexOf('-f') + 1], demuxer, ext);
  }
});

test('an unknown extension is refused before anything is spawned', async () => {
  for (const name of ['clip.xyz', 'noext', 'playlist.m3u8', 'clip.wav.txt']) {
    const { file } = await tinyAudio(name);
    const fake = fakeSpawn();
    await assert.rejects(
      generatePeaks({ filePath: file, spawn: fake.spawn }),
      (e) => e instanceof PeaksError && e.code === 'peaks_unavailable' && !e.message.includes(name),
    );
    await assert.rejects(probeAudio({ filePath: file, spawn: fake.spawn }), (e) => e.code === 'peaks_unavailable');
    assert.equal(fake.calls.length, 0, name);
  }
});

test('a hanging decoder is killed at timeoutMs and rejects', async () => {
  const { file } = await tinyAudio('hang.wav');
  const fake = fakeSpawn({ hangDecode: true });
  const started = Date.now();
  await assert.rejects(
    generatePeaks({ filePath: file, spawn: fake.spawn, timeoutMs: 40 }),
    (e) => e.code === 'peaks_unavailable' && /timed out/.test(e.message) && !e.message.includes('hang.wav'),
  );
  assert.ok(Date.now() - started < 2000);
  const decoder = fake.children[1];
  assert.equal(decoder.killed, 'SIGKILL');
  assert.equal(fake.children[0].killed, null, 'the finished probe is left alone');
});

test('a hanging probe is killed at timeoutMs and the decoder never starts', async () => {
  const { file } = await tinyAudio('hang.wav');
  const fake = fakeSpawn({ hangProbe: true });
  await assert.rejects(
    generatePeaks({ filePath: file, spawn: fake.spawn, timeoutMs: 40 }),
    (e) => e.code === 'peaks_unavailable' && /timed out/.test(e.message),
  );
  assert.equal(fake.children.length, 1);
  assert.equal(fake.children[0].killed, 'SIGKILL');
});

test('the service passes timeoutMs through and a timeout leaves no sidecars', async () => {
  const { dir, file } = await tinyAudio('hang.wav');
  const fake = fakeSpawn({ hangDecode: true });
  const service = createPeaksService({
    timeoutMs: 40,
    generate: (options) => generatePeaks({ ...options, spawn: fake.spawn }),
  });
  await assert.rejects(service.ensurePeaks({ filePath: file, candidates: [dir] }), (e) => e.code === 'peaks_unavailable');
  assert.deepEqual(await fs.readdir(dir), ['hang.wav']);
});

function slowGenerate(tracker, { delayMs = 40, failFor = null } = {}) {
  return async ({ filePath }) => {
    tracker.started.push(path.basename(filePath));
    tracker.inFlight += 1;
    tracker.max = Math.max(tracker.max, tracker.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failFor && path.basename(filePath) === failFor) throw new Error('boom');
      const stat = await fs.stat(filePath);
      return {
        header: {
          version: 1, sampleRate: 8000, channels: 1, blockSize: 1152, frames: 2, blocks: 1,
          peakMode: 'max-abs', source: { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: 'f'.repeat(64) },
        },
        peaks: new Uint16Array([7]),
      };
    } finally {
      tracker.inFlight -= 1;
    }
  };
}

async function threeFiles() {
  const dir = await freshDir('queue');
  const files = [];
  for (const name of ['a.wav', 'b.wav', 'c.wav']) {
    const file = path.join(dir, name);
    await fs.writeFile(file, name);
    files.push(file);
  }
  return { dir, files };
}

test('concurrency cap: never more than 2 generations in flight, FIFO order', async () => {
  const { dir, files } = await threeFiles();
  const tracker = { inFlight: 0, max: 0, started: [] };
  const service = createPeaksService({ generate: slowGenerate(tracker) });
  const results = await Promise.all(files.map((filePath) => service.ensurePeaks({ filePath, candidates: [dir] })));
  assert.equal(tracker.max, 2);
  assert.deepEqual(tracker.started, ['a.wav', 'b.wav', 'c.wav']);
  assert.ok(results.every((r) => r.generated === true));
});

test('maxConcurrent: 1 serialises, and a failed generation frees its slot', async () => {
  const { dir, files } = await threeFiles();
  const tracker = { inFlight: 0, max: 0, started: [] };
  const service = createPeaksService({ maxConcurrent: 1, generate: slowGenerate(tracker, { delayMs: 15, failFor: 'a.wav' }) });
  const settled = await Promise.allSettled(files.map((filePath) => service.ensurePeaks({ filePath, candidates: [dir] })));
  assert.equal(tracker.max, 1);
  assert.deepEqual(settled.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(settled[0].reason.code, 'peaks_unavailable');
});

test('size cap: an oversize source is refused before generation', async () => {
  const { dir, file } = await tinyAudio('big.wav', Buffer.alloc(100));
  let generations = 0;
  const service = createPeaksService({
    maxAudioBytes: 99,
    generate: async () => { generations += 1; throw new Error('should not run'); },
  });
  await assert.rejects(
    service.ensurePeaks({ filePath: file, candidates: [dir] }),
    (e) => e instanceof PeaksError && e.code === 'audio_too_large' && !e.message.includes('big.wav'),
  );
  assert.equal(generations, 0);
  assert.deepEqual(await fs.readdir(dir), ['big.wav']);

  // exactly at the cap is allowed
  const atCap = createPeaksService({ maxAudioBytes: 100, generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }) });
  const out = await atCap.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(out.generated, true);
});

test('write order: peaks land before the header, and the header never shows without its peaks', async () => {
  const { dir, file } = await tinyAudio('order.wav');
  const seen = [];
  const service = createPeaksService({
    generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }),
    beforeHeaderWrite: async ({ dir: where }) => {
      seen.push((await fs.readdir(where)).filter((n) => n.startsWith('order.wav.')).sort());
    },
  });
  const out = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.deepEqual(seen, [['order.wav.peaks']], 'only the peaks file exists when the header is about to be written');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['order.wav', 'order.wav.peaks', 'order.wav.peaks.json']);
  assert.equal((await fs.readFile(out.peaksPath)).length, out.header.blocks * out.header.channels * 2);
});

test('a crash between the two writes leaves no orphan header and no temp files', async () => {
  const { dir, file } = await tinyAudio('crash.wav');
  let crash = true;
  const service = createPeaksService({
    generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }),
    beforeHeaderWrite: async () => {
      if (crash) throw new Error('simulated crash');
    },
  });
  await assert.rejects(service.ensurePeaks({ filePath: file, candidates: [dir] }), (e) => e.code === 'peaks_unavailable' || /simulated/.test(e.message));
  const names = await fs.readdir(dir);
  assert.ok(!names.some((n) => n.endsWith('.peaks.json')), 'no header');
  assert.ok(!names.some((n) => n.endsWith('.tmp')), 'no temp files');

  // A lone peaks file (hard crash before cleanup) is never trusted: the next call regenerates.
  await fs.writeFile(path.join(dir, 'crash.wav.peaks'), Buffer.alloc(2));
  crash = false;
  const again = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(again.generated, true);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['crash.wav', 'crash.wav.peaks', 'crash.wav.peaks.json']);
});

test('a peaks file whose length disagrees with the header is stale', async () => {
  const { dir, file } = await tinyAudio('stale.wav');
  let generations = 0;
  const inner = slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 });
  const service = createPeaksService({ generate: (o) => { generations += 1; return inner(o); } });
  const first = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  await fs.appendFile(first.peaksPath, Buffer.alloc(2)); // one value too long
  const second = await service.ensurePeaks({ filePath: file, candidates: [dir] });
  assert.equal(second.generated, true);
  assert.equal(generations, 2);
  assert.equal((await fs.stat(second.peaksPath)).size, second.header.blocks * second.header.channels * 2);
});

test('a readOnly candidate object is searched but never written, even when its directory is writable', async () => {
  const { dir, file } = await tinyAudio('ro.wav');
  const cache = path.join(await freshDir('ro-cache-parent'), 'cache');
  const service = createPeaksService({
    cachePath: cache,
    generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }),
  });
  const out = await service.ensurePeaks({ filePath: file, candidates: [{ dir, readOnly: true }] });
  assert.equal(out.generated, true);
  assert.equal(out.kind, 'cache');
  assert.equal(out.dir, cache);
  assert.equal(out.location, 1);
  assert.deepEqual(await fs.readdir(dir), ['ro.wav'], 'nothing written into the readOnly directory');

  // Lookup in a readOnly location still works: seed one with a writable service, then read it.
  const seed = createPeaksService({ generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }) });
  const { dir: dir2, file: file2 } = await tinyAudio('seeded.wav');
  await seed.ensurePeaks({ filePath: file2, candidates: [dir2] });
  let generations = 0;
  const reader = createPeaksService({ cachePath: cache, generate: async () => { generations += 1; throw new Error('no'); } });
  const found = await reader.ensurePeaks({ filePath: file2, candidates: [{ dir: dir2, readOnly: true }] });
  assert.equal(found.generated, false);
  assert.equal(found.location, 0);
  assert.equal(found.kind, 'beside');
  assert.equal(generations, 0);
});

test('every candidate readOnly and no cache: no writable location', async () => {
  const { dir, file } = await tinyAudio('ro-only.wav');
  const service = createPeaksService({ generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }) });
  await assert.rejects(
    service.ensurePeaks({ filePath: file, candidates: [{ dir, readOnly: true }] }),
    (e) => e.code === 'peaks_unavailable',
  );
  assert.deepEqual(await fs.readdir(dir), ['ro-only.wav']);
});

test('string and object candidates mix, and a readOnly flag falls through to the next entry', async () => {
  const { dir, file } = await tinyAudio('mix.wav');
  const dest = path.join(await freshDir('mix-dest'), 'peaks');
  const service = createPeaksService({ generate: slowGenerate({ inFlight: 0, max: 0, started: [] }, { delayMs: 1 }) });
  const out = await service.ensurePeaks({ filePath: file, candidates: [{ dir, readOnly: true }, dest, null, { nodir: true }] });
  assert.equal(out.location, 1);
  assert.equal(out.kind, 'destination');
  assert.equal(out.dir, dest);
});

const ENCODERS = {
  '.flac': ['-c:a', 'flac'],
  '.mp3': ['-c:a', 'libmp3lame'],
  '.m4a': ['-c:a', 'aac'],
  '.aac': ['-c:a', 'aac'],
  '.ogg': ['-c:a', 'libvorbis'],
  '.opus': ['-c:a', 'libopus'],
  '.aiff': ['-c:a', 'pcm_s16be'],
};

test('forced demuxers decode real files of each supported format', { skip: tools }, async () => {
  const dir = await freshDir('formats');
  let checked = 0;
  for (const [ext, codecArgs] of Object.entries(ENCODERS)) {
    const file = path.join(dir, `tone${ext}`);
    try {
      execFileSync(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', monoWav, ...codecArgs, file], { stdio: 'ignore' });
    } catch {
      continue; // encoder not built in on this host
    }
    const { header } = await generatePeaks({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, filePath: file });
    assert.equal(header.channels, 1, ext);
    assert.ok(header.frames >= 44100 - 5000 && header.frames <= 48000 + 5000, `${ext} frames ${header.frames}`);
    checked += 1;
  }
  assert.ok(checked >= 3, `only ${checked} formats could be encoded`);
});
