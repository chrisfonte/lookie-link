'use strict';

// Error type shared by every projection kind. The record router maps any thrown
// object that carries `status` (4xx/5xx) and a string `code` straight onto the
// JSON error envelope; `extra` is spread at the top level of the body
// (e.g. `currentTargetSha256` on a target_conflict).

class ProjectionError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code
   * @param {string} message operator-facing message (never an absolute path)
   * @param {object|Array} [details]
   * @param {object} [extra] top-level response fields
   */
  constructor(status, code, message, details, extra) {
    super(message);
    this.name = 'ProjectionError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (extra !== undefined) this.extra = extra;
  }
}

module.exports = { ProjectionError };
