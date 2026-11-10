'use strict';

// Waveform peaks sidecars for the audio marker viewer.
//
// A sidecar is a pair beside (or cached for) an audio file:
//   <basename>.peaks       raw little-endian uint16[], index = block * channels + channel
//   <basename>.peaks.json  header describing the array and the source it came from
// The array layout matches a Rivendell ExportPeaks array (1152-frame blocks, values
// 0..32767). Peaks are produced with ffmpeg decoding to native-rate s16 PCM.

const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BLOCK_SIZE = 1152;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_AUDIO_BYTES = 2147483648;

/**
 * File extension -> ffmpeg/ffprobe demuxer. The demuxer is forced with `-f` so the tool never
 * probes content to pick a (possibly exotic) format, and only these formats are decoded.
 */
const EXTENSION_DEMUXERS = Object.freeze({
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.m4a': 'mov',
  '.aac': 'aac',
  '.aif': 'aiff',
  '.aiff': 'aiff',
});
const PROTOCOL_WHITELIST = 'file,pipe';
const VALUE_MAX = 32767;
const PEAK_MODES = new Set(['max-abs', 'max-positive']);
const WRITE_FALLTHROUGH_CODES = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EDQUOT', 'ENOSPC']);

const PACKAGE_VERSION = (() => {
  try {
    return require('../../package.json').version || '0';
  } catch {
    return '0';
  }
})();

/**
 * Every failure of the peaks service. `code` is 'peaks_unavailable' unless options.code says
 * otherwise (e.g. 'audio_too_large'); messages never name a path.
 */
class PeaksError extends Error {
  constructor(message, options) {
    const { code, ...rest } = options || {};
    super(message, Object.keys(rest).length ? rest : undefined);
    this.name = 'PeaksError';
    this.code = code || 'peaks_unavailable';
  }
}

function demuxerFor(filePath) {
  const demuxer = EXTENSION_DEMUXERS[path.extname(String(filePath)).toLowerCase()];
  if (!demuxer) throw new PeaksError('audio format is not supported');
  return demuxer;
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePeakMode(peakMode) {
  const mode = peakMode || 'max-abs';
  if (!PEAK_MODES.has(mode)) {
    throw new TypeError(`unsupported peakMode: ${mode}`);
  }
  return mode;
}

/**
 * Streaming per-block per-channel peak reducer over interleaved s16le PCM.
 * push() accepts buffers that split a sample or a frame anywhere.
 */
function reducePcmS16({ channels, blockSize = DEFAULT_BLOCK_SIZE, peakMode } = {}) {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new TypeError('channels must be a positive integer');
  }
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new TypeError('blockSize must be a positive integer');
  }
  const positiveOnly = normalizePeakMode(peakMode) === 'max-positive';
  const frameBytes = channels * 2;

  let out = new Uint16Array(Math.max(channels * 256, 256));
  let used = 0; // values written to `out`
  const current = new Uint16Array(channels);
  let inBlock = 0;
  let frames = 0;
  let carry = null;
  let finished = false;

  function flushBlock() {
    if (used + channels > out.length) {
      const grown = new Uint16Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    for (let c = 0; c < channels; c += 1) {
      out[used + c] = current[c];
      current[c] = 0;
    }
    used += channels;
    inBlock = 0;
  }

  function push(buffer) {
    if (finished) {
      throw new Error('reducer already finished');
    }
    let buf = buffer;
    if (carry && carry.length) {
      buf = Buffer.concat([carry, buffer]);
      carry = null;
    }
    const wholeFrames = Math.floor(buf.length / frameBytes);
    const usable = wholeFrames * frameBytes;
    let offset = 0;
    for (let i = 0; i < wholeFrames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const s = buf.readInt16LE(offset);
        offset += 2;
        let v;
        if (positiveOnly) {
          v = s > 0 ? s : 0;
        } else {
          v = s < 0 ? -s : s;
          if (v > VALUE_MAX) v = VALUE_MAX;
        }
        if (v > current[c]) current[c] = v;
      }
      frames += 1;
      inBlock += 1;
      if (inBlock === blockSize) flushBlock();
    }
    carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
  }

  function finish() {
    if (!finished) {
      finished = true;
      if (inBlock > 0) flushBlock(); // keep the final partial block
    }
    return { frames, blocks: used / channels, peaks: out.slice(0, used) };
  }

  return { push, finish };
}

/**
 * Run one child process under a timeout. `onData` receives stdout chunks; throwing from it
 * fails the run and kills the child. Resolves on exit 0, otherwise rejects with a PeaksError
 * (never naming a path). On timeout the child is killed and the promise rejects at once.
 */
