'use strict';

// Hosted HTML kits: config-driven folders of kit.yaml + stylesheet + templates.
// Modelled on wallpapers/appearance (load, watch, public projection, no host paths).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_BUNDLED_ROOT = path.join(__dirname, '..', 'kits');

let state = {
  enabled: true,
  defaultName: null,
  kits: new Map(), // name -> kit record
  watchTargets: [],
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

function scanRoot(root, source, warn) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      warn(`Warning: kits folder missing (${root}); skipped`);
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
    });
  }
  return found;
}

function loadKits({
  folders = [],
  bundledRoot = DEFAULT_BUNDLED_ROOT,
  enabled = true,
  default: defaultName,
  warn = console.warn,
} = {}) {
  const kits = new Map();
  const watchTargets = [];

  if (!enabled) {
    state = { enabled: false, defaultName: null, kits, watchTargets };
    return { kits: [], default: null, watch: watchTargets };
  }

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
      kits.set(kit.name, kit); // config wins on name clash
    }
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

  state = { enabled: true, defaultName: resolvedDefault, kits, watchTargets };
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
  const projection = {
    name: kit.name,
    label: kit.label,
    version: kit.version,
    description: kit.description,
    stylesheetUrl: `/kit/${encodeURIComponent(kit.name)}/kit.css`,
    templates: kit.templates.map((file) => projectFileRef(kit, file)),
    examples: kit.examples.map((file) => projectFileRef(kit, file)),
    consumes: [...kit.consumes],
    source: kit.source,
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

function kitsRevision() {
  const parts = [...state.kits.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((kit) => {
      const mt = Object.keys(kit.fileMtimes).sort()
        .map((file) => `${file}:${kit.fileMtimes[file]}`)
        .join(',');
      return `${kit.name}@${kit.version}:${kit.source}:{${mt}}`;
    });
  parts.push(`default:${state.defaultName || ''}`);
  parts.push(`enabled:${state.enabled ? '1' : '0'}`);
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

// Live reload. Watches every kit root (and the bundled/config parent folders);
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
  loadKits,
  listKits,
  getKit,
  getKitRecord,
  readKitFile,
  kitsRevision,
  kitsEnabled,
  defaultKitName,
  watchTargets,
  watchKits,
  contentTypeFor,
  projectKit,
};
