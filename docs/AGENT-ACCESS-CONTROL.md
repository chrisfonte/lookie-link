# Agent Access Control

This document describes the implemented authorization model. The exact route-to-permission mapping is maintained only in [CAPABILITIES.md](CAPABILITIES.md#registered-http-routes).

## Access context

Every request is resolved in this order:

1. A matching static `access.tokens` credential
2. A matching active managed API key, when its store is enabled
3. A matching active managed grant, when its store is enabled
4. The configured anonymous `access.humanDefault` posture

Bearer credentials take precedence over query credentials. Static tokens, API keys, and grants all produce the same effective fields: mode, credential type/source, subject metadata, permissions, all-repo or per-repo scopes, and a uniform denial response.

`view` reads/browses, `write` mutates source or managed content and annotations, and `publish` manages the virtual publish repo. `edit` is retained only as a compatibility alias for `write`. Publish management requires whole-repo scope; path scopes do not authorize slug lifecycle operations.

## Repo and path scopes

A credential can use `repos: all`, a list of whole repos, or a map of repo-specific paths. A path ending in `/` is a directory subtree; a path without the slash is one file. Directory listings are included when their subtree intersects an authorized file or directory, while file access requires the exact file or an ancestor directory scope.

Managed routes hide unauthorized resources with the same not-found response used for absent resources. All browser/API discovery responses omit host roots and unauthorized repo/path names.

## Credential transport

Use `Authorization: Bearer <token>` for agents and the unified CLI. Read-only browser links may use `?token=`; generated navigation preserves that token where necessary. Query credentials are rejected for every `POST`, `PUT`, `PATCH`, and `DELETE` request.

The default `humanDefault: full` gives an unauthenticated caller unrestricted `view`, `write`, and `publish` permissions. Feature flags and store availability still apply. Set `humanDefault` to `restricted` or `none` before using the instance across trust boundaries.

## Static tokens

Static tokens are configuration-backed and can include `subject`, `issuer`, and `audit` lineage. Prefer `secretEnv`; inline secrets are supported for private local development. Static secrets require config rotation/restart for revocation.

## Managed API keys

The API-key store hashes key secrets, writes private store files with mode `0600`, returns create/rotate secrets once, supports revocation, updates last-used time, and records safe lifecycle/content/publish audit events. Separate admin bearer tokens protect key lifecycle routes.

## Managed grants

Managed grants are expiring, revocable credentials with source/target company, subject, repo/path, permissions, issuer, reason, approval, and issue lineage. Creation validates configured repo ownership. Broad, write, or longer-lived grants require approval. Cross-company grants additionally require requested adapter allow-roots that contain every resolved target.

Grant renewal rotates the secret by default. The optional projection contains active safe grant projections and omits token hashes, reasons, revocation details, and audit events. Separate grant-admin credentials protect lifecycle routes.

## Discovery

`/api/repos`, `/api/whoami`, and `/.well-known/agent.json` return only caller-visible data. Capability booleans are intersections of runtime configuration, registered routes, store availability, and current scope. Endpoint templates are withheld when a feature or caller permission is unavailable. Administrative routes are never advertised.

Use `lookie whoami` and `lookie capabilities` before a sensitive workflow. The full response field inventory is [documented with the matrix](CAPABILITIES.md#discovery-field-inventory).

## Security boundaries

- Network isolation remains required; this is not a public multi-tenant identity service.
- Repository roots, store roots, credentials, private metadata, and internal admin identities must never enter rendered or discovery output.
- Static scopes do not grant filesystem access outside Lookie-Link.
- Managed repository and publish stores add symlink/realpath containment to route-level access checks.
- Raw HTML is a same-origin trusted-content feature. A file served through `/raw` can execute scripts with the viewer's origin privileges.
- Same-company local filesystem work can remain filesystem-native; Lookie-Link credentials authorize only its HTTP surface.
