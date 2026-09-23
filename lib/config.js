'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { configuredDestinationRoots } = require('./forms/destination-adapter');

const DEFAULT_PORT = 9876;
const DEFAULT_HOSTNAME = 'localhost';
const CONFIG_FILENAME = 'lookie-link.yaml';

function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function normalizeRepoName(name) {
  return String(name || '').trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Load lookie-link.yaml config file.
 * Search order: LOOKIE_LINK_CONFIG env → ~/.config/lookie-link/lookie-link.yaml → project root (fallback)
 * Returns null if no config file exists.
 */
function loadConfigFile() {
  const candidates = [];

  // 1. Env override (highest priority)
  if (process.env.LOOKIE_LINK_CONFIG) {
    candidates.push(path.resolve(expandHome(process.env.LOOKIE_LINK_CONFIG)));
  }

  // 2. User config dir (~/.config/lookie-link/lookie-link.yaml)
  candidates.push(path.join(os.homedir(), '.config', 'lookie-link', CONFIG_FILENAME));

  // 3. Project root (fallback for development)
  candidates.push(path.resolve(__dirname, '..', CONFIG_FILENAME));

  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        console.log(`Loaded config from ${configPath}`);
        return parsed;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Warning: Failed to parse ${configPath}: ${error.message}`);
      }
    }
  }

  return null;
}

/**
 * Parse ROOT_MAPPINGS env var (legacy support).
 */
function parseRootMappingsEnv(raw) {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid ROOT_MAPPINGS JSON: ${error.message}`);
    }
    const output = {};

    for (const [repo, dir] of Object.entries(parsed)) {
      const key = normalizeRepoName(repo);
      if (!key || !dir) {
        continue;
      }

      output[key] = path.resolve(expandHome(String(dir)));
    }

    return output;
  }

  const output = {};
  const pairs = trimmed.split(',');

  for (const pair of pairs) {
    const [rawRepo, ...dirParts] = pair.split('=');
    const repo = normalizeRepoName(rawRepo);
    const dir = dirParts.join('=').trim();

    if (!repo || !dir) {
      continue;
    }

    output[repo] = path.resolve(expandHome(dir));
  }

  return output;
}

const DEFAULT_REPOS = {
  // Configure your repos in lookie-link.yaml or ROOT_MAPPINGS env var.
  // Example: { "my-docs": "~/Documents/docs", "notes": "~/notes" }
};

let _config = null;

function getConfig() {
  if (!_config) {
    _config = loadConfigFile() || {};
  }
  return _config;
}

function loadRootMappings() {
  // Priority: ROOT_MAPPINGS env > lookie-link.yaml > defaults
  const envMappings = parseRootMappingsEnv(process.env.ROOT_MAPPINGS);
  if (envMappings && Object.keys(envMappings).length > 0) {
    return envMappings;
  }

  const config = getConfig();
  if (config.repositories && typeof config.repositories === 'object') {
    const output = {};
    for (const [repo, dir] of Object.entries(config.repositories)) {
      const key = normalizeRepoName(repo);
      if (!key || !dir) {
        continue;
      }
      output[key] = path.resolve(expandHome(String(dir)));
    }
    if (Object.keys(output).length > 0) {
      return output;
    }
  }

  return DEFAULT_REPOS;
}

