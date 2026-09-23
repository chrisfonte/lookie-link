# Capability and Route Matrix

This file is the authoritative inventory of the implemented Lookie-Link surface. Other documents describe workflows and payloads, but must link here instead of maintaining another route or capability list.

The inventory was checked against the route registrations in [`server.js`](../server.js), the exported modules in [`lib/`](../lib), the configuration readers in [`lib/config.js`](../lib/config.js), the sample YAML, the unified CLI in [`bin/lookie.js`](../bin/lookie.js), and the test suite. Source anchors identify the relevant route-registration block; authorization checks are inside the same handler.

## Authorization vocabulary

- **Public** means the route itself performs no access check.
- **Effective `view`, `write`, or `publish`** means the caller's resolved access context must allow that permission for the repository and path. With the default `access.humanDefault: full`, an unauthenticated caller receives all permissions; `restricted` and `none` require a valid static token, managed API key, or managed grant.
- `edit` is accepted in stored credentials as a legacy alias, but is normalized to `write`.
- Read requests accept a bearer token or `?token=`. All `POST`, `PUT`, `PATCH`, and `DELETE` requests reject query credentials before route handling and therefore require bearer credentials when access is restricted.
- Administrative tokens are separate from caller permissions and are never advertised by discovery.
- Denials and every other JSON API failure use the single error envelope `{ ok: false, error: { code, message, details? } }` (for example `unauthenticated`, `forbidden`, `query_credentials_rejected`); see [API.md → Error conventions](API.md#error-conventions).

## Registered HTTP routes

| Route / capability | Method | Required auth | Enabled by config | Notes and source |
|---|---|---|---|---|
| Static browser assets: `/public/*` | `GET`, `HEAD` | Public | Always | Express static mount; no repository data. [`server.js`](../server.js) |
| Repo tree: `/api/repos/:repo/tree` | `GET` | Effective `view` on requested directory and returned entries | Always | Any served repo, managed or plainly mapped. Bounded by depth and entry limits; `.git`, Syncthing state and `node_modules` are never listed; managed trash is hidden. [`server.js`](../server.js) |
| Repo changes: `/api/repos/:repo/changes` | `GET` | Effective `view` | Always | Any served repo. Bounded mtime-based file listing, newest first; `since` accepts epoch milliseconds, epoch seconds or ISO-8601 (compared against `mtimeMs`); entries carry `viewUrl`. [`server.js`](../server.js) |
| Repo file read: `/api/repos/:repo/files/*` | `GET` | Effective `view` on file | Always | Any served repo. UTF-8 content and metadata as JSON. [`server.js`](../server.js) |
| Managed repo list: `/api/managed-repos` | `GET` | Results require effective `view` | `managedRepos.storePath` | Returns only visible managed repos and omits roots; a denied caller receives an empty list rather than an auth error. [`server.js`](../server.js) |
| Managed repo registration: `/api/managed-repos` | `POST` | Managed-repo admin bearer token | `managedRepos.storePath`, `allowRoots`, and `adminTokens` | Registers or creates a root only below an existing allow-root. [`server.js`](../server.js) |
| Managed tree: `/api/managed-repos/:repo/tree` | `GET` | Effective `view` on requested directory and returned entries | `managedRepos.storePath` | Bounded by depth and entry limits; internal trash is hidden. [`server.js`](../server.js) |
| Managed changes: `/api/managed-repos/:repo/changes` | `GET` | Effective `view` | `managedRepos.storePath` | Bounded mtime-based file listing; `since` accepts epoch milliseconds, epoch seconds or ISO-8601 (compared against `mtimeMs`). [`server.js`](../server.js) |
| Managed file read: `/api/managed-repos/:repo/files/*` | `GET` | Effective `view` on file | `managedRepos.storePath` | Returns UTF-8 content and metadata as JSON. [`server.js`](../server.js) |
| Managed file create/update: `/api/managed-repos/:repo/files/*` | `PUT` | Effective `write` on file | `managedRepos.storePath` | Atomic UTF-8 write; optional `expectedMtimeMs`; records managed API-key audit events. [`server.js`](../server.js) |
| Publish create: `/api/publish` | `POST` | Repo-level `publish` on the configured publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Creates immutable revision 1. Path-only publish scope is insufficient. [`server.js`](../server.js) |
| Managed file delete: `/api/managed-repos/:repo/files/*` | `DELETE` | Effective `write` on file | `managedRepos.storePath` | Soft delete by default; `?hard=1` permanently deletes. [`server.js`](../server.js) |
| Managed trash list: `/api/managed-repos/:repo/trash` | `GET` | Effective `view` on repo; entries filtered by `view` on the original path | `managedRepos.storePath` | Soft-deleted records newest first: `trashId`, `originalPath`, `deletedAt`, `size`. [`server.js`](../server.js) |
| Managed trash restore: `/api/managed-repos/:repo/trash/:trashId/restore` | `POST` | Effective `write` on repo and original file | `managedRepos.storePath` | Restores a soft-deleted file. [`server.js`](../server.js) |
| Managed trash removal: `/api/managed-repos/:repo/trash/:trashId` | `DELETE` | Effective `write` on repo and original file | `managedRepos.storePath` | Permanently deletes one trash item. [`server.js`](../server.js) |
| Search: `/api/search` | `GET` | Effective `view`; results are caller-filtered | Always | Backend `ripgrep` (complete, every served repo) when a binary is available, else the fair-shared walk; the response names the backend. Unknown query parameters are rejected (400 with `details[]`); `repo` is an alias of `scope`. Requires `q`: whitespace-separated terms must ALL occur in a file's content (any order) or all in its path; `"quoted words"` form one phrase; literal, case-insensitive. `limit` must be an integer ≥ 1; a `scope` naming no searchable repo is `400`. Responses carry `terms`, `totalMatches` and `backend`. [`server.js`](../server.js) |
| Suggestions: `/api/search/suggest` | `GET` | Effective `view`; results are caller-filtered | Always | Requires `q`; returns bounded path suggestions. [`server.js`](../server.js) |
| Publish update: `/api/publish/:slug` | `POST` | Repo-level `publish` on publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Requires `expectedRevision`; creates a complete immutable next revision. [`server.js`](../server.js) |
| Publish revoke: `/api/publish/:slug/revoke` | `POST` | Repo-level `publish` on publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Requires a reason and revokes current and historical readback. [`server.js`](../server.js) |
| API-key list: `/api/agent-keys` | `GET` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Optional state/agent filters and audit projection. [`server.js`](../server.js) |
| API-key create: `/api/agent-keys` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Returns the new secret once; stores only its hash. [`server.js`](../server.js) |
| API-key rotate: `/api/agent-keys/:keyId/rotate` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Replaces and returns the secret once. [`server.js`](../server.js) |
| API-key revoke: `/api/agent-keys/:keyId/revoke` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Requires a reason. [`server.js`](../server.js) |
| Grant list: `/api/grants` | `GET` | Grant admin token; bearer preferred, query accepted for this read | `access.grants.storePath` and `adminTokens` | Optional filters and audit projection. [`server.js`](../server.js) |
| Grant create: `/api/grants` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Enforces issuer, subject, owner, expiry, approval, and cross-company allow-root policy. [`server.js`](../server.js) |
| Grant renew: `/api/grants/:grantId/renew` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Updates expiry and rotates the grant token unless disabled in the request. [`server.js`](../server.js) |
| Grant revoke: `/api/grants/:grantId/revoke` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Requires a reason and authorized issuer identity in the payload. [`server.js`](../server.js) |
| Repository index: `/` | `GET` | Non-denied caller; entries require effective `view` | Always | HTML index filtered to visible repos. [`server.js`](../server.js) |
| Health: `/healthz` | `GET` | Public | Always | Returns status and the three server feature booleans. [`server.js`](../server.js) |
| Agent discovery: `/.well-known/agent.json` | `GET` | Non-denied caller | Always | Versioned caller-scoped discovery document. [`server.js`](../server.js) |
| Caller discovery: `/api/whoami` | `GET` | Non-denied caller | Always | Caller identity, permissions, scopes, capabilities, and endpoints. [`server.js`](../server.js) |
| OpenAPI document: `/openapi.json` | `GET` | Non-denied caller | Always | OpenAPI 3.1 description of every route in this matrix (plus forms routes when mounted); `Cache-Control: no-cache`. Test-bound to the registered routes. [`server.js`](../server.js) |
| API explorer: `/api/docs` | `GET` | Non-denied caller | Always | HTML try-it page rendered from `/openapi.json`; sends requests with a bearer token kept in `sessionStorage`. [`server.js`](../server.js) |
| Repo discovery: `/api/repos` | `GET` | Non-denied caller; results require effective `view` | Always | Returns opaque repo/view/asset URLs, never roots. [`server.js`](../server.js) |
| Render/browse: `/view/*` | `GET` | Effective `view` on path | Always | Directory, document, code, image, audio, video, PDF, CSV, and JSON views; HTML supports `?validate=1`; publish readback supports `?version=`. [`server.js`](../server.js) |
| Edit page: `/edit/*` | `GET` | Effective `write` on file | `server.enableEditing` or `LOOKIE_LINK_ENABLE_EDITING` | Text/non-binary existing files only. [`server.js`](../server.js) |
| Save mounted file: `/api/save/*` | `POST` | Effective `write` on existing file | Editing flag | Atomic UTF-8 replacement with optional `expectedMtimeMs`. [`server.js`](../server.js) |
| Preview draft: `/api/preview/*` | `POST` | Effective `view` on existing file | Editing flag | Renders supplied content without writing it. [`server.js`](../server.js) |
| Annotation read: `/api/annotations/:repo/*` | `GET` | Effective `view` on file | `server.enableAnnotations` or `LOOKIE_LINK_ENABLE_ANNOTATIONS` | Sidecar read with repeatable `state` filter. [`server.js`](../server.js) |
| Annotation create: `/api/annotations/:repo/*` | `POST` | Effective `write` on file | Annotations flag | Supports heading, YAML-key, and line-range anchors. [`server.js`](../server.js) |
| Annotation update: `/api/annotations/:repo/*` | `PATCH` | Effective `write` on file | Annotations flag | Claim, resolve, reopen, reply, or redact; optional stale-write guard. [`server.js`](../server.js) |
| Raw asset: `/asset/:repo/*` | `GET` | Effective `view` on file | Always | Allowlisted image/audio/video/PDF/text MIME types; published revisions accept `?version=`. [`server.js`](../server.js) |
| Appearance list: `/api/appearance` | `GET` | Non-denied caller | Always | Pollable list of themes (palettes, aliases, picture ids per mode, effective glass values) plus global defaults, URL parameter names, `revision`; weak ETag, `no-cache`, 304 on `If-None-Match`. Never includes folder paths. [`lib/appearance-api.js`](../lib/appearance-api.js) |
| Appearance theme: `/api/appearance/themes/:slug` | `GET` | Non-denied caller | Always | One theme by slug or alias. [`lib/appearance-api.js`](../lib/appearance-api.js) |
| Appearance change: `/api/appearance` | `PATCH` | Appearance admin bearer token (`access.appearance.adminTokens`, else `access.grants.adminTokens`) | Admin tokens configured | Merges `wallpapers` / `themes` keys into the server-owned overlay file; `expectedRevision` required (409 `revision_conflict` + `currentRevision`); unknown keys, bad ranges and loader-level rejections return 400 with `details[]`; `themes.<Name>: null` removes a theme; audit `appearance.update`. [`lib/appearance-api.js`](../lib/appearance-api.js) |
| Wallpaper upload: `/api/appearance/themes/:slug/wallpapers/:mode` | `POST` | Appearance admin bearer token | Admin tokens configured | Raw image body (`image/jpeg`, `image/png`, `image/webp`, ≤24 MB), `?name=` becomes the picture id. Writes only the server-managed folder; a mode fed from another folder returns 409 `folder_not_managed`. First upload adopts the managed folder in the overlay. Audit `appearance.wallpaper.upload`. [`lib/appearance-api.js`](../lib/appearance-api.js) |
| Wallpaper delete: `/api/appearance/themes/:slug/wallpapers/:mode/:id` | `DELETE` | Appearance admin bearer token | Admin tokens configured | Managed folder only. Audit `appearance.wallpaper.delete`. [`lib/appearance-api.js`](../lib/appearance-api.js) |
| Wallpaper image: `/wallpaper/:slug/:mode/:id` | `GET` | Non-denied caller | Any theme declares `wallpapers` | Serves one image from the live catalog of a theme's configured folder; ids come from the catalog, never from a path. `Cache-Control: no-cache` with ETag revalidation, so a replaced picture shows on the next load. [`server.js`](../server.js) |
| Transformed HTML: `/embed/:repo/*` | `GET` | Effective `view` on file | Raw-HTML flag | `.html`/`.htm` only; preserves scripts while rewriting local URLs and injecting theme/annotation integration. Mounted repos only. [`server.js`](../server.js) |
| Verbatim HTML: `/raw/:repo/*` | `GET` | Effective `view` on file | Raw-HTML flag | `.html`/`.htm` only; unsanitized same-origin content; supports published revisions. [`server.js`](../server.js) |
| View redirect: `/view` | `GET` | Public redirect | Always | Redirects to `/`; a restricted caller is then challenged there. [`server.js`](../server.js) |

Unmatched paths use the final `404` middleware and unhandled errors use the final `500` middleware at [`server.js`](../server.js). These are fallbacks, not separately registered application routes.

## Discovery endpoint templates

This three-column table is test-checked against `lib/agent-discovery.js` and the registered routes. An endpoint is emitted only when its conditions are true for the caller.

| Endpoint key | Template | Emitted when |
|---|---|---|
| `agentDiscovery` | `/.well-known/agent.json` | Caller is non-denied |
| `whoami` | `/api/whoami` | Caller is non-denied |
| `repos` | `/api/repos` | Caller is non-denied |
| `view` | `/view/:repo/*path` | Caller has a visible `view` scope |
| `assetRead` | `/asset/:repo/*path` | Caller has a visible `view` scope |
| `edit` | `/edit/:repo/*path` | Editing is enabled and caller has a visible `write` scope |
| `save` | `/api/save/:repo/*path` | Editing is enabled and caller has a visible `write` scope |
| `preview` | `/api/preview/:repo/*path` | Editing is enabled and caller has a visible `view` scope |
| `annotationRead` | `/api/annotations/:repo/*path` | Annotations are enabled and caller has a visible `view` scope |
| `annotationCreate` | `/api/annotations/:repo/*path` | Annotations are enabled and caller has a visible `write` scope |
| `annotationUpdate` | `/api/annotations/:repo/*path` | Annotations are enabled and caller has a visible `write` scope |
| `rawHtml` | `/raw/:repo/*path` | Raw HTML is enabled and caller has a visible `view` scope |
| `embeddedHtml` | `/embed/:repo/*path` | Raw HTML is enabled and caller has a visible `view` scope |
| `managedRepoList` | `/api/managed-repos` | Managed store is enabled and caller can see a managed repo |
| `managedFileRead` | `/api/managed-repos/:repo/files/*path` | Managed store is enabled and caller can see a managed repo |
| `managedFileWrite` | `/api/managed-repos/:repo/files/*path` | Managed store is enabled and caller has a visible `write` scope |
| `managedTree` | `/api/managed-repos/:repo/tree` | Managed-repo capability is available |
| `managedChanges` | `/api/managed-repos/:repo/changes` | Managed-repo capability is available |
| `search` | `/api/search` | Caller has a visible `view` scope (managed and mapped repos) |
| `repoTree` | `/api/repos/:repo/tree` | Caller has a visible `view` scope |
| `repoChanges` | `/api/repos/:repo/changes` | Caller has a visible `view` scope |
| `repoFileRead` | `/api/repos/:repo/files/*path` | Caller has a visible `view` scope |
| `searchSuggest` | `/api/search/suggest` | Search capability is available |
| `publishCreate` | `/api/publish` | Publish store is enabled and caller has repo-level `publish` |
| `publishUpdate` | `/api/publish/:slug` | Publish capability is available |
| `publishRevoke` | `/api/publish/:slug/revoke` | Publish capability is available |
| `wallpaperImage` | `/wallpaper/:scheme/:mode/:id` | Any theme declares `wallpapers` and the route is registered |
| `appearance` | `/api/appearance` | Always (non-denied caller) |
| `appearanceTheme` | `/api/appearance/themes/:slug` | Always (non-denied caller) |
| `forms` | `/forms` | `forms.enabled` is true |
| `formsTemplates` | `/api/forms/templates` | `forms.enabled` is true |
| `formsSubmissions` | `/api/forms/:templateId/submissions` | `forms.enabled` is true |

Administrative grant, API-key, and managed-repo registration routes are intentionally not emitted.

## Runtime capability fields

Both discovery responses contain these booleans. They are computed from registered routes, enabled stores/flags, and the caller's effective scope.

| Field | True when |
|---|---|
| `whoami` | The `/api/whoami` route is registered |
| `repoDiscovery` | The `/api/repos` route is registered |
| `assetRead` | Caller has visible `view` scope and the asset route exists |
| `editing` | Editing is enabled, caller has visible `write`, and edit/save routes exist |
| `annotations` | Annotations are enabled, caller has visible `view`, and read route exists |
| `annotationWrite` | Annotations are enabled, caller has visible `write`, and create/update routes exist |
| `rawHtml` | Raw HTML is enabled, caller has visible `view`, and raw route exists |
| `embeddedHtml` | Raw HTML is enabled, caller has visible `view`, and embed route exists |
| `managedRepos` | Managed store is enabled and caller can see at least one managed repo |
| `search` | Caller has a visible `view` scope and the search route exists (covers managed and mapped repos) |
| `repoRead` | Caller has a visible `view` scope and the generic tree/file-read routes exist |
| `publish` | Publish store is enabled and caller has whole-repo `publish` scope on its virtual repo |
| `wallpapers` | At least one theme has a picture set and the wallpaper image route is registered |
| `appearance` | The appearance list route is registered (always); its admin writes are not advertised |
| `forms` | The forms router is mounted (`forms.enabled: true`); per-template authorization still applies on each forms route |

## Discovery field inventory

`GET /api/whoami` returns `ok`; the same `themes` appearance block as the agent card (below); `auth.mode`, `auth.type`, `auth.source`, and `auth.queryToken`; sanitized `subject` (`companyId`, `agentId`, `label`, or `null`); `permissions` (`view`, `write`, legacy-equivalent `edit`, `publish`); `repoScopes[]` (`repo`, `managed`, and `scopes[]` with `type` and `path`); plus `capabilities` and `endpoints` from the tables above.

`GET /.well-known/agent.json` returns `ok`, `schemaVersion`, `name`, package `version`, `generatedAt`; `instance.baseUrl` and `instance.mode`; `authentication.bearerToken` and `authentication.queryTokenForReadRequests`; `discovery.whoamiUrl`, `discovery.reposUrl`, `discovery.agentJsonUrl`, `discovery.openapiUrl`, and `discovery.apiDocsUrl`; `caller` containing the same `auth`, `subject`, `permissions`, and `repoScopes`; plus the same `capabilities` and `endpoints`. It also carries the appearance surface under `themes`: `parameters` (the five URL parameter names, see [URL selection](#url-selection-the-appearance-api)), `modes`, `wallpapers` (the `imageUrl` template, the `none` sentinel, and `panelOpacity` / `blur` ranges with their configured defaults), and `available[]` with each theme's `id`, `label`, `aliases`, and `wallpapers` (`dark[]` / `light[]` picture `id` + `label`, and that theme's effective `panelOpacity` / `blur`). A caller can build any valid appearance URL from this document alone.

Neither response includes credentials, token names, repository roots, store paths, private metadata, or administrative capabilities. A restricted missing credential returns `401`; an invalid credential returns `403`, without capability data.

## Configuration key inventory

| Key | Meaning / accepted value |
|---|---|
| `server.port` | Integer `1..65535`; default `9876`; overridden by `PORT` |
| `server.hostname` | Display hostname; default `localhost`; overridden by `HOSTNAME` |
| `server.enableEditing` | Boolean; default `false`; overridden by `LOOKIE_LINK_ENABLE_EDITING` |
| `server.enableAnnotations` | Boolean; default `false`; overridden by `LOOKIE_LINK_ENABLE_ANNOTATIONS` |
| `server.enableRawHtml` | Boolean; default `false`; overridden by `LOOKIE_LINK_ENABLE_RAW_HTML` |
| `repositories.<repo>` | Absolute or `~/`-relative mounted root; entire map overridden by `ROOT_MAPPINGS` |
| `access.humanDefault` | `full` (default), `restricted`, or `none` |
| `access.tokens.<name>.secretEnv` / `.secret` | Static credential secret source; environment is preferred |
| `access.tokens.<name>.permissions.{view,write,edit,publish}` | Boolean permissions; `edit` and legacy `allowEditing` normalize to `write` |
| `access.tokens.<name>.repos` | `all`, repo-name array, or repo map; repo scopes may be `all`, `true`, `null`, path array, or `{ paths: [...] }` |
| `access.tokens.<name>.subject` | Optional caller metadata; discovery exposes only `companyId`, `agentId`, and `label` |
| `access.tokens.<name>.issuer` / `.audit` | Optional opaque lineage retained in the access context, not exposed by discovery |
| `access.apiKeys.storePath` | Enables hashed managed API keys and their audit store |
| `access.apiKeys.adminTokens.<name>.secretEnv` / `.secret` | API-key lifecycle admin credentials |
| `access.grants.storePath` | Enables managed grants; resolved with `path.resolve` without `~` expansion |
| `access.grants.projectionPath` | Optional active-grant YAML/JSON projection; no `~` expansion |
| `access.grants.repoOwners.<repo>` | Source company allowed to issue grants for a repo |
| `access.grants.repoRoots.<repo>` | Root used to enforce cross-company adapter allow-roots; no `~` expansion |
| `access.grants.adminTokens.<name>.secretEnv` / `.secret` | Grant lifecycle admin credentials |
| `managedRepos.storePath` | Enables managed repository registry and mutable APIs |
| `managedRepos.allowRoots[]` | Existing directories beneath which repos may be registered/created |
| `managedRepos.adminTokens.<name>.secretEnv` / `.secret` | Managed-repo registration admin credentials |
| `publish.enabled` | `false` disables publishing; otherwise `areaPath` enables it |
| `publish.areaPath` | Publish storage root |
| `publish.repoId` | Virtual readback repo; default `published`; must not collide with a mounted repo |
| `publish.maxFiles` | Positive integer; default `100` |
| `publish.maxFileBytes` | Positive integer; default `2097152` |
| `publish.maxRevisionBytes` | Positive integer; default `10485760` |
| `publish.maxMetadataBytes` | Positive integer; default `65536` |
| `publish.maxRevisions` | Positive integer; default `20` |
| `forms.enabled` | Enables the first-party forms routes; default `false` |
| `forms.templatesPath` | Directory containing validated form-template YAML files; required when forms are enabled |
| `forms.destinations.<destinationId>` | Deployment-owned map from definition-ID aliases to absolute or `~/`-relative submission roots; roots are never disclosed to clients |
| `forms.submissionsPath` | Legacy single submission root; when `destinations` is absent it becomes the `default` destination |
| `forms.timezone` | IANA timezone used when a browser cannot report its UTC offset |
| `forms.publicOrigins[]` / `.publicOrigin` | Exact allowed browser mutation origins, including scheme and port; browser mutations fail closed when absent |
| `themes.<name>.dark` / `.light` | Custom CSS-variable maps. Accepted keys: `bg`, `bg_elev`, `bg_code`, `text`, `text_soft`, `accent`, `border`, `link`, `page_bg`, `toolbar_bg`, `toolbar_btn_bg`, `toolbar_btn_hover`, `toolbar_btn_text`, `toc_active_bg`, `heading_font` |
| `themes.<name>.aliases[]` | Additional names that render the same theme; never listed separately in the picker. See [CONFIGURATION.md](CONFIGURATION.md#aliases) |
| `search.ripgrep` / `search.maxResults` | Search backend: `auto` (default) uses a ripgrep binary on the service PATH, `false` forces the walk, a path names the binary; result cap 1–100. See [CONFIGURATION.md](CONFIGURATION.md#search) |
| `wallpapers.panel_opacity` / `wallpapers.blur` | Global glass defaults (50–100 %, 0–16 px). See [CONFIGURATION.md](CONFIGURATION.md#wallpapers) |
| `themes.<name>.wallpapers.default.dark` / `.light`, `.panel_opacity`, `.blur` | Per-theme starting picture and glass overrides |
| `access.appearance.adminTokens` | Bearer tokens for the appearance write API (same `{ name: { secret \| secretEnv } }` shape as grant admin tokens); when absent, `access.grants.adminTokens` are accepted |
| `themes.<name>.wallpapers.dark` / `.light` | Folder of images (`.jpg`, `.jpeg`, `.png`, `.webp`, at most 50) painted behind every page while that theme and mode are active. See [CONFIGURATION.md](CONFIGURATION.md#wallpapers) |

Configuration file lookup is `LOOKIE_LINK_CONFIG`, then the reader config directory, then the project root. The recognized server environment variables are `LOOKIE_LINK_CONFIG`, `ROOT_MAPPINGS`, `PORT`, `HOSTNAME`, `LOOKIE_LINK_ENABLE_EDITING`, `LOOKIE_LINK_ENABLE_ANNOTATIONS`, and `LOOKIE_LINK_ENABLE_RAW_HTML`. Secret environment-variable names are chosen by each `secretEnv` value.

## Unified CLI inventory

The `lookie` executable resolves the instance in this order: global `--instance`/`--base-url`, stored auth file, `LOOKIE_LINK_BASE_URL`, then `http://localhost:9876`. It resolves the token from `LOOKIE_LINK_TOKEN` before the stored auth file and sends it in the bearer header.

| Command | Implemented behavior |
|---|---|
| `lookie auth login --instance URL [--token-stdin]` | Stores normalized instance and token in the mode-`0600` auth file; without stdin, reads `LOOKIE_LINK_TOKEN` |
| `lookie auth status` | Reports instance, whether a token is configured, and auth-file path without printing the token |
| `lookie capabilities` | Reads agent discovery; falls back to `/api/whoami` only when discovery returns `404` |
| `lookie whoami` | Reads caller discovery |
| `lookie repos` | Lists caller-visible repos |
| `lookie read <repo>/<path>` | Tries managed-file JSON first, then falls back to `/asset`; `--json` wraps asset output |
| `lookie tree <repo> [--path REL] [--max-depth N]` | Reads managed bounded tree |
| `lookie changes <repo> --since VALUE` | Reads managed changes; `VALUE` is an ISO-8601 timestamp or Unix seconds (13+ digit values are taken as milliseconds). The CLI converts to the epoch milliseconds the server compares against file `mtimeMs` |
| `lookie write <repo>/<path> ...` | Managed atomic write using exactly one of `--content`, `--content-file`, or `--content-from-stdin`; optional `--expected-mtime` |
| `lookie delete <repo>/<path> [--hard]` | Managed soft or hard delete |
| `lookie search <query> [--scope REPO]... [--limit N] [--max-entries N]` | Path/content search across every served repo the caller can view (managed and mapped); every word must match, `"quotes"` make a phrase; scope when you know the repo |
| `lookie search suggest <query>` | Path suggestions across served repos |
| `lookie publish <file> ...` | Creates a single-file publication; accepts `--slug`, `--entry-path`, and `--expected-revision` |
| `lookie publish --manifest FILE ...` | Creates or updates from a JSON manifest |
| `lookie publish revoke <slug> --reason TEXT` | Revokes a publication |
| `lookie annotations list <repo>/<path> [--state S]...` | `GET /api/annotations/:repo/*`; states `open`, `claimed`, `resolved` |
| `lookie annotations get <repo>/<path> <id>` | Reads the document and selects one annotation; exit `4` if absent |
| `lookie annotations add <repo>/<path> --anchor A --kind K ...` | `POST /api/annotations/:repo/*`; kinds `heading`, `yamlKey`, `lineRange`; body via `--body`, `--body -` (stdin), or `--body-file`; `--author` (default `$LOOKIE_LINK_AUTHOR` or `lookie`) |
| `lookie annotations claim <repo>/<path> <id> [--by NAME]` | `PATCH` op `claim` |
| `lookie annotations resolve <repo>/<path> <id>` | `PATCH` op `resolve` |
| `lookie annotations replies <repo>/<path> <id> [--add BODY]` | Lists replies, or with `--add`/`--body-file` appends one (`PATCH` op `reply`) |
| `lookie trash restore <repo> <trashId>` | `POST /api/managed-repos/:repo/trash/:trashId/restore` |
| `lookie trash remove <repo> <trashId>` | `DELETE /api/managed-repos/:repo/trash/:trashId` (permanent) |
| `lookie trash list <repo>` | Lists soft-deleted records of a managed repo (newest first) via `GET /api/managed-repos/:repo/trash` |
| `lookie appearance show [--theme SLUG]` | `GET /api/appearance` (includes `revision`) or `GET /api/appearance/themes/:slug` |
| `lookie appearance set --revision N [--blur N] [--panel N] [--theme-json JSON]` | `PATCH /api/appearance` with `expectedRevision`; `--panel` maps to `wallpapers.panel_opacity`, `--theme-json` to `themes`; `--json-file FILE` supplies a whole body (flags override). Stale revision exits `5` |
| `lookie appearance upload <slug> <dark\|light> --name ID <file>` | `POST /api/appearance/themes/:slug/wallpapers/:mode?name=ID` with raw bytes; Content-Type from extension (`.jpg`/`.jpeg`/`.png`/`.webp`) |
| `lookie appearance delete <slug> <dark\|light> <id>` | `DELETE /api/appearance/themes/:slug/wallpapers/:mode/:id` |
| `lookie openapi` | Prints `/openapi.json` |
| `lookie docs` | Prints the `/api/docs` URL (`--json` wraps it as `{ok,url}`) |
| `lookie --help`, `lookie --version`, global `--json` | Help, version, and supported JSON output |

Appearance writes (`set`, `upload`, `delete`) send `LOOKIE_LINK_ADMIN_TOKEN` as the bearer, falling back to the normal token. Exit codes: `0` ok, `2` usage, `3` auth (401/403), `4` not found, `5` conflict, `6` transport/other.

The package also ships compatibility executables `lookie-read` and `lookie-annotations`; they remain as separate scripts. `lookie annotations` in the unified CLI covers the same operations (output is always JSON; the shim's `--pretty`/`--json-errors` are not ported).

## Library and store inventory

| Module | Confirmed runtime capability |
|---|---|
| `lib/access-control.js` | Parses static access, resolves static/API-key/grant credentials, enforces repo/path scopes, normalizes `edit` to `write`, propagates read query tokens, rejects mutation query tokens |
| `lib/agent-discovery.js` | Builds caller-scoped `whoami` and agent documents and filters advertised capabilities/endpoints |
| `lib/annotations.js` | Sidecar schema/read/filter/create/update; states `open`, `claimed`, `resolved`; heading, YAML-key, and line-range anchors; claim/resolve/reopen/reply/redact operations |
| `lib/api-key-store.js` | Mode-`0600` YAML/JSON store, hashed one-time keys, create/list/rotate/revoke, credential authentication, redacted audits |
| `lib/cli-auth.js` | Base-URL normalization, mode-`0600` auth-file read/write, environment/stored resolution, stdin token read |
| `lib/config.js` | Config search/normalization, repo and server settings, optional store config, built-in/custom themes |
| `lib/embed-html.js` | Strict UTF-8 HTML decoding, local/cross-repo/wiki URL rewriting, theme and annotation injection, sensitive path/value redaction |
| `lib/grant-store.js` | Hashed expiring grants, admin lifecycle, owner/issuer/approval/cross-company policy, rotation/revocation/audits, optional active projection |
| `lib/managed-repo-search.js` | Scope-preserving bounded search and suggestions across allowlisted text formats |
| `lib/managed-repo-store.js` | Allow-rooted registry, atomic UTF-8 file CRUD, mtime conflicts, recoverable trash, permanent deletion, bounded tree, symlink containment |
| `lib/path-utils.js` | Path containment and route builders plus display helpers |
| `lib/publish-store.js` | Atomic immutable revisions, optimistic update guard, metadata separation, limits, historical resolution, revocation |
| `lib/renderer.js` | Sanitized Markdown/HTML and highlighted code; directory/image/audio/video/PDF/CSV/JSON pages; portable links; anchors; editor and preview |

## Forms routes (mounted only when `forms.enabled` is true)

These routes are **not** part of the default route set above: they are registered
only when the opt-in `forms` configuration block is present, so the route-matrix
equality test intentionally does not cover them. When mounted, discovery
advertises the `forms` capability and the `forms`, `formsTemplates` and
`formsSubmissions` endpoint templates; per-template authorization still
applies on every forms route.

| Route | Method | Effective auth | Enabled by | Notes |
|---|---|---|---|---|
| Forms index: `/forms` | `GET` | `forms.submit` or `forms.manage` | `forms.enabled` | Lists active submit-visible forms; managers also see lifecycle metadata, entry counts, actions, and archived templates in a collapsed section. |
| Create template: `/forms/new`, `/forms` | `GET`, `POST` | `forms.manage` | `forms.enabled` | Single server-rendered creation flow backed by the template API controller; browser writes require exact Origin + CSRF. |
| Form page: `/forms/:templateId` | `GET` | `forms.submit` or `forms.view` | `forms.enabled` | Server-rendered first-party form; issues the browser context cookie and synchronizer token. |
| Native submit: `/forms/:templateId` | `POST` | `forms.submit` | `forms.enabled` | Requires exact configured Origin + `_csrf` token; Post/Redirect/Get to the receipt. Fails closed when no public origin is configured. |
| Entries hub: `/forms/entries` | `GET` | `forms.view` | `forms.enabled` | Root History: recent entries across trackers. |
| Receipt edit: `/forms/:templateId/receipts/:submissionId/edit` | `GET` | `forms.submit` | `forms.enabled` | Server-rendered correction form; saving creates a NEW record with `supersedesRecord`. |
| Delete template (browser): `/forms/:templateId/delete` | `POST` | `forms.manage` | `forms.enabled` | Browser path (context cookie + `_csrf` + Origin); API twin is `DELETE /api/forms/templates/:templateId`. |
| Clone template (browser): `/forms/:templateId/clone` | `POST` | `forms.manage` | `forms.enabled` | Browser twin of the clone API. |
| Restore version (browser): `/forms/:templateId/configure/restore-version` | `POST` | `forms.manage` | `forms.enabled` | Restores a published version as the draft. |
| Delete template (API): `/api/forms/templates/:templateId` | `DELETE` | `forms.manage` (bearer or browser context) | `forms.enabled` | Soft-deletes the template; envelope on error. |
| Submissions list (API): `/api/forms/:templateId/submissions` | `GET` | `forms.view` | `forms.enabled` | The caller's submissions for the template; discovery template `formsSubmissions`. |
| Submission history (API): `/api/forms/:templateId/submissions/:submissionId/history` | `GET` | `forms.view` | `forms.enabled` | Record lineage (corrections via `supersedesRecord`) with actor per entry. |
| Entry history: `/forms/:templateId/entries` | `GET` | `forms.submit` or `forms.read_submissions` | `forms.enabled` | Owner-scoped server-rendered history; shares persistent form navigation. |
| Template builder: `/forms/:templateId/configure` | `GET`, `POST` | `forms.manage` | `forms.enabled` | Server-rendered builder. Browser writes require exact Origin + CSRF and use the template API mutation controller with revision CAS. |
| Publish template: `/forms/:templateId/configure/publish` | `POST` | `forms.manage` | `forms.enabled` | Creates an immutable version from the rendered draft revision; stale revisions conflict. |
| Clone/lifecycle actions: `/forms/:templateId/clone`, `/forms/:templateId/archive`, `/forms/:templateId/restore` | `POST` | `forms.manage` | `forms.enabled` | Server-rendered actions backed by the JSON API controllers; lifecycle actions require revision CAS. |
| Template collection: `/api/forms/templates` | `GET`, `POST` | `forms.submit` or `forms.manage` (`GET`); `forms.manage` (`POST`) | `forms.enabled` | Lists submit-visible templates with a minimal projection, lists management metadata for managers, or creates a draft. Browser writes require exact Origin + CSRF; bearer agents use JSON. |
| Template item: `/api/forms/templates/:templateId` | `GET`, `PATCH` | `forms.manage` | `forms.enabled` | Reads management metadata or revises a draft with required revision CAS. Unauthorized item access is a uniform 404. |
| Publish API: `/api/forms/templates/:templateId/publish` | `POST` | `forms.manage` | `forms.enabled` | Creates the next immutable version; accepts an optional positive draft revision CAS guard. |
| Clone API: `/api/forms/templates/:templateId/clone` | `POST` | `forms.manage` | `forms.enabled` | Creates a revision-1 draft with a fresh identity and clone lineage; no submissions or published history are copied. |
| Archive/restore API: `/api/forms/templates/:templateId/archive`, `/api/forms/templates/:templateId/restore` | `POST` | `forms.manage` | `forms.enabled` | CAS-guarded lifecycle changes. Archived forms refuse new submissions while history and receipts remain readable. |
| JSON submit: `/api/forms/:templateId/submissions` | `POST` | `forms.submit` | `forms.enabled` | Same submission service as the native path. |
| Receipt: `/forms/:templateId/receipts/:submissionId` | `GET` | Submitter (or `read_submissions`) | `forms.enabled` | Uniform 404 for non-owners and unknown IDs. |

Templates are file-backed and validated on load (invalid ones are skipped, last
known good retained). A template may select an optional definition-ID
`destinationId`; omission selects `default`. The deployment-owned destination
adapter maps approved aliases to private storage roots. A template cannot define
that map or use a path as an alias, and an unknown alias prevents startup rather
than falling back. Each accepted submission is one immutable JSON file under the
selected root, with a capture-time field type and label, option label snapshots,
schema digest, and optional idempotency key. Receipt, correction, history, and
list reads use the same template destination, and no client response or audit
event includes storage paths.

Dynamic option providers, sessions, and reaction dispatch are **not** implemented.


## Viewer-wide wallpapers

When any custom theme declares `wallpapers`, every page built on the shared
shell (file browser, rendered files, Trackers) paints a fixed picture behind
the page and adds a Wallpaper menu to the floating toolbar, between the theme
picker and the light/dark button. Reading surfaces become frosted glass: panel
opacity (50–100%, default 72) and blur behind the panel (0–16 px, default 12)
are tunable; text stays fully opaque. A scrim fades the top of the picture into
the theme ground so the toolbar never ends in a hard edge.

The picture follows the active theme and mode. Choices persist in the browser
(`localStorage` key `lookie-link-wallpaper`): the picked image per theme, a
remembered "No background", opacity and blur. A theme without a set shows a
plain page and the menu says so. The catalog reloads live: new images,
wallpaper keys and theme palettes are picked up within about half a second
(the server watches the folders and the config file).

The embedded-HTML page is the exception: its sandboxed frame is opaque, so
there the document supplies pictures over the bridge below.

## URL selection (the appearance API)

Appearance is addressable: every appearance control has a query parameter, so
a caller (a script, a desktop hook, a handoff link) can open any viewer page
looking exactly one way without touching the reader's saved choices.

| Parameter | Values | Controls |
| --- | --- | --- |
| `lookie-scheme` | theme slug or alias | Theme (palette) |
| `lookie-theme` | `dark`, `light` | Mode |
| `lookie-wallpaper` | picture id from the theme's set, or `none` | Which picture shows |
| `lookie-panel` | integer 50–100 | Panel opacity, percent |
| `lookie-blur` | integer 0–16 | Blur behind the panel, px |

Each parameter is validated on its own; a missing, empty, unknown or repeated
value falls back to the saved choice. A parameter that is present wins on that
page. Same-origin links on the page inherit every parameter the URL carried,
so the selection follows a reader through the viewer, and a control change
rewrites the address only for keys the URL already carried. Nothing from the
URL is saved unless the reader then changes a control. Picture ids are the
labels in the Wallpaper menu, lower-cased and hyphenated, as listed at
`/wallpaper/<slug>/<mode>/<id>`. Example:

```
/view/notes/today.md?lookie-scheme=carolina-sunset&lookie-theme=dark&lookie-wallpaper=mackerel-sky&lookie-panel=85&lookie-blur=6
```

On the embedded-HTML page the same parameters are relayed to the document
through the bridge below as one `lookie-link:set-wallpaper` message once the
document has reported its catalog.

## Embedded wallpaper controls

An embedded HTML document can opt into a Wallpaper menu in the viewer's floating
toolbar, next to its theme picker and light/dark button. The menu controls that
document only. Ordinary documents do not show it. The sandbox remains unchanged;
the bridge accepts cosmetic state only, with no HTML, URLs or executable actions.

The document posts to its parent:

```js
window.parent.postMessage({
  type: 'lookie-link:wallpaper-state',
  choices: [{id: 'forest', label: 'Forest'}, {id: 'lake', label: 'Lake'}],
  choice: 'forest',
  opacity: 80,
  blur: 0
}, '*');
```

The viewer accepts messages only from its embedded window. A catalog has 0–50
unique IDs matching `^[a-z0-9][a-z0-9-]{0,63}$`; `none` is reserved.
Labels are nonblank strings of at most 80 characters and render as text.
The selected choice is a catalog ID or `none`. An empty catalog requires `none`, clears old choices and disables previous/next. Opacity is an integer from
50–100; blur is an integer from 0–16. Invalid states are ignored.

The document listens for messages from `window.parent` only:

| Message type | Document behavior |
| --- | --- |
| `lookie-link:request-wallpaper-state` | Report current state, including after frame load |
| `lookie-link:wallpaper-toolbar-ready` | Hide any duplicate in-document controls; do not echo another state just for this acknowledgement |
| `lookie-link:set-wallpaper` | Validate and apply `choice`, `opacity`, and `blur`; report the resulting state |
| `lookie-link:reset-wallpaper` | Restore document wallpaper defaults and report state |
| `lookie-link:set-theme` | Follow the existing viewer `mode` and `scheme` synchronization |

Report initial state when the document starts as well as when settings change.
The menu supplies previous/next with wrapping, no background, opacity, blur and
reset. Documents own image rendering and defaults. They can keep standalone
controls until the viewer acknowledges the toolbar. The bridge does not save
wallpaper preferences or add a server wallpaper catalog. `'*'` is required for
the opaque sandbox origin; payloads must contain only the cosmetic values above.
