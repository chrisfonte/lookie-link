# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use the private
security-reporting channel provided by the repository host. Include affected
versions, impact, reproduction steps, and whether credentials or listener
authority may have been exposed.

If no private reporting channel is available yet, retain the report privately
until the repository owner publishes one. Do not send bearer tokens, production
configuration, repository roots, or managed-content metadata in an initial
report.

## Supported versions

Until the project publishes a formal support window, only the current release
is evaluated for security fixes. Older builds may receive no backports.

## Security boundaries

- Repository access is caller-scoped; authorization never reveals filesystem
  roots or credentials.
- Tokens and managed grants live outside the repository and must never enter
  logs or examples.
- Mutation requests require the canonical `write` permission and reject query
  credentials.
- Editing, annotations, transformed HTML, and raw HTML are independent opt-in
  capabilities. Raw HTML is appropriate only for trusted authored content on a
  trusted private network.
- Audio roots (`audioRoots`) are read-only and contained by the same realpath
  check as repositories: only audio bytes are served from them, and edits,
  saves, annotation writes, raw and embedded HTML are refused. Peaks sidecars
  are written beside the audio only when the directory is not a read-only root;
  otherwise they go to a destination or cache directory named by a hash of the
  repository and path, never by user text. No response carries an absolute path.
- Marker templates are operator data, not code: they contain no command text.
  External validators and the YAML tool are named only in server configuration
  (`markers.validators`, `markers.yamlToolPath`); a template references a
  validator by id. Template create, revise and delete need an unrestricted
  caller or a token with `write` and whole-fleet repository scope.
- Marker records need `write` on the audio file's path (annotations need only
  `view`). The audio bytes are re-hashed on every save, so a record always binds
  to the exact file it was made against. Browser saves pass an Origin check and a
  CSRF token (`lookie_markers_context` cookie); bearer agents skip them, a bearer
  together with the cookie is refused, and no mutation accepts a query token.
- Projections write only into `markers.roots` aliases explicitly flagged
  `allowProjections`; a template cannot name a path outside its root, snapshot
  and receipt files are created exclusively and hashed from the bytes written, and
  a projection into a root that is also a served repository needs permission on
  that repository unless the caller is a template admin. Child tools are run
  without a shell and their output is never returned.
- The native viewer page carries no CSP, like other native pages; every
  file-derived string is rendered as text, never as HTML.
- The authored-HTML YouTube bridge does not grant authored content same-origin
  access. Only a message from the current report iframe, during transient user
  activation, can request a viewer-owned player. The parent independently
  accepts a fixed HTTPS provider/ID grammar and strips unrecognized parameters.
  YouTube gets an origin-only referrer, never the report path or query string.
  The cross-origin provider iframe has its own sandbox; it is not an exemption
  for the authored document. See [the player contract](docs/CAPABILITIES.md#youtube-clips-in-authored-html).
