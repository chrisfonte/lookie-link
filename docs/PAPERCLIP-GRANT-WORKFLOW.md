# Paperclip-Native Grant Workflow

This spec defines the Paperclip side of cross-company Lookie-Link access. It
assumes Lookie-Link remains the enforcement service and Paperclip remains the
authority for company identity, issue context, approvals, expiry, and audit.

## Classification

Paperclip should own grant creation and lifecycle. Lookie-Link should only
verify a presented credential, match it to repo/path/action scope, and deny
requests outside that scope.

Paperclip must not rely on ambient network access, shared company folders, or
agent name guessing for cross-company access. Every cross-company access path is
an explicit grant linked to a Paperclip issue or approval.

## Subject Identity

A grant subject is a Paperclip company plus one of these narrower selectors:

- `agents: all` for every active agent in the target company.
- `agentIds: [...]` for named Paperclip agents.
- `userIds: [...]` for board or human browser access, when human sharing is
  enabled later.

Minimum subject fields:

```json
{
  "companyId": "target-company-id",
  "agentIds": ["agent-id"],
  "agents": null
}
```

The `companyId` is mandatory. Agent names and company slugs are display fields,
not authorization keys.

## Issuer Rules

Only the company that owns the Lookie-Link resource can issue a grant for it.
Paperclip should resolve ownership from the configured repo mapping, not from
the requesting agent's claim.

Allowed issuers:

- A board user or CEO agent for the source company.
- A source-company manager agent acting under an issue or approval policy that
  permits sharing the requested resource.
- A trusted ops agent only when the action is linked to an issue that names the
  source company, target company, resource, reason, and expiry.

Disallowed issuers:

- A target-company agent granting itself access.
- Any agent outside the source company's chain of command unless a board
  approval explicitly delegates that action.
- Any workflow that cannot attach the grant to an issue or approval audit trail.

## Resource Scope

Grant resources are path-scoped. Whole-repo grants are exceptional and should
require explicit approval text.

Minimum resource fields:

```json
{
  "repoId": "operations-fontastic",
  "paths": ["clients/rfc-media/briefs/example.md"],
  "permissions": {
    "view": true,
    "edit": false
  }
}
```

Paperclip should normalize paths before writing or signing grants. Lookie-Link
must still enforce its own path normalization and deny traversal independently.

## Issue And Approval Linkage

Every grant must include at least one Paperclip issue link:

- `sourceIssueId`: the work item that requested the grant.
- `approvalId`: required for whole-repo access, edit access, expiry longer than
  7 days, or target subjects broader than named agents.
- `reason`: short human-readable purpose, suitable for audit logs.

Paperclip should add a comment to the source issue when a grant is issued,
renewed, revoked, or expired early. Comments should link ticket IDs in markdown
form, for example `[FON-3672](/FON/issues/FON-3672)`.

## Expiry Defaults

Default expiry should be short and purpose-specific:

| Grant type | Default | Maximum without explicit approval |
|------------|---------|-----------------------------------|
| Ad hoc issue review | 24 hours | 72 hours |
| Active project collaboration | 7 days | 14 days |
| Edit access | 24 hours | 7 days |
| Whole-repo access | Not default | Board approval required |

Renewal creates a new audit event and should not silently mutate the original
grant without recording who renewed it and why.

## Revocation Behavior

Revocation must take effect without changing the repo mapping.

Required states:

- `active`: not expired and not revoked.
- `expired`: current time is after `expiresAt`.
- `revoked`: `revokedAt` is set by an authorized issuer.

Revocation should be allowed by the source-company CEO, board user, original
issuer, or a manager in the original issuer's chain of command. Target-company
agents may request revocation but should not directly revoke a source-company
grant unless they are also authorized by that source company.

## Audit Fields

Each grant record should store:

```json
{
  "id": "grant-id",
  "sourceCompanyId": "source-company-id",
  "targetCompanyId": "target-company-id",
  "subjectAgentIds": ["agent-id"],
  "repoId": "operations-fontastic",
  "paths": ["clients/rfc-media/briefs/example.md"],
  "permissions": { "view": true, "edit": false },
  "sourceIssueId": "issue-id",
  "approvalId": null,
  "reason": "Cross-company review requested in FON-3672",
  "issuedByAgentId": "agent-id",
  "issuedByUserId": null,
  "createdAt": "2026-05-04T00:00:00Z",
  "expiresAt": "2026-05-05T00:00:00Z",
  "revokedAt": null,
  "revokedByAgentId": null,
  "revokedByUserId": null,
  "revocationReason": null,
  "tokenHash": "sha256-or-better-hash",
  "lastUsedAt": null
}
```

Audit events should be append-only even when the current grant row is updated.
At minimum, record `grant.created`, `grant.renewed`, `grant.revoked`,
`grant.expired`, and `grant.token.rotated`.

## Store Versus Signed Token

Use a private grant store first. Signed tokens can come later if there is a
clear need to avoid Lookie-Link calling or reading Paperclip-managed state.

Recommended first implementation:

1. Paperclip writes grants to a private local SQLite store or private YAML file
   outside the Lookie-Link repo.
2. Lookie-Link reads that store or a generated read-only projection.
3. Paperclip generates opaque bearer secrets and stores only hashes.
4. Lookie-Link checks hash, expiry, revocation, repo, path, and permission on
   every request.

Why this path first:

- Immediate revocation is straightforward.
- Audit state is inspectable.
- Rotation does not require signing-key distribution.
- Lookie-Link does not need to understand Paperclip's company graph beyond the
  materialized grant fields.

Signed short-lived tokens are a later optimization. If added, Paperclip must
still keep a grant record and revocation list, and Lookie-Link must reject
tokens whose grant ID is revoked.

## Proposed Paperclip Code Issues

1. Add a Paperclip grant data model and lifecycle API.
   - Implement grant create, revoke, renew, and list operations.
   - Enforce source-company issuer rules and approval requirements.
   - Persist the audit fields above and hash token secrets.

2. Add issue-linked grant workflow helpers.
   - Create grants from an issue or approval context.
   - Require `sourceIssueId`, reason, explicit expiry, subject, resource, and permission.
   - Post grant lifecycle comments back to the source issue with linked ticket
     references.

3. Add Lookie-Link grant projection writer.
   - Export active, non-revoked grants to a private store path configured by the
     operator.
   - Support atomic writes and reload-safe updates.
   - Include only enforcement fields and token hashes in the projection.

## Smallest Correct Next Step

Paperclip implementation should start with the grant data model and lifecycle
API. Until that exists, Lookie-Link should only ship static config tokens for
single-company agent scoping and should not enable cross-company sharing by
default.
