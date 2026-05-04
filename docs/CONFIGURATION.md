# Configuration

Create `~/.config/lookie-link/lookie-link.yaml`:

```yaml
server:
  port: 9876
  hostname: my-server.example.com
  enableEditing: false

repositories:
  docs: ~/Documents/docs
  notes: ~/notes
  project: ~/projects/my-project
```

Each key under `repositories` becomes a URL prefix: `/view/docs/...`, `/view/notes/...`, etc.

A sample config is included: `lookie-link.yaml.example`.

## Access Tokens

Phase 1 agent access control is config-driven under `access.tokens`. Secrets should come from environment variables when possible.

```yaml
access:
  humanDefault: full # full | restricted | none
  tokens:
    builder_read:
      secretEnv: LOOKIE_TOKEN_BUILDER_READ
      repos:
        docs:
          paths:
            - guides/
            - README.md
      permissions:
        view: true
        edit: false

    builder_edit:
      secretEnv: LOOKIE_TOKEN_BUILDER_EDIT
      repos:
        docs:
          paths:
            - drafts/
      permissions:
        view: true
        edit: true
```

Notes:

- `humanDefault: full` preserves current unauthenticated browser behavior.
- `humanDefault: restricted` or `none` requires a token for `/`, `/view/*`, `/asset/*`, `/edit/*`, and `/api/*`.
- Paths ending in `/` grant a directory subtree. Paths without a trailing slash grant a single file.
- Tokens can also use `secret:` directly for local development, but that should not be committed.
- Static tokens may carry optional `subject`, `issuer`, and `audit` metadata so future agent-facing `whoami/repos/grant` APIs can identify the Paperclip issue, agent, or projected grant behind a token without changing the phase 1 config shape.
- Query-string tokens are preserved across rendered links so tokenized browser sessions can keep navigating.

## Config Priority

Settings resolve in this order (first wins):

1. **Environment variables** (`PORT`, `HOSTNAME`, `ROOT_MAPPINGS`, `LOOKIE_LINK_CONFIG`)
2. **`~/.config/lookie-link/lookie-link.yaml`** (user config)
3. **`lookie-link.yaml`** in project root (development fallback)
4. **Built-in defaults** (port 9876)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default: 9876) |
| `HOSTNAME` | Hostname shown in startup logs |
| `ROOT_MAPPINGS` | Comma-separated `repo=path` pairs or JSON object |
| `LOOKIE_LINK_CONFIG` | Path to a custom config file (overrides search) |
| `LOOKIE_LINK_ENABLE_EDITING` | Boolean override for edit mode (`true/false`, `1/0`, `yes/no`) |

## Custom Themes

Define custom color themes in your config file. Each theme needs dark and/or light variants with CSS variable values (use underscores for property names):

```yaml
themes:
  midnight:
    dark:
      bg: "#0a0a1a"
      bg_elev: "#12122a"
      bg_code: "#08081a"
      text: "#c8c8ff"
      text_soft: "#8888bb"
      accent: "#7c6aff"
      border: "#2a2a55"
      link: "#9b8aff"
      page_bg: "radial-gradient(circle at top right, #1a1a3a, #0a0a1a 50%)"
      toolbar_bg: "rgba(18, 18, 42, 0.94)"
      toolbar_btn_bg: "#1a1a3a"
      toolbar_btn_hover: "#2a2a4a"
      toc_active_bg: "rgba(124, 106, 255, 0.18)"
    light:
      bg: "#f0f0ff"
      bg_elev: "#ffffff"
      bg_code: "#e8e8f8"
      text: "#1a1a3a"
      text_soft: "#5555aa"
      accent: "#4a3ad9"
      border: "#d0d0ee"
      link: "#4a3ad9"
      page_bg: "linear-gradient(160deg, #f0f0ff 0%, #e8e8f8 100%)"
      toolbar_bg: "rgba(255, 255, 255, 0.94)"
      toolbar_btn_bg: "#e8e8f8"
      toolbar_btn_hover: "#d8d8ee"
      toc_active_bg: "rgba(74, 58, 217, 0.15)"
```

Custom themes appear in the theme cycle button alongside the 10 built-in themes.
