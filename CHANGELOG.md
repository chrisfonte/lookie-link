# Changelog

## 2026-06-10 — Unreleased — Annotations Viewer UX

- When `server.enableAnnotations: true`, the document viewer now renders a 💬 button next to every anchored heading and YAML key path. Clicking it opens an inline form whose submission writes through `POST /api/annotations/<repo>/<path>`.
- Stored annotations render inline next to their anchor as a card with author, body, state badge, claim metadata, replies, and per-state actions (Claim, Resolve, Reopen, Reply). Each action calls the API and refreshes inline; stale-mtime conflicts surface in an alert.
- Added `public/annotations.js` (vanilla JS, ~330 lines) and a styled annotation card / inline-form section in `public/style.css`. Theme variables drive the colors so all built-in palettes look right.
- The bootstrap (`__lookieLinkAnnotations` with `repo`, `relativePath`, `queryToken`) and the `<script src="/public/annotations.js" defer>` tag are only emitted when `annotationsEnabled` is true for the request. Validator covers both presence (enabled) and absence (disabled).
- Author name is remembered in `localStorage` so repeat annotations don't re-prompt.
- No source file mutation; sidecar is still the only on-disk surface. No new auth surface — the script uses the same `view` permission and query-token plumbing as the rest of the viewer.

## 2026-06-09 — Unreleased — Annotations CLI Shim

- Added `bin/lookie-annotations.js` CLI shim, registered as the `lookie-annotations` bin. Mirrors `lookie-read.js` posture: env-based auth (`LOOKIE_LINK_BASE_URL`, `LOOKIE_LINK_TOKEN`, `LOOKIE_LINK_AUTHOR`), JSON-first stdout, shared exit-code grammar (`0/2/3/4/5`), and `--json-errors` for machine consumers.
- Subcommands: `list`, `get`, `add`, `claim`, `resolve`, `replies` (with `--add`). `--state` is repeatable; `--pretty` prints a human-friendly form; body input accepts `--body STRING`, `--body-file PATH`, or `--body -` (stdin).
- Extended `scripts/validate-editable-mode.js` to spawn the CLI against a real HTTP listener and cover every subcommand path, both body-input forms, state filtering, `--pretty`, no-token forbidden (exit 4), and scoped-token success.
- Documented both shims in `docs/AGENT-SHIM.md`.

## 2026-06-09 — Unreleased — Annotations Sidecar Transport

- Added sidecar-backed annotation storage at `<repoRoot>/.lookie-link/annotations/<repo>/<relative-path>.json` with atomic temp+rename writes, per-day annotation IDs, and stale-write protection via `expectedMtimeMs` on PATCH.
- Added `GET | POST | PATCH /api/annotations/<repo>/<path>` behind a new `server.enableAnnotations` flag (and `LOOKIE_LINK_ENABLE_ANNOTATIONS` env var), independent of `enableEditing`. Routes reuse the existing token-scoped `view` permission for both reads and writes.
- `GET` returns the sidecar (or an empty schema-1 document when no sidecar exists) and supports repeatable `?state=open|claimed|resolved` filters. `POST` accepts `anchor`, `anchorKind` (`heading`, `yamlKey`, `lineRange`), `body`, `author`. `PATCH` supports `claim`, `resolve`, `reopen`, and `reply` ops with 409 on stale mtime.
- Extended `scripts/validate-editable-mode.js` to cover the annotation transport: disabled-gate 404, empty-doc read, create + sidecar placement, claim → resolve → reopen → reply state walk, state filters (including invalid filter rejection), stale-mtime conflict, cross-repo access-control parity (403 on read and write), and 404 on missing source files.
- Documented the transport in `docs/API.md`, the flag in `docs/CONFIGURATION.md`, and the example in `lookie-link.yaml.example`.

## 2026-06-09 — Unreleased — Annotations & Agent-Feedback Loop Spec

