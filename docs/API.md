# API

The [capability and route matrix](CAPABILITIES.md) is the authoritative endpoint list, including methods, permissions, feature gates, discovery templates, and source anchors. This document adds payload and workflow details without duplicating that list.

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

`anchorKind` is `heading`, `yamlKey`, or `lineRange`; line ranges use `#L<start>-L<end>`. Reads accept repeatable `state=open|claimed|resolved`. Updates accept `claim`, `resolve`, `reopen`, `reply`, or `redact`, plus an optional `expectedMtimeMs`; stale updates return `409` with the current document. See [ANNOTATIONS-SPEC.md](ANNOTATIONS-SPEC.md).

## Managed repositories

Registration is an administrative operation constrained to configured existing allow-roots. Normal content operations use caller scope:

- File reads return UTF-8 `content`, path, size, and mtime.
- Writes require string `content`; optional `expectedMtimeMs` returns `409` on conflict.
- Deletes are soft by default and return a `trashId`; `?hard=1` deletes immediately.
- Restore and permanent-trash deletion re-check `write` on the original path.
- Tree and change responses are bounded and caller-filtered. `changes?since=` expects a numeric Unix timestamp.
- Search requires `q`, supports repeated `scope`, and bounds results, entries, file size, and total bytes. Suggestions match visible paths only.

## Publishing

Publishing requires whole-repo `publish` scope on the configured virtual publish repo. A path-only scope is rejected.

Create payloads contain a non-empty `files` array and may include `slug`, `entryPath`, public `metadata`, and internal `privateMetadata`. File entries default to UTF-8 and may specify `encoding: base64`. Create returns `201` and immutable revision 1.

Updates use the same complete-bundle payload plus a mandatory `expectedRevision`; stale updates return `409` with the safe current projection. Revoke requests require `{ "reason": "..." }`; revoked current and historical reads return `410`.

Readback uses the normal `view`, `asset`, and optional `raw` routes beneath the configured virtual repo. Public metadata containing absolute filesystem paths is rejected; private metadata is never projected. See [PUBLISHING.md](PUBLISHING.md).

## Administrative stores

API-key lifecycle routes require an API-key admin bearer token. Created and rotated secrets are returned once and stored only as hashes. Grant lifecycle routes require a grant admin token; mutation credentials must be bearer tokens. Grant requests also enforce issuer, subject, source-owner, expiry, approval, and cross-company allow-root policy.

These routes intentionally use store-specific admin credentials rather than the caller's `view`, `write`, or `publish` permissions.

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

More specific codes: `query_credentials_rejected` (400, a mutation carried `?token=` / URL credentials), `unknown_repo` (404, annotation routes naming an unconfigured repository), `feature_disabled` (404, editing or annotations turned off), `stale_write` (409, file changed on disk since `expectedMtimeMs`), `revision_conflict` (409, stale publish or form-template revision), and the forms codes `invalid_json` and `validation_error`.

Unmatched routes and unhandled errors (`404`, `413`, `500`) answer in the envelope when the path starts with `/api/` or `/.well-known/`, or the `Accept` header prefers `application/json`; browser and asset requests still get `text/plain`. HTML and asset routes (`/view`, `/raw`, `/embed`, `/assets`) keep their `text/plain` error bodies.
