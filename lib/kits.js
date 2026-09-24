'use strict';

// Hosted HTML kits: config-driven folders of kit.yaml + stylesheet + templates.
// Modelled on wallpapers/appearance (load, watch, public projection, no host paths).
// Stage 3 adds a managed folder, per-kit token overlays, and admin mutations.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CREATE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TOKEN_KEY_PATTERN = /^--[a-z][a-z0-9-]*$/;
const FILE_EXT_PATTERN = /\.(html|htm|md|css)$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 40;
const DEFAULT_BUNDLED_ROOT = path.join(__dirname, '..', 'kits');
const OVERLAY_MARKER = '\n/* lookie-link kit overlay */\n';

let state = {
  enabled: true,
  defaultName: null,
  kits: new Map(), // name -> kit record
  watchTargets: [],
  managedFolder: null,
};

function fileLabel(file) {
  const stem = String(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  if (!stem) return String(file);
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
}

function safeListedFile(file) {
  if (typeof file !== 'string' || !file) return null;
  if (file.includes('\0') || file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  if (file !== path.basename(file)) return null;
  return file;
}

function safeWritableFile(file) {
  const safe = safeListedFile(file);
  if (!safe || !FILE_EXT_PATTERN.test(safe)) return null;
  return safe;
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = typeof content === 'string' ? content : content;
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function parseManifest(raw, folderName, warn) {
  if (!isPlainObject(raw)) {
    warn(`Warning: kit folder ${folderName} has an invalid kit.yaml (not a mapping); skipped`);
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME_PATTERN.test(name)) {
    warn(`Warning: kit folder ${folderName} has an invalid kit.yaml name; skipped`);
    return null;
  }
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : name;
  const version = raw.version === undefined || raw.version === null ? '' : String(raw.version).trim();
  if (!version) {
    warn(`Warning: kit folder ${folderName} has an invalid kit.yaml version; skipped`);
    return null;
  }
  const stylesheet = typeof raw.stylesheet === 'string' && raw.stylesheet.trim()
    ? raw.stylesheet.trim()
    : 'kit.css';
  if (!safeListedFile(stylesheet)) {
    warn(`Warning: kit folder ${folderName} has an invalid kit.yaml stylesheet; skipped`);
    return null;
  }
  const templates = asStringList(raw.templates).map(safeListedFile).filter(Boolean);
  const examples = asStringList(raw.examples).map(safeListedFile).filter(Boolean);
  const consumes = asStringList(raw.consumes);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  return { name, label, version, stylesheet, templates, examples, consumes, description };
}

function listedFiles(manifest) {
  const files = new Set([manifest.stylesheet, ...manifest.templates, ...manifest.examples]);
  return [...files];
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function overlayPathFor(managedFolder, name) {
  return path.join(managedFolder, `${name}.overlay.yaml`);
}

function readOverlayFile(filePath) {
  try {
    const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainObject(raw)) return null;
    const tokens = isPlainObject(raw.tokens) ? raw.tokens : {};
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null;
    return { tokens, updatedAt, label, mtimeMs: mtimeMs(filePath), path: filePath };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function overlayHash(tokens) {
  const keys = Object.keys(tokens || {}).sort();
  const canonical = keys.map((key) => `${key}=${tokens[key]}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

function applyOverlay(kit, overlay) {
  if (!overlay) {
    kit.overlay = null;
    kit.effectiveVersion = kit.version;
    kit.overlayHash = null;
    return kit;
  }
  const tokens = {};
  for (const [key, value] of Object.entries(overlay.tokens || {})) {
    if (TOKEN_KEY_PATTERN.test(key) && typeof value === 'string') tokens[key] = value;
  }
  const hasTokens = Object.keys(tokens).length > 0;
  if (!hasTokens && !overlay.label) {
    kit.overlay = null;
    kit.effectiveVersion = kit.version;
    kit.overlayHash = null;
    return kit;
  }
  const hash = hasTokens ? overlayHash(tokens) : null;
  kit.overlay = {
    tokens: hasTokens ? tokens : {},
    updatedAt: overlay.updatedAt,
    ...(overlay.label ? { label: overlay.label } : {}),
  };
  kit.overlayHash = hash;
  kit.effectiveVersion = hash ? `${kit.version}+${hash}` : kit.version;
  if (overlay.label) kit.label = overlay.label;
  return kit;
}

function scanRoot(root, source, warn, { quietMissing = false } = {}) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      // The managed folder is created on the first admin write; its absence is
      // the normal state of a fresh instance, not a misconfiguration.
      if (!quietMissing) warn(`Warning: kits folder missing (${root}); skipped`);
    } else {
      warn(`Warning: cannot read kits folder ${root} (${error.code || error.message}); skipped`);
    }
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, 'kit.yaml');
    if (!fs.existsSync(manifestPath)) continue;
    let raw;
    try {
      raw = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      warn(`Warning: kit folder ${entry.name} has an invalid kit.yaml (${error.message}); skipped`);
      continue;
    }
    const manifest = parseManifest(raw, entry.name, warn);
    if (!manifest) continue;
    const stylesheetPath = path.join(dir, manifest.stylesheet);
    if (!fs.existsSync(stylesheetPath)) {
      warn(`Warning: kit folder ${entry.name} is missing ${manifest.stylesheet}; skipped`);
      continue;
    }
    const files = listedFiles(manifest);
    const fileMtimes = {};
    for (const file of files) {
      fileMtimes[file] = mtimeMs(path.join(dir, file));
    }
    fileMtimes['kit.yaml'] = mtimeMs(manifestPath);
    found.push({
      ...manifest,
      source,
      root: dir,
      files,
      fileMtimes,
      writable: source === 'managed',
      overlay: null,
      effectiveVersion: manifest.version,
      overlayHash: null,
    });
  }
  return found;
}

function loadOverlays(managedFolder, kits, warn) {
  if (!managedFolder) return;
  let entries;
  try {
    entries = fs.readdirSync(managedFolder);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(`Warning: cannot read kits managed folder ${managedFolder} (${error.code || error.message})`);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.overlay.yaml')) continue;
    const name = entry.slice(0, -'.overlay.yaml'.length);
    const kit = kits.get(name);
    if (!kit) continue;
    const overlay = readOverlayFile(path.join(managedFolder, entry));
    if (overlay) applyOverlay(kit, overlay);
  }
}

function loadKits({
  folders = [],
  managedFolder = null,
  bundledRoot = DEFAULT_BUNDLED_ROOT,
  enabled = true,
  default: defaultName,
  warn = console.warn,
} = {}) {
  const kits = new Map();
  const watchTargets = [];
  const resolvedManaged = typeof managedFolder === 'string' && managedFolder.trim()
    ? managedFolder.trim()
    : null;

  if (!enabled) {
    state = { enabled: false, defaultName: null, kits, watchTargets, managedFolder: resolvedManaged };
    return { kits: [], default: null, watch: watchTargets };
  }

  // Precedence on name clash: managed → config folders → bundled.
  if (bundledRoot) {
    watchTargets.push(bundledRoot);
    for (const kit of scanRoot(bundledRoot, 'bundled', warn)) {
      kits.set(kit.name, kit);
    }
  }

  for (const folder of folders) {
    if (typeof folder !== 'string' || !folder) continue;
    watchTargets.push(folder);
    for (const kit of scanRoot(folder, 'config', warn)) {
      kits.set(kit.name, kit);
    }
  }

  if (resolvedManaged) {
    watchTargets.push(resolvedManaged);
    for (const kit of scanRoot(resolvedManaged, 'managed', warn, { quietMissing: true })) {
      kits.set(kit.name, kit);
    }
    loadOverlays(resolvedManaged, kits, warn);
  }

  const ordered = [...kits.values()].sort((a, b) => a.name.localeCompare(b.name));
  let resolvedDefault = typeof defaultName === 'string' && defaultName.trim() ? defaultName.trim() : null;
  if (resolvedDefault && !kits.has(resolvedDefault)) {
    warn(`Warning: kits.default '${resolvedDefault}' is not a loaded kit; using the first bundled kit`);
    resolvedDefault = null;
  }
  if (!resolvedDefault) {
    const firstBundled = ordered.find((kit) => kit.source === 'bundled');
    resolvedDefault = firstBundled ? firstBundled.name : (ordered[0] ? ordered[0].name : null);
  }

  state = { enabled: true, defaultName: resolvedDefault, kits, watchTargets, managedFolder: resolvedManaged };
  return { kits: ordered.map(projectKit), default: resolvedDefault, watch: [...watchTargets] };
}

function projectFileRef(kit, file) {
  return {
    file,
    label: fileLabel(file),
    url: `/kit/${encodeURIComponent(kit.name)}/files/${encodeURIComponent(file)}`,
  };
}

function projectKit(kit, { includeFiles = false } = {}) {
  const effectiveVersion = kit.effectiveVersion || kit.version;
  const stylesheetUrl = `/kit/${encodeURIComponent(kit.name)}/kit.css`;
  const pinnedStylesheetUrl = `/kit/${encodeURIComponent(kit.name)}/v/${encodeURIComponent(effectiveVersion)}/kit.css`;
  const projection = {
    name: kit.name,
    label: kit.label,
    version: kit.version,
    effectiveVersion,
    description: kit.description,
    stylesheetUrl,
    pinnedStylesheetUrl,
    caching: { stylesheetUrl: 'no-cache', pinnedStylesheetUrl: 'immutable' },
    templates: kit.templates.map((file) => projectFileRef(kit, file)),
    examples: kit.examples.map((file) => projectFileRef(kit, file)),
    consumes: [...kit.consumes],
    source: kit.source,
    writable: Boolean(kit.writable),
    overlay: kit.overlay
      ? { tokens: { ...kit.overlay.tokens }, updatedAt: kit.overlay.updatedAt }
      : null,
  };
  if (includeFiles) {
    projection.files = kit.files.map((file) => ({
      file,
      url: file === kit.stylesheet
        ? projection.stylesheetUrl
        : `/kit/${encodeURIComponent(kit.name)}/files/${encodeURIComponent(file)}`,
    }));
  }
  return projection;
}

function listKits() {
  if (!state.enabled) return [];
  return [...state.kits.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((kit) => projectKit(kit));
}

function getKit(name) {
  if (!state.enabled) return null;
  const kit = state.kits.get(String(name || ''));
  return kit ? projectKit(kit, { includeFiles: true }) : null;
}

function getKitRecord(name) {
  if (!state.enabled) return null;
  return state.kits.get(String(name || '')) || null;
}

function defaultKitName() {
  return state.defaultName;
}

function kitsEnabled() {
  return state.enabled && state.kits.size > 0;
}

function managedFolderPath() {
  return state.managedFolder;
}

function readKitFile(name, file) {
  const kit = getKitRecord(name);
  if (!kit) return null;
  const safe = safeListedFile(file);
  if (!safe || !kit.files.includes(safe)) return null;
  const target = path.join(kit.root, safe);
  const resolvedRoot = path.resolve(kit.root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  try {
    return fs.readFileSync(resolvedTarget, 'utf8');
  } catch {
    return null;
  }
}

function formatOverlayCss(tokens) {
  const keys = Object.keys(tokens || {}).sort();
  if (!keys.length) return '';
  const body = keys.map((key) => `${key}:${tokens[key]}`).join(';');
  return `${OVERLAY_MARKER}:root{${body}}\n`;
}

function readKitStylesheet(name) {
  const kit = getKitRecord(name);
  if (!kit) return null;
  const base = readKitFile(name, kit.stylesheet);
  if (base === null) return null;
  if (!kit.overlay || !kit.overlay.tokens || !Object.keys(kit.overlay.tokens).length) {
    return base;
  }
  return base + formatOverlayCss(kit.overlay.tokens);
}

function kitsRevision() {
  const parts = [...state.kits.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((kit) => {
      const mt = Object.keys(kit.fileMtimes).sort()
        .map((file) => `${file}:${kit.fileMtimes[file]}`)
        .join(',');
      const overlayPart = kit.overlay
        ? `overlay:${kit.effectiveVersion}:${JSON.stringify(kit.overlay.tokens)}:${kit.overlay.updatedAt || ''}`
        : 'overlay:none';
      return `${kit.name}@${kit.version}:${kit.source}:{${mt}}:${overlayPart}`;
    });
  parts.push(`default:${state.defaultName || ''}`);
  parts.push(`enabled:${state.enabled ? '1' : '0'}`);
  parts.push(`managed:${state.managedFolder || ''}`);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function watchTargets() {
  return [...state.watchTargets];
}

function contentTypeFor(file) {
  const lower = String(file || '').toLowerCase();
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function ensureManagedFolder() {
  if (!state.managedFolder) {
    const err = new Error('Kits managed folder is not configured.');
    err.code = 'EFEATURE';
    throw err;
  }
  fs.mkdirSync(state.managedFolder, { recursive: true });
  return state.managedFolder;
}

function validateTokenMap(tokens, details, pathPrefix = 'tokens') {
  if (tokens === null) return {};
  if (!isPlainObject(tokens)) {
    details.push({ path: pathPrefix, message: 'must be an object or null' });
    return null;
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (!TOKEN_KEY_PATTERN.test(key)) {
      details.push({ path: `${pathPrefix}.${key}`, message: 'keys must match /^--[a-z][a-z0-9-]*$/' });
      continue;
    }
    if (typeof value !== 'string') {
      details.push({ path: `${pathPrefix}.${key}`, message: 'must be a string' });
      continue;
    }
    if (value.length > 200) {
      details.push({ path: `${pathPrefix}.${key}`, message: 'values must be ≤ 200 characters' });
      continue;
    }
    if (/[;{}<]|url\(/i.test(value)) {
      details.push({ path: `${pathPrefix}.${key}`, message: 'values must not contain ; { } < or url(' });
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function validateCreateBody(body) {
  const details = [];
  if (!isPlainObject(body)) return { details: [{ path: '', message: 'body must be a JSON object' }] };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!CREATE_NAME_PATTERN.test(name)) {
    details.push({ path: 'name', message: 'must match /^[a-z][a-z0-9-]{0,39}$/' });
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '';
  if (!label) details.push({ path: 'label', message: 'required non-empty string' });
  const version = body.version === undefined || body.version === null ? '' : String(body.version).trim();
  if (!version) details.push({ path: 'version', message: 'required non-empty string' });
  const description = typeof body.description === 'string' ? body.description : '';
  const stylesheet = typeof body.stylesheet === 'string' ? body.stylesheet : null;
  if (stylesheet === null) details.push({ path: 'stylesheet', message: 'required CSS text' });
  else if (Buffer.byteLength(stylesheet, 'utf8') > MAX_FILE_BYTES) {
    details.push({ path: 'stylesheet', message: 'must be ≤ 1 MB' });
  }

  const fileMap = new Map();
  fileMap.set('kit.css', stylesheet);

  function absorbFileMap(field) {
    if (body[field] === undefined) return;
    if (!isPlainObject(body[field])) {
      details.push({ path: field, message: 'must be an object of filename → text' });
      return;
    }
    for (const [file, content] of Object.entries(body[field])) {
      const safe = safeWritableFile(file);
      if (!safe) {
        details.push({ path: `${field}.${file}`, message: 'file names must be *.html|*.htm|*.md|*.css without / or ..' });
        continue;
      }
      if (typeof content !== 'string') {
        details.push({ path: `${field}.${file}`, message: 'must be a string' });
        continue;
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        details.push({ path: `${field}.${file}`, message: 'must be ≤ 1 MB' });
        continue;
      }
      if (fileMap.has(safe) && field !== 'templates') {
        // allow templates/examples to list distinct files; collision with stylesheet name is bad
      }
      if (safe === 'kit.css' || safe === 'kit.yaml') {
        details.push({ path: `${field}.${file}`, message: 'reserved file name' });
        continue;
      }
      fileMap.set(safe, content);
    }
  }
  absorbFileMap('templates');
  absorbFileMap('examples');

  if (fileMap.size > MAX_FILES) {
    details.push({ path: 'files', message: `at most ${MAX_FILES} files` });
  }

  return {
    details,
    value: details.length ? null : {
      name,
      label,
      version,
      description,
      stylesheet: 'kit.css',
      stylesheetText: stylesheet,
      templates: isPlainObject(body.templates) ? Object.keys(body.templates).map(safeWritableFile).filter(Boolean) : [],
      examples: isPlainObject(body.examples) ? Object.keys(body.examples).map(safeWritableFile).filter(Boolean) : [],
      fileMap,
    },
  };
}

function createManagedKit(body) {
  const { details, value } = validateCreateBody(body);
  if (details.length) {
    const err = new Error('Kit create payload is invalid.');
    err.code = 'EINVALID';
    err.details = details;
    throw err;
  }
  if (state.kits.has(value.name)) {
    const err = new Error(`Kit already exists: ${value.name}`);
    err.code = 'ECONFLICT';
    throw err;
  }
  const root = path.join(ensureManagedFolder(), value.name);
  if (fs.existsSync(root)) {
    const err = new Error(`Kit already exists: ${value.name}`);
    err.code = 'ECONFLICT';
    throw err;
  }
  fs.mkdirSync(root, { recursive: true });
  const manifest = {
    name: value.name,
    label: value.label,
    version: value.version,
    stylesheet: 'kit.css',
    templates: value.templates,
    examples: value.examples,
    consumes: [],
    description: value.description,
  };
  try {
    writeFileAtomic(path.join(root, 'kit.yaml'), yaml.dump(manifest, { lineWidth: 120 }));
    writeFileAtomic(path.join(root, 'kit.css'), value.stylesheetText);
    for (const [file, content] of value.fileMap.entries()) {
      if (file === 'kit.css') continue;
      writeFileAtomic(path.join(root, file), content);
    }
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw error;
  }
  return value.name;
}

function writeManagedFile(name, file, content) {
  const kit = getKitRecord(name);
  if (!kit) {
    const err = new Error(`Unknown kit: ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  if (kit.source !== 'managed') {
    const err = new Error('Kit is read-only.');
    err.code = 'EREADONLY';
    throw err;
  }
  const safe = safeWritableFile(file);
  if (!safe) {
    const err = new Error('Invalid kit file name.');
    err.code = 'EINVALID';
    err.details = [{ path: 'file', message: 'file names must be *.html|*.htm|*.md|*.css without / or ..' }];
    throw err;
  }
  if (typeof content !== 'string') {
    const err = new Error('content must be a string.');
    err.code = 'EINVALID';
    err.details = [{ path: 'content', message: 'must be a string' }];
    throw err;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    const err = new Error('File exceeds 1 MB.');
    err.code = 'EINVALID';
    err.details = [{ path: 'content', message: 'must be ≤ 1 MB' }];
    throw err;
  }
  const nextFiles = new Set(kit.files);
  nextFiles.add(safe);
  if (nextFiles.size > MAX_FILES) {
    const err = new Error(`Kit may have at most ${MAX_FILES} files.`);
    err.code = 'EINVALID';
    err.details = [{ path: 'files', message: `at most ${MAX_FILES} files` }];
    throw err;
  }
  writeFileAtomic(path.join(kit.root, safe), content);
  // Keep the manifest file list in sync for templates/examples (stylesheet is always listed).
  if (safe !== kit.stylesheet) {
    const manifestPath = path.join(kit.root, 'kit.yaml');
    let raw;
    try { raw = yaml.load(fs.readFileSync(manifestPath, 'utf8')) || {}; } catch { raw = {}; }
    const templates = new Set(asStringList(raw.templates));
    const examples = new Set(asStringList(raw.examples));
    if (!templates.has(safe) && !examples.has(safe)) {
      if (/\.(html|htm)$/i.test(safe)) templates.add(safe);
      else if (/\.md$/i.test(safe)) examples.add(safe);
      else templates.add(safe);
    }
    raw.templates = [...templates];
    raw.examples = [...examples];
    writeFileAtomic(manifestPath, yaml.dump(raw, { lineWidth: 120 }));
  }
  return safe;
}

function deleteManagedKit(name) {
  const kit = getKitRecord(name);
  if (!kit) {
    const err = new Error(`Unknown kit: ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  if (kit.source !== 'managed') {
    const err = new Error('Kit is read-only.');
    err.code = 'EREADONLY';
    throw err;
  }
  fs.rmSync(kit.root, { recursive: true, force: true });
  if (state.managedFolder) {
    const overlay = overlayPathFor(state.managedFolder, name);
    try { fs.unlinkSync(overlay); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return true;
}

function patchKitOverlay(name, { expectedRevision, tokens, label } = {}) {
  const kit = getKitRecord(name);
  if (!kit) {
    const err = new Error(`Unknown kit: ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  const details = [];
  if (expectedRevision === undefined || expectedRevision === null
    || (typeof expectedRevision !== 'string' && typeof expectedRevision !== 'number')) {
    details.push({ path: 'expectedRevision', message: 'revision from the last kits list/show is required' });
  }
  if (label !== undefined && label !== null && (typeof label !== 'string' || !label.trim())) {
    details.push({ path: 'label', message: 'must be a non-empty string when set' });
  }
  let cleanedTokens = undefined;
  if (tokens !== undefined) {
    cleanedTokens = validateTokenMap(tokens, details);
  }
  if (details.length) {
    const err = new Error('Kit patch is invalid.');
    err.code = 'EINVALID';
    err.details = details;
    throw err;
  }
  const current = kitsRevision();
  if (String(expectedRevision) !== current) {
    const err = new Error('Kit revision is stale.');
    err.code = 'EREVISION';
    err.currentRevision = current;
    throw err;
  }

  const managed = ensureManagedFolder();
  const target = overlayPathFor(managed, name);

  // tokens: {} or null clears the overlay entirely (brief).
  if (tokens === null || (tokens !== undefined && cleanedTokens && Object.keys(cleanedTokens).length === 0)) {
    try { fs.unlinkSync(target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return name;
  }

  const existing = readOverlayFile(target) || { tokens: {}, label: null };
  const nextTokens = tokens === undefined ? (existing.tokens || {}) : cleanedTokens;
  const nextLabel = label === undefined
    ? existing.label
    : (label === null ? null : String(label).trim());
  const payload = {
    tokens: nextTokens,
    updatedAt: new Date().toISOString(),
  };
  if (nextLabel) payload.label = nextLabel;

  if (!Object.keys(payload.tokens).length && !payload.label) {
    try { fs.unlinkSync(target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } else {
    writeFileAtomic(target, `# Written by the Lookie-Link kits API. Do not hand-edit.\n${yaml.dump(payload, { lineWidth: 120 })}`);
  }
  return name;
}

// Live reload. Watches every kit root (and the bundled/config/managed parent folders);
// on change, after a short quiet period, rescans. Same shape as watchWallpapers.
function watchKits({ fs: fsApi = fs, path: pathApi = path, reload, log = console.log, warn = console.warn, quietMs = 400 }) {
  let watchers = [];
  let timer = null;
  function close() {
    for (const watcher of watchers) {
      try { watcher.close(); } catch (_) { /* ignore */ }
    }
    watchers = [];
  }
  function arm(targets) {
    close();
    for (const target of new Set((targets || []).filter(Boolean))) {
      try {
        const watcher = fsApi.watch(target, { persistent: false }, () => schedule());
        watcher.on('error', () => {});
        watchers.push(watcher);
      } catch (error) {
        if (error.code !== 'ENOENT') warn(`Warning: cannot watch ${target} (${error.code || error.message})`);
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, quietMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function run() {
    let result;
    try {
      result = reload();
    } catch (error) {
      warn(`Warning: kits reload failed (${error.message}); keeping the previous catalog`);
      return;
    }
    arm(result.watch);
    log(`Kits reloaded: ${result.summary}`);
  }
  const initial = reload();
  arm(initial.watch);
  log(`Kits: ${initial.summary} (live reload on)`);
  return { close, refresh: run };
}

module.exports = {
  DEFAULT_BUNDLED_ROOT,
  CREATE_NAME_PATTERN,
  MAX_FILE_BYTES,
  MAX_FILES,
  loadKits,
  listKits,
  getKit,
  getKitRecord,
  readKitFile,
  readKitStylesheet,
  kitsRevision,
  kitsEnabled,
  defaultKitName,
  managedFolderPath,
  watchTargets,
  watchKits,
  contentTypeFor,
  projectKit,
  createManagedKit,
  writeManagedFile,
  deleteManagedKit,
  patchKitOverlay,
  ensureManagedFolder,
  formatOverlayCss,
  writeFileAtomic,
};
