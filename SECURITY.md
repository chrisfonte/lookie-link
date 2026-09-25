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
