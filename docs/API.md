# API

The [capability and route matrix](CAPABILITIES.md) is the authoritative endpoint list, including methods, permissions, feature gates, discovery templates, and source anchors. This document adds payload and workflow details without duplicating that list.

## An agent's first seven requests

Everything below is discoverable from the first request; nothing needs prior knowledge of the host.

| # | Request | Answers |
|---|---|---|
| 1 | `GET /.well-known/agent.json` | what this caller may do (`capabilities`), the path templates to use (`endpoints`), `discovery.openapiUrl` / `discovery.apiDocsUrl`, and the appearance `themes` block |
| 2 | `GET /api/repos` | visible repos with `viewUrl` and `assetUrl` |
| 3 | `GET /api/appearance` | themes, aliases, picture counts, defaults, `revision`; poll with `If-None-Match` using the `ETag` |
| 4 | `GET /api/appearance/themes/:slug` | one theme's palettes, glass values and picture ids (aliases resolve) |
| 5 | `GET /api/repos/:repo/tree`, `…/changes?since=<ms>`, `…/files/*path` | list a folder, what changed since a time, read a text file as JSON — any served repo; `GET /asset/:repo/*path` for raw bytes (`/view` is the client-rendered HTML shell) |
| 6 | `GET /api/annotations/:repo/*path` | the page's annotations, when enabled |
| 7 | any error | `{ "ok": false, "error": { "code", "message", "details"? } }` on every route |

Search covers every served repo and is complete when the ripgrep backend is active (the response says which backend ran; the walk fallback samples an unscoped fleet). Every word must match, in any order; quote a phrase. Scope it when the repo is known. The same flow from the CLI: `lookie capabilities`, `lookie repos`, `lookie appearance show`, `lookie tree`, `lookie changes --since`, `lookie search [--scope]`, `lookie read`, `lookie annotations list`, `lookie openapi`.

## Authentication and authorization

Static tokens, managed API keys, and managed grants resolve to the same `view`, `write`, and `publish` permission model plus repo/path scopes. `edit` remains a legacy alias for `write` in stored credentials.

Use `Authorization: Bearer <token>` for agents. Read requests also accept `?token=` so browser navigation can propagate a scoped token. Every mutation rejects query credentials with `400`, even if a bearer header is also present.

`access.humanDefault: full` grants an unauthenticated caller unrestricted permissions. `restricted` and `none` return `401` without a credential and `403` for an invalid one. Managed-repository handlers deliberately return uniform not-found responses for missing and unauthorized resources.

## Discovery

`GET /api/repos` returns caller-visible opaque mappings:

```json
{
  "repos": [
    {
      "repo": "docs",
      "viewUrl": "/view/docs/",
      "assetUrl": "/asset/docs/"
    }
  ],
  "count": 1
}
```

`GET /api/whoami` reports sanitized caller auth, subject, effective permissions, repo scopes, live capabilities, and authorized endpoint templates. `GET /.well-known/agent.json` wraps the same caller state with schema, version, instance, authentication, and discovery metadata. Their exact fields and capability rules are in [CAPABILITIES.md](CAPABILITIES.md#discovery-field-inventory).

`GET /.well-known/agent.json` is also the appearance API's read side. Its `themes` block lists every installed theme with its aliases and wallpaper picture ids per mode, the five URL parameter names, the image URL template, and the panel-opacity and blur ranges with their configured defaults. Compose a viewer URL from it, for example:

```
GET /.well-known/agent.json
→ themes.available[n].id = "carolina-sunset"
→ themes.available[n].wallpapers.dark[1].id = "mackerel-sky"
→ /view/docs/today.md?lookie-scheme=carolina-sunset&lookie-theme=dark&lookie-wallpaper=mackerel-sky&lookie-panel=85
```

Appearance has no write endpoint yet; themes and wallpapers are configured in the server's YAML file and reload live.

Discovery never returns repository roots, home paths, store paths, credentials, token/admin names, grant audit data, or private publish metadata. Administrative APIs are not advertised.

## Appearance

`GET /api/appearance` is the pollable list of what exists: every theme with its palettes, aliases, picture ids and labels per mode and effective glass values, plus the global defaults, the five URL parameter names and a `revision`. It carries a weak ETag and `Cache-Control: no-cache`, so a poller sends `If-None-Match` and gets `304` until something changes. `GET /api/appearance/themes/:slug` returns one theme; aliases resolve. Neither includes folder paths.

Writes need an appearance admin bearer token and land in a server-owned overlay file beside the operator's config (the operator's YAML is never rewritten; the overlay wins where both set a key; the config watcher reloads the result live):

```http
PATCH /api/appearance
Authorization: Bearer <admin token>
Content-Type: application/json

{ "expectedRevision": 3,
  "wallpapers": { "blur": 8 },
  "themes": { "Carolina Sunset": { "dark": { "accent": "#e1886e" }, "wallpapers": { "default": { "dark": "mackerel-sky" } } },
              "Old Theme": null } }
```

