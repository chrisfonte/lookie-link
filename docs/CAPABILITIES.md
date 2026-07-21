# Capability and Route Matrix

This file is the authoritative inventory of the implemented Lookie-Link surface. Other documents describe workflows and payloads, but must link here instead of maintaining another route or capability list.

The inventory was checked against the route registrations in [`server.js`](../server.js), the exported modules in [`lib/`](../lib), the configuration readers in [`lib/config.js`](../lib/config.js), the sample YAML, the unified CLI in [`bin/lookie.js`](../bin/lookie.js), and the test suite. Source anchors identify the relevant route-registration block; authorization checks are inside the same handler.

## Authorization vocabulary

- **Public** means the route itself performs no access check.
- **Effective `view`, `write`, or `publish`** means the caller's resolved access context must allow that permission for the repository and path. With the default `access.humanDefault: full`, an unauthenticated caller receives all permissions; `restricted` and `none` require a valid static token, managed API key, or managed grant.
- `edit` is accepted in stored credentials as a legacy alias, but is normalized to `write`.
- Read requests accept a bearer token or `?token=`. All `POST`, `PUT`, `PATCH`, and `DELETE` requests reject query credentials before route handling and therefore require bearer credentials when access is restricted.
- Administrative tokens are separate from caller permissions and are never advertised by discovery.

## Registered HTTP routes

