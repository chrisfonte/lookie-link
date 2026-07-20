# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Lookie-Link is a self-hosted Express.js server for browsing and editing local directories over a private network. It renders markdown, sanitized HTML, syntax-highlighted code, and YAML files viewable from any device (designed for Tailscale / private networks, no auth).

## Commands

- `npm start` — run the server (`node server.js`), default http://localhost:9876
- `npm run validate:editable` — run the validation test suite (editable mode integration tests)
- `npm run validate:raw-html` — validate `/raw/<path>.html` serving + `/view` sanitisation invariants
- `npm install` — install dependencies (no build step needed)

There is no linter, formatter, or unit test framework. The test suites are `scripts/validate-editable-mode.js` and `scripts/validate-raw-html.js`.

## Architecture

Three core modules plus a client-side script:

- **`server.js`** — Express app setup, all route handlers (`/`, `/healthz`, `/view/*`, `/edit/*`, `/api/save/*`, `/api/preview/*`, `/asset/*`, `/raw/*`), binary detection, path safety via `safeResolve()`. Loads custom themes at startup and passes `customThemeCss` to all render functions.
- **`lib/config.js`** — Config loading with priority: env vars > user YAML (`~/.config/lookie-link/lookie-link.yaml`) > project YAML > defaults. Key settings: PORT, HOSTNAME, ROOT_MAPPINGS, LOOKIE_LINK_ENABLE_EDITING. Also handles custom theme loading from YAML config (`loadCustomThemes()`, `generateCustomThemeCss()`).
- **`lib/renderer.js`** — Rendering pipeline: markdown-it for markdown, sanitized inline HTML documents for `.html`/`.htm`, highlight.js for code/YAML. Post-processing chain in `postProcessHtml()`: cross-link rewriting → tilde link rewriting → image source rewriting → heading anchors → YAML anchors → DOMPurify sanitization (always last). Shared `toolbarHtml()` and `themeScript()` provide the toolbar and theme switching JS on every page type. Image lightbox is injected via `baseHtml()`.
- **`lib/path-utils.js`** — Path resolution, URL-safe escaping, breadcrumb building.
- **`public/editor.js`** — Client-side vanilla JS for edit/preview tab switching, debounced preview, save with conflict detection.
- **`public/style.css`** — Theme system via CSS custom properties and `data-color-scheme`/`data-theme` attributes. Built-in themes: Slate, Teal, Nord, Rosé Pine, Monokai, Solarized, GitHub. Custom themes injected as inline `<style>` from YAML config.

## Key Patterns

- **No build step.** Plain Node.js, no transpilation, no bundler, no frontend framework.
- **Path safety:** `safeResolve(rootPath, relativePath)` uses `fs.realpath()` + boundary check to prevent directory traversal. All file operations must go through this.
- **Stale-write guard:** Edits use `expectedMtimeMs` to detect concurrent modifications (409 Conflict). Writes use temp file + rename for atomicity.
- **Editable mode is opt-in** (disabled by default). Any non-binary file can be edited when enabled.
- **DOMPurify sanitization is always the last step** in the rendering pipeline — never add post-processing after it.
- **Cross-links:** `[[name]] (~/repo/path.md#anchor)` syntax gets rewritten to clickable links pointing to `/view/` routes.
- **Theme system:** Dark mode uses absence of `data-theme` attribute; light mode sets `data-theme="light"`. Color schemes use `data-color-scheme` attribute. Theme cycling button (not a `<select>`) avoids browser dropdown interaction issues. Custom themes from YAML config are injected as inline CSS and added to the cycle list via `setThemeList()`.
- **Toolbar is shared:** `toolbarHtml()` and `themeScript()` in renderer.js are used by all page types (directory, document, image, edit). Page-specific buttons (TOC, Raw, Edit) are passed as `extraButtons`.
- **Image lightbox:** Clicking any `.content img` opens a full-screen overlay box with close button. Handled in `baseHtml()` so it works on all pages.
- **Raw HTML mode (opt-in, off by default):** `/raw/<repo>/<path>.html` serves the file body verbatim with `text/html` — no DOMPurify, no viewer chrome — so self-contained interactive HTML artifacts (e.g. NotebookLM flashcards/quiz) actually run. Enabled via `LOOKIE_LINK_ENABLE_RAW_HTML=true` or `server.enableRawHtml: true` in YAML. **Trust assumption:** every file under the configured roots must be authored or vetted by you — a raw file runs on the same origin as `/api/save` and `/api/grants`, so do not flip this on for instances exposed to untrusted content. The existing `/view/<path>.html` route continues to sanitize + wrap regardless of this flag. When enabled, `/view` pages for `.html`/`.htm` files get an "Open raw" toolbar button linking to `/raw/`.