function runProcess(spawnFn, command, args, { timeoutMs, label, onData }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let failure = null;
    let child = null;

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    function kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }

    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(new PeaksError(`${label} could not be started`, { cause: error }));
      return;
    }
    timer = setTimeout(() => {
      kill();
      finish(new PeaksError(`${label} timed out`));
    }, timeoutMs);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (settled || failure) return;
      try {
        onData(chunk);
      } catch (error) {
        failure = error;
        kill();
      }
    });
    child.on('error', (error) => finish(new PeaksError(`${label} could not be started`, { cause: error })));
    child.on('close', (code) => {
      if (failure) finish(new PeaksError(`${label} failed`, { cause: failure }));
      else if (code !== 0) finish(new PeaksError(`${label} failed (exit ${code})`));
      else finish();
    });
  });
}

/** ffprobe the first audio stream: { sampleRate, channels, codec, durationTs }. */
async function probeAudio({
  ffprobePath = 'ffprobe', filePath, spawn: spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const demuxer = demuxerFor(filePath);
  const chunks = [];
  await runProcess(spawnFn, ffprobePath, [
    '-v', 'error', '-protocol_whitelist', PROTOCOL_WHITELIST, '-f', demuxer,
    '-show_streams', '-select_streams', 'a:0', '-of', 'json', '-i', filePath,
  ], { timeoutMs: positiveOr(timeoutMs, DEFAULT_TIMEOUT_MS), label: 'audio probe', onData: (d) => chunks.push(d) });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new PeaksError('audio probe returned unreadable output', { cause: error });
  }
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  if (!stream) {
    throw new PeaksError('no audio stream found');
  }
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || !Number.isInteger(channels) || channels < 1) {
    throw new PeaksError('audio stream has no usable rate or channel count');
  }
  const durationTs = stream.duration_ts === undefined ? null : Number(stream.duration_ts);
  return { sampleRate, channels, codec: stream.codec_name || null, durationTs };
}

/** Stream-hash a file. Returns { promise, abort }; abort() stops reading and rejects. */
function hashFile(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  const promise = new Promise((resolve, reject) => {
    stream
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
      .on('close', () => reject(new Error('hash aborted')));
  });
  promise.catch(() => {}); // observed by the caller; avoid an unhandled rejection
  return { promise, abort: () => stream.destroy() };
}