function getPort() {
  // Priority: PORT env > lookie-link.yaml > default
  const rawEnv = process.env.PORT;
  if (rawEnv) {
    const value = Number(rawEnv);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid PORT value: ${rawEnv}`);
    }
    return value;
  }

  const config = getConfig();
  if (config.server && config.server.port) {
    const value = Number(config.server.port);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      return value;
    }
  }

  return DEFAULT_PORT;
}

function getHostname() {
  const rawEnv = process.env.HOSTNAME;
  if (rawEnv && rawEnv.trim()) {
    return rawEnv.trim();
  }

  const config = getConfig();
  if (config.server && config.server.hostname) {
    return String(config.server.hostname).trim();
  }

  return DEFAULT_HOSTNAME;
}

function getAccessConfig() {
  const config = getConfig();
  if (config.access && typeof config.access === 'object') {
    return config.access;
  }

  return {};
}

function getManagedReposConfig() {
  const config = getConfig();
  if (!config.managedRepos || typeof config.managedRepos !== 'object') {
    return {};
  }

  return {
    ...config.managedRepos,
    storePath: config.managedRepos.storePath
      ? path.resolve(expandHome(String(config.managedRepos.storePath)))
      : undefined,
    allowRoots: Array.isArray(config.managedRepos.allowRoots)
      ? config.managedRepos.allowRoots.map((entry) => path.resolve(expandHome(String(entry))))
      : [],
  };
}

function getPublishConfig() {
  const config = getConfig();
  if (!config.publish || typeof config.publish !== 'object') {
    return {};
  }

  return {
    ...config.publish,
    areaPath: typeof config.publish.areaPath === 'string'
      ? path.resolve(expandHome(config.publish.areaPath))
      : config.publish.areaPath,
  };
}

function getFormsConfig() {
  const config = getConfig();
  if (!config.forms || typeof config.forms !== 'object') {
    return {};
  }

  const enabled = parseBoolean(config.forms.enabled) === true;
  const destinations = config.forms.destinations !== undefined
    || typeof config.forms.submissionsPath === 'string'
    ? configuredDestinationRoots(config.forms)
    : undefined;
  return {
    enabled,
    templatesPath: typeof config.forms.templatesPath === 'string'
      ? path.resolve(expandHome(config.forms.templatesPath))
      : undefined,
    submissionsPath: typeof config.forms.submissionsPath === 'string'
      ? path.resolve(expandHome(config.forms.submissionsPath))
      : undefined,
    destinations,
    timezone: typeof config.forms.timezone === 'string'
      ? config.forms.timezone
      : undefined,
    publicOrigins: Array.isArray(config.forms.publicOrigins)
      ? config.forms.publicOrigins.filter((origin) => typeof origin === 'string')
      : typeof config.forms.publicOrigin === 'string'
        ? [config.forms.publicOrigin]
        : undefined,
  };
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

const BUILT_IN_THEMES = ['slate', 'teal', 'nord', 'rose-pine', 'monokai', 'solarized', 'github', 'ember', 'noir', 'indigo', 'codex'];

const THEME_CSS_PROPERTIES = [
  'bg', 'bg-elev', 'bg-code', 'text', 'text-soft', 'accent', 'border', 'link',
  'page-bg', 'toolbar-bg', 'toolbar-btn-bg', 'toolbar-btn-hover', 'toolbar-btn-text',
  'toc-active-bg', 'heading-font',
];

const ALIAS_PATTERN = /^[a-z0-9-]+$/;

function loadCustomThemes() {
  const config = getConfig();
  if (!config.themes || typeof config.themes !== 'object') {
    return [];
  }

  const custom = [];
  // Tracks every name already claimed by a built-in theme, a custom theme's
  // canonical slug, or an accepted alias -- an alias must not collide with any
  // of them, so this one set is checked (and grown) across the whole pass.
  const claimed = new Set(BUILT_IN_THEMES);

  for (const [name, def] of Object.entries(config.themes)) {
    if (!def || typeof def !== 'object') {
      continue;
    }

    const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug || BUILT_IN_THEMES.includes(slug)) {
      console.warn(`Warning: skipping theme "${name}" (reserved or invalid name)`);
      continue;
    }
    if (claimed.has(slug)) {
      console.warn(`Warning: skipping theme "${name}" (slug "${slug}" is already used by another theme or alias)`);
      continue;
    }
    claimed.add(slug);

    const theme = { slug, label: String(name).trim(), dark: {}, light: {}, aliases: [] };

    if (def.dark && typeof def.dark === 'object') {
      for (const prop of THEME_CSS_PROPERTIES) {
        const yamlKey = prop.replace(/-/g, '_');
        if (def.dark[yamlKey] !== undefined) {
          theme.dark[prop] = String(def.dark[yamlKey]);
        }
      }
    }

    if (def.light && typeof def.light === 'object') {
      for (const prop of THEME_CSS_PROPERTIES) {
        const yamlKey = prop.replace(/-/g, '_');
        if (def.light[yamlKey] !== undefined) {
          theme.light[prop] = String(def.light[yamlKey]);
        }
      }
    }

    // Optional aliases: additional slugs that render this same theme (#389).
    // Each must be well-formed and unclaimed by a built-in, another custom
    // theme's slug, or another alias (including a duplicate within this list).
    if (Array.isArray(def.aliases)) {
      for (const rawAlias of def.aliases) {
        const alias = String(rawAlias).trim().toLowerCase();
        if (!ALIAS_PATTERN.test(alias)) {
          console.warn(`Warning: skipping alias "${rawAlias}" for theme "${name}" (aliases must match /^[a-z0-9-]+$/)`);
          continue;
        }
        if (claimed.has(alias)) {
          console.warn(`Warning: skipping alias "${alias}" for theme "${name}" (already used by a built-in theme, another custom theme, or another alias)`);
          continue;
        }
        claimed.add(alias);
        theme.aliases.push(alias);
      }
    }

    // Optional wallpapers: one folder of images per mode. The viewer scans the
    // folder at startup and serves the images itself, so the folder can live
    // anywhere on the host (an Omarchy theme's backgrounds directory, say).
    if (def.wallpapers && typeof def.wallpapers === 'object') {
      theme.wallpapers = {};
      for (const mode of ['dark', 'light']) {
        if (typeof def.wallpapers[mode] === 'string' && def.wallpapers[mode].trim()) {
          theme.wallpapers[mode] = path.resolve(expandHome(def.wallpapers[mode].trim()));
        }
      }
      // Per-theme presentation: starting picture per mode and the glass
      // defaults. Anything absent falls back to the global `wallpapers:` block.
      const starts = def.wallpapers.default;
      if (starts && typeof starts === 'object') {
        theme.wallpapers.default = {};
        for (const mode of ['dark', 'light']) {
          if (typeof starts[mode] === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(starts[mode])) theme.wallpapers.default[mode] = starts[mode];
        }
      }
      const opacity = wallpaperInteger(def.wallpapers.panel_opacity, 50, 100);
      if (opacity !== null) theme.wallpapers.panelOpacity = opacity;
      const blur = wallpaperInteger(def.wallpapers.blur, 0, 16);
      if (blur !== null) theme.wallpapers.blur = blur;
    }

    if (Object.keys(theme.dark).length > 0 || Object.keys(theme.light).length > 0) {
      custom.push(theme);
    }
  }

  return custom;
}

function wallpaperInteger(value, min, max) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Global `wallpapers:` block: the glass defaults every theme starts from.
//   wallpapers:
//     panel_opacity: 72   # 50-100
//     blur: 12            # 0-16 px
function getWallpaperDefaults() {
  const config = getConfig();
  const block = config.wallpapers && typeof config.wallpapers === 'object' ? config.wallpapers : {};
  const opacity = wallpaperInteger(block.panel_opacity, 50, 100);
  const blur = wallpaperInteger(block.blur, 0, 16);
  return { panelOpacity: opacity === null ? 72 : opacity, blur: blur === null ? 12 : blur };
}

const WALLPAPER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const WALLPAPER_LIMIT = 50;
const WALLPAPER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Derives a stable id and a human label from a wallpaper filename. Omarchy
// names files "<n>-<theme>-<words>.jpg"; the numeric prefix orders the set and
// the theme prefix is dropped so the label reads as just the picture's name.
function wallpaperEntry(filename, slug) {
  const stem = path.basename(filename, path.extname(filename)).toLowerCase();
  const order = /^(\d+)-/.exec(stem);
  let id = stem.replace(/^\d+-/, '');
  id = id.replace(new RegExp('^' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-light)?-'), '');
  id = id.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!WALLPAPER_ID_PATTERN.test(id)) return null;
  const label = id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { id, label, file: filename, order: order ? Number(order[1]) : Number.MAX_SAFE_INTEGER };
}

// Scans each theme's wallpaper folders once. Result: { [slug]: { dark: [...],
// light: [...] } } where each entry is { id, label, file } and file is the
// absolute path the server may send. Missing or unreadable folders yield an
// empty list with a warning; they never fail startup.
function loadWallpaperCatalog(themes) {
  const catalog = {};
  for (const theme of themes) {
    if (!theme.wallpapers) continue;
    const sets = { dark: [], light: [] };
    for (const mode of ['dark', 'light']) {
      const dir = theme.wallpapers[mode];
      if (!dir) continue;
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        console.warn(`Warning: wallpapers for theme "${theme.label}" (${mode}): cannot read ${dir} (${error.code || error.message})`);
        continue;
      }
      const seen = new Set();
      const entries = [];
      for (const name of names) {
        if (!WALLPAPER_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        const entry = wallpaperEntry(name, theme.slug);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push({ ...entry, file: path.join(dir, name) });
      }
      entries.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
      sets[mode] = entries.slice(0, WALLPAPER_LIMIT).map(({ id, label, file }) => ({ id, label, file }));
    }
    if (sets.dark.length || sets.light.length) {
      // A configured starting picture moves to the front of its set, so "the
      // set's first" and "the theme default" stay the same thing everywhere.
      for (const mode of ['dark', 'light']) {
        const start = theme.wallpapers.default && theme.wallpapers.default[mode];
        const index = start ? sets[mode].findIndex((item) => item.id === start) : -1;
        if (index > 0) sets[mode].unshift(sets[mode].splice(index, 1)[0]);
        else if (start && index < 0 && sets[mode].length) console.warn(`Warning: wallpapers for theme "${theme.label}" (${mode}): default "${start}" is not in the set`);
      }
      if (theme.wallpapers.panelOpacity !== undefined) sets.panelOpacity = theme.wallpapers.panelOpacity;
      if (theme.wallpapers.blur !== undefined) sets.blur = theme.wallpapers.blur;
      catalog[theme.slug] = sets;
    }
  }
  return catalog;
}

function generateCustomThemeCss(themes) {
  if (!themes.length) {
    return '';
  }

  const blocks = [];
  for (const theme of themes) {
    // An alias (#389) is just another selector value that renders the same
    // theme -- the canonical slug and each alias each get their own block.
    const slugs = [theme.slug, ...(theme.aliases || [])];
    if (Object.keys(theme.dark).length > 0) {
      const vars = Object.entries(theme.dark).map(([k, v]) => `  --${k}: ${v};`).join('\n');
      for (const slug of slugs) {
        blocks.push(`:root[data-color-scheme="${slug}"] {\n  color-scheme: dark;\n${vars}\n}`);
        // Reveal this theme's name in the toolbar label without waiting for script.
        blocks.push(`:root[data-color-scheme="${slug}"] [data-theme-name="${slug}"] { display: inline; }`);
      }
    }
    if (Object.keys(theme.light).length > 0) {
      const vars = Object.entries(theme.light).map(([k, v]) => `  --${k}: ${v};`).join('\n');
      for (const slug of slugs) {
        blocks.push(`:root[data-color-scheme="${slug}"][data-theme="light"] {\n  color-scheme: light;\n${vars}\n}`);
      }
    }
  }

  return blocks.join('\n\n');
}

function getEditingEnabled() {
  const rawEnv = process.env.LOOKIE_LINK_ENABLE_EDITING;
  if (typeof rawEnv === 'string') {
    const parsedEnv = parseBoolean(rawEnv);
    if (parsedEnv !== null) {
      return parsedEnv;
    }
  }

  const config = getConfig();
  if (config.server && Object.prototype.hasOwnProperty.call(config.server, 'enableEditing')) {
    const parsedConfig = parseBoolean(config.server.enableEditing);
    if (parsedConfig !== null) {
      return parsedConfig;
    }
  }

  return false;
}

function getAnnotationsEnabled() {
  const rawEnv = process.env.LOOKIE_LINK_ENABLE_ANNOTATIONS;
  if (typeof rawEnv === 'string') {
    const parsedEnv = parseBoolean(rawEnv);
    if (parsedEnv !== null) {
      return parsedEnv;
    }
  }

  const config = getConfig();
  if (config.server && Object.prototype.hasOwnProperty.call(config.server, 'enableAnnotations')) {
    const parsedConfig = parseBoolean(config.server.enableAnnotations);
    if (parsedConfig !== null) {
      return parsedConfig;
    }
  }

  return false;
}

// Raw HTML serving.
//
// TRUST ASSUMPTION
// ----------------
// When enabled, the /raw/<repo>/<path>.html endpoint returns the file body
// verbatim with `text/html` content type — no DOMPurify sanitization, no
// viewer chrome. Inline <script> tags execute. This is required for
// self-contained interactive HTML artifacts (e.g. NotebookLM flashcards/quiz)
// to function in the browser.
//
// Enable this ONLY for instances on trusted private networks (Tailscale,
// home LAN, etc.) where:
//   1. Every file under the configured roots is authored by you or by tools
//      you trust (NotebookLM exports, your own notes, etc.).
//   2. There is no untrusted upload path that can land arbitrary HTML in a
//      mapped repo.
//
// Same-origin caveat: a raw HTML file at /raw/<repo>/foo.html runs on the
// same origin as the rest of Lookie-Link. A malicious file could call the
// /api/save or /api/grants endpoints with the current viewer's token. Keep
// the default off, and only flip it on when the above conditions hold.
//
// Existing /view/<repo>/foo.html continues to sanitize + wrap regardless of
// this flag — the safer-by-default path is unchanged.
function getRawHtmlEnabled() {
  const rawEnv = process.env.LOOKIE_LINK_ENABLE_RAW_HTML;
  if (typeof rawEnv === 'string') {
    const parsedEnv = parseBoolean(rawEnv);
    if (parsedEnv !== null) {
      return parsedEnv;
    }
  }

  const config = getConfig();
  if (config.server && Object.prototype.hasOwnProperty.call(config.server, 'enableRawHtml')) {
    const parsedConfig = parseBoolean(config.server.enableRawHtml);
    if (parsedConfig !== null) {
      return parsedConfig;
    }
  }

  return false;
}

module.exports = {
  loadWallpaperCatalog,
  getWallpaperDefaults,
  loadRootMappings,
  getPort,
  getHostname,
  getEditingEnabled,
  getAnnotationsEnabled,
  getRawHtmlEnabled,
  getAccessConfig,
  getManagedReposConfig,
  getPublishConfig,
  getFormsConfig,
  loadCustomThemes,
  generateCustomThemeCss,
  BUILT_IN_THEMES,
};