| Route / capability | Method | Required auth | Enabled by config | Notes and source |
|---|---|---|---|---|
| Static browser assets: `/public/*` | `GET`, `HEAD` | Public | Always | Express static mount; no repository data. [`server.js#L767`](../server.js#L767) |
| Managed repo list: `/api/managed-repos` | `GET` | Results require effective `view` | `managedRepos.storePath` | Returns only visible managed repos and omits roots; a denied caller receives an empty list rather than an auth error. [`server.js#L772`](../server.js#L772) |
| Managed repo registration: `/api/managed-repos` | `POST` | Managed-repo admin bearer token | `managedRepos.storePath`, `allowRoots`, and `adminTokens` | Registers or creates a root only below an existing allow-root. [`server.js#L784`](../server.js#L784) |
| Managed tree: `/api/managed-repos/:repo/tree` | `GET` | Effective `view` on requested directory and returned entries | `managedRepos.storePath` | Bounded by depth and entry limits; internal trash is hidden. [`server.js#L804`](../server.js#L804) |
| Managed changes: `/api/managed-repos/:repo/changes` | `GET` | Effective `view` | `managedRepos.storePath` | Bounded mtime-based file listing; `since` is a numeric Unix timestamp. [`server.js#L845`](../server.js#L845) |
| Managed file read: `/api/managed-repos/:repo/files/*` | `GET` | Effective `view` on file | `managedRepos.storePath` | Returns UTF-8 content and metadata as JSON. [`server.js#L874`](../server.js#L874) |
| Managed file create/update: `/api/managed-repos/:repo/files/*` | `PUT` | Effective `write` on file | `managedRepos.storePath` | Atomic UTF-8 write; optional `expectedMtimeMs`; records managed API-key audit events. [`server.js#L891`](../server.js#L891) |
| Publish create: `/api/publish` | `POST` | Repo-level `publish` on the configured publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Creates immutable revision 1. Path-only publish scope is insufficient. [`server.js#L920`](../server.js#L920) |
| Managed file delete: `/api/managed-repos/:repo/files/*` | `DELETE` | Effective `write` on file | `managedRepos.storePath` | Soft delete by default; `?hard=1` permanently deletes. [`server.js#L955`](../server.js#L955) |
| Managed trash restore: `/api/managed-repos/:repo/trash/:trashId/restore` | `POST` | Effective `write` on repo and original file | `managedRepos.storePath` | Restores a soft-deleted file. [`server.js#L973`](../server.js#L973) |
| Managed trash removal: `/api/managed-repos/:repo/trash/:trashId` | `DELETE` | Effective `write` on repo and original file | `managedRepos.storePath` | Permanently deletes one trash item. [`server.js#L994`](../server.js#L994) |
| Managed search: `/api/search` | `GET` | Effective `view`; results are caller-filtered | `managedRepos.storePath` | Requires `q`; searches bounded path/content candidates in supported text formats. [`server.js#L1015`](../server.js#L1015) |
| Managed suggestions: `/api/search/suggest` | `GET` | Effective `view`; results are caller-filtered | `managedRepos.storePath` | Requires `q`; returns bounded path suggestions. [`server.js#L1046`](../server.js#L1046) |
| Publish update: `/api/publish/:slug` | `POST` | Repo-level `publish` on publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Requires `expectedRevision`; creates a complete immutable next revision. [`server.js#L1077`](../server.js#L1077) |
| Publish revoke: `/api/publish/:slug/revoke` | `POST` | Repo-level `publish` on publish repo | `publish.areaPath`; disabled when `publish.enabled: false` | Requires a reason and revokes current and historical readback. [`server.js#L1117`](../server.js#L1117) |
| API-key list: `/api/agent-keys` | `GET` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Optional state/agent filters and audit projection. [`server.js#L1144`](../server.js#L1144) |
| API-key create: `/api/agent-keys` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Returns the new secret once; stores only its hash. [`server.js#L1163`](../server.js#L1163) |
| API-key rotate: `/api/agent-keys/:keyId/rotate` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Replaces and returns the secret once. [`server.js#L1178`](../server.js#L1178) |
| API-key revoke: `/api/agent-keys/:keyId/revoke` | `POST` | API-key admin bearer token | `access.apiKeys.storePath` and `adminTokens` | Requires a reason. [`server.js#L1194`](../server.js#L1194) |
| Grant list: `/api/grants` | `GET` | Grant admin token; bearer preferred, query accepted for this read | `access.grants.storePath` and `adminTokens` | Optional filters and audit projection. [`server.js#L1210`](../server.js#L1210) |
| Grant create: `/api/grants` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Enforces issuer, subject, owner, expiry, approval, and cross-company allow-root policy. [`server.js#L1231`](../server.js#L1231) |
| Grant renew: `/api/grants/:grantId/renew` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Updates expiry and rotates the grant token unless disabled in the request. [`server.js#L1250`](../server.js#L1250) |
| Grant revoke: `/api/grants/:grantId/revoke` | `POST` | Grant admin bearer token | `access.grants.storePath` and `adminTokens` | Requires a reason and authorized issuer identity in the payload. [`server.js#L1270`](../server.js#L1270) |
| Repository index: `/` | `GET` | Non-denied caller; entries require effective `view` | Always | HTML index filtered to visible repos. [`server.js#L1290`](../server.js#L1290) |
| Health: `/healthz` | `GET` | Public | Always | Returns status and the three server feature booleans. [`server.js#L1320`](../server.js#L1320) |
| Agent discovery: `/.well-known/agent.json` | `GET` | Non-denied caller | Always | Versioned caller-scoped discovery document. [`server.js#L1338`](../server.js#L1338) |
| Caller discovery: `/api/whoami` | `GET` | Non-denied caller | Always | Caller identity, permissions, scopes, capabilities, and endpoints. [`server.js#L1347`](../server.js#L1347) |
| Repo discovery: `/api/repos` | `GET` | Non-denied caller; results require effective `view` | Always | Returns opaque repo/view/asset URLs, never roots. [`server.js#L1356`](../server.js#L1356) |
| Render/browse: `/view/*` | `GET` | Effective `view` on path | Always | Directory, document, code, image, audio, video, PDF, CSV, and JSON views; HTML supports `?validate=1`; publish readback supports `?version=`. [`server.js#L1372`](../server.js#L1372) |
| Edit page: `/edit/*` | `GET` | Effective `write` on file | `server.enableEditing` or `LOOKIE_LINK_ENABLE_EDITING` | Text/non-binary existing files only. [`server.js#L1705`](../server.js#L1705) |
| Save mounted file: `/api/save/*` | `POST` | Effective `write` on existing file | Editing flag | Atomic UTF-8 replacement with optional `expectedMtimeMs`. [`server.js#L1805`](../server.js#L1805) |
| Preview draft: `/api/preview/*` | `POST` | Effective `view` on existing file | Editing flag | Renders supplied content without writing it. [`server.js#L1955`](../server.js#L1955) |
| Annotation read: `/api/annotations/:repo/*` | `GET` | Effective `view` on file | `server.enableAnnotations` or `LOOKIE_LINK_ENABLE_ANNOTATIONS` | Sidecar read with repeatable `state` filter. [`server.js#L2040`](../server.js#L2040) |
| Annotation create: `/api/annotations/:repo/*` | `POST` | Effective `write` on file | Annotations flag | Supports heading, YAML-key, and line-range anchors. [`server.js#L2138`](../server.js#L2138) |
| Annotation update: `/api/annotations/:repo/*` | `PATCH` | Effective `write` on file | Annotations flag | Claim, resolve, reopen, reply, or redact; optional stale-write guard. [`server.js#L2226`](../server.js#L2226) |
| Raw asset: `/asset/:repo/*` | `GET` | Effective `view` on file | Always | Allowlisted image/audio/video/PDF/text MIME types; published revisions accept `?version=`. [`server.js#L2327`](../server.js#L2327) |
| Transformed HTML: `/embed/:repo/*` | `GET` | Effective `view` on file | Raw-HTML flag | `.html`/`.htm` only; preserves scripts while rewriting local URLs and injecting theme/annotation integration. Mounted repos only. [`server.js#L2420`](../server.js#L2420) |
| Verbatim HTML: `/raw/:repo/*` | `GET` | Effective `view` on file | Raw-HTML flag | `.html`/`.htm` only; unsanitized same-origin content; supports published revisions. [`server.js#L2534`](../server.js#L2534) |
| View redirect: `/view` | `GET` | Public redirect | Always | Redirects to `/`; a restricted caller is then challenged there. [`server.js#L2636`](../server.js#L2636) |

Unmatched paths use the final `404` middleware and unhandled errors use the final `500` middleware at [`server.js#L2640`](../server.js#L2640). These are fallbacks, not separately registered application routes.

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
| `search` | `/api/search` | Managed-repo capability is available |
| `searchSuggest` | `/api/search/suggest` | Search capability is available |
| `publishCreate` | `/api/publish` | Publish store is enabled and caller has repo-level `publish` |
| `publishUpdate` | `/api/publish/:slug` | Publish capability is available |
| `publishRevoke` | `/api/publish/:slug/revoke` | Publish capability is available |

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
| `search` | Managed-repo capability and search route are available |
| `publish` | Publish store is enabled and caller has whole-repo `publish` scope on its virtual repo |

## Discovery field inventory

`GET /api/whoami` returns `ok`; `auth.mode`, `auth.type`, `auth.source`, and `auth.queryToken`; sanitized `subject` (`companyId`, `agentId`, `label`, or `null`); `permissions` (`view`, `write`, legacy-equivalent `edit`, `publish`); `repoScopes[]` (`repo`, `managed`, and `scopes[]` with `type` and `path`); plus `capabilities` and `endpoints` from the tables above.

`GET /.well-known/agent.json` returns `schemaVersion`, `name`, package `version`, `generatedAt`; `instance.baseUrl` and `instance.mode`; `authentication.bearerToken` and `authentication.queryTokenForReadRequests`; `discovery.whoamiUrl`, `discovery.reposUrl`, and `discovery.agentJsonUrl`; `caller` containing the same `auth`, `subject`, `permissions`, and `repoScopes`; plus the same `capabilities` and `endpoints`.

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

Configuration file lookup is `LOOKIE_LINK_CONFIG`, then the user config directory, then the project root. The recognized server environment variables are `LOOKIE_LINK_CONFIG`, `ROOT_MAPPINGS`, `PORT`, `HOSTNAME`, `LOOKIE_LINK_ENABLE_EDITING`, `LOOKIE_LINK_ENABLE_ANNOTATIONS`, and `LOOKIE_LINK_ENABLE_RAW_HTML`. Secret environment-variable names are chosen by each `secretEnv` value.

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
| `lookie changes <repo> --since VALUE` | Reads managed changes; the server expects a numeric Unix timestamp despite the CLI help label `ISO_TIMESTAMP` |
| `lookie write <repo>/<path> ...` | Managed atomic write using exactly one of `--content`, `--content-file`, or `--content-from-stdin`; optional `--expected-mtime` |
| `lookie delete <repo>/<path> [--hard]` | Managed soft or hard delete |
| `lookie search <query> [--scope REPO]...` | Managed path/content search |
| `lookie search suggest <query>` | Managed path suggestions |
| `lookie publish <file> ...` | Creates a single-file publication; accepts `--slug`, `--entry-path`, and `--expected-revision` |
| `lookie publish --manifest FILE ...` | Creates or updates from a JSON manifest |
| `lookie publish revoke <slug> --reason TEXT` | Revokes a publication |
| `lookie --help`, `lookie --version`, global `--json` | Help, version, and supported JSON output |

The package also ships compatibility executables `lookie-read` and `lookie-annotations`; they are separate scripts, not subcommands of the unified CLI.

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
equality test intentionally does not cover them.

| Route | Method | Effective auth | Enabled by | Notes |
|---|---|---|---|---|
| Forms index: `/forms` | `GET` | `forms.submit` or `forms.manage` | `forms.enabled` | Lists active submit-visible forms; managers also see lifecycle metadata, entry counts, actions, and archived templates in a collapsed section. |
| Create template: `/forms/new`, `/forms` | `GET`, `POST` | `forms.manage` | `forms.enabled` | Single server-rendered creation flow backed by the template API controller; browser writes require exact Origin + CSRF. |
| Form page: `/forms/:templateId` | `GET` | `forms.submit` or `forms.view` | `forms.enabled` | Server-rendered first-party form; issues the browser context cookie and synchronizer token. |
| Native submit: `/forms/:templateId` | `POST` | `forms.submit` | `forms.enabled` | Requires exact configured Origin + `_csrf` token; Post/Redirect/Get to the receipt. Fails closed when no public origin is configured. |
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
