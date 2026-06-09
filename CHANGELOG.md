# Changelog

## 2026-06-09 — Unreleased — Annotations & Agent-Feedback Loop Spec

- FON-11762 — Nested YAML key anchors. Anchor IDs now use full-path slugs like `database-connection-host`, with deterministic `-2`, `-3` suffixes for collisions. Existing top-level vs nested TOC styling is preserved; nested keys get their own anchor-link buttons. Adds an HTTP regression test through `/view` for nested YAML coverage.
- Added `docs/ANNOTATIONS-SPEC.md` — draft planning doc for a structured annotation layer (sidecar by default, inline opt-in) and a flat-file pickup contract for agents. Lays out a verdict table, sidecar JSON schema, click-to-annotate UX on existing heading/YAML-key anchors, line-range fallback, a `bin/lookie-annotations.js` CLI shim, and a phase split. Establishes nested YAML key anchors as a phase-1 prerequisite. No code changes yet; basis for follow-up implementation issues.

## 2026-06-08 — Unreleased — Agent-Facing Read/Write Standard (FON-11515)

- Added `GET /api/repos` JSON discovery endpoint so agents can enumerate served repos at runtime (`{repo, rootPath, viewUrl, assetUrl}`). Filtered by the same access-control logic as the home page. Closes FON-11515.
- Added `bin/lookie-read.js` CLI shim (`lookie-read <repo>/<path>`) declared in `package.json#bin`. Encapsulates discovery, local-fallback, HTTP fetch with Range, and `LOOKIE_LINK_TOKEN` auth. Closes FON-11519.
- Extended `/asset/<repo>/<path>` mime allowlist to cover text/source extensions (markdown, yaml, json, sh/py/js/ts/go/rs/c/cpp/etc.) so the read shim can fetch source files. Source-code and HTML extensions are served as `text/plain; charset=utf-8` to prevent browser auto-rendering. Unknown extensions still return `415`.
- Added `scripts/lookie-link-config-audit.sh` + `scripts/lookie-link-config-audit-cron.sh` and `scripts/launchd/com.lookie-link.config-audit.plist` to enumerate `~/operations-*` directories, classify them (served / worktree-skip / placeholder-skip / missing), and post deltas to Paperclip. Closes FON-11521.
- Added test coverage for `/api/repos` in `scripts/validate-editable-mode.js`. Closes FON-11518.
- Documented the convention upstream at `~/operations/docs/meta/lookie-link-for-agents/lookie-link-for-agents-best-practices.md` and `~/operations/ai-tools/knowledge/universal-methods.yaml#lookie-link-for-file-references`.

## 2026-05-16 — Unreleased — Linkify Bare URLs

- Enabled `linkify: true` in markdown-it so bare URLs (e.g. `https://itflow.org` in a `## Sources` bullet list) render as clickable links. Verified YouTube iframe + sandbox flow still works and that URLs inside fenced/inline code remain literal.
- Documented behavior in README feature list, `docs/FEATURES.md#markdown-link-rendering`, and as an informational comment in `lookie-link.yaml.example`.
- Closes FON-7049

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
