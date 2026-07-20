#!/usr/bin/env node
'use strict';

// lookie-annotations — agent-facing shim for Lookie-Link sidecar annotations.
//
// See ../docs/AGENT-SHIM.md for the full contract.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BASE_URL = process.env.LOOKIE_LINK_BASE_URL || 'http://localhost:9876';

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_FORBIDDEN = 4;
const EXIT_TRANSPORT = 5;

const SUPPORTED_STATES = new Set(['open', 'claimed', 'resolved']);
const SUPPORTED_KINDS = new Set(['heading', 'yamlKey', 'lineRange']);
const SUBCOMMANDS = new Set(['list', 'get', 'add', 'claim', 'resolve', 'replies']);

const TOP_HELP = [
  'Usage: lookie-annotations <command> <repo>/<path> [options]',
  '',
  'Commands:',
  '  list <repo>/<path> [--state STATE]...      Read all annotations',
  '  get <repo>/<path> <id>                     Read one annotation',
  '  add <repo>/<path> --anchor A --kind K      Create an annotation',
  '                    --body BODY [--author X]',
  '  claim <repo>/<path> <id> [--by AGENT]      Mark annotation claimed',
  '  resolve <repo>/<path> <id>                 Mark annotation resolved',
  '  replies <repo>/<path> <id>                 List replies on annotation',
  '  replies <repo>/<path> <id> --add BODY      Append a reply',
  '',
  'Common options:',
  '  --base-url URL       Lookie-Link base URL (env: LOOKIE_LINK_BASE_URL)',
  '  --pretty             Human-readable output (default: JSON)',
  '  --json-errors        Errors as JSON to stdout (default: text to stderr)',
  '  --body STRING        Inline body. Use "-" to read from stdin',
  '  --body-file PATH     Read body from a file',
  '  --author NAME        Author/agent name (default: $LOOKIE_LINK_AUTHOR or "lookie-annotations")',
  '  -h, --help           This help',
  '  -v, --version        Print version',
  '',
  'Env:',
  '  LOOKIE_LINK_BASE_URL  Base URL (default http://localhost:9876)',
  '  LOOKIE_LINK_TOKEN     Bearer token forwarded to the server',
  '  LOOKIE_LINK_AUTHOR    Default author/agent name',
  '',
  'Exit codes: 0 success, 2 usage, 3 not found, 4 forbidden, 5 transport/5xx',
].join('\n');

const SUBCOMMAND_HELP = {
  list: 'Usage: lookie-annotations list <repo>/<path> [--state STATE]...',
  get: 'Usage: lookie-annotations get <repo>/<path> <id>',
  add: 'Usage: lookie-annotations add <repo>/<path> --anchor A --kind heading|yamlKey|lineRange --body BODY [--author NAME]',
  claim: 'Usage: lookie-annotations claim <repo>/<path> <id> [--by AGENT]',
  resolve: 'Usage: lookie-annotations resolve <repo>/<path> <id>',
  replies: 'Usage: lookie-annotations replies <repo>/<path> <id> [--add BODY] [--author NAME]',
};

const errorState = {
  jsonErrors: false,
};

function die(code, message) {
  if (message) {
    if (errorState.jsonErrors) {
      process.stdout.write(`${JSON.stringify({ error: message, code })}\n`);
    } else {
      process.stderr.write(`lookie-annotations: ${message}\n`);
    }
  }
  process.exit(code);
}

function printVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    process.stdout.write(`lookie-annotations ${pkg.version}\n`);
  } catch {
    process.stdout.write('lookie-annotations (unknown version)\n');
  }
  process.exit(EXIT_OK);
}

