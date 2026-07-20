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

JSON APIs generally return `{ "ok": false, "error": "..." }`. Common statuses are `400` invalid input, `401` missing required authentication, `403` denied, `404` missing/disabled/hidden, `409` optimistic conflict, `410` revoked publication, `415` unsupported type, and `500` internal failure.
