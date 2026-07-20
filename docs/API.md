# API Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check (returns `{"status":"ok","editingEnabled":bool}`) |
| `GET /api/repos` | Discover served repos as JSON (filtered by grant scope when a token is presented) |
| `GET /view/<repo>/<path>` | Rendered file or directory listing |
| `GET /asset/<repo>/<path>` | Raw asset serving. Supports `Range` requests so `<audio>` can seek, backs the embedded PDF viewer page, and is the agent-facing read path for text/source files (see `lookie-read` CLI in the repo `bin/`). MIME types: images (`.png`/`.jpg`/`.gif`/`.webp`/`.svg`/`.jpeg`), audio (`.m4a`/`.mp3`/`.wav`/`.ogg`/`.oga`/`.opus`/`.flac`/`.aac`), PDF (`.pdf`), markdown (`.md`/`.markdown`/`.mdown` → `text/markdown`), YAML (`.yaml`/`.yml` → `text/yaml`), JSON (`.json`), XML (`.xml`), and the editable text/source set (shell, Python, JS/TS, Go, Rust, C/C++, etc.) returned as `text/plain; charset=utf-8`. Anything else returns `415 Unsupported asset type`. |
| `GET /edit/<repo>/<path>` | Edit page (only when editing enabled) |
| `POST /api/save/<repo>/<path>` | Save updated file content (JSON body) |
| `POST /api/preview/<repo>/<path>` | Render preview HTML from draft content (JSON body) |
| `GET /api/annotations/<repo>/<path>` | Read sidecar annotations for a file. Supports repeatable `?state=open|claimed|resolved`. Returns an empty schema document when no sidecar exists. |
| `POST /api/annotations/<repo>/<path>` | Create an annotation. Requires only `view` access and `enableAnnotations: true`. |
| `PATCH /api/annotations/<repo>/<path>` | Apply `claim`, `resolve`, `reopen`, or `reply` to an annotation with stale-write protection. Requires only `view` access and `enableAnnotations: true`. |
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
- `/edit/*` and `/api/save/*` require `edit`
- `/api/preview/*` requires `view` and still respects global editing mode
- `/api/annotations/*` requires `view` and returns `404` when annotations are disabled

Invalid tokens return `403`. Missing tokens return `401` when unauthenticated human access is restricted.

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
- Returns `{ "schema": 1, "file": "<repo>/<path>", "annotations": [] }` when no sidecar exists yet
- Optional `?state=` filter can be repeated, for example `?state=open&state=claimed`

`POST /api/annotations/<repo>/<path>`

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

- Supported `op` values: `claim`, `resolve`, `reopen`, `reply`
- `reply` payload requires `author` and `body`
- Stale `expectedMtimeMs` returns `409` with the current annotation document in `current`

## Managed Grant Lifecycle

When `access.grants` is configured, grant lifecycle endpoints are enabled and
require a grant admin token from `access.grants.adminTokens`.

Issue-linked create and renew requests require an explicit `expiresAt` value.

Create request example:

```json
{
  "repoId": "operations-fontastic",
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
  "paths": ["clients/rfc-media/briefs/"],
  "sourceIssueId": "FON-3675",
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
