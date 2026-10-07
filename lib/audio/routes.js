'use strict';

/**
 * Audio info and peaks routes for the marker viewer.
 *
 * registerAudioRoutes(app, deps) registers exactly:
 *   GET /api/audio/:repo/*   JSON info (generates peaks when missing)
 *   GET /api/peaks/:repo/*   raw uint16 LE peaks, or the JSON header with ?header=1
 *
 * deps (all supplied by the integration layer):
 *   resolveAudioFile(req, repo, relPath)  sync or async. Handles access control, unknown
 *     repo, non-audio extension and missing file. Returns
 *     { ok: true, absPath, extension, mimeType } or { ok: false, status, code, message }.
 *   peaksCandidates(repo, relPath, absPath)  ordered directories to look for and write the
 *     sidecar: the audio's own directory first, destination peaks directories next, the
 *     cache directory last.
 *   peaksService  object with ensurePeaks({ filePath, candidates }) (lib/audio/peaks.js).
 *   apiError(res, status, code, message, details?)  the lib/api-error.js shape.
 *   buildViewHref(repo, relPath), buildAssetHref(repo, relPath)  from lib/path-utils.js.
 *   readPeaks(peaksPath)  optional; defaults to lib/audio/peaks.js readPeaks.
 *
 * Responses never contain an absolute path.
 */

const { peaksHeaderToHttpHeaders, readPeaks: defaultReadPeaks } = require('./peaks');

function encodeSegment(segment) {
  return encodeURIComponent(segment);
}

function buildApiHref(kind, repo, relPath) {
  const rel = String(relPath).split('/').filter(Boolean).map(encodeSegment).join('/');
  return `/api/${kind}/${encodeSegment(repo)}/${rel}`;
}

function weakEtag(header) {
  return `W/"${header.source.sha256}"`;
}

function etagMatches(req, etag) {
  const raw = req.headers['if-none-match'];
  if (!raw) return false;
  return String(raw).split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
}

function registerAudioRoutes(app, deps) {
  const {
    resolveAudioFile, peaksCandidates, peaksService, apiError, buildViewHref, buildAssetHref,
  } = deps;
  const readPeaks = deps.readPeaks || defaultReadPeaks;

  async function resolve(req, res) {
    const repo = req.params.repo;
    const relPath = req.params[0] || '';
    const resolved = await resolveAudioFile(req, repo, relPath);
    if (!resolved || !resolved.ok) {
      const failure = resolved || {};
      apiError(res, failure.status || 404, failure.code || 'not_found', failure.message || 'Audio file not found.');
      return null;
    }
    return { repo, relPath, resolved };
  }

  async function ensure(res, repo, relPath, resolved) {
    try {
      return await peaksService.ensurePeaks({
        filePath: resolved.absPath,
        candidates: peaksCandidates(repo, relPath, resolved.absPath),
      });
    } catch {
      apiError(res, 503, 'peaks_unavailable', 'Waveform peaks could not be generated for this audio file.');
      return null;
    }
  }

  app.get('/api/audio/:repo/*', async (req, res, next) => {
    try {
      const ctx = await resolve(req, res);
      if (!ctx) return;
      const { repo, relPath, resolved } = ctx;
      const peaks = await ensure(res, repo, relPath, resolved);
      if (!peaks) return;
      const { header } = peaks;
      res.json({
        ok: true,
        repo,
        path: relPath,
        viewUrl: buildViewHref(repo, relPath),
        assetUrl: buildAssetHref(repo, relPath),
        peaksUrl: buildApiHref('peaks', repo, relPath),
        infoUrl: buildApiHref('audio', repo, relPath),
        sampleRate: header.sampleRate,
        channels: header.channels,
        frames: header.frames,
        durationSeconds: header.frames / header.sampleRate,
        sha256: header.source.sha256,
        blockSize: header.blockSize,
        blocks: header.blocks,
        peakMode: header.peakMode,
        sidecar: { location: peaks.kind },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/peaks/:repo/*', async (req, res, next) => {
    try {
      const ctx = await resolve(req, res);
      if (!ctx) return;
      const { repo, relPath, resolved } = ctx;
      const peaks = await ensure(res, repo, relPath, resolved);
      if (!peaks) return;
      const { header } = peaks;
      const etag = weakEtag(header);
      res.set('Cache-Control', 'no-cache');
      res.set('ETag', etag);
      if (req.query.header === '1') {
        res.json(header);
        return;
      }
      res.set(peaksHeaderToHttpHeaders(header));
      if (etagMatches(req, etag)) {
        res.status(304).end();
        return;
      }
      let data;
      try {
        data = await readPeaks(peaks.peaksPath);
      } catch {
        apiError(res, 503, 'peaks_unavailable', 'Waveform peaks could not be read for this audio file.');
        return;
      }
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', String(data.length));
      res.end(data);
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerAudioRoutes };
