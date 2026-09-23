#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  AUTH_PATH,
  normalizeBaseUrl,
  readAuthFile,
  readTokenFromStdin,
  resolveAuth,
  writeAuthFile,
} = require('../lib/cli-auth');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_AUTH = 3;
const EXIT_NOT_FOUND = 4;
const EXIT_CONFLICT = 5;
const EXIT_TRANSPORT = 6;

function redact(value, secrets = []) {
  let output = String(value == null ? '' : value);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret) continue;
    output = output.split(secret).join('[redacted]');
    try {
      output = output.split(encodeURIComponent(secret)).join('[redacted]');
    } catch {
      // The literal replacement above still protects malformed input.
    }
  }
  return output;
}

function die(code, message, secrets) {
  if (message) process.stderr.write(`lookie: ${redact(message, secrets)}\n`);
  process.exit(code);
}

function printVersion() {
  try {
    const pkg = require('../package.json');
    process.stdout.write(`lookie ${pkg.version}\n`);
  } catch {
    process.stdout.write('lookie (unknown version)\n');
  }
}

function printUsage(stream = process.stdout) {
  stream.write([
    'Usage: lookie [global-options] <command> [args]',
    '',
    'Global options:',
    '  --instance URL      Override the Lookie-Link base URL',
    '  --base-url URL      Alias for --instance',
    '  --json              Print JSON output where supported',
    '  -h, --help          Show help',
    '  -v, --version       Show version',
    '',
    'Commands:',
    '  auth login --instance URL [--token-stdin]',
    '  auth status',
    '  capabilities',
    '  whoami',
    '  repos',
    '  read <repo>/<path>',
    '  tree <repo> [--path REL] [--max-depth N]',
    '  changes <repo> --since (ISO_TIMESTAMP | UNIX_SECONDS)',
    '  write <repo>/<path> (--content TEXT | --content-file FILE | --content-from-stdin) [--expected-mtime N]',
    '  delete <repo>/<path> [--hard]',
    '  search <query> [--scope REPO]...',
    '  search suggest <query>',
    '  publish <file> [--slug SLUG] [--entry-path PATH] [--expected-revision N]',
    '  publish --manifest FILE [--slug SLUG] [--entry-path PATH] [--expected-revision N]',
    '  publish revoke <slug> --reason TEXT',
    '  annotations list <repo>/<path> [--state open|claimed|resolved]...',
    '  annotations get <repo>/<path> <id>',
    '  annotations add <repo>/<path> --anchor A --kind heading|yamlKey|lineRange (--body TEXT|- | --body-file FILE) [--author NAME]',
    '  annotations claim <repo>/<path> <id> [--by NAME]',
    '  annotations resolve <repo>/<path> <id>',
    '  annotations replies <repo>/<path> <id> [--add TEXT|- | --body-file FILE] [--author NAME]',
    '  trash restore <repo> <trashId>',
    '  trash remove <repo> <trashId>',
    '  appearance show [--theme SLUG]',
    '  appearance set --revision N [--blur N] [--panel N] [--theme-json JSON] | --json-file FILE',
    '  appearance upload <slug> <dark|light> --name ID <file>',
    '  appearance delete <slug> <dark|light> <id>',
    '  openapi',
    '  docs',
    '',
    'Tokens are accepted through auth login stdin or LOOKIE_LINK_TOKEN, never URL query parameters.',
    'Appearance writes use LOOKIE_LINK_ADMIN_TOKEN (falls back to LOOKIE_LINK_TOKEN).',
    `Auth file: ${AUTH_PATH}`,
    '',
  ].join('\n'));
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) die(EXIT_USAGE, `${name} requires a value`);
  return value;
}

