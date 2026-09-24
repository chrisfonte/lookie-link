'use strict';

// Hosted HTML kits: config-driven folders of kit.yaml + stylesheet + templates.
// Modelled on wallpapers/appearance (load, watch, public projection, no host paths).
// R15a: managedFolder is an org-scoped root (orgs/<org>/kits + versions + overlays;
// _shared for operator-curated kits). Exactly one org (`default`) in R15a.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CREATE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const ORG_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TOKEN_KEY_PATTERN = /^--[a-z][a-z0-9-]*$/;
const FILE_EXT_PATTERN = /\.(html|htm|md|css)$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 40;
const DEFAULT_BUNDLED_ROOT = path.join(__dirname, '..', 'kits');
const DEFAULT_ORG = 'default';
const OVERLAY_MARKER = '\n/* lookie-link kit overlay */\n';
const RESERVED_MANAGED_DIRS = new Set(['_shared', 'orgs']);

let state = {
  enabled: true,
  defaultName: null,
  kits: new Map(), // name -> kit record
  tombstones: new Map(), // name -> { name, deletedAt, ... }
  watchTargets: [],
  managedFolder: null,
  defaultOrg: DEFAULT_ORG,
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

function copyFileVerified(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const a = fs.readFileSync(src);
  const b = fs.readFileSync(dest);
  if (!a.equals(b)) {
    throw new Error(`copy verification failed: ${src} → ${dest}`);
  }
}

function copyDirVerified(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirVerified(from, to);
    else if (entry.isFile()) copyFileVerified(from, to);
  }
}

function dirSizeBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
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

function sharedRoot(managedFolder) {
  return path.join(managedFolder, '_shared');
}

function orgKitsRoot(managedFolder, org = DEFAULT_ORG) {
  return path.join(managedFolder, 'orgs', org, 'kits');
}

function orgOverlaysRoot(managedFolder, org = DEFAULT_ORG) {
  return path.join(managedFolder, 'orgs', org, 'overlays');
}

function kitRecordPath(managedFolder, org, name) {
  return path.join(orgKitsRoot(managedFolder, org), name, 'kit.yaml');
}

function kitVersionDir(managedFolder, org, name, versionNum) {
  return path.join(orgKitsRoot(managedFolder, org), name, 'versions', String(versionNum));
}

function overlayPathFor(managedFolder, name, org = DEFAULT_ORG) {
  return path.join(orgOverlaysRoot(managedFolder, org), `${name}.overlay.yaml`);
}

function baseEffectiveVersion(kit) {
  if (kit.scope === 'org' && kit.currentVersion != null) {
    return `${kit.version}@${kit.currentVersion}`;
  }
  return kit.version;
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
  const base = baseEffectiveVersion(kit);
  if (!overlay) {
    kit.overlay = null;
    kit.effectiveVersion = base;
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
    kit.effectiveVersion = base;
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
  kit.effectiveVersion = hash ? `${base}+${hash}` : base;
  if (overlay.label) kit.label = overlay.label;
  return kit;
}

function scanRoot(root, source, scope, warn, { quietMissing = false, org = null } = {}) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!quietMissing) warn(`Warning: kits folder missing (${root}); skipped`);
    } else {
      warn(`Warning: cannot read kits folder ${root} (${error.code || error.message}); skipped`);
    }
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (source === 'shared' && RESERVED_MANAGED_DIRS.has(entry.name)) continue;
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
      scope,
      org,
      root: dir,
      files,
      fileMtimes,
      writable: scope === 'org',
      currentVersion: null,
      versionEntries: [],
      overlay: null,
      effectiveVersion: manifest.version,
      overlayHash: null,
    });
  }
  return found;
}

