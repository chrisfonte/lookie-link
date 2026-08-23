# Configuration

The authoritative inventory of recognized keys, defaults, and environment overrides is [CAPABILITIES.md](CAPABILITIES.md#configuration-key-inventory). Unknown YAML keys are not feature declarations; only settings listed in that inventory are supported.

## File lookup and precedence

The server reads the first available file in this order:

1. `LOOKIE_LINK_CONFIG`
2. `~/.config/lookie-link/lookie-link.yaml`
3. `lookie-link.yaml` in the project root

For supported settings, direct environment overrides take precedence over the selected YAML file. Copy `lookie-link.yaml.example` to the user config directory as a starting point.

## Core server and repositories

```yaml
server:
  port: 9876
  hostname: localhost
  enableEditing: false
  enableAnnotations: false
  enableRawHtml: false

repositories:
  docs: ~/Documents/docs
  notes: ~/Documents/notes
```

Each repository key becomes `/view/<key>/...`. `ROOT_MAPPINGS` replaces the YAML map when it contains either JSON or comma-separated `repo=path` pairs.

The three feature flags are independent and default off. Raw HTML serves trusted authored HTML without sanitization on the application origin; do not enable it for untrusted content.

## Caller access

```yaml
access:
  humanDefault: restricted
  tokens:
    docs_reader:
      secretEnv: LOOKIE_TOKEN_DOCS_READER
      subject:
        companyId: example-company
        agentId: review-agent
        label: Review Agent
      repos:
        docs:
          paths:
            - guides/
            - README.md
      permissions:
        view: true
        write: false
        publish: false
```

`humanDefault: full` is the backward-compatible default and grants anonymous access. Use `restricted` or `none` for mixed-user instances. Paths ending in `/` grant a subtree; other paths grant one file. `repos: all` grants all repos. Prefer `secretEnv`; inline `secret` values should remain in private local config.

`write` is canonical. Existing `permissions.edit` and `allowEditing` values are accepted as aliases.

## Managed API keys and grants

```yaml
access:
  apiKeys:
    storePath: ~/.local/share/lookie-link/agent-api-keys.yaml
    adminTokens:
      operator:
        secretEnv: LOOKIE_LINK_AGENT_KEY_ADMIN_TOKEN
  grants:
    storePath: /srv/lookie-link/grants.yaml
    projectionPath: /srv/lookie-link/grants-projection.yaml
    repoOwners:
      docs: example-company
    repoRoots:
      docs: /srv/lookie-link/repos/docs
    adminTokens:
      issuer:
        secretEnv: LOOKIE_LINK_GRANT_ADMIN_TOKEN
```

The store files enable their corresponding APIs. API keys and grant tokens are hashed at rest; admin secrets are resolved from config/env. A grant projection is optional and contains active safe projections only. Grant store, projection, and repo-root values are resolved with `path.resolve` but do not expand `~`, so use absolute paths. `repoRoots` is required to enforce cross-company API request `adapterAllowRoots` against real paths.

## Managed repositories

```yaml
managedRepos:
  storePath: ~/.local/share/lookie-link/managed-repos.yaml
  allowRoots:
    - ~/Documents/shared-workspaces
  adminTokens:
    operator:
      secretEnv: LOOKIE_LINK_MANAGED_REPO_ADMIN_TOKEN
```

Every allow-root must already exist. The registry and all newly registered roots are contained by realpath checks. Registration uses the admin token; normal file operations use caller `view` or `write` scope.

## Publishing

```yaml
publish:
  enabled: true
  areaPath: ~/.local/share/lookie-link/published
  repoId: published
  maxFiles: 100
  maxFileBytes: 2097152
  maxRevisionBytes: 10485760
  maxMetadataBytes: 65536
  maxRevisions: 20
```

`areaPath` enables the store unless `enabled` is exactly `false`. The virtual repo ID must not collide with a mounted repository. All limits are positive integers. Enabling the store while leaving `humanDefault: full` permits anonymous publishing, so restricted access is strongly recommended.

## Custom themes

Lookie-Link ships with Slate, Teal, Nord, Rose Pine, Monokai, Solarized,
GitHub, Ember, Noir, Indigo, and Codex. The Codex theme is a research-based
interpretation of the Codex desktop app's neutral shell and blue interaction
accent. It intentionally follows the flat working interface—not the more vivid
marketing imagery—and does not bundle or copy proprietary Codex artwork.

```yaml
themes:
  midnight:
    dark:
      bg: "#0a0a1a"
      text: "#d8d8ff"
      accent: "#8a7cff"
      toolbar_btn_text: "#ffffff"
      heading_font: "system-ui, sans-serif"
    light:
      bg: "#f5f5ff"
      text: "#202044"
      accent: "#5140d8"
```

Theme variants may set any key listed in the [configuration inventory](CAPABILITIES.md#configuration-key-inventory). Underscores map to CSS custom-property hyphens. A custom name that normalizes to a built-in theme name is skipped.

## Server environment variables

| Variable | Purpose |
|---|---|
| `LOOKIE_LINK_CONFIG` | Select config file |
| `PORT` | Override server port |
| `HOSTNAME` | Override display hostname |
| `ROOT_MAPPINGS` | Replace repository map |
| `LOOKIE_LINK_ENABLE_EDITING` | Override editing boolean |
| `LOOKIE_LINK_ENABLE_ANNOTATIONS` | Override annotations boolean |
| `LOOKIE_LINK_ENABLE_RAW_HTML` | Override raw/transformed HTML boolean |

Boolean overrides accept `true/false`, `1/0`, `yes/no`, and `on/off`. The CLI additionally reads `LOOKIE_LINK_BASE_URL` and `LOOKIE_LINK_TOKEN`; those do not configure the server.
