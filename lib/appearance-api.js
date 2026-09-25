'use strict';

// Appearance API (API review 2026-09-23 item 5): the pollable list of what
// exists (themes, palettes, aliases, picture sets, glass defaults) and the
// admin write side that changes it without touching the operator's YAML.
//
// Read side is open to any non-denied caller and never leaks host paths.
// Write side needs an appearance admin bearer token (access.appearance.
// adminTokens, same shape as the grant/API-key admin tokens), an
// expectedRevision guard, validation that refuses rather than silently skips,
// and an audit event per change. Writes land in the server-owned overlay
// file (lib/config.js APPEARANCE_OVERLAY_FILENAME); the existing config
// watcher then reloads themes and wallpapers live.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const yaml = require('js-yaml');
const { apiError } = require('./api-error');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WALLPAPER_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const UPLOAD_LIMIT = '24mb';

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractBearer(req) {
  const header = req.get('authorization');
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1].trim() : null;
}

function resolveAdminTokens(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).flatMap(([name, def]) => {
    if (!def || typeof def !== 'object') return [];
    const secret = typeof def.secret === 'string' && def.secret
      ? def.secret
      : (typeof def.secretEnv === 'string' && process.env[def.secretEnv]) || null;
    return secret ? [{ name, secret }] : [];
  });
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Public projection of one theme: what a caller may see. Folder paths are
// replaced by the managed/unmanaged distinction so nothing about the host
// filesystem leaves the server.
function projectTheme(theme, sets, defaults, managedFolders) {
  const wallpapers = { dark: [], light: [], panelOpacity: defaults.panelOpacity, blur: defaults.blur, managed: { dark: false, light: false } };
  if (sets) {
    wallpapers.dark = sets.dark.map(({ id, label }) => ({ id, label }));
    wallpapers.light = sets.light.map(({ id, label }) => ({ id, label }));
    if (sets.panelOpacity !== undefined) wallpapers.panelOpacity = sets.panelOpacity;
    if (sets.blur !== undefined) wallpapers.blur = sets.blur;
  }
  for (const mode of ['dark', 'light']) {
    const folder = theme.wallpapers && theme.wallpapers[mode];
    wallpapers.managed[mode] = Boolean(folder && managedFolders && folder === managedFolders(theme.slug, mode));
  }
  return {
    id: theme.slug,
    label: theme.label,
    aliases: [...(theme.aliases || [])],
    dark: { ...theme.dark },
    light: { ...theme.light },
    wallpapers,
  };
}

