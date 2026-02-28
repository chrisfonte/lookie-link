# Lookie-Link — Web File Viewer for Local Directories

## What to Build

A lightweight web file viewer that runs locally and serves files over your network (e.g., Tailscale) for mobile/desktop access. The primary use case: an AI agent modifies a file, shows the user a clickable link, and the user can view the rendered file in their browser.

## Core Requirements

1. **Web server** that serves files from configurable root directories (e.g., `~/docs`, `~/notes`, `~/projects/my-project`)
2. **Markdown rendering** — render `.md` files as formatted HTML with syntax highlighting for code blocks
3. **YAML rendering** — render `.yaml`/`.yml` files with syntax highlighting
4. **Script/code rendering** — syntax-highlighted view for `.sh`, `.bash`, `.py`, `.js`, `.ts`, `.json`, etc.
5. **Plain text fallback** — anything else rendered as preformatted text
6. **URL structure**: `http://<hostname>:<port>/view/<repo-path>/<file-path>`
   - Example: `http://localhost:9876/view/docs/guides/getting-started.md`
   - Example: `http://localhost:9876/view/notes/README.md`
7. **Directory listing** — if a path points to a directory, show a file listing with clickable links
8. **Dark mode** — default to dark theme, clean readable typography
9. **Mobile-friendly** — responsive layout that works on phone screens
10. **No authentication required** — this runs on Tailscale (private network), so no auth needed

## Technical Constraints

- **Node.js** preferred (already installed on gateway: v25.6.1)
- **Minimal dependencies** — use well-known, lightweight packages
- **Single `npm start` to run** — no build step required, or at most a simple one
- **Port configurable** via environment variable (default: 9876)
- **Hostname**: configurable (default: `localhost`; set to your Tailscale MagicDNS name for remote access)

## Path Mapping

The server maps URL prefixes to local directories:

```
/view/docs/...                → ~/docs/...
/view/notes/...               → ~/notes/...
/view/project/...             → ~/projects/my-project/...
```

These should be configurable (env var or config file).

## Rendering Stack Suggestions

- **Markdown**: `marked` or `markdown-it` (with GFM tables, task lists)
- **Syntax highlighting**: `highlight.js` or `prism` (server-side rendering preferred)
- **YAML**: treat as code with yaml syntax highlighting
- **CSS**: Embed a clean dark theme (no external CDN dependencies)

## What NOT to Build (Yet)

- No editing capability — read-only viewer
- No file upload
- No authentication (Tailscale handles network access)
- No search (maybe later)
- No git integration (maybe later)
- No WebSocket live-reload (maybe later)

## Project Structure

```
ops-file-viewer/
├── package.json
├── server.js          # Main entry point
├── lib/               # Rendering logic
├── views/             # HTML templates (if using templates)
├── public/            # Static assets (CSS, etc.)
├── README.md
├── CHANGELOG.md
└── PROMPT.md          # This file (saved delegation prompt)
```

## Success Criteria

1. `npm install && npm start` launches the server
2. Navigating to a markdown file URL renders it beautifully
3. YAML files render with syntax highlighting
4. Directory listings are navigable
5. Works on mobile Safari over Tailscale
6. Dark mode by default, clean typography

## Reference Projects

Look at these for inspiration (but keep it simpler):
- `glow` (terminal markdown renderer) — for rendering quality reference
- `grip` (GitHub readme instant preview) — for the "serve markdown" concept
- VS Code's built-in markdown preview — for rendering fidelity
- `serve` (vercel/serve) — for the static file serving pattern

## After Building

- Add a `start` script to package.json
- Test with a few real files from the operations repos
- Commit everything including this PROMPT.md
