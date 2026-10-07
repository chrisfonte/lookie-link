'use strict';

// Browser-write gate for JSON management routes (design §5): Origin match plus a
// synchronizer CSRF token held in an in-memory context map. Bearer callers skip
// the Origin and CSRF checks; a bearer together with the context cookie is
// ambiguous and refused. Mirrors `managementEnvelope` in lib/forms/routes.js
// (the forms module is untouched by this change and does not export its helpers).

const crypto = require('node:crypto');

const { apiError } = require('./api-error');

const DEFAULT_COOKIE = 'lookie_markers_context';
const MAX_CONTEXTS = 10000;

// Copied from lib/forms/routes.js `cookieValue` (lines 53-67).
function cookieValue(req, name) {
  const header = typeof req.get === 'function' ? req.get('cookie') : null;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_error) {
      return null;
    }
  }
  return null;
}

// Copied from lib/forms/routes.js `safeEqual` (lines 69-73).
function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

// Copied from lib/forms/routes.js `bearerPresented` (lines 79-82).
function bearerPresented(req) {
  const header = req.get('authorization');
  return typeof header === 'string' && /^Bearer\s+\S/i.test(header);
}

// Copied from lib/forms/routes.js `exactOrigin` (lines 1986-1995).
function exactOrigin(value) {
  if (typeof value !== 'string' || !value || value.includes(',')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch (_error) {
    return null;
  }
}

// Copied from lib/forms/routes.js `configuredOrigins` (lines 1997-2000).
function configuredOrigins(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(exactOrigin).filter(Boolean))];
}

// Copied from lib/forms/routes.js `originAllowed` (lines 2002-2022).
function originAllowed(req, configuredOrigin) {
  const expected = configuredOrigins(configuredOrigin);
  if (expected.length === 0) return false;
  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  const origin = originHeader ? exactOrigin(originHeader) : null;
  let refererOrigin = null;
  if (refererHeader) {
    try {
      const referer = new URL(refererHeader);
      if (referer.username || referer.password) return false;
      refererOrigin = referer.origin;
    } catch (_error) {
      return false;
    }
  }
  if (originHeader && !expected.includes(origin)) return false;
  if (refererHeader && !expected.includes(refererOrigin)) return false;
  if (originHeader && refererHeader && origin !== refererOrigin) return false;
  return Boolean(originHeader || refererHeader);
}

/**
 * @param {object} options
 * @param {string|string[]|(() => (string|string[]))} options.publicOrigins exact origins (scheme + host + port)
 * @param {string} [options.cookieName]
 * @param {Map<string, {csrfToken: string}>} [options.contexts]
 * @param {(event: string, req: object, details: {outcome: string, type: string}) => void} [options.audit]
 * @param {{warn?: Function}} [options.logger]
 */
function createBrowserWriteGate({
  publicOrigins, cookieName = DEFAULT_COOKIE, contexts = new Map(), audit, logger,
} = {}) {
  const origins = () => configuredOrigins(typeof publicOrigins === 'function' ? publicOrigins() : publicOrigins);
  if (origins().length === 0 && logger && typeof logger.warn === 'function') {
    logger.warn('No valid public origin is configured; browser mutations will be refused.');
  }

  function emitAudit(req, type, outcome) {
    if (typeof audit !== 'function') return;
    try {
      audit('markers.gate', req, { outcome, type });
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn('Browser write gate audit sink failed.', { error: error.message });
    }
  }

  function contextFor(req) {
    const contextId = cookieValue(req, cookieName);
    return (contextId && contexts.get(contextId)) || null;
  }

  function tokenFor(req) {
    const context = contextFor(req);
    return context ? context.csrfToken : null;
  }

  function issueContext(req, res) {
    const existing = contextFor(req);
    if (existing) return existing.csrfToken;
    const contextId = crypto.randomBytes(24).toString('base64url');
    const context = { csrfToken: crypto.randomBytes(32).toString('base64url') };
    contexts.set(contextId, context);
    if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
    const list = origins();
    const secure = list.length > 0 && list.every((origin) => origin.startsWith('https://'));
    res.append('Set-Cookie', `${cookieName}=${encodeURIComponent(contextId)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    return context.csrfToken;
  }

  function validCsrf(req, token) {
    const context = contextFor(req);
    return Boolean(context && typeof token === 'string' && safeEqual(context.csrfToken, token));
  }

  /**
   * Returns true to continue. Returns false after sending the refusal itself.
   */
  function check(req, res, { mutation = false, type = 'markers' } = {}) {
    const bearer = bearerPresented(req);
    if (bearer && cookieValue(req, cookieName)) {
      emitAudit(req, type, 'rejected_authn');
      apiError(res, 400, 'ambiguous_credentials', 'Ambiguous credentials are not accepted.');
      return false;
    }
    if (mutation && !bearer && !originAllowed(req, origins())) {
      emitAudit(req, type, 'rejected_origin');
      apiError(res, 403, 'origin_rejected',
        'Browser mutations need an Origin header matching a configured public origin; agents present a bearer token instead.');
      return false;
    }
    if (mutation && !bearer && !validCsrf(req, req.get('x-csrf-token'))) {
      emitAudit(req, type, 'rejected_csrf');
      apiError(res, 403, 'csrf_rejected', 'A valid CSRF token is required for browser mutations.');
      return false;
    }
    return true;
  }

  return { check, issueContext, tokenFor, contexts };
}

module.exports = { createBrowserWriteGate, originAllowed, configuredOrigins, exactOrigin, bearerPresented };
