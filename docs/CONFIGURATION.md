# Configuration

Create `~/.config/lookie-link/lookie-link.yaml`:

```yaml
server:
  port: 9876
  hostname: my-server.example.com
  enableEditing: false
  enableAnnotations: false

repositories:
  docs: ~/Documents/docs
  notes: ~/notes
  project: ~/projects/my-project
```

Each key under `repositories` becomes a URL prefix: `/view/docs/...`, `/view/notes/...`, etc.

A sample config is included: `lookie-link.yaml.example`.

## Managed Repositories

```yaml
managedRepos:
  storePath: ~/.local/share/lookie-link/managed-repos.yaml
  allowRoots:
    - ~/shared-workspaces
  adminTokens:
    local_operator:
      secretEnv: LOOKIE_LINK_MANAGED_REPO_ADMIN_TOKEN
```

`storePath` enables the registry and mutable-content routes. Each `allowRoots`
entry must be an existing directory. Registration resolves real paths and only
creates a repository below a real, in-scope ancestor, so a symlink ancestor
cannot redirect creation outside the allow-root. Keep admin secrets in the
environment; normal file mutations use caller `write` capability.

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
        write: false

    builder_write:
      secretEnv: LOOKIE_TOKEN_BUILDER_WRITE
      repos:
        docs:
          paths:
            - drafts/
      permissions:
        view: true
        write: true
```

Notes:

- `humanDefault: full` preserves current unauthenticated browser behavior.
- `humanDefault: restricted` or `none` requires a token for `/`, `/view/*`, `/asset/*`, `/edit/*`, and `/api/*`.
- Paths ending in `/` grant a directory subtree. Paths without a trailing slash grant a single file.
- Tokens can also use `secret:` directly for local development, but that should not be committed.
- Static tokens still accept legacy `edit: true|false` and normalize it to `write` for backward compatibility.
- Static tokens may carry optional `subject`, `issuer`, and `audit` metadata so future agent-facing `whoami/repos/grant` APIs can identify the Paperclip issue, agent, or projected grant behind a token without changing the phase 1 config shape.
- Query-string tokens are preserved across rendered links so tokenized browser sessions can keep navigating.

## Managed Grants

Managed grants add a writable grant store, optional read-only projection, and
admin-auth lifecycle API for Paperclip or another issuer workflow.

```yaml
access:
  humanDefault: restricted
  grants:
    storePath: ~/.local/share/lookie-link/grants.yaml
    projectionPath: ~/.local/share/lookie-link/grants-projection.yaml
    repoOwners:
      docs: fontastic
    repoRoots:
      docs: ~/Documents/docs
    adminTokens:
      paperclip:
        secretEnv: LOOKIE_LINK_GRANT_ADMIN_TOKEN
```

Notes:

- `storePath` enables the managed grant lifecycle and is required.
- `projectionPath` is optional; when set, Lookie-Link writes active grants only,
  without reasons or revocation metadata, for runtime projection use.
- `repoOwners` maps each repo id to the company allowed to issue grants for it.
- `repoRoots` should mirror the configured repository roots when you want
  cross-company `adapterAllowRoots` enforcement.
- Cross-company grant creation requires `adapterAllowRoots` in the API request
  and rejects targets outside those absolute roots.

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
| `LOOKIE_LINK_ENABLE_ANNOTATIONS` | Boolean override for annotation routes (`true/false`, `1/0`, `yes/no`) |

## Annotation Transport

`server.enableAnnotations` gates the JSON sidecar transport under `/api/annotations/*`.

- Default: `false`
- Precedence: `LOOKIE_LINK_ENABLE_ANNOTATIONS` env var, then user/project YAML, then default
- Independent of `enableEditing`
- When disabled, `GET|POST|PATCH /api/annotations/<repo>/<path>` return `404`
- `GET` requires `view`; `POST` and `PATCH` require the write-class `write` permission (including legacy `edit` aliases)
- Annotation sidecars live inside each served repo at `.lookie-link/annotations/<repo>/<relative-path>.json`

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
