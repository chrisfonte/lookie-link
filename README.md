# ops-file-viewer

Web file viewer for operations repositories, intended to run on a local macOS gateway and be accessed over Tailscale.

## Features

- Read-only file and directory browser
- URL format: `/view/<repo>/<path>`
- Markdown rendering with syntax-highlighted code blocks
- YAML/code rendering with syntax highlighting
- Plain text fallback for unknown extensions
- Mobile-friendly dark theme
- Configurable repo-to-directory mapping via env var

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

Server defaults:

- Port: `9876`
- Hostname label in logs: `mac-mini-2.bobcat-tetra.ts.net`

## Configuration

### `PORT`

Port to listen on.

### `HOSTNAME`

Hostname shown in startup logs.

### `ROOT_MAPPINGS`

Repo path mappings. Two formats are supported:

1. Comma-separated `repo=/abs/path` pairs

```bash
ROOT_MAPPINGS="operations=~/operations,clawd=~/clawd"
```

2. JSON object

```bash
ROOT_MAPPINGS='{"operations":"~/operations","clawd":"~/clawd"}'
```

Default mappings:

- `operations -> ~/operations`
- `operations-fontastic -> ~/operations-fontastic`
- `operations-chris-fonte -> ~/operations-chris-fonte`
- `clawd -> ~/clawd`

## Endpoints

- `GET /` - repo index
- `GET /healthz` - health check
- `GET /view/<repo>/<path>` - file or directory view