function expandHomeAndStripLeading(input) {
  let s = String(input || '').trim();
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

function buildHeaders(extra) {
  const headers = { Accept: 'application/json' };
  if (process.env.LOOKIE_LINK_TOKEN) {
    headers.Authorization = `Bearer ${process.env.LOOKIE_LINK_TOKEN}`;
  }
  return Object.assign(headers, extra || {});
}

function buildAnnotationsUrl(baseUrl, repo, relativePath, states) {
  const segments = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  let url = `${baseUrl}/api/annotations/${encodeURIComponent(repo)}/${segments}`;
  if (states && states.length) {
    const qs = states.map((s) => `state=${encodeURIComponent(s)}`).join('&');
    url += `?${qs}`;
  }
  return url;
}

function mapHttpFailure(res, label) {
  if (res.status === 404) die(EXIT_NOT_FOUND, `not found (${label}): HTTP 404`);
  if (res.status === 401 || res.status === 403) die(EXIT_FORBIDDEN, `forbidden (${label}): HTTP ${res.status}`);
  if (res.status === 400) die(EXIT_USAGE, `bad request (${label}): HTTP 400`);
  die(EXIT_TRANSPORT, `HTTP ${res.status} (${label})`);
}

async function httpJson(method, url, body, label) {
  const init = { method, headers: buildHeaders(body ? { 'Content-Type': 'application/json' } : null) };
  if (body) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    die(EXIT_TRANSPORT, `${label} fetch failed: ${err.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Body may be empty / non-JSON; we'll surface as transport below.
  }
  if (!res.ok) {
    if (res.status === 409) {
      return { status: 409, body: json };
    }
    mapHttpFailure(res, label);
  }
  return { status: res.status, body: json };
}

async function readBody(opts) {
  if (opts.body !== null && opts.body !== undefined) {
    if (opts.body === '-') {
      return readStdin();
    }
    return opts.body;
  }
  if (opts.bodyFile) {
    try {
      return await fsp.readFile(opts.bodyFile, 'utf8');
    } catch (err) {
      die(EXIT_USAGE, `--body-file: ${err.message}`);
    }
  }
  return null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    pretty: false,
    jsonErrors: false,
    states: [],
    anchor: null,
    kind: null,
    body: null,
    bodyFile: null,
    author: process.env.LOOKIE_LINK_AUTHOR || 'lookie-annotations',
    by: null,
    addReply: false,
    positional: [],
  };

  let subcommand = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help': {
        const stream = process.stdout;
        if (subcommand && SUBCOMMAND_HELP[subcommand]) {
          stream.write(`${SUBCOMMAND_HELP[subcommand]}\n`);
        } else {
          stream.write(`${TOP_HELP}\n`);
        }
        process.exit(EXIT_OK);
        break;
      }
      case '-v':
      case '--version':
        printVersion();
        break;
      case '--base-url':
        opts.baseUrl = argv[++i];
        if (!opts.baseUrl) die(EXIT_USAGE, '--base-url requires a value');
        break;
      case '--pretty':
        opts.pretty = true;
        break;
      case '--json-errors':
        opts.jsonErrors = true;
        errorState.jsonErrors = true;
        break;
      case '--state': {
        const value = argv[++i];
        if (!value) die(EXIT_USAGE, '--state requires a value');
        if (!SUPPORTED_STATES.has(value)) {
          die(EXIT_USAGE, `--state must be one of open|claimed|resolved (got ${value})`);
        }
        opts.states.push(value);
        break;
      }
      case '--anchor':
        opts.anchor = argv[++i];
        if (!opts.anchor) die(EXIT_USAGE, '--anchor requires a value');
        break;
      case '--kind':
        opts.kind = argv[++i];
        if (!opts.kind) die(EXIT_USAGE, '--kind requires a value');
        if (!SUPPORTED_KINDS.has(opts.kind)) {
          die(EXIT_USAGE, `--kind must be heading|yamlKey|lineRange (got ${opts.kind})`);
        }
        break;
      case '--body':
        opts.body = argv[++i];
        if (opts.body === undefined) die(EXIT_USAGE, '--body requires a value');
        break;
      case '--body-file':
        opts.bodyFile = argv[++i];
        if (!opts.bodyFile) die(EXIT_USAGE, '--body-file requires a value');
        break;
      case '--author':
        opts.author = argv[++i];
        if (!opts.author) die(EXIT_USAGE, '--author requires a value');
        break;
      case '--by':
        opts.by = argv[++i];
        if (!opts.by) die(EXIT_USAGE, '--by requires a value');
        break;
      case '--add':
        opts.addReply = true;
        opts.body = argv[++i];
        if (opts.body === undefined) die(EXIT_USAGE, '--add requires a body value');
        break;
      default:
        if (arg.startsWith('--')) die(EXIT_USAGE, `unknown option: ${arg}`);
        if (!subcommand) {
          if (!SUBCOMMANDS.has(arg)) {
            die(EXIT_USAGE, `unknown command: ${arg} (run --help for usage)`);
          }
          subcommand = arg;
        } else {
          opts.positional.push(arg);
        }
    }
  }

  return { subcommand, opts };
}

function emit(opts, payload) {
  if (opts.pretty) {
    process.stdout.write(`${formatPretty(payload)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

function formatAnnotation(a) {
  const lines = [];
  lines.push(`[${a.state}] ${a.id} by ${a.author} @ ${a.createdAt}`);
  lines.push(`  anchor: ${a.anchorKind} ${a.anchor}`);
  if (a.claimedBy) lines.push(`  claimed by ${a.claimedBy} @ ${a.claimedAt}`);
  if (a.resolvedAt) lines.push(`  resolved @ ${a.resolvedAt}`);
  lines.push('  body:');
  for (const bodyLine of String(a.body).split('\n')) {
    lines.push(`    ${bodyLine}`);
  }
  const replies = Array.isArray(a.replies) ? a.replies : [];
  if (replies.length) {
    lines.push(`  replies (${replies.length}):`);
    for (const reply of replies) {
      lines.push(`    - ${reply.author} @ ${reply.createdAt}`);
      for (const bodyLine of String(reply.body).split('\n')) {
        lines.push(`      ${bodyLine}`);
      }
    }
  } else {
    lines.push('  (no replies)');
  }
  return lines.join('\n');
}

function formatPretty(payload) {
  if (payload && Array.isArray(payload.annotations)) {
    if (payload.annotations.length === 0) {
      return `# ${payload.file}\n(no annotations)`;
    }
    const head = `# ${payload.file} (${payload.annotations.length})`;
    return [head, ...payload.annotations.map(formatAnnotation)].join('\n\n');
  }
  if (payload && payload.annotation) {
    return formatAnnotation(payload.annotation);
  }
  if (payload && Array.isArray(payload.replies)) {
    if (payload.replies.length === 0) return '(no replies)';
    return payload.replies
      .map((reply) => {
        const lines = [`- ${reply.author} @ ${reply.createdAt}`];
        for (const bodyLine of String(reply.body).split('\n')) {
          lines.push(`  ${bodyLine}`);
        }
        return lines.join('\n');
      })
      .join('\n');
  }
  return JSON.stringify(payload, null, 2);
}

function requireRepoPath(positional, subcommand) {
  if (positional.length === 0) {
    die(EXIT_USAGE, `${subcommand}: missing <repo>/<path>`);
  }
  const parsed = splitRepoPath(positional[0]);
  if (!parsed || !parsed.repo || !parsed.relativePath) {
    die(EXIT_USAGE, `${subcommand}: argument must be <repo>/<path>`);
  }
  return parsed;
}

async function fetchDocument(opts, repo, relativePath, states) {
  const url = buildAnnotationsUrl(opts.baseUrl, repo, relativePath, states);
  const { body } = await httpJson('GET', url, null, 'read annotations');
  if (!body || !Array.isArray(body.annotations)) {
    die(EXIT_TRANSPORT, 'malformed annotation response');
  }
  return body;
}

async function findAnnotationById(opts, repo, relativePath, id) {
  const doc = await fetchDocument(opts, repo, relativePath, []);
  const found = doc.annotations.find((a) => a && a.id === id);
  if (!found) die(EXIT_NOT_FOUND, `annotation not found: ${id}`);
  return found;
}

async function cmdList(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'list');
  const doc = await fetchDocument(opts, repo, relativePath, opts.states);
  emit(opts, doc);
}

async function cmdGet(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'get');
  const id = opts.positional[1];
  if (!id) die(EXIT_USAGE, 'get: missing <id>');
  const annotation = await findAnnotationById(opts, repo, relativePath, id);
  emit(opts, { ok: true, annotation });
}

async function cmdAdd(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'add');
  if (!opts.anchor) die(EXIT_USAGE, 'add: --anchor is required');
  if (!opts.kind) die(EXIT_USAGE, 'add: --kind is required');
  const body = await readBody(opts);
  if (body === null || !String(body).trim()) {
    die(EXIT_USAGE, 'add: --body, --body-file, or --body - is required');
  }
  const url = buildAnnotationsUrl(opts.baseUrl, repo, relativePath);
  const payload = {
    anchor: opts.anchor,
    anchorKind: opts.kind,
    body: String(body),
    author: opts.author,
  };
  const { body: response } = await httpJson('POST', url, payload, 'create annotation');
  emit(opts, response);
}

async function cmdClaim(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'claim');
  const id = opts.positional[1];
  if (!id) die(EXIT_USAGE, 'claim: missing <id>');
  const claimedBy = opts.by || opts.author;
  const url = buildAnnotationsUrl(opts.baseUrl, repo, relativePath);
  const { body: response } = await httpJson(
    'PATCH',
    url,
    { id, op: 'claim', payload: { claimedBy } },
    'claim annotation'
  );
  emit(opts, response);
}