function decodeToReducer(spawnFn, ffmpegPath, filePath, demuxer, reducer, timeoutMs) {
  return runProcess(spawnFn, ffmpegPath, [
    '-nostdin', '-v', 'error', '-protocol_whitelist', PROTOCOL_WHITELIST, '-f', demuxer, '-i', filePath,
    '-map', '0:a:0', '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ], { timeoutMs, label: 'audio decode', onData: (chunk) => reducer.push(chunk) });
}

function sameStat(a, b) {
  return a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}

/**
 * Decode `filePath` with ffmpeg at native rate and channels and reduce it.
 * The demuxer is forced from the file extension (EXTENSION_DEMUXERS) and only file/pipe
 * protocols are allowed; an unknown extension is refused before anything is spawned. Each
 * child process is killed after `timeoutMs`.
 * Returns { header, peaks } where header is the sidecar JSON object.
 */
async function generatePeaks({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  filePath,
  blockSize = DEFAULT_BLOCK_SIZE,
  peakMode,
  spawn: spawnFn = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const mode = normalizePeakMode(peakMode);
  const demuxer = demuxerFor(filePath);
  const limit = positiveOr(timeoutMs, DEFAULT_TIMEOUT_MS);
  let before;
  try {
    before = await fsp.stat(filePath);
  } catch (error) {
    throw new PeaksError('audio file is not readable', { cause: error });
  }
  const probe = await probeAudio({ ffprobePath, filePath, spawn: spawnFn, timeoutMs: limit });
  const reducer = reducePcmS16({ channels: probe.channels, blockSize, peakMode: mode });
  const sha = hashFile(filePath);
  try {
    await decodeToReducer(spawnFn, ffmpegPath, filePath, demuxer, reducer, limit);
  } catch (error) {
    sha.abort();
    throw error;
  }
  let sha256;
  try {
    sha256 = await sha.promise;
  } catch (error) {
    throw new PeaksError('audio file is not readable', { cause: error });
  }
  const after = await fsp.stat(filePath).catch(() => null);
  if (!after || !sameStat(before, after)) {
    throw new PeaksError('audio file changed while peaks were generated');
  }
  const { frames, blocks, peaks } = reducer.finish();
  const header = {
    version: 1,
    format: 'rivendell-levl-u16le',
    layout: 'block-major-channel-interleaved',
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    blockSize,
    frames,
    blocks,
    peakMode: mode,
    valueMax: VALUE_MAX,
    source: { size: before.size, mtimeMs: Math.round(before.mtimeMs), sha256 },
    generator: `lookie-link/${PACKAGE_VERSION} ffmpeg`,
  };
  return { header, peaks };
}

function peaksHeaderToHttpHeaders(header) {
  return {
    'X-Peaks-Sample-Rate': String(header.sampleRate),
    'X-Peaks-Channels': String(header.channels),
    'X-Peaks-Block-Size': String(header.blockSize),
    'X-Peaks-Frames': String(header.frames),
    'X-Peaks-Blocks': String(header.blocks),
    'X-Peaks-Peak-Mode': String(header.peakMode),
    'X-Peaks-Source-Sha256': String(header.source && header.source.sha256),
  };
}

function peaksBuffer(peaks) {
  const buf = Buffer.alloc(peaks.length * 2);
  for (let i = 0; i < peaks.length; i += 1) buf.writeUInt16LE(peaks[i], i * 2);
  return buf;
}

async function writeDurable(finalPath, data) {
  const dir = path.dirname(finalPath);
  const tmp = path.join(dir, `.${path.basename(finalPath)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o644);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(tmp, 0o644);
    await fsp.rename(tmp, finalPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function sidecarPaths(dir, baseName) {
  return {
    peaksPath: path.join(dir, `${baseName}.peaks`),
    headerPath: path.join(dir, `${baseName}.peaks.json`),
  };
}

async function readHeaderIfCurrent(dir, baseName, stat, blockSize) {
  const { peaksPath, headerPath } = sidecarPaths(dir, baseName);
  let header;
  try {
    header = JSON.parse(await fsp.readFile(headerPath, 'utf8'));
  } catch {
    return null;
  }
  if (!header || header.version !== 1 || !header.source) return null;
  if (header.source.size !== stat.size || header.source.mtimeMs !== Math.round(stat.mtimeMs)) return null;
  if (header.blockSize !== blockSize) return null;
  if (!Number.isInteger(header.channels) || !Number.isInteger(header.blocks)) return null;
  try {
    const peaksStat = await fsp.stat(peaksPath);
    if (peaksStat.size !== header.blocks * header.channels * 2) return null;
  } catch {
    return null;
  }
  return { header, peaksPath, headerPath };
}

// Write order is fixed: the peaks array first, the header second, each by temp file + rename.
// The header is the commit record, so it is never visible without its peaks file; a crash
// between the two leaves only an unreferenced .peaks file, which readers ignore.
async function writeSidecar(dir, baseName, header, peaksData, { makeDir, beforeHeaderWrite }) {
  if (makeDir) await fsp.mkdir(dir, { recursive: true });
  const { peaksPath, headerPath } = sidecarPaths(dir, baseName);
  await writeDurable(peaksPath, peaksData);
  try {
    if (beforeHeaderWrite) await beforeHeaderWrite({ dir, peaksPath, headerPath });
    await writeDurable(headerPath, Buffer.from(JSON.stringify(header)));
  } catch (error) {
    await fsp.rm(peaksPath, { force: true }).catch(() => {});
    throw error;
  }
  return { peaksPath, headerPath };
}

/** FIFO counting semaphore: at most `limit` holders; waiters are released in arrival order. */
function createGate(limit) {
  let active = 0;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
  async function run(task) {
    if (active < limit) {
      active += 1;
    } else {
      await new Promise((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      release();
    }
  }
  return { run };
}

/**
 * Create the peaks service.
 *
 * Options:
 *   ffmpegPath, ffprobePath, blockSize, peakMode  passed to generation
 *   cachePath        last-resort writable directory, always appended to the candidates
 *   timeoutMs        kill a probe or decode child after this long (default 120000)
 *   maxConcurrent    generations running at once, others wait FIFO (default 2)
 *   maxAudioBytes    larger sources are refused with code 'audio_too_large' before any
 *                    probing (default 2147483648)
 *   generate         replaceable generator (tests)
 *   beforeHeaderWrite  async hook run after the peaks file is written and before the header;
 *                    test seam for crash simulation
 */
function createPeaksService({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  blockSize = DEFAULT_BLOCK_SIZE,
  peakMode,
  cachePath,
  logger,
  generate = generatePeaks,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  beforeHeaderWrite,
} = {}) {
  const mode = normalizePeakMode(peakMode);
  const inFlight = new Map();
  const gate = createGate(Math.max(1, Math.floor(positiveOr(maxConcurrent, DEFAULT_MAX_CONCURRENT))));
  const sizeLimit = positiveOr(maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES);
  const generationTimeout = positiveOr(timeoutMs, DEFAULT_TIMEOUT_MS);

  function locationKind(index, dir) {
    if (cachePath && path.resolve(dir) === path.resolve(cachePath)) return 'cache';
    return index === 0 ? 'beside' : 'destination';
  }

  // Accepts strings and { dir, readOnly } objects; returns [{ dir, readOnly }].
  function listDirs(candidates) {
    const entries = [];
    for (const candidate of candidates || []) {
      const dir = candidate && typeof candidate === 'object' ? candidate.dir : candidate;
      if (typeof dir !== 'string' || !dir) continue;
      entries.push({ dir: path.resolve(dir), readOnly: Boolean(candidate && candidate.readOnly) });
    }
    if (cachePath && !entries.some((entry) => entry.dir === path.resolve(cachePath))) {
      entries.push({ dir: path.resolve(cachePath), readOnly: false });
    }
    return entries;
  }

  async function writeFirstWritable(entries, upTo, baseName, header, data) {
    let lastError = null;
    for (let i = 0; i < upTo; i += 1) {
      if (entries[i].readOnly) continue; // lookup only; never written to
      try {
        const written = await writeSidecar(entries[i].dir, baseName, header, data, {
          makeDir: i > 0, beforeHeaderWrite,
        });
        return { index: i, ...written };
      } catch (error) {
        if (!WRITE_FALLTHROUGH_CODES.has(error && error.code)) throw error;
        lastError = error;
      }
    }
    return { index: -1, error: lastError };
  }

  function result(entries, index, found, header, generated) {
    return {
      header,
      peaksPath: found.peaksPath,
      headerPath: found.headerPath,
      dir: entries[index].dir,
      location: index,
      kind: locationKind(index, entries[index].dir),
      generated,
    };
  }

  async function generateQueued(filePath) {
    return gate.run(async () => {
      try {
        return await generate({
          ffmpegPath, ffprobePath, filePath, blockSize, peakMode: mode, timeoutMs: generationTimeout,
        });
      } catch (error) {
        if (error instanceof PeaksError) throw error;
        throw new PeaksError('peaks generation failed', { cause: error });
      }
    });
  }

  async function run(filePath, candidates) {
    const baseName = path.basename(filePath);
    if (!baseName) throw new PeaksError('audio file name is empty');
    const entries = listDirs(candidates);
    if (!entries.length) throw new PeaksError('no peaks location is configured');
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      throw new PeaksError('audio file is not readable', { cause: error });
    }

    for (let i = 0; i < entries.length; i += 1) {
      const found = await readHeaderIfCurrent(entries[i].dir, baseName, stat, blockSize);
      if (!found) continue;
      if (i > 0) {
        // An earlier location may have become writable since: copy forward.
        try {
          const data = await fsp.readFile(found.peaksPath);
          const copied = await writeFirstWritable(entries, i, baseName, found.header, data);
          if (copied.index >= 0) return result(entries, copied.index, copied, found.header, false);
        } catch (error) {
          if (logger && logger.warn) logger.warn(`peaks copy-forward skipped: ${error.code || error.message}`);
        }
      }
      return result(entries, i, found, found.header, false);
    }

    if (stat.size > sizeLimit) {
      throw new PeaksError('audio file is too large to analyze', { code: 'audio_too_large' });
    }
    const generatedResult = await generateQueued(filePath);
    const data = peaksBuffer(generatedResult.peaks);
    const written = await writeFirstWritable(entries, entries.length, baseName, generatedResult.header, data);
    if (written.index < 0) {
      throw new PeaksError('no writable peaks location', { cause: written.error || undefined });
    }
    return result(entries, written.index, written, generatedResult.header, true);
  }

  /**
   * candidates: ordered locations, the audio's own directory first, cachePath appended last.
   * Each is a directory string or { dir, readOnly }. A readOnly location is searched for an
   * existing sidecar but never written to. The service does not test the filesystem to decide
   * what is "beside the audio": integration passes the audio directory first, marked
   * `{ dir, readOnly: true }` for audio roots (which are read-only by contract), and a
   * plain string when sidecars may be written beside the audio.
   * Only path.basename(filePath) is used to name sidecars.
   */
  function ensurePeaks({ filePath, candidates }) {
    const key = path.resolve(filePath);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run(key, candidates).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return { ensurePeaks };
}

function readPeaks(peaksPath) {
  return fsp.readFile(peaksPath);
}

module.exports = {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_AUDIO_BYTES,
  EXTENSION_DEMUXERS,
  PeaksError,
  reducePcmS16,
  probeAudio,
  generatePeaks,
  createPeaksService,
  readPeaks,
  peaksHeaderToHttpHeaders,
};
