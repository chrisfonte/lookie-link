#!/usr/bin/env node
'use strict';

// lookie-read — agent-facing shim for fetching files from a Lookie-Link host.
//
// Usage:
//   lookie-read <repo>/<path>
//   lookie-read ~/repo/path
//   lookie-read --range 0-99 <repo>/<path>
//   lookie-read --list-repos
//
// See ../docs/AGENT-SHIM.md and the agent best-practices doc for the contract.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');

const DEFAULT_BASE_URL = process.env.LOOKIE_LINK_BASE_URL || 'http://mac-mini-2.bobcat-tetra.ts.net:9876';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'lookie-link');
const CACHE_FILE = path.join(CACHE_DIR, 'repos.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_FORBIDDEN = 4;
const EXIT_TRANSPORT = 5;

function die(code, message) {
  if (message) process.stderr.write(`lookie-read: ${message}\n`);
  process.exit(code);
}

function printUsage(stream = process.stdout) {
  stream.write(
    [
      'Usage: lookie-read [options] <repo>/<path>',
      '       lookie-read [options] ~/<repo>/<path>',
      '       lookie-read --list-repos',
      '',
      'Options:',
      '  --base-url URL      Lookie-Link base URL (env: LOOKIE_LINK_BASE_URL)',
      '  --range BYTES       HTTP Range header, e.g. "0-99" or "100-"',
      '  --no-local          Skip the local-filesystem fast path',
      '  --no-cache          Bypass and refresh the /api/repos manifest cache',
      '  --list-repos        Print the discovered repo manifest as JSON',
      '  -h, --help          This help',
      '  -v, --version       Print version',
      '',
      'Env:',
      '  LOOKIE_LINK_BASE_URL  Base URL (default http://mac-mini-2.bobcat-tetra.ts.net:9876)',
      '  LOOKIE_LINK_TOKEN     Bearer token forwarded to the server (optional)',
      '',
      'Exit codes:',
      '  0 success, 2 usage, 3 not found, 4 forbidden, 5 transport/5xx',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    range: null,
    noLocal: false,
    noCache: false,
    listRepos: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        printUsage();
        process.exit(EXIT_OK);
        break;
      case '-v':
      case '--version': {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          process.stdout.write(`lookie-read ${pkg.version}\n`);
        } catch {
          process.stdout.write('lookie-read (unknown version)\n');
        }
        process.exit(EXIT_OK);
        break;
      }
      case '--base-url':
        opts.baseUrl = argv[++i];
        if (!opts.baseUrl) die(EXIT_USAGE, '--base-url requires a value');
        break;
      case '--range':
        opts.range = argv[++i];
        if (!opts.range) die(EXIT_USAGE, '--range requires a value');
        break;
      case '--no-local':
        opts.noLocal = true;
        break;
      case '--no-cache':
        opts.noCache = true;
        break;
      case '--list-repos':
        opts.listRepos = true;
        break;
      default:
        if (arg.startsWith('--')) die(EXIT_USAGE, `unknown option: ${arg}`);
        opts.positional.push(arg);
    }
  }

  return opts;
}

function expandHomeAndStripLeading(input) {
  let s = input.trim();
  if (s.startsWith('~/')) s = s.slice(2);
  else if (s.startsWith('/')) s = s.replace(/^\/+/, '');
  return s.replace(/^\.\//, '');
}

function splitRepoPath(input) {
  const cleaned = expandHomeAndStripLeading(input);
  if (!cleaned) return null;
  const slash = cleaned.indexOf('/');
  if (slash < 0) return { repo: cleaned, relativePath: '' };
  return {
    repo: cleaned.slice(0, slash),
    relativePath: cleaned.slice(slash + 1),
  };
}

async function readCachedManifest() {
  try {
    const stat = await fsp.stat(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCachedManifest(manifest) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(CACHE_FILE, JSON.stringify(manifest), 'utf8');
  } catch {
    // Best-effort; manifest cache is non-essential.
  }
}

function buildHeaders() {
  const headers = { Accept: 'application/json,*/*;q=0.5' };
  if (process.env.LOOKIE_LINK_TOKEN) {
    headers.Authorization = `Bearer ${process.env.LOOKIE_LINK_TOKEN}`;
  }
  return headers;
}

async function fetchManifest(baseUrl) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/repos`, { headers: buildHeaders() });
  } catch (err) {
    die(EXIT_TRANSPORT, `discovery failed: ${err.message}`);
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 401) die(EXIT_FORBIDDEN, `discovery denied: HTTP ${res.status}`);
    die(EXIT_TRANSPORT, `discovery returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.repos)) die(EXIT_TRANSPORT, 'discovery response missing repos[]');
  return body;
}