- Nested YAML key anchors now use full-path slugs like `database-connection-host`, with deterministic `-2`, `-3` suffixes for collisions. Existing top-level vs nested TOC styling is preserved; nested keys get their own anchor-link buttons. Adds an HTTP regression test through `/view` for nested YAML coverage.
- Added `docs/ANNOTATIONS-SPEC.md` — draft planning doc for a structured annotation layer (sidecar by default, inline opt-in) and a flat-file pickup contract for agents. Lays out a verdict table, sidecar JSON schema, click-to-annotate UX on existing heading/YAML-key anchors, line-range fallback, a `bin/lookie-annotations.js` CLI shim, and a phase split. Establishes nested YAML key anchors as a phase-1 prerequisite. No code changes yet; basis for follow-up implementation issues.

## 2026-06-08 — Unreleased — Agent-Facing Read/Write Standard

- Added `GET /api/repos` JSON discovery endpoint so agents can enumerate served repos at runtime (`{repo, rootPath, viewUrl, assetUrl}`). Filtered by the same access-control logic as the home page.
- Added `bin/lookie-read.js` CLI shim (`lookie-read <repo>/<path>`) declared in `package.json#bin`. Encapsulates discovery, local-fallback, HTTP fetch with Range, and `LOOKIE_LINK_TOKEN` auth.
- Extended `/asset/<repo>/<path>` mime allowlist to cover text/source extensions (markdown, yaml, json, sh/py/js/ts/go/rs/c/cpp/etc.) so the read shim can fetch source files. Source-code and HTML extensions are served as `text/plain; charset=utf-8` to prevent browser auto-rendering. Unknown extensions still return `415`.
- Added `scripts/lookie-link-config-audit.sh` + `scripts/lookie-link-config-audit-cron.sh` and `scripts/launchd/com.lookie-link.config-audit.plist` to enumerate configured operations directories, classify them (served / worktree-skip / placeholder-skip / missing), and post deltas to Paperclip.
- Added test coverage for `/api/repos` in `scripts/validate-editable-mode.js`.
- Documented repository discovery and agent file-reference conventions in the public API and shim documentation.

## 2026-05-16 — Unreleased — Linkify Bare URLs

- Enabled `linkify: true` in markdown-it so bare URLs (e.g. `https://itflow.org` in a `## Sources` bullet list) render as clickable links. Verified YouTube iframe + sandbox flow still works and that URLs inside fenced/inline code remain literal.
- Documented behavior in README feature list, `docs/FEATURES.md#markdown-link-rendering`, and as an informational comment in `lookie-link.yaml.example`.

## 2026-05-14 — Unreleased — PDF Rendering

- Render `.pdf` files at `/view/...pdf` in a dedicated viewer page with an embedded browser PDF frame, Open-in-browser and Download links.
- Stream PDF bytes from `/asset/...pdf` with `application/pdf` MIME type and `Range` request support.
- PDFs remain non-editable (treated as binary assets); markdown links resolving to `.pdf` open the same viewer page.
- Documented in README, `docs/API.md`, `docs/FEATURES.md`. Test coverage in `test/access-control.test.js`.

## 2026-05-13 — Unreleased — HTML Source Rendering

- Render `.html` and `.htm` files as sanitized HTML documents with a Raw source toggle
- Strip `<script>` tags and preserve local repo images through the existing DOMPurify + asset rewrite pipeline
- Added integration coverage for direct `/view/.../.htm` rendering and `/edit/.../.htm` access

## 2026-05-12 — Unreleased — Audio File Playback

- Added audio playback support for `.m4a`, `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.flac`, `.aac`
- Browsing an audio file directly renders a dedicated player page with controls and a download link
- Markdown links to audio files (e.g. NotebookLM `.m4a` overviews) get an inline `<audio>` player with the original link caption
- Inline player also triggers for fully-qualified `http(s)://<host>:9876/view/<repo>/<path>.<audio-ext>` URLs — the Paperclip-style labeled-link form — not just `./relative` and `~/repo` paths
- `/asset/<repo>/<path>` route serves audio with correct MIME types and Range requests for seeking
- Audio files are excluded from editable mode (binary)
- Documented in `docs/FEATURES.md` (new Audio Playback section).
- Closes GH#54

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