function parseGlobalArgs(argv) {
  const options = { baseUrl: null, json: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(EXIT_OK);
    }
    if (arg === '-v' || arg === '--version') {
      printVersion();
      process.exit(EXIT_OK);
    }
    if (arg === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (arg === '--instance' || arg === '--base-url') {
      options.baseUrl = optionValue(argv, index, arg);
      index += 2;
      continue;
    }
    if (!arg.startsWith('-')) break;
    die(EXIT_USAGE, `unknown option: ${arg}`);
  }
  return { options, rest: argv.slice(index) };
}

function requireArgument(value, description) {
  if (!value || value.startsWith('--')) die(EXIT_USAGE, `missing ${description}`);
  return value;
}

function parseRepoPath(input) {
  const value = String(input || '').replace(/^\/+/, '').replace(/^~\//, '');
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) die(EXIT_USAGE, 'expected <repo>/<path>');
  return { repo: value.slice(0, slash), relativePath: value.slice(slash + 1) };
}

function encodePath(value) {
  return String(value).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function formatOutput(value, asJson) {
  if (asJson || typeof value !== 'string') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestUrl(baseUrl, targetPath) {
  return new URL(targetPath, `${baseUrl}/`).toString();
}

async function request(auth, targetPath, init = {}) {
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  try {
    return await fetch(requestUrl(auth.baseUrl, targetPath), { ...init, headers });
  } catch (error) {
    die(EXIT_TRANSPORT, error && error.message ? error.message : error, [auth.token]);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text };
  }
}

async function handleApiResponse(response, auth) {
  if (response.ok) return parseJsonResponse(response);
  const payload = await parseJsonResponse(response);
  const serverError = payload && payload.error;
  const serverMessage = serverError && typeof serverError === 'object' ? serverError.message : serverError;
  const message = payload && (serverMessage || payload.message)
    ? serverMessage || payload.message
    : `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) die(EXIT_AUTH, message, [auth.token]);
  if (response.status === 404) die(EXIT_NOT_FOUND, message, [auth.token]);
  if (response.status === 409) die(EXIT_CONFLICT, message, [auth.token]);
  die(EXIT_TRANSPORT, message, [auth.token]);
}

async function capabilitiesCommand(auth) {
  const discovery = await request(auth, '/.well-known/agent.json');
  if (discovery.status !== 404) {
    formatOutput(await handleApiResponse(discovery, auth), true);
    return;
  }

  const whoami = await request(auth, '/api/whoami');
  const identity = await handleApiResponse(whoami, auth);
  formatOutput({
    name: 'lookie-link',
    capabilities: identity && identity.capabilities ? identity.capabilities : {},
    source: '/api/whoami',
  }, true);
}

async function readCommand(auth, target, outputJson) {
  const { repo, relativePath } = parseRepoPath(target);
  const managed = await request(auth, `/api/managed-repos/${encodeURIComponent(repo)}/files/${encodePath(relativePath)}`);
  if (managed.ok) {
    const payload = await parseJsonResponse(managed);
    formatOutput(outputJson ? payload : payload.content, outputJson);
    return;
  }
  if (managed.status !== 404) await handleApiResponse(managed, auth);

  const asset = await request(auth, `/asset/${encodeURIComponent(repo)}/${encodePath(relativePath)}`, {
    headers: { Accept: '*/*' },
  });
  if (!asset.ok) await handleApiResponse(asset, auth);
  const content = await asset.text();
  formatOutput(outputJson ? { ok: true, repo, path: relativePath, content, source: 'asset' } : content, outputJson);
}

async function writeCommand(auth, target, args) {
  const { repo, relativePath } = parseRepoPath(target);
  let content;
  let contentSource = null;
  let expectedMtimeMs;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--content') {
      if (contentSource) die(EXIT_USAGE, 'choose exactly one content source');
      content = optionValue(args, index, arg);
      contentSource = arg;
      index += 1;
    } else if (arg === '--content-file') {
      if (contentSource) die(EXIT_USAGE, 'choose exactly one content source');
      content = await fs.readFile(optionValue(args, index, arg), 'utf8');
      contentSource = arg;
      index += 1;
    } else if (arg === '--content-from-stdin') {
      if (contentSource) die(EXIT_USAGE, 'choose exactly one content source');
      content = await readAllStdin();
      contentSource = arg;
    } else if (arg === '--expected-mtime') {
      expectedMtimeMs = Number(optionValue(args, index, arg));
      if (!Number.isFinite(expectedMtimeMs)) die(EXIT_USAGE, '--expected-mtime must be a number');
      index += 1;
    } else {
      die(EXIT_USAGE, `unknown write option: ${arg}`);
    }
  }
  if (!contentSource) die(EXIT_USAGE, 'write requires --content, --content-file, or --content-from-stdin');
  const body = { content };
  if (expectedMtimeMs !== undefined) body.expectedMtimeMs = expectedMtimeMs;
  const response = await request(auth, `/api/managed-repos/${encodeURIComponent(repo)}/files/${encodePath(relativePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  formatOutput(await handleApiResponse(response, auth), true);
}

async function deleteCommand(auth, target, args) {
  for (const arg of args) if (arg !== '--hard') die(EXIT_USAGE, `unknown delete option: ${arg}`);
  const { repo, relativePath } = parseRepoPath(target);
  const query = args.includes('--hard') ? '?hard=1' : '';
  const response = await request(auth, `/api/managed-repos/${encodeURIComponent(repo)}/files/${encodePath(relativePath)}${query}`, {
    method: 'DELETE',
  });
  formatOutput(await handleApiResponse(response, auth), true);
}

async function treeCommand(auth, repo, args) {
  const query = new URLSearchParams();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--path') {
      query.set('path', optionValue(args, index, arg));
      index += 1;
    } else if (arg === '--max-depth') {
      query.set('maxDepth', optionValue(args, index, arg));
      index += 1;
    } else {
      die(EXIT_USAGE, `unknown tree option: ${arg}`);
    }
  }
  const suffix = query.size ? `?${query}` : '';
  const response = await request(auth, `/api/managed-repos/${encodeURIComponent(repo)}/tree${suffix}`);
  formatOutput(await handleApiResponse(response, auth), true);
}

// The server filters on entry mtimeMs, so --since is sent in milliseconds.
// Accept an ISO-8601 timestamp or Unix seconds (13+ digit values are taken as ms already).
function sinceToMs(value) {
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return /^\d{13,}/.test(text) ? numeric : Math.round(numeric * 1000);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) die(EXIT_USAGE, '--since must be an ISO-8601 timestamp or Unix seconds');
  return parsed;
}