async function cmdResolve(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'resolve');
  const id = opts.positional[1];
  if (!id) die(EXIT_USAGE, 'resolve: missing <id>');
  const url = buildAnnotationsUrl(opts.baseUrl, repo, relativePath);
  const { body: response } = await httpJson(
    'PATCH',
    url,
    { id, op: 'resolve', payload: {} },
    'resolve annotation'
  );
  emit(opts, response);
}

async function cmdReplies(opts) {
  const { repo, relativePath } = requireRepoPath(opts.positional, 'replies');
  const id = opts.positional[1];
  if (!id) die(EXIT_USAGE, 'replies: missing <id>');
  if (opts.addReply) {
    const body = await readBody(opts);
    if (body === null || !String(body).trim()) {
      die(EXIT_USAGE, 'replies --add: body is required');
    }
    const url = buildAnnotationsUrl(opts.baseUrl, repo, relativePath);
    const { body: response } = await httpJson(
      'PATCH',
      url,
      {
        id,
        op: 'reply',
        payload: { author: opts.author, body: String(body) },
      },
      'reply to annotation'
    );
    emit(opts, response);
    return;
  }
  const annotation = await findAnnotationById(opts, repo, relativePath, id);
  const replies = Array.isArray(annotation.replies) ? annotation.replies : [];
  emit(opts, { ok: true, id, file: `${repo}/${relativePath}`, replies });
}

async function main() {
  if (process.argv.length <= 2) {
    process.stderr.write(`${TOP_HELP}\n`);
    process.exit(EXIT_USAGE);
  }

  const { subcommand, opts } = parseArgs(process.argv.slice(2));
  if (!subcommand) {
    die(EXIT_USAGE, 'missing subcommand (run --help for usage)');
  }

  switch (subcommand) {
    case 'list':
      await cmdList(opts);
      return;
    case 'get':
      await cmdGet(opts);
      return;
    case 'add':
      await cmdAdd(opts);
      return;
    case 'claim':
      await cmdClaim(opts);
      return;
    case 'resolve':
      await cmdResolve(opts);
      return;
    case 'replies':
      await cmdReplies(opts);
      return;
    default:
      die(EXIT_USAGE, `unknown command: ${subcommand}`);
  }
}

main().catch((err) => {
  die(EXIT_TRANSPORT, err && err.message ? err.message : String(err));
});
