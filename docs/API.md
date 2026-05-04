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