async function changesCommand(auth, repo, args) {
  let since;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--since') die(EXIT_USAGE, `unknown changes option: ${args[index]}`);
    since = optionValue(args, index, '--since');
    index += 1;
  }
  if (!since) die(EXIT_USAGE, 'changes requires --since (ISO_TIMESTAMP | UNIX_SECONDS)');
  const query = new URLSearchParams({ since: String(sinceToMs(since)) });
  const response = await request(auth, `/api/managed-repos/${encodeURIComponent(repo)}/changes?${query}`);
  formatOutput(await handleApiResponse(response, auth), true);
}

async function searchCommand(auth, args) {
  if (!args.length) die(EXIT_USAGE, 'search requires a query');
  if (args[0] === 'suggest') {
    const queryText = requireArgument(args[1], 'suggest query');
    if (args.length > 2) die(EXIT_USAGE, `unknown search suggest option: ${args[2]}`);
    const response = await request(auth, `/api/search/suggest?${new URLSearchParams({ q: queryText })}`);
    formatOutput(await handleApiResponse(response, auth), true);
    return;
  }
  const query = new URLSearchParams({ q: args[0] });
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--scope') die(EXIT_USAGE, `unknown search option: ${args[index]}`);
    query.append('scope', optionValue(args, index, '--scope'));
    index += 1;
  }
  const response = await request(auth, `/api/search?${query}`);
  formatOutput(await handleApiResponse(response, auth), true);
}

