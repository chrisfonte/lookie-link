# Changelog

## 2026-02-28 — v2.1.0 — DOMPurify, Rename, Public-Ready

- Replaced extract/restore YouTube hack with DOMPurify sanitization pipeline (#21)
- Enable `html: true` + `linkify: true` in markdown-it, sanitize with DOMPurify allowlist
- YouTube iframes allowed (`youtube.com/embed/` only), `sandbox` auto-injected
- `<script>`, `<object>`, `<embed>`, `<form>`, event handlers stripped
- Renamed project: Lookout → Lookie-Link (#22)
- Config path: `~/.config/lookie-link/lookie-link.yaml`
- Added LICENSE (MIT), EXAMPLES.md, Contributing section
- README rewritten: why it exists, security model, design history
- Closes #21, #22

## 2026-02-28 — v2.0.0 — Cross-Links, Copy Anchors, Inline Images

- Added hybrid cross-link rendering for `[[name]] (~/repo/path.md#anchor)` patterns in markdown
- Added section copy-link buttons (`🔗`) for markdown heading anchors and YAML top-level key anchors
- Added inline image support with secure `GET /asset/<repo>/<path>` endpoint
- Added markdown image source rewriting for relative and `~/repo/...` image paths
- Added image rendering styles (`max-width: 100%`) for content pages
- Closes #1
- Closes #2
- Closes #3

## 2026-02-28 — v1.2.0 — YAML Config File

- Added `lookie-link.yaml` configuration file for repo mappings, port, hostname
- Config priority: env vars > lookie-link.yaml > built-in defaults
- Added `LOOKIE_LINK_CONFIG` env var to point to custom config location
- Added `js-yaml` dependency
- Renamed project to **Lookie-Link** in all docs
- Updated README with full config documentation

## 1.0.0 - 2026-02-28

- Initial release of `ops-file-viewer`
- Added secure repo path mapping with traversal protection
- Added directory listing with parent navigation
- Added Markdown rendering with highlighted code blocks
- Added YAML and source code syntax highlighting
- Added plain text fallback renderer
- Added responsive dark theme optimized for mobile
