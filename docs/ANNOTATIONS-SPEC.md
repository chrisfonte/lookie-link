# Annotation Sidecar Contract

This document specifies the implemented annotation transport and viewer behavior. Route methods, auth gates, and feature switches are authoritative in [CAPABILITIES.md](CAPABILITIES.md#registered-http-routes).

## Enablement and authorization

Annotations default off and are enabled by `server.enableAnnotations` or `LOOKIE_LINK_ENABLE_ANNOTATIONS`. The flag is independent of editing. Reads require effective `view` on an existing file; every create/update operation requires effective `write`. Query credentials are allowed for reads and rejected for mutations.

## Storage

One JSON sidecar is stored beneath the served repo at `.lookie-link/annotations/<repo>/<relative-path>.json`. Writes use a temp file and rename. The source file is never modified, and there is no inline-source storage or migration command.

An empty document has this shape:

```json
{
  "schema": 1,
  "file": "docs/guide.md",
  "annotations": []
}
```

The read response also contains sidecar `mtimeMs` (or `null`). Each annotation has a server-assigned ID and timestamps, `anchor`, `anchorKind`, author/body, state, optional claim/resolution/redaction metadata, and replies.

## Anchors and states

Supported anchor kinds are:

- `heading` for rendered heading IDs
- `yamlKey` for rendered YAML key-path IDs
- `lineRange` using `#L<start>-L<end>` with start not greater than end

Authored HTML can expose a deliberate stable target with `data-lookie-annotation-anchor`. Arbitrary CSS selectors and text-quote ranges are not supported.

States are `open`, `claimed`, and `resolved`. A read may repeat the `state` query parameter to select multiple states.

## Create and update

A create payload requires `anchor`, `anchorKind`, `body`, and `author`. The server assigns ID, timestamps, and initial `open` state.

An update payload requires `id` and one operation:

- `claim` with `payload.claimedBy`
- `resolve` or `reopen`
- `reply` with `payload.author` and `payload.body`
- `redact` with `payload.redactedBy`

An optional `expectedMtimeMs` protects against stale sidecar writes. A conflict returns `409` with the current mtime and document. Redaction scrubs the annotation and reply bodies, resolves the annotation, and keeps minimal audit metadata.

## Viewer integration

When enabled for an authorized file, rendered documents load the annotation client. The toolbar toggles annotation mode and resolved visibility. Markdown/HTML headings and YAML keys receive anchor affordances, source/code views support line ranges, matching cards render near their targets, and annotations with missing anchors remain visible in a stale-anchor section.

The transformed HTML runtime can inject the same client and deliberate targets. Verbatim raw HTML is not modified.

## Compatibility CLI

`lookie-annotations` implements `list`, `get`, `add`, `claim`, `resolve`, and `replies` (including reply creation). It is a separate compatibility executable, not a `lookie annotations` subcommand. The unified CLI currently has no annotation command. See [AGENT-SHIM.md](AGENT-SHIM.md).
