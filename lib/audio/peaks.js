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

class PeaksError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PeaksError';
    this.code = 'peaks_unavailable';
  }
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

function runCapture(spawnFn, command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new PeaksError('audio tool could not be started', { cause: error }));
      return;
    }
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.resume();
    child.on('error', (error) => reject(new PeaksError('audio tool could not be started', { cause: error })));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new PeaksError(`audio probe failed (exit ${code})`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** ffprobe the first audio stream: { sampleRate, channels, codec, durationTs }. */
async function probeAudio({ ffprobePath = 'ffprobe', filePath, spawn: spawnFn = spawn }) {
  const text = await runCapture(spawnFn, ffprobePath, [
    '-v', 'error', '-show_streams', '-select_streams', 'a:0', '-of', 'json', filePath,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(text);
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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function decodeToReducer(spawnFn, ffmpegPath, filePath, reducer) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, [
        '-nostdin', '-v', 'error', '-i', filePath,
        '-map', '0:a:0', '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new PeaksError('audio decoder could not be started', { cause: error }));
      return;
    }
    let failure = null;
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      try {
        reducer.push(chunk);
      } catch (error) {
        failure = failure || error;
      }
    });
    child.on('error', (error) => reject(new PeaksError('audio decoder could not be started', { cause: error })));
    child.on('close', (code) => {
      if (failure) {
        reject(new PeaksError('audio decode failed', { cause: failure }));
      } else if (code !== 0) {
        reject(new PeaksError(`audio decode failed (exit ${code})`));
      } else {
        resolve();
      }
    });
  });
}

function sameStat(a, b) {
  return a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}

/**
 * Decode `filePath` with ffmpeg at native rate and channels and reduce it.
 * Returns { header, peaks } where header is the sidecar JSON object.
 */
async function generatePeaks({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  filePath,
  blockSize = DEFAULT_BLOCK_SIZE,
  peakMode,
  spawn: spawnFn = spawn,
}) {
  const mode = normalizePeakMode(peakMode);
  let before;
  try {
    before = await fsp.stat(filePath);
  } catch (error) {
    throw new PeaksError('audio file is not readable', { cause: error });
  }
  const probe = await probeAudio({ ffprobePath, filePath, spawn: spawnFn });
  const reducer = reducePcmS16({ channels: probe.channels, blockSize, peakMode: mode });
  const sha = hashFile(filePath);
  sha.catch(() => {}); // observed below; avoid an unhandled rejection if decode fails first
  try {
    await decodeToReducer(spawnFn, ffmpegPath, filePath, reducer);
  } catch (error) {
    await sha.catch(() => {});
    throw error;
  }
  let sha256;
  try {
    sha256 = await sha;
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

async function writeSidecar(dir, baseName, header, peaksData, { makeDir }) {
  if (makeDir) await fsp.mkdir(dir, { recursive: true });
  const { peaksPath, headerPath } = sidecarPaths(dir, baseName);
  await writeDurable(peaksPath, peaksData);
  try {
    await writeDurable(headerPath, Buffer.from(JSON.stringify(header)));
  } catch (error) {
    await fsp.rm(peaksPath, { force: true }).catch(() => {});
    throw error;
  }
  return { peaksPath, headerPath };
}

function createPeaksService({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  blockSize = DEFAULT_BLOCK_SIZE,
  peakMode,
  cachePath,
  logger,
  generate = generatePeaks,
} = {}) {
  const mode = normalizePeakMode(peakMode);
  const inFlight = new Map();

  function locationKind(index, dir) {
    if (cachePath && path.resolve(dir) === path.resolve(cachePath)) return 'cache';
    return index === 0 ? 'beside' : 'destination';
  }

  function listDirs(candidates) {
    const dirs = [];
    for (const dir of candidates || []) {
      if (typeof dir === 'string' && dir) dirs.push(path.resolve(dir));
    }
    if (cachePath && !dirs.includes(path.resolve(cachePath))) dirs.push(path.resolve(cachePath));
    return dirs;
  }

  async function writeFirstWritable(dirs, upTo, baseName, header, data) {
    let lastError = null;
    for (let i = 0; i < upTo; i += 1) {
      try {
        const written = await writeSidecar(dirs[i], baseName, header, data, { makeDir: i > 0 });
        return { index: i, ...written };
      } catch (error) {
        if (!WRITE_FALLTHROUGH_CODES.has(error && error.code)) throw error;
        lastError = error;
      }
    }
    return { index: -1, error: lastError };
  }

  function result(dirs, index, found, header, generated) {
    return {
      header,
      peaksPath: found.peaksPath,
      headerPath: found.headerPath,
      dir: dirs[index],
      location: index,
      kind: locationKind(index, dirs[index]),
      generated,
    };
  }

  async function run(filePath, candidates) {
    const baseName = path.basename(filePath);
    if (!baseName) throw new PeaksError('audio file name is empty');
    const dirs = listDirs(candidates);
    if (!dirs.length) throw new PeaksError('no peaks location is configured');
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      throw new PeaksError('audio file is not readable', { cause: error });
    }

    for (let i = 0; i < dirs.length; i += 1) {
      const found = await readHeaderIfCurrent(dirs[i], baseName, stat, blockSize);
      if (!found) continue;
      if (i > 0) {
        // An earlier location may have become writable since: copy forward.
        try {
          const data = await fsp.readFile(found.peaksPath);
          const copied = await writeFirstWritable(dirs, i, baseName, found.header, data);
          if (copied.index >= 0) return result(dirs, copied.index, copied, found.header, false);
        } catch (error) {
          if (logger && logger.warn) logger.warn(`peaks copy-forward skipped: ${error.code || error.message}`);
        }
      }
      return result(dirs, i, found, found.header, false);
    }

    let generatedResult;
    try {
      generatedResult = await generate({ ffmpegPath, ffprobePath, filePath, blockSize, peakMode: mode });
    } catch (error) {
      if (error instanceof PeaksError) throw error;
      throw new PeaksError('peaks generation failed', { cause: error });
    }
    const data = peaksBuffer(generatedResult.peaks);
    const written = await writeFirstWritable(dirs, dirs.length, baseName, generatedResult.header, data);
    if (written.index < 0) {
      throw new PeaksError('no writable peaks location', { cause: written.error || undefined });
    }
    return result(dirs, written.index, written, generatedResult.header, true);
  }

  /**
   * candidates: ordered directories, the audio's own directory first, cachePath last.
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
  PeaksError,
  reducePcmS16,
  probeAudio,
  generatePeaks,
  createPeaksService,
  readPeaks,
  peaksHeaderToHttpHeaders,
};
