# API Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Repository index |
| `GET /healthz` | Health check (returns `{"status":"ok","editingEnabled":bool}`) |
| `GET /view/<repo>/<path>` | Rendered file or directory listing |
| `GET /asset/<repo>/<path>` | Image asset serving (for inline images) |
| `GET /edit/<repo>/<path>` | Edit page (only when editing enabled) |
| `POST /api/save/<repo>/<path>` | Save updated file content (JSON body) |
| `POST /api/preview/<repo>/<path>` | Render preview HTML from draft content (JSON body) |
| `GET /api/grants` | List managed Paperclip grants (admin token required) |
| `POST /api/grants` | Create a managed grant and mint a bearer token |
| `POST /api/grants/:grantId/renew` | Renew a managed grant and optionally rotate its token |
| `POST /api/grants/:grantId/revoke` | Revoke a managed grant immediately |

## Access Tokens

Agent requests can authenticate with either:

- `Authorization: Bearer <secret>`
- `?token=<secret>`

Route enforcement in phase 1:

- `/` and `/view/*` require `view` access when `access.humanDefault` is not `full`
- `/asset/*` requires `view`
- `/edit/*` and `/api/save/*` require `edit`
- `/api/preview/*` requires `view` and still respects global editing mode

Invalid tokens return `403`. Missing tokens return `401` when unauthenticated human access is restricted.

## Managed Grants API

All `/api/grants*` routes require `Authorization: Bearer <admin-secret>` where the secret matches `access.grants.adminTokens`.

Create request:

```json
{
  "sourceCompanyId": "source-company-id",
  "targetCompanyId": "target-company-id",
  "subject": {
    "companyId": "target-company-id",
    "agentIds": ["agent-id"]
  },
  "repoId": "docs",
  "paths": ["guides/", "README.md"],
  "permissions": { "view": true, "edit": false },
  "sourceIssueId": "issue-id",
  "approvalId": null,
  "reason": "Cross-company review requested in FON-3674",
  "adapterAllowRoots": [
    "/Users/chrisfonte/operations-fontastic/docs",
    "/Users/chrisfonte/operations-fontastic/README.md"
  ],
  "issuer": {
    "role": "manager_agent",
    "companyId": "source-company-id",
    "agentId": "agent-id"
  },
  "expiresAt": "2026-05-05T00:00:00Z"
}
```

Responses:

- `POST /api/grants` returns `201` with `{ ok, grant, token }`. The raw `token` is only returned once.
- `GET /api/grants?state=active&includeAudit=true` returns the stored grants plus optional audit events.
- `POST /api/grants/:grantId/renew` returns the updated grant and a new `token` when rotation is enabled.
- `POST /api/grants/:grantId/revoke` marks the grant revoked immediately.
- When `access.grants.projectionPath` is configured, create/renew/revoke also refresh an atomic projection containing only active grants, enforcement fields, and token hashes.

Cross-company grant creation rules:

- `adapterAllowRoots` is required when `sourceCompanyId` and `targetCompanyId` differ.
- Every granted path, or the whole repo root for whole-repo grants, must resolve inside at least one adapter allow root after `realpath` normalization.
- Requests that fall outside the adapter allow roots are rejected with `400`.

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
