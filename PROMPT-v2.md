# Spyglass v2.0 — Feature Build Prompt

## Project Context

Spyglass is a lightweight Node.js/Express web file viewer for browsing operations repos over Tailscale. It renders markdown, YAML, and code files with syntax highlighting and a dark theme. Currently deployed at `http://mac-mini-2.bobcat-tetra.ts.net:9876`.

**Key files:**
- `server.js` — Express app, routes, file serving
- `lib/renderer.js` — markdown-it rendering, heading anchors, YAML anchors, syntax highlighting
- `lib/config.js` — YAML config loading (spyglass.yaml), env vars, repo mappings
- `lib/path-utils.js` — path resolution, security (jail-break prevention)
- `public/style.css` — dark theme styles
- `spyglass.yaml` — repo mappings and server config

## Feature 1: Render Hybrid Cross-Links as Clickable Links (Closes #1)

Our documentation uses a "hybrid link" format: `[[wikilink-name]] (~/path/to/doc.md#Section-Name)`

**Requirements:**
- In rendered markdown output, detect the pattern `[[...]] (~/path/to/file.md...)` and convert it to a clickable `<a>` tag
- The visible text should be the wikilink name (text between `[[` and `]]`)
- The href should map the path to a Spyglass URL:
  - `~/operations/docs/meta/foo.md#bar` → `/view/operations/docs/meta/foo.md#bar`
  - `~/operations-research/topic/doc.md` → `/view/operations-research/topic/doc.md`
  - `~/clawd/SOUL.md` → `/view/clawd/SOUL.md`
- To resolve `~/reponame/path` → `/view/reponame/path`, strip the `~/` prefix and split on the first `/` to get the repo key, then the rest is the file path
- The `<private-repo>` placeholder should NOT be linkified — leave as plain text
- Paths wrapped in backticks (`` ` ``) within code blocks should NOT be linkified
- This should be a **post-processing step** on the rendered HTML from markdown-it, not a markdown-it plugin (simpler)

**Implementation approach:**
After `markdown.render(source)`, run a regex replacement on the HTML output that:
1. Matches `[[...]] (~/...)` patterns (but not inside `<code>` or `<pre>` tags)
2. Extracts the wikilink text and the path
3. Converts the path to a Spyglass URL
4. Wraps in `<a href="..." class="cross-link">wikilink-text</a>`

Also handle the case where the path is wrapped in backticks: `[[name]] (\`~/path\`)` — strip the backticks.

## Feature 2: Copy Section Link Button (Closes #2)

**Requirements:**
- Add a small link icon (🔗 or SVG) next to each heading that has an `id` attribute
- On click, copy the full URL to clipboard: `http://{hostname}:{port}/view/{repo}/{path}#{anchor}`
- Brief visual feedback (icon changes to ✓ for 1-2 seconds)
- Also works for YAML top-level key anchors
- The hostname and port should come from the page's current `window.location` (not hardcoded)
- Icon should be subtle (low opacity), visible on hover

**Implementation:**
- Add a `<a class="anchor-link" href="#id">🔗</a>` inside each heading during rendering
- Add a small inline `<script>` at the bottom of document pages that:
  - Intercepts clicks on `.anchor-link` elements
  - Builds the full URL from `window.location.origin + window.location.pathname + '#' + id`
  - Uses `navigator.clipboard.writeText()` to copy
  - Swaps icon to ✓ briefly
- CSS: `.anchor-link { opacity: 0.3; margin-left: 0.5em; text-decoration: none; cursor: pointer; } h1:hover .anchor-link, h2:hover .anchor-link, ... { opacity: 0.7; }`

## Feature 3: Inline Image Rendering (Closes #3)

**Requirements:**
- Add a new route: `GET /asset/:repo/*` that serves image files from configured repos
- Supported formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`
- Security: use the same `safeResolve()` jail-break prevention as `/view/` routes
- Set appropriate `Content-Type` headers based on extension
- In the markdown renderer, rewrite image `src` attributes:
  - Relative paths like `./image.png` or `image.png` → `/asset/{repo}/{dir}/image.png`
  - Absolute-ish paths like `~/operations/path/image.png` → `/asset/operations/path/image.png`
- Pass the current `repo` and directory path into `renderContent()` so it can resolve relative image paths
- Add `max-width: 100%;` styling for images in `.content img`

**Implementation:**
- In `server.js`: add `GET /asset/:repo/*` route before the 404 handler
- In `lib/renderer.js`: after markdown rendering, post-process `<img src="...">` tags to rewrite paths
- The `renderDocumentPage` function needs to know the repo and directory for relative path resolution
- MIME type mapping: `.png` → `image/png`, `.jpg`/`.jpeg` → `image/jpeg`, `.gif` → `image/gif`, `.webp` → `image/webp`, `.svg` → `image/svg+xml`

## General Notes

- Keep the code style consistent with existing files (strict mode, const/let, no var)
- No new dependencies needed — markdown-it, highlight.js, express, js-yaml already installed
- Update `package.json` version to `2.0.0`
- Update `CHANGELOG.md` with a v2.0.0 entry listing all three features
- Update `README.md` to document:
  - Cross-link rendering
  - Copy link button
  - Image support and the `/asset/` endpoint
- All three features reference GitHub issues: include `Closes #1`, `Closes #2`, `Closes #3` in commit messages