function readOrgKitRecord(recordPath) {
  try {
    const raw = yaml.load(fs.readFileSync(recordPath, 'utf8'));
    if (!isPlainObject(raw)) return null;
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function normalizeVersionEntries(raw, managedFolder, org, name) {
  const entries = [];
  if (Array.isArray(raw.versions)) {
    for (const entry of raw.versions) {
      if (!isPlainObject(entry)) continue;
      const version = Number(entry.version);
      if (!Number.isInteger(version) || version < 1) continue;
      const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : null;
      let sizeBytes = Number(entry.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
        sizeBytes = dirSizeBytes(kitVersionDir(managedFolder, org, name, version));
      }
      entries.push({ version, createdAt, sizeBytes });
    }
  }
  if (!entries.length) {
    const currentVersion = Number(raw.currentVersion) || 1;
    for (let n = 1; n <= currentVersion; n += 1) {
      const dir = kitVersionDir(managedFolder, org, name, n);
      if (!fs.existsSync(dir)) continue;
      entries.push({
        version: n,
        createdAt: null,
        sizeBytes: dirSizeBytes(dir),
      });
    }
  }
  return entries.sort((a, b) => a.version - b.version);
}

function scanOrgKits(managedFolder, org, warn) {
  const found = [];
  const tombstones = [];
  const root = orgKitsRoot(managedFolder, org);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(`Warning: cannot read org kits folder ${root} (${error.code || error.message}); skipped`);
    }
    return { found, tombstones };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const recordPath = kitRecordPath(managedFolder, org, name);
    const record = readOrgKitRecord(recordPath);
    if (!record) continue;
    const deletedAt = typeof record.deletedAt === 'string' && record.deletedAt
      ? record.deletedAt
      : (record.deletedAt === null || record.deletedAt === undefined ? null : String(record.deletedAt));
    if (deletedAt) {
      tombstones.push({
        name: typeof record.name === 'string' ? record.name : name,
        deletedAt,
        org,
        currentVersion: Number(record.currentVersion) || null,
      });
      continue;
    }
    const currentVersion = Number(record.currentVersion);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      warn(`Warning: org kit ${name} has an invalid currentVersion; skipped`);
      continue;
    }
    const versionRoot = kitVersionDir(managedFolder, org, name, currentVersion);
    const manifestPath = path.join(versionRoot, 'kit.yaml');
    if (!fs.existsSync(manifestPath)) {
      warn(`Warning: org kit ${name} is missing versions/${currentVersion}/kit.yaml; skipped`);
      continue;
    }
    let raw;
    try {
      raw = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      warn(`Warning: org kit ${name} has an invalid version manifest (${error.message}); skipped`);
      continue;
    }
    const manifest = parseManifest(raw, name, warn);
    if (!manifest) continue;
    // Prefer record-level identity fields when present.
    if (typeof record.label === 'string' && record.label.trim()) manifest.label = record.label.trim();
    if (record.version !== undefined && record.version !== null && String(record.version).trim()) {
      manifest.version = String(record.version).trim();
    }
    if (typeof record.description === 'string') manifest.description = record.description.trim();
    const stylesheetPath = path.join(versionRoot, manifest.stylesheet);
    if (!fs.existsSync(stylesheetPath)) {
      warn(`Warning: org kit ${name} is missing ${manifest.stylesheet} in versions/${currentVersion}; skipped`);
      continue;
    }
    const files = listedFiles(manifest);
    const fileMtimes = {};
    for (const file of files) {
      fileMtimes[file] = mtimeMs(path.join(versionRoot, file));
    }
    fileMtimes['kit.yaml'] = mtimeMs(manifestPath);
    fileMtimes['__record__'] = mtimeMs(recordPath);
    const versionEntries = normalizeVersionEntries(record, managedFolder, org, name);
    found.push({
      ...manifest,
      source: 'org',
      scope: 'org',
      org,
      root: versionRoot,
      kitHome: path.join(orgKitsRoot(managedFolder, org), name),
      files,
      fileMtimes,
      writable: true,
      currentVersion,
      versionEntries,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      deletedAt: null,
      overlay: null,
      effectiveVersion: `${manifest.version}@${currentVersion}`,
      overlayHash: null,
    });
  }
  return { found, tombstones };
}

