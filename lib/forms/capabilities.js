'use strict';

// The forms capability vocabulary a scoped bearer credential may carry. The
// forms router's default authorizer reads `accessContext.formsCapabilities`;
// static tokens and managed API keys populate it from this allowlist, so a
// token can be granted exactly "log entries" or "edit trackers" without
// ambient unrestricted access (#183).
const FORMS_CAPABILITIES = Object.freeze([
  'forms.view',
  'forms.submit',
  'forms.read_submissions',
  'forms.manage',
]);

const KNOWN = new Set(FORMS_CAPABILITIES);

// Strict form for credential creation and config: unknown names are a
// configuration error, not something to drop silently.
function normalizeFormsCapabilities(raw, label = 'formsCapabilities') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array.`);
  const out = new Set();
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!KNOWN.has(name)) {
      throw new Error(`${label} entries must be one of: ${FORMS_CAPABILITIES.join(', ')}.`);
    }
    out.add(name);
  }
  return FORMS_CAPABILITIES.filter((name) => out.has(name));
}

// Lenient form for values read back from a persisted store: keep known names.
function sanitizeFormsCapabilities(raw) {
  if (!Array.isArray(raw)) return [];
  const present = new Set(raw.filter((entry) => typeof entry === 'string'));
  return FORMS_CAPABILITIES.filter((name) => present.has(name));
}

module.exports = {
  FORMS_CAPABILITIES,
  normalizeFormsCapabilities,
  sanitizeFormsCapabilities,
};