`expectedRevision` must equal the current `revision` (else `409 revision_conflict` with `currentRevision`). Unknown keys, out-of-range values and anything the theme loader would reject return `400 invalid_request` with `details[]`. `themes.<Name>: null` removes a theme from the overlay. Pictures: `POST /api/appearance/themes/:slug/wallpapers/:mode?name=<id>` with the raw image bytes (`image/jpeg`, `image/png`, `image/webp`) writes the server-managed folder only; a mode whose pictures come from another folder (an Omarchy set) answers `409 folder_not_managed`, and the first upload for a mode adopts the managed folder in the overlay. `DELETE …/wallpapers/:mode/:id` removes a managed picture. Every write records an audit event (`appearance.update`, `appearance.wallpaper.upload`, `appearance.wallpaper.delete`).

## OpenAPI

`GET /openapi.json` returns an OpenAPI 3.1 document for every registered route (forms routes are included only when `forms.enabled` is true), with the shared `Error` envelope, `bearerAuth` and `queryToken` security schemes, and `x-lookie-capability` / `x-lookie-endpoint-key` extensions linking operations to discovery. `GET /api/docs` is a small try-it explorer built from it. Both require only a non-denied caller; a test keeps the document equal to the registered routes and to [CAPABILITIES.md](CAPABILITIES.md).

## Mounted content

`GET /view/<repo>/<path>` renders a directory or supported file. HTML requests with `?validate=1` return a JSON report describing local asset/navigation references without exposing host paths. Published content additionally accepts `?version=<positive-integer>`.

`GET /asset/<repo>/<path>` returns only allowlisted image, audio, video, PDF, and text/source extensions with an explicit MIME type. HTML is served as plain text on this route. Unknown extensions return `415`.

When editing is enabled, `GET /edit/<repo>/<path>` loads an existing non-binary file. `POST /api/save/<repo>/<path>` accepts:

```json
{
  "content": "replacement UTF-8 content",
  "expectedMtimeMs": 1234567890
}
```

The mtime guard is optional; a stale value returns `409`. A successful save uses temp-file-plus-rename replacement. `POST /api/preview/<repo>/<path>` accepts `{ "content": "draft" }`, requires only `view` on the existing target, and returns rendered HTML without writing.

## Annotations

Annotation routes require the annotation feature flag and an existing file. Reads require `view`; creates and updates require `write`.

Create request:

```json
{
  "anchor": "#design-decisions",
  "anchorKind": "heading",
  "body": "Please split this section.",
  "author": "review-agent"
}
```

`anchorKind` is `heading`, `yamlKey`, or `lineRange`; line ranges use `#L<start>-L<end>`. Reads accept repeatable `state=open|claimed|resolved`. Updates are `{ id, op, payload?, expectedMtimeMs? }` with `op` one of `claim`, `resolve`, `reopen`, `reply`, `redact`; `payload` carries `claimedBy` (claim), `author` + `body` (reply), `redactedBy` (redact). Resolve and reopen are idempotent (a repeat returns `200` and re-stamps the time). Stale updates return `409` with the current document. See [ANNOTATIONS-SPEC.md](ANNOTATIONS-SPEC.md).

## Any served repository: tree, changes, file read, search

Since 2026-09-23 the read half of the repository API is not limited to managed repositories. `GET /api/repos/:repo/tree`, `GET /api/repos/:repo/changes?since=<epoch ms | epoch s | ISO-8601>` and `GET /api/repos/:repo/files/*path` work for every repo the caller can view, managed or plainly mapped, with the same bounds, caller filtering, envelope and `viewUrl` fields; responses carry `managed: true|false`. `.git`, Syncthing state folders and `node_modules` are never listed. `GET /api/search` and `/suggest` cover the union of managed and mapped repos. The `/api/managed-repos/...` read routes remain for managed repos.

## Managed repositories

Registration is an administrative operation constrained to configured existing allow-roots. Normal content operations use caller scope:

