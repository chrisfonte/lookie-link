# API Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check (returns `{"status":"ok","editingEnabled":bool}`) |
| `GET /api/repos` | Discover served repos as JSON (filtered by grant scope when a token is presented) |
| `GET /view/<repo>/<path>` | Rendered file or directory listing |
| `GET /asset/<repo>/<path>` | Asset serving for inline images, audio, and PDFs. Supports `Range` requests so `<audio>` can seek, and also backs the embedded PDF viewer page. MIME type derived from extension (`.png`/`.jpg`/`.gif`/`.webp`/`.svg`/`.jpeg` for images; `.m4a`/`.mp3`/`.wav`/`.ogg`/`.oga`/`.opus`/`.flac`/`.aac` for audio; `.pdf` for PDFs). |
| `GET /edit/<repo>/<path>` | Edit page (only when editing enabled) |
| `POST /api/save/<repo>/<path>` | Save updated file content (JSON body) |
| `POST /api/preview/<repo>/<path>` | Render preview HTML from draft content (JSON body) |
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

Invalid tokens return `403`. Missing tokens return `401` when unauthenticated human access is restricted.

## Repo Discovery Endpoint

`GET /api/repos`

Lets agents discover served repos at runtime without parsing the HTML index or reading the host's YAML config. Response shape:

```json
{
  "repos": [
    {
      "repo": "operations",
      "rootPath": "/Users/chrisfonte/operations",
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
