'use strict';

// Single JSON error envelope for every Lookie API (API review 2026-09-23 item 3):
//   { ok: false, error: { code, message, details? } }
// Forms (lib/forms/routes.js) already used this shape; core routes adopted it.

const DEFAULT_CODES = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'invalid_request',
  429: 'rate_limited',
  500: 'internal_error',
};

function defaultErrorCode(status) {
  return DEFAULT_CODES[status] || (status >= 500 ? 'internal_error' : 'invalid_request');
}

function errorEnvelope(status, code, message, details) {
  return {
    ok: false,
    error: {
      code: code || defaultErrorCode(status),
      message: String(message),
      ...(details ? { details } : {}),
    },
  };
}

// `extra` carries pre-existing top-level context fields (e.g. `current`,
// `currentMtimeMs`) that some conflict responses already returned.
function apiError(res, status, code, message, details, extra) {
  res.status(status).json({ ...errorEnvelope(status, code, message, details), ...(extra || {}) });
}

module.exports = { apiError, errorEnvelope, defaultErrorCode, DEFAULT_CODES };
