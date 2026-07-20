# Publishing

Publishing creates a stable, slug-addressed lineage of finished artifact bundles without writing into a configured source repository.

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

The publish area is exposed only through the virtual `published` repo namespace. Internal publication metadata and the configured filesystem path are not mounted into the viewer.

A publishing credential needs `publish: true` and scope for the configured publish repo. Reading an artifact separately needs `view` scope for its slug or path.

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

## Read Current And Historical Content

- Current rendered entry: `/view/published/release-notes/index.md`
- Revision 1 rendered entry: `/view/published/release-notes/index.md?version=1`
- Revision 1 asset: `/asset/published/release-notes/diagram.png?version=1`
- Revision 1 raw HTML, when raw HTML is enabled: `/raw/published/release-notes/page.html?version=1`

These routes reuse the normal viewer authorization and rendering rules under the `published` repo name. They never use metadata to resolve or authorize a source repository.

## Revoke A Slug

```bash
curl -X POST http://localhost:9876/api/publish/release-notes/revoke \
  -H 'Authorization: Bearer <publish-token>' \
  -H 'Content-Type: application/json' \
  -d '{ "reason": "artifact superseded" }'
```

Revocation returns `410 Gone` for current and historical `view`, `asset`, and `raw` reads. It does not rewrite or delete the immutable revision snapshots.

Managed agent API keys record `publish.create`, `publish.update`, and `publish.revoke` audit events in the API-key audit store.