function loadOverlays(managedFolder, org, kits, warn) {
  if (!managedFolder) return;
  const overlaysRoot = orgOverlaysRoot(managedFolder, org);
  let entries;
  try {
    entries = fs.readdirSync(overlaysRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(`Warning: cannot read kits overlays folder ${overlaysRoot} (${error.code || error.message})`);
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.overlay.yaml')) continue;
    const name = entry.slice(0, -'.overlay.yaml'.length);
    const kit = kits.get(name);
    if (!kit) continue;
    const overlay = readOverlayFile(path.join(overlaysRoot, entry));
    if (overlay) applyOverlay(kit, overlay);
  }
}

function migrateFlatManagedLayout(managedFolder, { warn = console.warn, log = console.log } = {}) {
  if (!managedFolder || !fs.existsSync(managedFolder)) return { kits: 0, overlays: 0 };
  let movedKits = 0;
  let movedOverlays = 0;
  let entries;
  try {
    entries = fs.readdirSync(managedFolder, { withFileTypes: true });
  } catch (error) {
    warn(`Warning: cannot read kits managed folder for migration (${error.code || error.message})`);
    return { kits: 0, overlays: 0 };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (RESERVED_MANAGED_DIRS.has(entry.name)) continue;
    const srcDir = path.join(managedFolder, entry.name);
    const manifestPath = path.join(srcDir, 'kit.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    const destVersion = kitVersionDir(managedFolder, DEFAULT_ORG, entry.name, 1);
    const destRecord = kitRecordPath(managedFolder, DEFAULT_ORG, entry.name);
    const already = fs.existsSync(destRecord) && fs.existsSync(path.join(destVersion, 'kit.yaml'));

    if (!already) {
      copyDirVerified(srcDir, destVersion);
      let raw = {};
      try { raw = yaml.load(fs.readFileSync(path.join(destVersion, 'kit.yaml'), 'utf8')) || {}; } catch { raw = {}; }
      const now = new Date().toISOString();
      const record = {
        name: typeof raw.name === 'string' ? raw.name : entry.name,
        label: typeof raw.label === 'string' ? raw.label : entry.name,
        version: raw.version === undefined || raw.version === null ? '1' : String(raw.version),
        description: typeof raw.description === 'string' ? raw.description : '',
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        versions: [{ version: 1, createdAt: now, sizeBytes: dirSizeBytes(destVersion) }],
      };
      writeFileAtomic(destRecord, yaml.dump(record, { lineWidth: 120 }));
    }

    // Verify byte-equal for every source file, then remove the flat source.
    let verified = true;
    const walk = (dir, rel = '') => {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        const from = path.join(dir, child.name);
        const to = path.join(destVersion, rel, child.name);
        if (child.isDirectory()) walk(from, path.join(rel, child.name));
        else if (child.isFile()) {
          if (!fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to))) {
            verified = false;
          }
        }
      }
    };
    walk(srcDir);
    if (verified) {
      fs.rmSync(srcDir, { recursive: true, force: true });
      movedKits += 1;
      log(`Kits migration: moved flat kit '${entry.name}' → orgs/${DEFAULT_ORG}/kits/${entry.name}/versions/1`);
    } else {
      warn(`Warning: kits migration left flat kit '${entry.name}' in place (destination copy not byte-equal)`);
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.overlay.yaml')) continue;
    const name = entry.name.slice(0, -'.overlay.yaml'.length);
    const src = path.join(managedFolder, entry.name);
    const dest = overlayPathFor(managedFolder, name, DEFAULT_ORG);
    if (!fs.existsSync(dest)) {
      copyFileVerified(src, dest);
    }
    if (fs.existsSync(dest) && fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      fs.unlinkSync(src);
      movedOverlays += 1;
      log(`Kits migration: moved flat overlay '${entry.name}' → orgs/${DEFAULT_ORG}/overlays/${entry.name}`);
    } else {
      warn(`Warning: kits migration left flat overlay '${entry.name}' in place (destination copy not byte-equal)`);
    }
  }

  return { kits: movedKits, overlays: movedOverlays };
}

