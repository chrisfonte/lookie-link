# Publishing

Publishing creates a stable, slug-addressed lineage of finished artifact bundles without writing into a configured source repository.

The authoritative publish route, permission, config, CLI, and discovery inventory is [CAPABILITIES.md](CAPABILITIES.md). This document covers the payload and revision model.

## Immutability And Revisions

“Immutable” applies to each numbered revision, not to the slug. A slug is a stable pointer whose current revision can advance from 1 to 2 and so on. Advancing the slug always creates a complete new snapshot; it never changes files in an existing revision. Historical revisions remain readable until the slug is revoked.

`maxRevisions` is a creation limit, not a retention policy. When a slug reaches the configured limit, another update is rejected; Lookie-Link does not delete older revisions.

## Configuration

```yaml
publish:
  enabled: true
  areaPath: ~/.local/share/lookie-link/published
  repoId: published
  maxFiles: 100
  maxFileBytes: 2097152
  maxRevisionBytes: 10485760
  maxMetadataBytes: 65536
  maxRevisions: 20
```

The publish area is exposed only through the virtual `published` repo namespace. Its `repoId` must not collide with a configured source-repository mapping; Lookie-Link rejects a collision at startup. Internal publication metadata and the configured filesystem path are not mounted into the viewer.

Publishing is a repo-level capability. A publishing credential needs `publish: true` and whole-repo scope for the configured publish repo (or `repos: all`). Path-scoped publish credentials are rejected for create, update, and revoke rather than silently treating a path as a slug-management boundary. Reading an artifact separately remains path-aware and needs `view` scope for its slug or path.

Publish routes use the instance's normal default-access posture. The default `access.humanDefault: full` therefore allows anonymous publish, update, and revoke when publishing is enabled. Multi-user deployments should use `humanDefault: restricted` or `none` and explicit publish credentials.

## Create A Slug

```bash
curl -X POST http://localhost:9876/api/publish \
  -H 'Authorization: Bearer <publish-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "release-notes",
    "files": [
      { "path": "index.md", "content": "# Release notes\n" },
      { "path": "diagram.png", "encoding": "base64", "content": "<base64-data>" }
    ],
    "entryPath": "index.md",
    "metadata": { "label": "Release notes" },
    "privateMetadata": { "sourceRepo": "internal-docs" }
  }'
```

Omit `slug` to mint a random slug. A supplied slug must contain 1–64 lowercase letters, digits, or internal hyphens. File paths must be relative, cannot contain traversal or symlink ancestors, and must be unique within the payload.

`metadata` is returned in publication responses but is descriptive only: it never grants access to a repo or path, and absolute filesystem paths are rejected. `privateMetadata` is stored in the publication control record but is omitted from every API projection and published readback path. Put source repository names and filesystem paths only in `privateMetadata`.

## Create A New Revision

Updates submit another complete bundle, not a partial file patch:

```bash
curl -X POST http://localhost:9876/api/publish/release-notes \
  -H 'Authorization: Bearer <publish-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedRevision": 1,
    "files": [
      { "path": "index.md", "content": "# Revised release notes\n" }
    ],
    "entryPath": "index.md"
  }'
```

`expectedRevision` is mandatory. A stale value returns `409 Conflict` with the current revision. Multi-file revisions are staged outside the visible revision path and committed together; a failed publish does not expose a partial bundle. An interrupted, unreferenced next revision is removed when the same update is retried.

The `expectedRevision` check and per-slug lock coordinate one Lookie-Link process. Deployments must not run multiple server instances against the same `areaPath`; cross-process locking is not currently provided.

## Kits

Create and update payloads accept an optional `kit` field: a kit name string, or `true` for the configured default kit. When `kit` is set, every `.html`/`.htm` file in the bundle is rewritten at publish time:

1. If the document contains a `<link rel="stylesheet" … data-kit …>` element (any `href`), that element is replaced with an inlined `<style data-kit="<name>" data-kit-version="<version>">…</style>` block holding the current served `kit.css` bytes.
2. Else if the document already contains `<style data-kit=…>`, it is left alone.
3. Else the same `<style>` block is inserted into `<head>` immediately after a `<meta charset…>` when present, otherwise at the start of `<head>`; with no `<head>`, the block is prepended to the document.

Non-HTML files are never touched. The stored revision keeps the inlined bytes, so later kit or overlay changes cannot alter published history. The revision record (and the publication / list projections for the current revision) carry `kit: { name, version, revision }` where `version` is the kit's effective version at publish time (`1.26`, or `1.26+<overlay hash>` when an admin token overlay was active, so the overlay is baked into that revision) and `revision` is the kits catalog revision at publish time; bundles published without `kit` show `kit: null`. Unknown kit names return `400 invalid_request` with `details: [{ path: "kit", message: "unknown kit: …" }]`; when kits are disabled or none are loaded and `kit` is given, the response is `400 feature_disabled`.

To prepare a page for kit inlining, include a placeholder link such as:

```html
<link rel="stylesheet" href="kit.css" data-kit>
```

## Read Current And Historical Content

- Current rendered entry: `/view/published/release-notes/index.md`
- Revision 1 rendered entry: `/view/published/release-notes/index.md?version=1`
- Revision 1 asset: `/asset/published/release-notes/diagram.png?version=1`
- Revision 1 raw HTML, when raw HTML is enabled: `/raw/published/release-notes/page.html?version=1`

These routes reuse the normal viewer authorization and rendering rules under the `published` repo name. They never use metadata to resolve or authorize a source repository.

## List And Inspect Publications

`GET /api/publish` needs whole-repo `view` (not `publish`) on the publish repo and returns every publication the caller may view, sorted by slug, as a summary projection (no `revisions[]`): `{ ok, publications, count, revision, generatedAt }`. `?state=active` or `?state=revoked` filters; any other query parameter is a `400`.

```bash
curl http://localhost:9876/api/publish
curl 'http://localhost:9876/api/publish?state=active'
```

`GET /api/publish/:slug` returns one publication's full projection plus `revisions[]` (`revision`, `createdAt`, `entryPath`, `fileCount`, `sizeBytes`, `viewUrl`). A revoked slug still returns its record with `state: "revoked"`; an unknown slug is `404 not_found`. `?version=N` adds a `files` entry for that one revision.

```bash
curl http://localhost:9876/api/publish/release-notes
curl 'http://localhost:9876/api/publish/release-notes?version=1'
```

Both routes carry `revision` (an opaque hash over every publication's `slug`/`updatedAt`/`currentRevision`/`revokedAt`, changing whenever anything is created, updated, or revoked) and set a weak `ETag`; send `If-None-Match` on later polls and expect `304` when nothing changed.

## Revoke A Slug

```bash
curl -X POST http://localhost:9876/api/publish/release-notes/revoke \
  -H 'Authorization: Bearer <publish-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "reason": "artifact superseded" }'
```

Revocation returns `410 Gone` for current and historical `view`, `asset`, and `raw` reads. It does not rewrite or delete the immutable revision snapshots.

Managed agent API keys record `publish.create`, `publish.update`, and `publish.revoke` audit events in the API-key audit store.
