# API Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check, including `editingEnabled`, `annotationsEnabled`, and `rawHtmlEnabled` booleans |
| `GET /api/repos` | Discover served repos as JSON (filtered by grant scope when a token is presented) |
| `GET /view/<repo>/<path>` | Rendered file or directory listing. For `.html` and `.htm`, append `?validate=1` to inspect local asset and document references as JSON. |
| `GET /asset/<repo>/<path>` | Raw asset serving. Supports `Range` requests so `<audio>` can seek, backs the embedded PDF viewer page, and is the agent-facing read path for text/source files (see `lookie-read` CLI in the repo `bin/`). MIME types: images (`.png`/`.jpg`/`.gif`/`.webp`/`.svg`/`.jpeg`), audio (`.m4a`/`.mp3`/`.wav`/`.ogg`/`.oga`/`.opus`/`.flac`/`.aac`), PDF (`.pdf`), markdown (`.md`/`.markdown`/`.mdown` → `text/markdown`), YAML (`.yaml`/`.yml` → `text/yaml`), JSON (`.json`), XML (`.xml`), and the editable text/source set (shell, Python, JS/TS, Go, Rust, C/C++, etc.) returned as `text/plain; charset=utf-8`. Anything else returns `415 Unsupported asset type`. |
| `GET /edit/<repo>/<path>` | Edit page (only when editing enabled) |
| `POST /api/save/<repo>/<path>` | Save updated file content (JSON body) |
| `POST /api/preview/<repo>/<path>` | Render preview HTML from draft content (JSON body) |
| `GET /api/annotations/<repo>/<path>` | Read sidecar annotations for a file. Supports repeatable `?state=open|claimed|resolved`. Returns an empty schema document when no sidecar exists. |
| `POST /api/annotations/<repo>/<path>` | Create an annotation. Requires `write` access and `enableAnnotations: true`. |
| `PATCH /api/annotations/<repo>/<path>` | Apply `claim`, `resolve`, `reopen`, `reply`, or `redact` with stale-write protection. Requires `write` access and `enableAnnotations: true`. |
| `POST /api/publish` | Create a publish slug and immutable revision 1 |
| `POST /api/publish/:slug` | Create the next immutable revision with an `expectedRevision` guard |
| `POST /api/publish/:slug/revoke` | Revoke current and historical readback for a publish slug |
| `GET /api/grants` | List managed grants (`Authorization: Bearer <admin-token>`) |
| `POST /api/grants` | Create a managed grant and return token + issue comment helper |
| `POST /api/grants/:grantId/renew` | Renew a managed grant and return issue comment helper |
| `POST /api/grants/:grantId/revoke` | Revoke a managed grant and return issue comment helper |

## Access Tokens

Agent requests can authenticate with either:

- `Authorization: Bearer <secret>`
- `?token=<secret>`

Managed grant tokens use the same auth shape as static tokens. The server checks
static `access.tokens` first, then falls back to the managed grant store when
`access.grants.storePath` is configured.

Route enforcement in phase 1:

- `/` and `/view/*` require `view` access when `access.humanDefault` is not `full`
- `/asset/*` requires `view`
- `/edit/*` and `/api/save/*` require `write` (`edit` remains a backward-compatible alias)
- `/api/preview/*` requires `view` and still respects global editing mode
- annotation reads require `view`; annotation creates and updates require `write`; all annotation routes return `404` when annotations are disabled
- `/api/publish*` mutations require `publish`; readback under the configured publish repo requires `view`

Invalid tokens return `403`. Missing tokens return `401` when unauthenticated human access is restricted.

## Publish Endpoints

Publishing is available when `publish.areaPath` is configured and `publish.enabled` is not `false`.

`POST /api/publish` accepts a non-empty `files` array and an optional slug, `entryPath`, public `metadata`, and non-projected `privateMetadata`. File content is UTF-8 by default; use `"encoding": "base64"` for binary data. It returns `201` with the slug, revision, publication projection, and view URL.

`POST /api/publish/:slug` accepts the same complete-bundle payload plus a mandatory positive `expectedRevision`. Every successful call creates a new immutable numbered snapshot. A stale guard returns `409` with `currentRevision` and the safe current publication projection.

`POST /api/publish/:slug/revoke` requires `{ "reason": "..." }`. After revocation, current and historical readback return `410`.

Readback reuses the existing routes under a virtual repo namespace:

- `/view/published/<slug>/<path>`
- `/asset/published/<slug>/<path>`
- `/raw/published/<slug>/<path>` when raw HTML is enabled
- append `?version=<positive-integer>` to select a historical revision

The configured `publish.repoId` replaces `published` in these paths when customized. Published metadata is never interpreted as an authorization grant or source-repository mapping, and public metadata containing absolute filesystem paths is rejected. `privateMetadata` and the publish area's control files are not reachable through published readback. See [PUBLISHING.md](PUBLISHING.md) for the complete contract and examples.