function loadKits({
  folders = [],
  managedFolder = null,
  bundledRoot = DEFAULT_BUNDLED_ROOT,
  enabled = true,
  default: defaultName,
  warn = console.warn,
  log = console.log,
  org = DEFAULT_ORG,
} = {}) {
  const kits = new Map();
  const tombstones = new Map();
  const watchTargets = [];
  const resolvedManaged = typeof managedFolder === 'string' && managedFolder.trim()
    ? managedFolder.trim()
    : null;
  const resolvedOrg = ORG_ID_PATTERN.test(String(org || '')) ? String(org) : DEFAULT_ORG;

  if (!enabled) {
    state = {
      enabled: false,
      defaultName: null,
      kits,
      tombstones,
      watchTargets,
      managedFolder: resolvedManaged,
      defaultOrg: resolvedOrg,
    };
    return { kits: [], default: null, watch: watchTargets };
  }

  // Precedence on name clash: org > shared (_shared + config folders) > bundled.
  // Load order (last wins): bundled → config folders → _shared → org.
  if (bundledRoot) {
    watchTargets.push(bundledRoot);
    for (const kit of scanRoot(bundledRoot, 'bundled', 'bundled', warn)) {
      kits.set(kit.name, kit);
    }
  }

  for (const folder of folders) {
    if (typeof folder !== 'string' || !folder) continue;
    watchTargets.push(folder);
    for (const kit of scanRoot(folder, 'config', 'shared', warn)) {
      kits.set(kit.name, kit);
    }
  }

  if (resolvedManaged) {
    migrateFlatManagedLayout(resolvedManaged, { warn, log });
    watchTargets.push(resolvedManaged);
    const shared = sharedRoot(resolvedManaged);
    watchTargets.push(shared);
    for (const kit of scanRoot(shared, 'shared', 'shared', warn, { quietMissing: true })) {
      kits.set(kit.name, kit);
    }
    watchTargets.push(orgKitsRoot(resolvedManaged, resolvedOrg));
    watchTargets.push(orgOverlaysRoot(resolvedManaged, resolvedOrg));
    const { found, tombstones: gone } = scanOrgKits(resolvedManaged, resolvedOrg, warn);
    for (const kit of found) {
      kits.set(kit.name, kit);
    }
    for (const stone of gone) {
      tombstones.set(stone.name, stone);
    }
    loadOverlays(resolvedManaged, resolvedOrg, kits, warn);
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

  state = {
    enabled: true,
    defaultName: resolvedDefault,
    kits,
    tombstones,
    watchTargets,
    managedFolder: resolvedManaged,
    defaultOrg: resolvedOrg,
  };
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
    scope: kit.scope || (kit.source === 'org' ? 'org' : kit.source === 'bundled' ? 'bundled' : 'shared'),
    writable: Boolean(kit.writable),
    overlay: kit.overlay
      ? { tokens: { ...kit.overlay.tokens }, updatedAt: kit.overlay.updatedAt }
      : null,
  };
  if (projection.scope === 'org') {
    projection.org = kit.org || DEFAULT_ORG;
    projection.currentVersion = kit.currentVersion;
  }
  if (includeFiles) {
    projection.files = kit.files.map((file) => ({
      file,
      url: file === kit.stylesheet
        ? projection.stylesheetUrl
        : `/kit/${encodeURIComponent(kit.name)}/files/${encodeURIComponent(file)}`,
    }));
    if (projection.scope === 'org' && Array.isArray(kit.versionEntries)) {
      projection.versions = kit.versionEntries.map((entry) => ({
        version: entry.version,
        createdAt: entry.createdAt,
        sizeBytes: entry.sizeBytes,
      }));
    }
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

function getDeletedKit(name) {
  if (!state.enabled) return null;
  return state.tombstones.get(String(name || '')) || null;
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

function defaultOrgId() {
  return state.defaultOrg || DEFAULT_ORG;
}

function readKitFile(name, file, { versionNum = null } = {}) {
  const kit = getKitRecord(name);
  if (!kit) return null;
  const safe = safeListedFile(file);
  if (!safe || !kit.files.includes(safe)) {
    // Historical snapshot may list different files; allow when versionNum is set.
    if (versionNum == null || !safe) return null;
  }
  let root = kit.root;
  if (versionNum != null && kit.scope === 'org' && state.managedFolder) {
    root = kitVersionDir(state.managedFolder, kit.org || DEFAULT_ORG, kit.name, versionNum);
  }
  const target = path.join(root, safe);
  const resolvedRoot = path.resolve(root);
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

// Serve a pinned effectiveVersion. Current effectiveVersion includes the overlay
// when one applies; historical org snapshots are addressable as <version>@<n>
// (base bytes only) and stay servable after later writes.
function readKitStylesheetAtVersion(name, effectiveVersion) {
  const kit = getKitRecord(name);
  if (!kit) return null;
  const requested = String(effectiveVersion || '');
  if (requested === kit.effectiveVersion) {
    return readKitStylesheet(name);
  }
  if (kit.scope !== 'org') return null;
  const match = requested.match(/^(.*)@(\d+)(?:\+([0-9a-f]{8}))?$/);
  if (!match) return null;
  const versionPrefix = match[1];
  const versionNum = Number(match[2]);
  const hash = match[3] || null;
  if (versionPrefix !== kit.version) return null;
  if (!Number.isInteger(versionNum) || versionNum < 1) return null;
  if (!state.managedFolder) return null;
  const versionRoot = kitVersionDir(state.managedFolder, kit.org || DEFAULT_ORG, kit.name, versionNum);
  const manifestPath = path.join(versionRoot, 'kit.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  let raw;
  try {
    raw = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const stylesheet = typeof raw.stylesheet === 'string' && raw.stylesheet.trim()
    ? raw.stylesheet.trim()
    : 'kit.css';
  let base;
  try {
    base = fs.readFileSync(path.join(versionRoot, stylesheet), 'utf8');
  } catch {
    return null;
  }
  if (!hash) return base;
  if (hash !== kit.overlayHash) return null;
  if (!kit.overlay || !kit.overlay.tokens) return null;
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
      const verPart = kit.scope === 'org' ? `cv:${kit.currentVersion}` : 'cv:';
      return `${kit.name}@${kit.version}:${kit.source}:{${mt}}:${overlayPart}:${verPart}`;
    });
  const stones = [...state.tombstones.keys()].sort().join(',');
  parts.push(`tombstones:${stones}`);
  parts.push(`default:${state.defaultName || ''}`);
  parts.push(`enabled:${state.enabled ? '1' : '0'}`);
  parts.push(`managed:${state.managedFolder || ''}`);
  parts.push(`org:${state.defaultOrg || DEFAULT_ORG}`);
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
  fs.mkdirSync(orgKitsRoot(state.managedFolder, defaultOrgId()), { recursive: true });
  fs.mkdirSync(orgOverlaysRoot(state.managedFolder, defaultOrgId()), { recursive: true });
  fs.mkdirSync(sharedRoot(state.managedFolder), { recursive: true });
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

function writeOrgKitRecord(managed, org, name, record) {
  writeFileAtomic(kitRecordPath(managed, org, name), yaml.dump(record, { lineWidth: 120 }));
}

function createManagedKit(body) {
  const { details, value } = validateCreateBody(body);
  if (details.length) {
    const err = new Error('Kit create payload is invalid.');
    err.code = 'EINVALID';
    err.details = details;
    throw err;
  }
  if (state.tombstones.has(value.name) || (state.managedFolder && (() => {
    const record = readOrgKitRecord(kitRecordPath(state.managedFolder, defaultOrgId(), value.name));
    return record && record.deletedAt;
  })())) {
    const err = new Error('kit was deleted; restore is not supported yet');
    err.code = 'ECONFLICT';
    throw err;
  }
  if (state.kits.has(value.name)) {
    const err = new Error(`Kit already exists: ${value.name}`);
    err.code = 'ECONFLICT';
    throw err;
  }
  const managed = ensureManagedFolder();
  const org = defaultOrgId();
  const kitHome = path.join(orgKitsRoot(managed, org), value.name);
  const versionRoot = kitVersionDir(managed, org, value.name, 1);
  if (fs.existsSync(kitHome) || fs.existsSync(versionRoot)) {
    const err = new Error(`Kit already exists: ${value.name}`);
    err.code = 'ECONFLICT';
    throw err;
  }
  fs.mkdirSync(versionRoot, { recursive: true });
  const now = new Date().toISOString();
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
    writeFileAtomic(path.join(versionRoot, 'kit.yaml'), yaml.dump(manifest, { lineWidth: 120 }));
    writeFileAtomic(path.join(versionRoot, 'kit.css'), value.stylesheetText);
    for (const [file, content] of value.fileMap.entries()) {
      if (file === 'kit.css') continue;
      writeFileAtomic(path.join(versionRoot, file), content);
    }
    const sizeBytes = dirSizeBytes(versionRoot);
    const record = {
      name: value.name,
      label: value.label,
      version: value.version,
      description: value.description,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      versions: [{ version: 1, createdAt: now, sizeBytes }],
    };
    writeOrgKitRecord(managed, org, value.name, record);
  } catch (error) {
    try { fs.rmSync(kitHome, { recursive: true, force: true }); } catch (_) { /* ignore */ }
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
  if (kit.scope !== 'org' || kit.source !== 'org') {
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
  const managed = ensureManagedFolder();
  const org = kit.org || defaultOrgId();
  const nextVersion = kit.currentVersion + 1;
  const prevRoot = kitVersionDir(managed, org, kit.name, kit.currentVersion);
  const nextRoot = kitVersionDir(managed, org, kit.name, nextVersion);
  if (fs.existsSync(nextRoot)) {
    const err = new Error(`Kit version already exists: ${nextVersion}`);
    err.code = 'ECONFLICT';
    throw err;
  }
  const tempRoot = `${nextRoot}.${process.pid}.${Date.now()}.tmp`;
  try {
    copyDirVerified(prevRoot, tempRoot);
    writeFileAtomic(path.join(tempRoot, safe), content);
    // Keep the snapshot manifest file list in sync for templates/examples.
    if (safe !== kit.stylesheet) {
      const manifestPath = path.join(tempRoot, 'kit.yaml');
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
    const listed = new Set([kit.stylesheet, ...kit.files, safe]);
    if (listed.size > MAX_FILES) {
      const err = new Error(`Kit may have at most ${MAX_FILES} files.`);
      err.code = 'EINVALID';
      err.details = [{ path: 'files', message: `at most ${MAX_FILES} files` }];
      throw err;
    }
    fs.renameSync(tempRoot, nextRoot);
  } catch (error) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw error;
  }

  const now = new Date().toISOString();
  const recordPath = kitRecordPath(managed, org, kit.name);
  const existing = readOrgKitRecord(recordPath) || {};
  const versionEntries = normalizeVersionEntries(existing, managed, org, kit.name)
    .filter((entry) => entry.version !== nextVersion);
  versionEntries.push({
    version: nextVersion,
    createdAt: now,
    sizeBytes: dirSizeBytes(nextRoot),
  });
  const record = {
    name: kit.name,
    label: typeof existing.label === 'string' ? existing.label : kit.label,
    version: typeof existing.version !== 'undefined' && existing.version !== null
      ? String(existing.version)
      : kit.version,
    description: typeof existing.description === 'string' ? existing.description : kit.description,
    currentVersion: nextVersion,
    createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
    deletedAt: null,
    versions: versionEntries.sort((a, b) => a.version - b.version),
  };
  writeOrgKitRecord(managed, org, kit.name, record);
  return safe;
}

function deleteManagedKit(name) {
  const kit = getKitRecord(name);
  if (!kit) {
    const err = new Error(`Unknown kit: ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  if (kit.scope !== 'org' || kit.source !== 'org') {
    const err = new Error('Kit is read-only.');
    err.code = 'EREADONLY';
    throw err;
  }
  const managed = ensureManagedFolder();
  const org = kit.org || defaultOrgId();
  const recordPath = kitRecordPath(managed, org, kit.name);
  const existing = readOrgKitRecord(recordPath) || {};
  const now = new Date().toISOString();
  const record = {
    name: kit.name,
    label: typeof existing.label === 'string' ? existing.label : kit.label,
    version: typeof existing.version !== 'undefined' && existing.version !== null
      ? String(existing.version)
      : kit.version,
    description: typeof existing.description === 'string' ? existing.description : kit.description,
    currentVersion: kit.currentVersion,
    createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
    deletedAt: now,
    versions: normalizeVersionEntries(existing, managed, org, kit.name),
  };
  writeOrgKitRecord(managed, org, kit.name, record);
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
  const target = overlayPathFor(managed, name, defaultOrgId());

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
  DEFAULT_ORG,
  CREATE_NAME_PATTERN,
  ORG_ID_PATTERN,
  MAX_FILE_BYTES,
  MAX_FILES,
  loadKits,
  listKits,
  getKit,
  getDeletedKit,
  getKitRecord,
  readKitFile,
  readKitStylesheet,
  readKitStylesheetAtVersion,
  kitsRevision,
  kitsEnabled,
  defaultKitName,
  managedFolderPath,
  defaultOrgId,
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
  migrateFlatManagedLayout,
  overlayPathFor,
  kitVersionDir,
  orgKitsRoot,
  orgOverlaysRoot,
  sharedRoot,
};
