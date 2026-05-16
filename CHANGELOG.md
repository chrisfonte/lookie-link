# Changelog

## 2026-05-14 — Unreleased — PDF Rendering

- Render `.pdf` files at `/view/...pdf` in a dedicated viewer page with an embedded browser PDF frame, Open-in-browser and Download links.
- Stream PDF bytes from `/asset/...pdf` with `application/pdf` MIME type and `Range` request support.
- PDFs remain non-editable (treated as binary assets); markdown links resolving to `.pdf` open the same viewer page.
- Documented in README, `docs/API.md`, `docs/FEATURES.md`. Test coverage in `test/access-control.test.js`.

## 2026-05-13 — Unreleased — HTML Source Rendering

- Render `.html` and `.htm` files as sanitized HTML documents with a Raw source toggle
- Strip `<script>` tags and preserve local repo images through the existing DOMPurify + asset rewrite pipeline
- Added integration coverage for direct `/view/.../.htm` rendering and `/edit/.../.htm` access
- Closes FON-6175

## 2026-05-12 — Unreleased — Audio File Playback

- Added audio playback support for `.m4a`, `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.flac`, `.aac`
- Browsing an audio file directly renders a dedicated player page with controls and a download link
- Markdown links to audio files (e.g. NotebookLM `.m4a` overviews) get an inline `<audio>` player with the original link caption
- Inline player also triggers for fully-qualified `http(s)://<host>:9876/view/<repo>/<path>.<audio-ext>` URLs — the Paperclip-style labeled-link form — not just `./relative` and `~/repo` paths
- `/asset/<repo>/<path>` route serves audio with correct MIME types and Range requests for seeking
- Audio files are excluded from editable mode (binary)
- Documented in `docs/FEATURES.md` (new Audio Playback section) and `~/operations/ai-tools/knowledge/integrations/lookie-link.yaml` (v1.2)
- Closes FON-5963, GH#54

## 2026-05-03 — Unreleased — Phase 1 Token-Scoped Access

- Added phase 1 token-scoped repo/path access for agents
- Enforced per-token `view` and `edit` permissions across index, document, asset, edit, save, and preview routes
- Filtered repo and directory listings to authorized paths only
- Preserved query-token navigation across rendered links and editor actions
- Documented the new `access.tokens` config shape and API behavior

## 2026-04-03 — v2.2.0 — Stitch-Informed Theme Polish

- Added a narrow editorial-style theme polish pass inspired by a Stitch File Index concept
- Introduced Space Grotesk + Inter typography for stronger heading and brand hierarchy
- Retuned dark/light theme tokens toward a slate/blue review-oriented palette
- Upgraded directory listing presentation with richer file-row hierarchy and softer card/table treatment
- Preserved existing app structure and route behavior (no redesign, no framework migration)
- Added `prompts/PROMPT-v4-stitch-theme-polish.md` to document the prompt/spec for the theme pass

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