async function getManifest(opts) {
  if (!opts.noCache) {
    const cached = await readCachedManifest();
    if (cached && cached.baseUrl === opts.baseUrl) return cached.manifest;
  }
  const manifest = await fetchManifest(opts.baseUrl);
  await writeCachedManifest({ baseUrl: opts.baseUrl, manifest, cachedAt: Date.now() });
  return manifest;
}

async function tryLocalRead(rootPath, relativePath) {
  if (!rootPath || !relativePath) return false;
  const absolute = path.resolve(rootPath, relativePath);
  const normalizedRoot = path.resolve(rootPath) + path.sep;
  if (absolute !== path.resolve(rootPath) && !absolute.startsWith(normalizedRoot)) {
    return false;
  }
  let realRoot;
  let realFile;
  try {
    realRoot = await fsp.realpath(rootPath);
  } catch {
    return false;
  }
  try {
    realFile = await fsp.realpath(absolute);
  } catch {
    return false;
  }
  const guard = realRoot + path.sep;
  if (realFile !== realRoot && !realFile.startsWith(guard)) return false;
  let stat;
  try {
    stat = await fsp.stat(realFile);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  await pipeline(fs.createReadStream(realFile), process.stdout);
  return true;
}

async function fetchAsset(baseUrl, repo, relativePath, range) {
  const url = `${baseUrl}/asset/${encodeURIComponent(repo)}/${relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  const headers = buildHeaders();
  if (range) headers.Range = `bytes=${range}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    die(EXIT_TRANSPORT, `fetch failed: ${err.message}`);
  }
  if (res.status === 404) die(EXIT_NOT_FOUND, `not found: ${repo}/${relativePath}`);
  if (res.status === 403 || res.status === 401) die(EXIT_FORBIDDEN, `forbidden: HTTP ${res.status}`);
  if (res.status === 415) die(EXIT_USAGE, `unsupported asset type for ${repo}/${relativePath}`);
  if (!res.ok && res.status !== 206) die(EXIT_TRANSPORT, `HTTP ${res.status}`);
  if (!res.body) die(EXIT_TRANSPORT, 'empty response body');
  // Web stream -> Node stream -> stdout
  const { Readable } = require('node:stream');
  await pipeline(Readable.fromWeb(res.body), process.stdout);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.listRepos) {
    const manifest = await getManifest(opts);
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return;
  }

  if (opts.positional.length === 0) {
    printUsage(process.stderr);
    die(EXIT_USAGE, 'missing <repo>/<path> argument');
  }

  let repo;
  let relativePath;
  if (opts.positional.length === 1) {
    const parsed = splitRepoPath(opts.positional[0]);
    if (!parsed || !parsed.repo || !parsed.relativePath) {
      die(EXIT_USAGE, 'argument must be <repo>/<path> (e.g. operations/README.md)');
    }
    repo = parsed.repo;
    relativePath = parsed.relativePath;
  } else if (opts.positional.length === 2) {
    repo = expandHomeAndStripLeading(opts.positional[0]);
    relativePath = expandHomeAndStripLeading(opts.positional[1]);
    if (!repo || !relativePath) die(EXIT_USAGE, 'repo and path must both be non-empty');
  } else {
    die(EXIT_USAGE, 'too many positional arguments');
  }

  const manifest = await getManifest(opts);
  const entry = manifest.repos.find((r) => r.repo === repo);
  if (!entry) die(EXIT_NOT_FOUND, `repo "${repo}" not served by ${opts.baseUrl} (run --list-repos to see options)`);

  if (!opts.noLocal && entry.rootPath) {
    const served = await tryLocalRead(entry.rootPath, relativePath);
    if (served) return;
  }

  await fetchAsset(opts.baseUrl, repo, relativePath, opts.range);
}

main().catch((err) => {
  die(EXIT_TRANSPORT, err && err.message ? err.message : String(err));
});