## HTML Bundle Validation

`GET /view/<repo>/<path>.html?validate=1`

Returns the HTML source metadata, repo-relative view/asset URLs, local references
from stylesheet, script, image, and source elements, and local HTML/directory
navigation targets. Each reference includes its resolved repo-relative path,
content type, existence, byte count, and rewritten view URL where applicable.
The `summary` object provides missing and unsupported counts for automated checks.

Validation uses the caller's normal `view` scope for every referenced target.
An unreadable target is reported with the same `exists: false`, null metadata,
and `not_found` error as an absent target. Responses never include filesystem
paths from the host.

## Repo Discovery Endpoint

`GET /api/repos`

Lets agents discover served repos at runtime without parsing the HTML index or reading the host's YAML config. Response shape:

```json
{
  "repos": [
    {
      "repo": "operations",
      "rootPath": "~/notes",
      "viewUrl": "/view/operations/",
      "assetUrl": "/asset/operations/"
    }
  ],
  "count": 1
}
```

The list is filtered to the repos the caller can `view`: with a scoped token the response only contains repos that token can reach; unauthenticated callers see all mappings when `access.humanDefault` allows it and otherwise receive `401`. `viewUrl` and `assetUrl` are repo-rooted paths — append your own `?token=...` if you authenticate via query string.

## Save Endpoint

`POST /api/save/<repo>/<path>`

Request body:
```json
{
  "content": "file content here",
  "expectedMtimeMs": 1234567890
}
```

- `expectedMtimeMs` enables stale-write detection — if the file's mtime has changed since the editor loaded it, returns `409 Conflict`
- Writes use a temp file + rename pattern for atomicity

## Preview Endpoint

`POST /api/preview/<repo>/<path>`

Request body:
```json
{
  "content": "markdown or yaml content to preview"
}
```

Returns `{"ok": true, "html": "rendered HTML"}`.

## Annotation Endpoints

`GET /api/annotations/<repo>/<path>`

- Requires `server.enableAnnotations: true`
- Requires `view` access to the target file
- Returns `{ "schema": 1, "file": "<repo>/<path>", "annotations": [], "mtimeMs": null }` when no sidecar exists yet
- Optional `?state=` filter can be repeated, for example `?state=open&state=claimed`

`POST /api/annotations/<repo>/<path>`

- Requires `write` access to the target file

Request body:

```json
{
  "anchor": "#design-decisions",
  "anchorKind": "heading",
  "body": "Please split this section.",
  "author": "agent-bob"
}
```

- `anchorKind` must be `heading`, `yamlKey`, or `lineRange`
- `lineRange` anchors must use `#L<start>-L<end>`
- Server assigns `id`, `createdAt`, and `state: "open"`
- Sidecars are written under `<repoRoot>/.lookie-link/annotations/<repo>/<path>.json`

`PATCH /api/annotations/<repo>/<path>`

- Requires `write` access to the target file

Request body:

```json
{
  "id": "2026-06-09-001",
  "expectedMtimeMs": 1749500000000,
  "op": "claim",
  "payload": {
    "claimedBy": "agent-bob"
  }
}
```

- Supported `op` values: `claim`, `resolve`, `reopen`, `reply`, `redact`
- `reply` payload requires `author` and `body`
- `redact` payload requires `redactedBy` (or `author`). It replaces the annotation and reply bodies with placeholders, marks the item resolved, and preserves authorship and timestamp metadata for audit history.
- Stale `expectedMtimeMs` returns `409` with the current annotation document in `current`

## Managed Grant Lifecycle

When `access.grants` is configured, grant lifecycle endpoints are enabled and
require a grant admin token from `access.grants.adminTokens`.

Issue-linked create and renew requests require an explicit `expiresAt` value.

Create request example:

```json
{
  "repoId": "acme-co",
  "sourceCompanyId": "fontastic",
  "targetCompanyId": "target-company",
  "subject": {
    "companyId": "target-company",
    "agentIds": ["agent-bob"]
  },
  "permissions": {
    "view": true,
    "edit": false
  },
  "paths": ["clients/example-client/briefs/"],
  "sourceIssueId": "ACME-1234",
  "reason": "Cross-company review requested in issue.",
  "expiresAt": "2026-05-10T00:00:00.000Z",
  "issuer": {
    "role": "manager_agent",
    "companyId": "fontastic",
    "agentId": "agent-manager"
  },
  "adapterAllowRoots": ["/absolute/repo/root"]
}
```

Create and renew responses include:

- `grant`: normalized grant record with computed `state`
- `token`: opaque bearer secret for the new or rotated grant
- `issueComment`: markdown payload Paperclip can post back to the linked issue

`GET /api/grants?includeAudit=1` also returns one-time `grant.expired` audit
events with an `issueComment` payload when Lookie-Link first observes an expired
grant.