async function buildPublishPayload(args) {
  let sourceFile;
  let manifestPath;
  let slug;
  let entryPath;
  let expectedRevision;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--') && !sourceFile) {
      sourceFile = arg;
    } else if (arg === '--manifest') {
      manifestPath = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--slug') {
      slug = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--entry-path') {
      entryPath = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--expected-revision') {
      expectedRevision = Number(optionValue(args, index, arg));
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        die(EXIT_USAGE, '--expected-revision must be a positive integer');
      }
      index += 1;
    } else {
      die(EXIT_USAGE, `unknown publish option: ${arg}`);
    }
  }
  if (sourceFile && manifestPath) die(EXIT_USAGE, 'publish accepts either a source file or --manifest');
  let payload;
  if (manifestPath) {
    payload = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } else {
    if (!sourceFile) die(EXIT_USAGE, 'publish requires a source file or --manifest');
    const content = await fs.readFile(sourceFile);
    const publishPath = entryPath || path.basename(sourceFile);
    payload = { entryPath: publishPath, files: [{ path: publishPath, content: content.toString('base64'), encoding: 'base64' }] };
  }
  if (slug) payload.slug = slug;
  if (entryPath) payload.entryPath = entryPath;
  if (expectedRevision !== undefined) payload.expectedRevision = expectedRevision;
  return payload;
}