- File reads return UTF-8 `content`, path, size, and mtime.
- Writes require string `content`; optional `expectedMtimeMs` returns `409` on conflict.
- Deletes are soft by default and return a `trashId`; `?hard=1` deletes immediately. `GET /api/managed-repos/:repo/trash` lists soft-deleted records (newest first) the caller may view.
- Restore and permanent-trash deletion re-check `write` on the original path.
- Tree and change responses are bounded and caller-filtered (the generic `/api/repos/:repo/...` routes above give the same for mapped repos). `changes?since=` accepts epoch milliseconds, epoch seconds or an ISO-8601 timestamp (compared against file `mtimeMs`).
- Search requires `q`. Query semantics (both backends): whitespace splits `q` into terms and every term must occur in the file's content, in any order, or every term in its path; wrap words in double quotes for a phrase; matching is literal (no regular expressions) and case-insensitive, and the response echoes the `terms` it used. A `scope` that names no repo the caller can search is a `400` (not an empty result), and `limit` must be an integer ≥ 1. `npm run search:battery -- <base-url>` runs the naive-user query battery (reversed words, quoted phrase, misspelled scope, limit=0, unknown parameter) against any instance and exits non-zero on a silent bad answer. Search supports repeated `scope` (alias `repo`), rejects unknown query parameters with `400` so a misspelled filter cannot silently widen a search, and bounds results, entries, file size, and total bytes. The entry budget (default 20000, max 40000) is shared fairly across the candidate repos (500–5000 entries each), so an unscoped search across a large fleet samples every repo rather than exhausting the budget on the first; `truncated` says when a repo's slice ran out. With a ripgrep binary configured or on the service PATH the backend is `ripgrep`: complete across every served repo in one process (about 0.2 s warm on an 18-repo fleet), `totalMatches` reported and `truncated` only when the result cap is hit. The response's `backend` field says which ran. Suggestions match visible paths only.

## Publishing

Publishing requires whole-repo `publish` scope on the configured virtual publish repo. A path-only scope is rejected.

Create payloads contain a non-empty `files` array and may include `slug`, `entryPath`, public `metadata`, and internal `privateMetadata`. File entries default to UTF-8 and may specify `encoding: base64`. Create returns `201` and immutable revision 1.

Updates use the same complete-bundle payload plus a mandatory `expectedRevision`; stale updates return `409` with the safe current projection. Revoke requests require `{ "reason": "..." }`; revoked current and historical reads return `410`.

Readback uses the normal `view`, `asset`, and optional `raw` routes beneath the configured virtual repo. Public metadata containing absolute filesystem paths is rejected; private metadata is never projected. See [PUBLISHING.md](PUBLISHING.md).

## Administrative stores

API-key lifecycle routes require an API-key admin bearer token. Created and rotated secrets are returned once and stored only as hashes. Grant lifecycle routes require a grant admin token; mutation credentials must be bearer tokens. Grant requests also enforce issuer, subject, source-owner, expiry, approval, and cross-company allow-root policy.

These routes intentionally use store-specific admin credentials rather than the caller's `view`, `write`, or `publish` permissions.

## Stale-write guards

Two guard styles exist, for historical reasons:

| Guard | Used by | Semantics |
|---|---|---|
| `expectedRevision` (integer) | publish, forms templates, appearance | The standard for every new API. Compare with the resource's `revision`; a mismatch is `409 revision_conflict` and the body carries `currentRevision` (or the safe current projection). |
| `expectedMtimeMs` (number) | managed files, `/api/save`, annotations | Legacy file-backed guard. Compare with the file's `mtimeMs`; a mismatch is `409 stale_write` with `currentMtimeMs`. Kept because those resources have no revision counter; not to be used for new resources. |

## Error conventions

Every JSON error — core routes and forms alike — uses one envelope:

```json
{ "ok": false, "error": { "code": "invalid_request", "message": "q is required.", "details": [{ "path": "q", "message": "q is required." }] } }
```

- `error.code` is a stable `snake_case` identifier; branch on it, not on the text.
- `error.message` is human-readable. It carries the exact string earlier releases sent as the bare `error` value (breaking change, API review 2026-09-23: `error` is now always an object, never a string).
- `error.details` is optional: an array of `{ path, message }` pointing at the offending field(s).
- A few conflict responses keep extra top-level context beside `error` (`current`, `currentRevision`, `currentMtimeMs`).

Default codes by status, used when no more specific code applies:

| Status | Code |
|---|---|
| `400` | `invalid_request` |
| `401` | `unauthenticated` |
| `403` | `forbidden` |
| `404` | `not_found` |
| `405` | `method_not_allowed` |
| `409` | `conflict` |
| `410` | `gone` |
| `413` | `payload_too_large` |
| `415` | `unsupported_media_type` |
| `422` | `invalid_request` |
| `429` | `rate_limited` |
| `500` | `internal_error` |

More specific codes: `query_credentials_rejected` (400, a mutation carried `?token=` / URL credentials), `unknown_repo` (404, annotation routes naming an unconfigured repository), `feature_disabled` (404, editing or annotations turned off), `stale_write` (409, file changed on disk since `expectedMtimeMs`), `revision_conflict` (409, stale publish or form-template revision), the forms codes `invalid_json` and `validation_error`, and the forms browser-gate codes `origin_rejected` (403, no bearer and the Origin header is not a configured public origin) and `csrf_rejected` (403, no bearer and the synchronizer token / context cookie is missing or wrong).

Unmatched routes and unhandled errors (`404`, `413`, `500`) answer in the envelope when the path starts with `/api/` or `/.well-known/`, or the `Accept` header prefers `application/json`; browser and asset requests still get `text/plain`. HTML and asset routes (`/view`, `/raw`, `/embed`, `/assets`) keep their `text/plain` error bodies.
