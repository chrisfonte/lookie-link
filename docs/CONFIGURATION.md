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

## Search

```yaml
search:
  ripgrep: auto        # auto (look on the service's PATH) | false | /usr/bin/rg
  maxResults: 100      # 1-100
```

Query semantics are the same on both backends: every whitespace-separated term must occur in a file's content (any order) or every term in its path; `"quoted words"` form one phrase; matching is literal and case-insensitive.

With a ripgrep binary available, `/api/search` searches every served repository in one process and is complete (the response says `backend: "ripgrep"`). Without one, the built-in walk is used: complete when scoped to one repo, fair-share sampled across a fleet (`backend: "walk"`, `truncated` says when a slice ran out). `maxEntries` applies to the walk only. The binary must be on the SERVICE's PATH (a shell alias or function does not count) or named explicitly.

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

**Behavior change (aliases, #389).** Two custom themes that normalize to the
same slug — or a theme and an alias claiming the same slug, including across
different theme entries — used to both load: both emitted CSS, and whichever
block came later in the file won in the cascade. Slugs are now tracked as
they are claimed across the whole pass, so the later entry is skipped
entirely, with a warning naming the theme (or theme and alias) and the
colliding slug. Only the first claim survives.

### Wallpapers

A custom theme may point at a folder of images per mode. The viewer scans each
folder once at startup and paints the pictures behind every page while that
theme and mode are active (see [CAPABILITIES.md](CAPABILITIES.md#viewer-wide-wallpapers)).

```yaml
themes:
  Carolina Sunset:
    wallpapers:
      dark: ~/.config/omarchy/themes/carolina-sunset/backgrounds
      light: ~/.config/omarchy/themes/carolina-sunset-light/backgrounds
```

Presentation is configuration too. A global block sets the glass defaults
every theme starts from, and a theme may override them and name its starting
picture per mode:

```yaml
wallpapers:
  panel_opacity: 72        # 50-100, percent
  blur: 12                 # 0-16, px behind the panel

themes:
  Carolina Sunset:
    wallpapers:
      dark: ~/.config/omarchy/themes/carolina-sunset/backgrounds
      light: ~/.config/omarchy/themes/carolina-sunset-light/backgrounds
      default:
        dark: mackerel-sky   # picture id; moves to the front of the set
        light: pale-dawn
      panel_opacity: 80    # this theme only
      blur: 6
```

Changes take effect without a restart. The server watches the config file
and every wallpaper folder; a saved edit or a new image is picked up within
about half a second and shows on the next page load. This covers the whole
`themes:` section (palettes, aliases, wallpapers) and the global
`wallpapers:` block. Server settings such as roots, port, access and forms
are still read at startup.

A reader's own slider changes, once made, persist in their browser and win
over these defaults until they press Reset. URL parameters
(`lookie-wallpaper`, `lookie-panel`, `lookie-blur`) win over both for that
page. A `default` id that is not in the set logs a warning and is ignored.

Accepted files: `.jpg`, `.jpeg`, `.png`, `.webp`; at most 50 per folder.
Files are ordered by a leading number (`3-…`) when present, then by name. The
picture's id and label come from the filename with the number and the theme's
own name stripped, so `0-carolina-sunset-ember-ripples.jpg` is "Ember
Ripples". A folder that is missing or unreadable logs a warning and yields an
empty set; the server still starts. Only the images are served, by id, at
`/wallpaper/<slug>/<mode>/<id>`; the folder path never leaves the server.

### Appearance API and the overlay file

Themes and wallpapers can also be changed over HTTP (see [API.md](API.md#appearance)). Those changes are written to `appearance.yaml` beside the config file (override with `LOOKIE_LINK_APPEARANCE_OVERLAY`), never to the config file itself; the overlay is merged over the config at load time and wins where both set a key. Uploaded pictures go to `wallpapers/<slug>/<mode>/` beside the config file. Writes require a bearer token from `access.appearance.adminTokens` (same shape as the grant admin tokens); when that block is absent the grant admin tokens are accepted.

### Aliases

A custom theme may also declare `aliases:` — additional names that render the
same theme:

```yaml
themes:
  harbor-night:
    aliases: [old-harbor]
    dark:
      bg: "#0a0a1a"
      text: "#d8d8ff"
    light:
      bg: "#f5f5ff"
      text: "#202044"
```

An alias must match `/^[a-z0-9-]+$/` and must not collide with a built-in
theme, another custom theme's slug, or another theme's alias (or repeat
within the same list) — a violating alias is skipped with a warning naming
the theme and the alias, and the theme itself is kept. The picker only ever
lists the theme once, under its canonical slug; a form template's
`presentation.theme` set to an alias resolves to the theme exactly like the
slug would. An unknown slug (neither a theme nor an alias) still fails open
to the default theme, unchanged.

**Renaming a theme.** To rename `harbor-night` to `harbor`, add the old
name as an alias of the new one rather than deleting it outright:

```yaml
themes:
  harbor:
    aliases: [harbor-night]
    dark: { ... }
    light: { ... }
```

Anyone whose saved picker choice was `harbor-night` still renders the theme
and, on their next visit, sees the picker re-select the new `harbor` entry —
their stored preference is rewritten to the canonical slug automatically.
Templates that still reference `presentation.theme: harbor-night` keep
rendering correctly too, so the rename is a config-only, zero-downtime
change. Drop the alias later once nothing references the old name anymore.

## Kits

Hosted HTML kits are folders of a stylesheet plus templates/examples that
agents can list and fetch. The product ships a bundled `ops` kit under
`kits/ops/`; operators can add more roots:

```yaml
kits:
  enabled: true          # default true when any kit exists
  default: ops           # advertised default; used by publish when kit: is omitted (stage 2)
  folders:               # extra kit roots; each child folder with a kit.yaml is a kit
    - ~/.config/lookie-link/kits
```

Each kit folder contains `kit.yaml` (required), `kit.css`, and the HTML/Markdown
files listed in the manifest. Sources, in precedence order: `kits.folders[]`
(config) then the bundled `kits/` directory. Same name: config wins. Missing
folders and invalid manifests are skipped with a console warning; the server
still starts. Kit folders are watched for live reload like wallpaper folders.

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