async function publishCommand(auth, args) {
  if (args[0] === 'revoke') {
    const slug = requireArgument(args[1], 'publish slug');
    let reason;
    for (let index = 2; index < args.length; index += 1) {
      if (args[index] !== '--reason') die(EXIT_USAGE, `unknown publish revoke option: ${args[index]}`);
      reason = optionValue(args, index, '--reason');
      index += 1;
    }
    if (!reason) die(EXIT_USAGE, 'publish revoke requires --reason');
    const response = await request(auth, `/api/publish/${encodeURIComponent(slug)}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    formatOutput(await handleApiResponse(response, auth), true);
    return;
  }
  const payload = await buildPublishPayload(args);
  const slug = payload.slug;
  const endpoint = slug && payload.expectedRevision !== undefined
    ? `/api/publish/${encodeURIComponent(slug)}`
    : '/api/publish';
  if (endpoint !== '/api/publish') delete payload.slug;
  const response = await request(auth, endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  formatOutput(await handleApiResponse(response, auth), true);
}

const ANNOTATION_STATES = ['open', 'claimed', 'resolved'];
const ANNOTATION_KINDS = ['heading', 'yamlKey', 'lineRange'];

async function annotationBody(opts) {
  if (opts.bodyFile) return fs.readFile(opts.bodyFile, 'utf8');
  if (opts.body === '-') return readAllStdin();
  return opts.body === undefined ? null : opts.body;
}

function parseAnnotationArgs(args) {
  const opts = { positional: [], states: [], author: process.env.LOOKIE_LINK_AUTHOR || 'lookie' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const takes = (key) => { opts[key] = optionValue(args, index, arg); index += 1; };
    if (arg === '--state') {
      const value = optionValue(args, index, arg);
      if (!ANNOTATION_STATES.includes(value)) die(EXIT_USAGE, `--state must be one of ${ANNOTATION_STATES.join('|')}`);
      opts.states.push(value);
      index += 1;
    } else if (arg === '--kind') {
      takes('kind');
      if (!ANNOTATION_KINDS.includes(opts.kind)) die(EXIT_USAGE, `--kind must be ${ANNOTATION_KINDS.join('|')}`);
    } else if (arg === '--body' || arg === '--add') {
      if (args[index + 1] === undefined) die(EXIT_USAGE, `${arg} requires a value`);
      opts.body = args[index + 1];
      if (arg === '--add') opts.addReply = true;
      index += 1;
    } else if (arg === '--anchor') takes('anchor');
    else if (arg === '--body-file') takes('bodyFile');
    else if (arg === '--author') takes('author');
    else if (arg === '--by') takes('by');
    else if (arg.startsWith('--')) die(EXIT_USAGE, `unknown annotations option: ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

async function annotationsCommand(auth, args) {
  const sub = args[0];
  if (!['list', 'get', 'add', 'claim', 'resolve', 'replies'].includes(sub)) {
    die(EXIT_USAGE, 'annotations requires list, get, add, claim, resolve, or replies');
  }
  const opts = parseAnnotationArgs(args.slice(1));
  const { repo, relativePath } = parseRepoPath(requireArgument(opts.positional[0], 'repo/path'));
  const route = `/api/annotations/${encodeURIComponent(repo)}/${encodePath(relativePath)}`;
  const id = opts.positional[1];
  if (sub !== 'list' && sub !== 'add' && !id) die(EXIT_USAGE, `annotations ${sub}: missing <id>`);
  const send = async (method, body) => handleApiResponse(await request(auth, route, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), auth);
  const fetchDoc = async (states) => {
    const query = new URLSearchParams();
    for (const state of states) query.append('state', state);
    const doc = await handleApiResponse(await request(auth, query.size ? `${route}?${query}` : route), auth);
    if (!doc || !Array.isArray(doc.annotations)) die(EXIT_TRANSPORT, 'malformed annotation response');
    return doc;
  };
  const findById = async () => {
    const found = (await fetchDoc([])).annotations.find((item) => item && item.id === id);
    if (!found) die(EXIT_NOT_FOUND, `annotation not found: ${id}`);
    return found;
  };

  if (sub === 'list') return formatOutput(await fetchDoc(opts.states), true);
  if (sub === 'get') return formatOutput({ ok: true, annotation: await findById() }, true);
  if (sub === 'add') {
    if (!opts.anchor) die(EXIT_USAGE, 'annotations add: --anchor is required');
    if (!opts.kind) die(EXIT_USAGE, 'annotations add: --kind is required');
    const body = await annotationBody(opts);
    if (body === null || !String(body).trim()) die(EXIT_USAGE, 'annotations add: --body, --body-file, or --body - is required');
    return formatOutput(await send('POST', { anchor: opts.anchor, anchorKind: opts.kind, body: String(body), author: opts.author }), true);
  }
  if (sub === 'claim') return formatOutput(await send('PATCH', { id, op: 'claim', payload: { claimedBy: opts.by || opts.author } }), true);
  if (sub === 'resolve') return formatOutput(await send('PATCH', { id, op: 'resolve', payload: {} }), true);
  if (opts.addReply || opts.bodyFile) {
    const body = await annotationBody(opts);
    if (body === null || !String(body).trim()) die(EXIT_USAGE, 'annotations replies --add: body is required');
    return formatOutput(await send('PATCH', { id, op: 'reply', payload: { author: opts.author, body: String(body) } }), true);
  }
  const annotation = await findById();
  return formatOutput({ ok: true, id, file: `${repo}/${relativePath}`, replies: Array.isArray(annotation.replies) ? annotation.replies : [] }, true);
}

// The server has no trash listing endpoint (trash is hidden from tree/changes);
// trash IDs come from the soft-delete response of `lookie delete`.
async function trashCommand(auth, args) {
  const sub = args[0];
  if (sub === 'list') die(EXIT_USAGE, 'trash list is not supported: the server exposes no trash listing endpoint; use the trashId returned by `lookie delete`');
  if (sub !== 'restore' && sub !== 'remove') die(EXIT_USAGE, 'trash requires restore or remove');
  const repo = requireArgument(args[1], 'repo');
  const trashId = requireArgument(args[2], 'trashId');
  if (args.length > 3) die(EXIT_USAGE, `unknown trash option: ${args[3]}`);
  const base = `/api/managed-repos/${encodeURIComponent(repo)}/trash/${encodeURIComponent(trashId)}`;
  const response = sub === 'restore'
    ? await request(auth, `${base}/restore`, { method: 'POST' })
    : await request(auth, base, { method: 'DELETE' });
  formatOutput(await handleApiResponse(response, auth), true);
}

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function integerOption(args, index, name) {
  const value = Number(optionValue(args, index, name));
  if (!Number.isInteger(value)) die(EXIT_USAGE, `${name} must be an integer`);
  return value;
}

async function appearanceCommand(auth, args) {
  const sub = args[0];
  const admin = { ...auth, token: process.env.LOOKIE_LINK_ADMIN_TOKEN || auth.token };
  if (sub === 'show') {
    let theme;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] !== '--theme') die(EXIT_USAGE, `unknown appearance show option: ${args[index]}`);
      theme = optionValue(args, index, '--theme');
      index += 1;
    }
    const route = theme ? `/api/appearance/themes/${encodeURIComponent(theme)}` : '/api/appearance';
    return formatOutput(await handleApiResponse(await request(auth, route), auth), true);
  }
  if (sub === 'set') {
    let body = null;
    const wallpapers = {};
    let revision;
    let themes;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--revision') revision = integerOption(args, index, arg);
      else if (arg === '--blur') wallpapers.blur = integerOption(args, index, arg);
      else if (arg === '--panel') wallpapers.panel_opacity = integerOption(args, index, arg);
      else if (arg === '--theme-json' || arg === '--json-file') {
        const raw = arg === '--json-file' ? await fs.readFile(optionValue(args, index, arg), 'utf8') : optionValue(args, index, arg);
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) { die(EXIT_USAGE, `${arg}: invalid JSON (${error.message})`); }
        if (arg === '--json-file') body = parsed; else themes = parsed;
      } else die(EXIT_USAGE, `unknown appearance set option: ${arg}`);
      index += 1;
    }
    body = body && typeof body === 'object' ? { ...body } : {};
    if (revision !== undefined) body.expectedRevision = revision;
    if (Object.keys(wallpapers).length) body.wallpapers = { ...(body.wallpapers || {}), ...wallpapers };
    if (themes !== undefined) body.themes = themes;
    if (!Number.isInteger(body.expectedRevision)) die(EXIT_USAGE, 'appearance set requires --revision N (from `lookie appearance show`)');
    const response = await request(admin, '/api/appearance', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return formatOutput(await handleApiResponse(response, admin), true);
  }
  if (sub === 'upload') {
    const slug = requireArgument(args[1], 'theme slug');
    const mode = requireArgument(args[2], 'mode (dark|light)');
    let name;
    let file;
    for (let index = 3; index < args.length; index += 1) {
      if (args[index] === '--name') { name = optionValue(args, index, '--name'); index += 1; }
      else if (!args[index].startsWith('--') && !file) file = args[index];
      else die(EXIT_USAGE, `unknown appearance upload option: ${args[index]}`);
    }
    if (!name) die(EXIT_USAGE, 'appearance upload requires --name ID');
    if (!file) die(EXIT_USAGE, 'appearance upload requires an image file');
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) die(EXIT_USAGE, 'appearance upload accepts .jpg, .jpeg, .png, or .webp files');
    const response = await request(admin, `/api/appearance/themes/${encodeURIComponent(slug)}/wallpapers/${encodeURIComponent(mode)}?${new URLSearchParams({ name })}`, {
      method: 'POST', headers: { 'Content-Type': type }, body: await fs.readFile(file),
    });
    return formatOutput(await handleApiResponse(response, admin), true);
  }
  if (sub === 'delete') {
    const slug = requireArgument(args[1], 'theme slug');
    const mode = requireArgument(args[2], 'mode (dark|light)');
    const id = requireArgument(args[3], 'picture id');
    if (args.length > 4) die(EXIT_USAGE, `unknown appearance delete option: ${args[4]}`);
    const response = await request(admin, `/api/appearance/themes/${encodeURIComponent(slug)}/wallpapers/${encodeURIComponent(mode)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return formatOutput(await handleApiResponse(response, admin), true);
  }
  return die(EXIT_USAGE, 'appearance requires show, set, upload, or delete');
}

async function authCommand(args, outputJson) {
  const subcommand = args[0];
  if (subcommand === 'status') {
    if (args.length > 1) die(EXIT_USAGE, `unknown auth status option: ${args[1]}`);
    const auth = await resolveAuth();
    formatOutput({ ok: true, instance: auth.baseUrl, tokenConfigured: Boolean(auth.token), authPath: auth.authPath }, true);
    return;
  }
  if (subcommand !== 'login') die(EXIT_USAGE, 'auth requires login or status');
  let instance;
  let tokenFromStdin = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--instance' || arg === '--base-url') {
      instance = optionValue(args, index, arg);
      index += 1;
    } else if (arg === '--token-stdin') {
      tokenFromStdin = true;
    } else {
      die(EXIT_USAGE, `unknown auth login option: ${arg}`);
    }
  }
  if (!instance) die(EXIT_USAGE, 'auth login requires --instance URL');
  const token = tokenFromStdin ? await readTokenFromStdin() : process.env.LOOKIE_LINK_TOKEN;
  if (!token) die(EXIT_USAGE, 'auth login requires LOOKIE_LINK_TOKEN or --token-stdin');
  const normalized = normalizeBaseUrl(instance);
  await writeAuthFile({ instance: normalized, token: String(token).trim(), updatedAt: new Date().toISOString() });
  formatOutput({ ok: true, instance: normalized, authPath: AUTH_PATH }, outputJson || true);
}

async function main() {
  const { options, rest } = parseGlobalArgs(process.argv.slice(2));
  const command = rest[0];
  const args = rest.slice(1);
  if (!command) {
    printUsage(process.stderr);
    die(EXIT_USAGE, 'missing command');
  }
  if (command === 'auth') return authCommand(args, options.json);
  const auth = await resolveAuth({ baseUrl: options.baseUrl });
  switch (command) {
    case 'capabilities': return capabilitiesCommand(auth);
    case 'whoami': {
      const response = await request(auth, '/api/whoami');
      return formatOutput(await handleApiResponse(response, auth), true);
    }
    case 'repos': {
      const response = await request(auth, '/api/repos');
      return formatOutput(await handleApiResponse(response, auth), true);
    }
    case 'read': return readCommand(auth, requireArgument(args[0], 'repo/path'), options.json);
    case 'tree': return treeCommand(auth, requireArgument(args[0], 'repo'), args.slice(1));
    case 'changes': return changesCommand(auth, requireArgument(args[0], 'repo'), args.slice(1));
    case 'write': return writeCommand(auth, requireArgument(args[0], 'repo/path'), args.slice(1));
    case 'delete': return deleteCommand(auth, requireArgument(args[0], 'repo/path'), args.slice(1));
    case 'search': return searchCommand(auth, args);
    case 'publish': return publishCommand(auth, args);
    case 'annotations': return annotationsCommand(auth, args);
    case 'trash': return trashCommand(auth, args);
    case 'appearance': return appearanceCommand(auth, args);
    case 'openapi': {
      const response = await request(auth, '/openapi.json');
      return formatOutput(await handleApiResponse(response, auth), true);
    }
    case 'docs': {
      const url = requestUrl(auth.baseUrl, '/api/docs');
      return formatOutput(options.json ? { ok: true, url } : url, options.json);
    }
    default: return die(EXIT_USAGE, `unknown command: ${command}`);
  }
}

main().catch(async (error) => {
  const secrets = [process.env.LOOKIE_LINK_TOKEN, process.env.LOOKIE_LINK_ADMIN_TOKEN];
  try {
    const stored = await readAuthFile();
    if (stored && stored.token) secrets.push(stored.token);
  } catch {
    // ignore: redaction is best-effort and must not mask the original error
  }
  die(EXIT_TRANSPORT, error && error.message ? error.message : error, secrets);
});
