# Spyglass

Lightweight web file viewer for operations repositories. Runs on a local macOS gateway and serves rendered files over Tailscale.

## Features

- Read-only file and directory browser
- URL format: `/view/<repo>/<path>#<anchor>`
- Markdown rendering with syntax-highlighted code blocks
- YAML/code rendering with syntax highlighting
- Anchor linking for markdown headers and YAML top-level keys
- Plain text fallback for unknown extensions
- Mobile-friendly dark theme
- Configurable via `spyglass.yaml` or environment variables

## Requirements

- Node.js 20+

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Configuration

Edit `spyglass.yaml` in the project root:

```yaml
server:
  port: 9876
  hostname: mac-mini-2.bobcat-tetra.ts.net

repositories:
  operations: ~/operations
  operations-fontastic: ~/operations-fontastic
  operations-chris-fonte: ~/operations-chris-fonte
  clawd: ~/clawd
```

### Config Priority

Settings are resolved in this order (first wins):

1. **Environment variables** (`PORT`, `HOSTNAME`, `ROOT_MAPPINGS`)
2. **`spyglass.yaml`** (project root, or path set by `SPYGLASS_CONFIG` env)
3. **Built-in defaults**

### Environment Variables (legacy)

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default: 9876) |
| `HOSTNAME` | Hostname shown in logs |
| `ROOT_MAPPINGS` | Comma-separated `repo=path` pairs or JSON object |
| `SPYGLASS_CONFIG` | Path to a custom `spyglass.yaml` location |

## Anchor Linking

Spyglass generates anchor IDs for:

- **Markdown headers**: `## Core Truths` → `#core-truths`
- **YAML top-level keys**: `learned_patterns:` → `#learned_patterns`

Append the anchor to any URL: `/view/clawd/SOUL.md#core-truths`

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check |
| `GET /view/<repo>/<path>` | File or directory view |

## Project Structure

```
ops-file-viewer/
├── spyglass.yaml      # Configuration
├── server.js          # Main entry point
├── lib/
│   ├── config.js      # Config loading (YAML + env)
│   ├── renderer.js    # Markdown/YAML/code rendering
│   └── path-utils.js  # Path resolution and formatting
├── public/
│   └── style.css      # Dark theme styles
├── PROMPT.md          # Original build prompt
├── CHANGELOG.md
└── README.md
```