// Registers directly on the app (not a Router) so the routes are first-class
// in the route-availability scan and the authoritative route matrix.
function registerAppearanceRoutes(app, options) {
  const {
    overlayPath,            // server-owned YAML written by this API
    managedRoot,            // folder that receives uploaded pictures
    adminTokens,            // access.appearance.adminTokens map
    readState,              // () => ({ themes, catalog, defaults, revision })
    validate,               // (mergedConfig) => { themes, warnings[] }
    afterWrite,             // () => void  (force a reload; the watcher also fires)
    audit,                  // (type, req, target, metadata) => void
    resolveAccess,          // (req) => accessContext
    sendAccessError,        // (res, accessContext) => void
    themeProperties,        // allowed palette keys (hyphenated)
  } = options;
  const router = app;
  const tokens = resolveAdminTokens(adminTokens);

  const managedFolder = (slug, mode) => (managedRoot ? path.join(managedRoot, slug, mode) : null);

  function readOverlay() {
    try {
      const parsed = yaml.load(fs.readFileSync(overlayPath, 'utf8'));
      return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
  function currentRevision(overlay) {
    return Number.isInteger(overlay.revision) && overlay.revision >= 0 ? overlay.revision : 0;
  }
  function writeOverlay(overlay, revision) {
    const next = { ...overlay, revision, updatedAt: new Date().toISOString() };
    writeFileAtomic(overlayPath, `# Written by the Lookie-Link appearance API. Do not hand-edit; the operator's\n# config file stays the base and this overlay wins where both set a key.\n${yaml.dump(next, { lineWidth: 120 })}`);
    return next;
  }

  function requireAdmin(req, res) {
    if (!tokens.length) {
      apiError(res, 404, 'feature_disabled', 'Appearance admin tokens are not configured.');
      return false;
    }
    const secret = extractBearer(req);
    if (!secret) {
      apiError(res, 401, 'unauthenticated', 'Appearance admin authentication required.');
      return false;
    }
    const admin = tokens.find((token) => constantTimeEqual(token.secret, secret));
    if (!admin) {
      apiError(res, 403, 'forbidden', 'Invalid appearance admin token.');
      return false;
    }
    req.appearanceAdmin = admin.name;
    return true;
  }

  function gate(req, res) {
    const accessContext = req.accessContext || (resolveAccess ? resolveAccess(req) : { mode: 'unrestricted' });
    if (accessContext.mode === 'denied') {
      sendAccessError(res, accessContext);
      return false;
    }
    return true;
  }

  function snapshot() {
    const state = readState();
    const overlay = readOverlay();
    const revision = currentRevision(overlay);
    const themes = state.themes.map((theme) => projectTheme(theme, state.catalog[theme.slug], state.defaults, managedFolder));
    return { revision, overlay, themes, defaults: state.defaults };
  }

  function sendWithEtag(req, res, revision, body) {
    const etag = `W/"appearance-${revision}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');
    if (req.get('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).json(body);
  }

  // ---- Read side --------------------------------------------------------

  router.get('/api/appearance', (req, res) => {
    if (!gate(req, res)) return;
    const snap = snapshot();
    sendWithEtag(req, res, snap.revision, {
      ok: true,
      revision: snap.revision,
      generatedAt: new Date().toISOString(),
      parameters: { scheme: 'lookie-scheme', mode: 'lookie-theme', wallpaper: 'lookie-wallpaper', panelOpacity: 'lookie-panel', blur: 'lookie-blur' },
      defaults: { panelOpacity: snap.defaults.panelOpacity, blur: snap.defaults.blur },
      count: snap.themes.length,
      themes: snap.themes,
    });
  });

  router.get('/api/appearance/themes/:slug', (req, res) => {
    if (!gate(req, res)) return;
    const snap = snapshot();
    const slug = String(req.params.slug || '').toLowerCase();
    const theme = snap.themes.find((item) => item.id === slug || item.aliases.includes(slug));
    if (!theme) {
      apiError(res, 404, 'not_found', `Unknown theme: ${slug}`);
      return;
    }
    sendWithEtag(req, res, snap.revision, { ok: true, revision: snap.revision, theme });
  });

  // ---- Write side -------------------------------------------------------

  function validateThemePatch(name, def, details) {
    if (def === null) return; // deletion marker
    if (!isPlainObject(def)) { details.push({ path: `themes.${name}`, message: 'must be an object or null' }); return; }
    for (const key of Object.keys(def)) {
      if (!['dark', 'light', 'aliases', 'wallpapers'].includes(key)) details.push({ path: `themes.${name}.${key}`, message: 'unknown key' });
    }
    for (const mode of ['dark', 'light']) {
      if (def[mode] === undefined) continue;
      if (!isPlainObject(def[mode])) { details.push({ path: `themes.${name}.${mode}`, message: 'must be an object' }); continue; }
      for (const [prop, value] of Object.entries(def[mode])) {
        const hyphen = prop.replace(/_/g, '-');
        if (!themeProperties.includes(hyphen)) details.push({ path: `themes.${name}.${mode}.${prop}`, message: 'unknown palette key' });
        else if (typeof value !== 'string' || !value.trim() || value.length > 200) details.push({ path: `themes.${name}.${mode}.${prop}`, message: 'must be a non-empty string' });
      }
    }
    if (def.aliases !== undefined) {
      if (!Array.isArray(def.aliases)) details.push({ path: `themes.${name}.aliases`, message: 'must be an array' });
      else def.aliases.forEach((alias, i) => { if (typeof alias !== 'string' || !/^[a-z0-9-]+$/.test(alias)) details.push({ path: `themes.${name}.aliases[${i}]`, message: 'aliases match /^[a-z0-9-]+$/' }); });
    }
    if (def.wallpapers !== undefined) {
      if (!isPlainObject(def.wallpapers)) { details.push({ path: `themes.${name}.wallpapers`, message: 'must be an object' }); return; }
      for (const [key, value] of Object.entries(def.wallpapers)) {
        if (key === 'dark' || key === 'light') {
          if (typeof value !== 'string' || !value.trim()) details.push({ path: `themes.${name}.wallpapers.${key}`, message: 'must be a folder path' });
        } else if (key === 'default') {
          if (!isPlainObject(value)) details.push({ path: `themes.${name}.wallpapers.default`, message: 'must be an object' });
          else for (const mode of Object.keys(value)) {
            if (!['dark', 'light'].includes(mode) || typeof value[mode] !== 'string' || !SLUG_PATTERN.test(value[mode])) details.push({ path: `themes.${name}.wallpapers.default.${mode}`, message: 'must be a picture id' });
          }
        } else if (key === 'panel_opacity') {
          if (!Number.isInteger(value) || value < 50 || value > 100) details.push({ path: `themes.${name}.wallpapers.panel_opacity`, message: 'integer 50-100' });
        } else if (key === 'blur') {
          if (!Number.isInteger(value) || value < 0 || value > 16) details.push({ path: `themes.${name}.wallpapers.blur`, message: 'integer 0-16' });
        } else details.push({ path: `themes.${name}.wallpapers.${key}`, message: 'unknown key' });
      }
    }
  }

  function validatePatch(body) {
    const details = [];
    if (!isPlainObject(body)) return [{ path: '', message: 'body must be a JSON object' }];
    for (const key of Object.keys(body)) {
      if (!['expectedRevision', 'wallpapers', 'themes'].includes(key)) details.push({ path: key, message: 'unknown key' });
    }
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) details.push({ path: 'expectedRevision', message: 'integer revision from the last read is required' });
    if (body.wallpapers !== undefined) {
      if (!isPlainObject(body.wallpapers)) details.push({ path: 'wallpapers', message: 'must be an object' });
      else for (const [key, value] of Object.entries(body.wallpapers)) {
        if (key === 'panel_opacity') { if (!Number.isInteger(value) || value < 50 || value > 100) details.push({ path: 'wallpapers.panel_opacity', message: 'integer 50-100' }); }
        else if (key === 'blur') { if (!Number.isInteger(value) || value < 0 || value > 16) details.push({ path: 'wallpapers.blur', message: 'integer 0-16' }); }
        else details.push({ path: `wallpapers.${key}`, message: 'unknown key' });
      }
    }
    if (body.themes !== undefined) {
      if (!isPlainObject(body.themes)) details.push({ path: 'themes', message: 'must be an object keyed by theme name' });
      else for (const [name, def] of Object.entries(body.themes)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name)) details.push({ path: `themes.${name}`, message: 'theme names are 1-64 letters, digits, spaces, _ or -' });
        validateThemePatch(name, def, details);
      }
    }
    return details;
  }

  // PATCH semantics on the overlay: the body's keys are merged over what the
  // overlay already holds, which is itself merged over the operator's config.
  router.patch('/api/appearance', express.json({ limit: '256kb' }), (req, res) => {
    if (!requireAdmin(req, res)) return;
    const details = validatePatch(req.body);
    if (details.length) {
      apiError(res, 400, 'invalid_request', 'Appearance patch is invalid.', details);
      return;
    }
    let overlay;
    try { overlay = readOverlay(); } catch (error) {
      apiError(res, 500, 'internal_error', `Cannot read the appearance overlay: ${error.message}`);
      return;
    }
    const revision = currentRevision(overlay);
    if (req.body.expectedRevision !== revision) {
      apiError(res, 409, 'revision_conflict', 'Appearance revision is stale.', null, { currentRevision: revision });
      return;
    }
    const nextOverlay = { ...overlay };
    if (req.body.wallpapers) nextOverlay.wallpapers = { ...(isPlainObject(overlay.wallpapers) ? overlay.wallpapers : {}), ...req.body.wallpapers };
    if (req.body.themes) {
      const themes = { ...(isPlainObject(overlay.themes) ? overlay.themes : {}) };
      for (const [name, def] of Object.entries(req.body.themes)) {
        if (def === null) { themes[name] = null; continue; }
        const current = isPlainObject(themes[name]) ? themes[name] : {};
        const merged = { ...current, ...def };
        for (const key of ['dark', 'light', 'wallpapers']) {
          if (isPlainObject(def[key])) merged[key] = { ...(isPlainObject(current[key]) ? current[key] : {}), ...def[key] };
        }
        themes[name] = merged;
      }
      nextOverlay.themes = themes;
    }
    // Refuse anything the theme loader would skip with a warning: an API
    // caller gets a 400 with the reason, never a silently dropped theme.
    const verdict = validate(nextOverlay);
    if (verdict.warnings.length) {
      apiError(res, 400, 'invalid_request', 'The merged appearance config would be rejected by the theme loader.', verdict.warnings.map((message) => ({ path: 'themes', message })));
      return;
    }
    let written;
    try { written = writeOverlay(nextOverlay, revision + 1); } catch (error) {
      apiError(res, 500, 'internal_error', `Cannot write the appearance overlay: ${error.message}`);
      return;
    }
    if (afterWrite) afterWrite();
    if (audit) audit('appearance.update', req, { overlay: path.basename(overlayPath) }, { revision: written.revision, keys: Object.keys(req.body).filter((k) => k !== 'expectedRevision'), admin: req.appearanceAdmin });
    const snap = snapshot();
    res.status(200).json({ ok: true, revision: snap.revision, defaults: snap.defaults, themes: snap.themes });
  });

  // Picture upload: raw image body, name from ?name= (becomes the id). Only
  // the server-managed folder is ever written; a theme whose pictures come
  // from elsewhere (an Omarchy set) is refused with the folder distinction.
  router.post('/api/appearance/themes/:slug/wallpapers/:mode', express.raw({ type: Object.keys(WALLPAPER_TYPES), limit: UPLOAD_LIMIT }), (req, res) => {
    if (!requireAdmin(req, res)) return;
    const mode = req.params.mode;
    const slug = String(req.params.slug || '').toLowerCase();
    const state = readState();
    const theme = state.themes.find((item) => item.slug === slug || (item.aliases || []).includes(slug));
    if (!theme) { apiError(res, 404, 'not_found', `Unknown theme: ${slug}`); return; }
    if (mode !== 'dark' && mode !== 'light') { apiError(res, 400, 'invalid_request', 'mode must be dark or light.', [{ path: 'mode', message: 'dark or light' }]); return; }
    if (!managedRoot) { apiError(res, 404, 'feature_disabled', 'Managed wallpaper folder is not configured.'); return; }
    const extension = WALLPAPER_TYPES[(req.get('content-type') || '').split(';')[0].trim()];
    if (!extension || !Buffer.isBuffer(req.body) || !req.body.length) { apiError(res, 415, 'unsupported_media_type', 'Send the image bytes with Content-Type image/jpeg, image/png or image/webp.'); return; }
    const name = String(req.query.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SLUG_PATTERN.test(name)) { apiError(res, 400, 'invalid_request', 'name is required: 1-64 lowercase letters, digits or hyphens.', [{ path: 'name', message: 'picture id' }]); return; }
    const folder = managedFolder(theme.slug, mode);
    const configured = theme.wallpapers && theme.wallpapers[mode];
    if (configured && configured !== folder) {
      apiError(res, 409, 'folder_not_managed', `This theme's ${mode} pictures come from a folder the API does not manage. Point wallpapers.${mode} at the managed folder first (PATCH /api/appearance).`, null, { managedFolder: '<managed>' });
      return;
    }
    fs.mkdirSync(folder, { recursive: true });
    const existing = fs.readdirSync(folder).filter((file) => path.basename(file, path.extname(file)).replace(/^\d+-/, '') === name);
    const order = fs.readdirSync(folder).length;
    const filename = `${existing.length ? existing[0].replace(/\.[^.]+$/, '') : `${order}-${name}`}${extension}`;
    for (const stale of existing) if (stale !== filename) fs.unlinkSync(path.join(folder, stale));
    writeFileAtomic(path.join(folder, filename), req.body);
    if (!configured) {
      // First upload for this mode adopts the managed folder in the overlay.
      const overlay = readOverlay();
      const themes = { ...(isPlainObject(overlay.themes) ? overlay.themes : {}) };
      const current = isPlainObject(themes[theme.label]) ? themes[theme.label] : {};
      themes[theme.label] = { ...current, wallpapers: { ...(isPlainObject(current.wallpapers) ? current.wallpapers : {}), [mode]: folder } };
      writeOverlay({ ...overlay, themes }, currentRevision(overlay) + 1);
    }
    if (afterWrite) afterWrite();
    if (audit) audit('appearance.wallpaper.upload', req, { theme: theme.slug, mode, id: name }, { bytes: req.body.length, admin: req.appearanceAdmin });
    const snap = snapshot();
    res.status(201).json({ ok: true, revision: snap.revision, theme: snap.themes.find((item) => item.id === theme.slug) });
  });

  router.delete('/api/appearance/themes/:slug/wallpapers/:mode/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { mode } = req.params;
    const slug = String(req.params.slug || '').toLowerCase();
    const id = String(req.params.id || '');
    const state = readState();
    const theme = state.themes.find((item) => item.slug === slug || (item.aliases || []).includes(slug));
    if (!theme) { apiError(res, 404, 'not_found', `Unknown theme: ${slug}`); return; }
    if (mode !== 'dark' && mode !== 'light') { apiError(res, 400, 'invalid_request', 'mode must be dark or light.'); return; }
    if (!SLUG_PATTERN.test(id)) { apiError(res, 400, 'invalid_request', 'id must be a picture id.'); return; }
    const folder = managedFolder(theme.slug, mode);
    const configured = theme.wallpapers && theme.wallpapers[mode];
    if (!folder || configured !== folder) {
      apiError(res, 409, 'folder_not_managed', `This theme's ${mode} pictures come from a folder the API does not manage.`);
      return;
    }
    const sets = state.catalog[theme.slug];
    const entry = sets && sets[mode].find((item) => item.id === id);
    if (!entry) { apiError(res, 404, 'not_found', `Unknown picture: ${id}`); return; }
    fs.unlinkSync(entry.file);
    if (afterWrite) afterWrite();
    if (audit) audit('appearance.wallpaper.delete', req, { theme: theme.slug, mode, id }, { admin: req.appearanceAdmin });
    const snap = snapshot();
    res.status(200).json({ ok: true, revision: snap.revision, theme: snap.themes.find((item) => item.id === theme.slug) });
  });

}

module.exports = {
  registerAppearanceRoutes,
  projectTheme,
  resolveAdminTokens,
  extractBearer,
  constantTimeEqual,
  writeFileAtomic,
};
