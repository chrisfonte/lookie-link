# Lookout

Lightweight web file viewer for local directories. Browse markdown, YAML, and code files with a rendered dark-theme UI. Designed for documentation repos, knowledge bases, and project files.

## Features

- Read-only file and directory browser
- URL format: `/view/<repo>/<path>#<anchor>`
- Markdown rendering with syntax-highlighted code blocks
- Hybrid cross-link rendering: `[[name]] (~/repo/path.md#anchor)` -> clickable Lookout links
- YAML/code rendering with syntax highlighting
- Anchor linking for markdown headers and YAML top-level keys with one-click copy buttons
- Inline image rendering for local repo images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`)
- Plain text fallback for unknown extensions
- Mobile-friendly dark theme
- Configurable via `lookout.yaml` or environment variables

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

Create `~/.config/lookout/lookout.yaml`:

```yaml
server:
  port: 9876
  hostname: my-server.example.com

repositories:
  my-docs: ~/Documents/docs
  notes: ~/notes
  project: ~/projects/my-project
```

### Config Priority

Settings are resolved in this order (first wins):

1. **Environment variables** (`PORT`, `HOSTNAME`, `ROOT_MAPPINGS`)
2. **`~/.config/lookout/lookout.yaml`** (user config)
3. **`lookout.yaml`** in project root (development fallback)
4. **Built-in defaults**

### Environment Variables (legacy)

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default: 9876) |
| `HOSTNAME` | Hostname shown in logs |
| `ROOT_MAPPINGS` | Comma-separated `repo=path` pairs or JSON object |
| `LOOKOUT_CONFIG` | Path to a custom `lookout.yaml` location (overrides all) |

## Anchor Linking

Lookout generates anchor IDs for:

- **Markdown headers**: `## Core Truths` → `#core-truths`
- **YAML top-level keys**: `learned_patterns:` → `#learned_patterns`

Append the anchor to any URL: `/view/my-docs/guide.md#core-truths`

Each heading/key anchor includes a `🔗` button that copies the full page URL (with `#anchor`) to clipboard.

## Cross-Link Rendering

Lookout rewrites these markdown patterns in rendered output:

- `[[wikilink-name]] (~/my-docs/guides/foo.md#bar)` -> `/view/my-docs/guides/foo.md#bar`
- `[[topic]] (\`~/notes/topic/doc.md\`)` -> `/view/notes/topic/doc.md`
- `[[readme]] (~/project/README.md)` -> `/view/project/README.md`

Rules:

- The visible text is the `[[wikilink-name]]` label
- The `~/` prefix is stripped and mapped as `/view/<repo>/<path>`
- `<private-repo>` placeholders are intentionally not linkified
- Content inside code blocks/inline code is not rewritten

## Inline Images

Lookout rewrites markdown image paths to the `/asset` endpoint so local repository images render inline:

- `![alt](image.png)` -> `/asset/<current-repo>/<current-dir>/image.png`
- `![alt](./image.png)` -> `/asset/<current-repo>/<current-dir>/image.png`
- `![alt](~/my-docs/img/diagram.png)` -> `/asset/my-docs/img/diagram.png`

Supported asset types:

- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check |
| `GET /view/<repo>/<path>` | File or directory view |
| `GET /asset/<repo>/<path>` | Read-only image asset serving for inline docs |

## Project Structure

```
ops-file-viewer/
├── lookout.yaml.example  # Config template (copy to ~/.config/lookout/)
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
