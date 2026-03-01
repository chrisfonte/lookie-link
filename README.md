# Lookie-Link

A read-only web file viewer for browsing local directories over your network. Point it at your documentation repos, knowledge bases, or project files and get rendered markdown, syntax-highlighted code, and clickable cross-links — all in a dark-theme UI.

## Why This Exists

If you work with AI agents that read and write files — Claude Code, OpenClaw, Codex, or anything similar — you know the problem: the agent modifies a file, and now you need to see what it did. Your options are bad. The agent dumps the entire file into Telegram or Slack (unreadable on a phone). You SSH in and `cat` it. You open your laptop and find it in your editor. None of these work well when you're reviewing from a phone or tablet.

Lookie-Link solves this by giving every file a URL. The agent modifies a document, drops a link in chat, and you tap it. You're reading the rendered file in your browser — formatted markdown, syntax-highlighted code, deep-linked to the exact section that changed. You can review, comment back, and the agent makes another pass. The whole loop works from a phone over Tailscale without ever touching a terminal.

This also works for anyone managing multiple documentation repos (operations docs, knowledge bases, project files). GitHub doesn't render local files. Editors don't render cross-repo links. Neither gives you a shareable URL. Lookie-Link does.

## Features

- **Read-only file browser** — directory listings, rendered documents, no write access
- **Markdown rendering** — full CommonMark with syntax-highlighted code blocks
- **Cross-link rendering** — `[[name]] (~/repo/path.md#anchor)` becomes a clickable link
- **YouTube iframe embeds** — write `<iframe>` tags in markdown, they render with sandboxed security
- **Anchor linking** — every markdown heading and YAML top-level key gets a `🔗` copy-link button
- **Inline images** — local repo images render inline (png, jpg, gif, webp, svg)
- **YAML/code rendering** — syntax-highlighted with highlight.js
- **URL format** — `/view/<repo>/<path>#<anchor>` — predictable, shareable, deep-linkable
- **Dark theme** — mobile-friendly, single stylesheet
- **Configurable** — YAML config file or environment variables

## Network Model

Lookie-Link is designed for private networks — specifically [Tailscale](https://tailscale.com) or similar mesh VPNs. It runs on a machine with access to your repos (a Mac Mini, a home server, a NAS) and serves files to any device on your tailnet. Your phone, your tablet, your laptop at a coffee shop — if it's on the VPN, it can reach Lookie-Link.

It also works on a plain LAN, but Tailscale is the intended deployment: set `hostname` in your config to your Tailscale machine name and every link works from anywhere.

This is **not** a public-facing web server. There is no authentication layer — access control comes from your network.

HTML in markdown is enabled but sanitized through [DOMPurify](https://github.com/cure53/DOMPurify):

- **Allowed**: standard HTML tags (p, div, table, etc.)
- **Allowed**: `<iframe>` tags with `src` matching `youtube.com/embed/` only
- **Stripped**: `<script>`, `<object>`, `<embed>`, `<form>`, all event handlers (`onclick`, etc.)
- **Auto-injected**: `sandbox="allow-scripts allow-same-origin"` on all iframes

This approach was informed by [comparative research](https://github.com/cure53/DOMPurify) of how Jekyll, Hugo, Docusaurus, GitHub, and Obsidian handle embedded HTML. See the `prompts/` directory for the full design history.

## Quick Start

```bash
git clone https://github.com/chrisfonte/lookie-link.git
cd lookie-link
npm install
npm start
```

Open `http://localhost:9876` in your browser.

## Configuration

Create `~/.config/lookie-link/lookie-link.yaml`:

```yaml
server:
  port: 9876
  hostname: my-server.example.com

repositories:
  docs: ~/Documents/docs
  notes: ~/notes
  project: ~/projects/my-project
```

Each key under `repositories` becomes a URL prefix: `/view/docs/...`, `/view/notes/...`, etc.

A sample config is included: `lookie-link.yaml.example`.

### Config Priority

Settings resolve in this order (first wins):

1. **Environment variables** (`PORT`, `HOSTNAME`, `ROOT_MAPPINGS`, `LOOKIE_LINK_CONFIG`)
2. **`~/.config/lookie-link/lookie-link.yaml`** (user config)
3. **`lookie-link.yaml`** in project root (development fallback)
4. **Built-in defaults** (port 9876)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default: 9876) |
| `HOSTNAME` | Hostname shown in startup logs |
| `ROOT_MAPPINGS` | Comma-separated `repo=path` pairs or JSON object |
| `LOOKIE_LINK_CONFIG` | Path to a custom config file (overrides search) |

## Cross-Link Rendering

Lookie-Link rewrites hybrid cross-link patterns in rendered markdown:

```markdown
[[Getting Started]] (~/docs/guides/getting-started.md#installation)
[[API Reference]] (`~/project/docs/api.md`)
```

These become clickable links to `/view/docs/guides/getting-started.md#installation`, etc.

Rules:
- The visible text is the `[[wikilink]]` label
- `~/` paths are mapped to `/view/<repo>/<path>`
- Content inside `<pre>` blocks is not rewritten
- `<private-repo>` placeholders are intentionally not linkified

## Anchor Linking

Every markdown heading and YAML top-level key gets an anchor ID and a `🔗` button that copies the full URL (with `#fragment`) to clipboard.

- `## Core Truths` → `#core-truths`
- `learned_patterns:` (YAML) → `#learned_patterns`

Append anchors to any URL: `/view/docs/guide.md#core-truths`

## Inline Images

Markdown image paths are rewritten to serve local repo images:

```markdown
![Diagram](./images/architecture.png)
![Logo](~/docs/assets/logo.svg)
```

Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check |
| `GET /view/<repo>/<path>` | Rendered file or directory listing |
| `GET /asset/<repo>/<path>` | Image asset serving (for inline images) |

## Project Structure

```
lookie-link/
├── server.js              # Express entry point
├── lib/
│   ├── config.js          # YAML + env config loading
│   ├── renderer.js        # Markdown/YAML/code rendering + DOMPurify
│   └── path-utils.js      # Path resolution, escaping, formatting
├── public/
│   └── style.css          # Dark theme
├── views/                 # EJS templates (if applicable)
├── prompts/               # Build prompts (design history)
│   ├── PROMPT-v1.md       # Original build prompt
│   ├── PROMPT-v2.md       # Feature expansion prompt
│   └── README.md          # Prompt index
├── lookie-link.yaml.example
├── CHANGELOG.md
└── README.md
```

## Contributing

Issues and PRs welcome. This is a simple tool — the codebase is ~600 lines of JavaScript across three files.

If you're adding a new post-processing step to the renderer, note the execution order in `postProcessHtml()`:

1. `rewriteHybridCrossLinks()` — wiki-link patterns → clickable links
2. `rewriteTildeLinks()` — plain `~/path` references → clickable links
3. `rewriteImageSources()` — image paths → `/asset/` endpoint
4. `addHeadingAnchorLinks()` — heading anchors + copy buttons
5. `addYamlAnchorLinks()` — YAML key anchors + copy buttons
6. `sanitizeHtml()` — DOMPurify (always last)

## License

MIT
