# ADR 93: Versioned template, form, submission, and direct-file contracts

> ## As-built status — 2026-07-21
>
> The Phase-1 forms slice shipped between this revision and today. Recorded here so this
> document is not read as a description of the running system.
>
> **Built and matching this ADR:** immutable one-file-per-submission store (exclusive `wx`
> create, fsync, atomic `link(2)` publish that cannot replace an existing record, directory
> fsync); capture-time `fieldType`, `fieldLabel`, and option-label snapshots, so template edits
> never re-caption issued receipts; corrections as new records via `supersedesRecord`;
> RFC 8785-style canonical serialization with `schemaDigest`; idempotency keys with replay
> protection.
>
> **Divergence 1 — `templateVersion` semantics. The ADR is correct; the code is wrong.**
> This document states that `templateVersion` versions a template's immutable content while
> `revision` versions a mutable definition, and that they are *not interchangeable*.
> `lib/forms/submission-service.js` stamps `templateVersion: template.revision`. Confirmed on
> the live instance: `gym-strength-entry` is revision 2 with **zero** published versions, so
> every submission's provenance pointer refers to a version that does not exist. Tracked as
> [#185](https://github.com/chrisfonte/lookie-link/issues/185); the fix is to the code, not to
> this ADR.
>
> **Divergence 2 — the form-instance layer is deferred, not dropped silently.** §3.3
> (`resourceKind: form-instance`) and the `{ formId, formRevision }` references on submissions
> and related records are **not implemented**. Submissions reference the template directly and
> carry no `formId`. Tracked as [#118](https://github.com/chrisfonte/lookie-link/issues/118)
> and [#123](https://github.com/chrisfonte/lookie-link/issues/123).
>
> **Open question that could move §3.** Whether structured write-back belongs in a database
> rather than files is unresolved (private todo `2026-07-12-lookie-writeback-database-question`,
> SQLite → Postgres ladder). The file model shipped before that was answered. Resolving it
> would change the storage assumptions here.
>
> Triage record: `~/operations-system/plans/lookie-link-backlog-triage/`.



- Changelog: Revision 2 addresses adversarial-review requirements R1–R4.
- Status: Accepted 2026-07-21 — partially implemented, see As-built status
- Date: 2026-07-19
- Issue: #93
- Parent: #90
- Decision owners: Lookie-Link maintainers and deployment operator
- Scope: v1 public data and persistence contracts; route authorization mechanics remain in ADR #92

## Context

The forms platform must be file-native and API-first without creating a second contract for direct edits. The parent architecture requires fixed generic APIs; separate template, version, form, submission, provider, and reaction resources; canonical YAML/JSON; one immutable JSON file per accepted submission; rebuildable SQLite only; logical approved bindings; and capture before reaction (`refs/issue-90.md:13-22`). Issue #93 requires the data model, lifecycle, time, correction, deletion, import, serialization, and last-known-good rules to be frozen before route or builder work (`refs/issue-93.md:7-31`).

The approved plan already decides that forms pin immutable template versions, submissions snapshot enough schema and option meaning to remain interpretable, direct files use the same validator, and direct submission files are imports rather than receipts (`plan-pkg/plans/user-defined-forms-platform/plan.md:104-126`, `:163-208`, `:227-252`). The independent review makes five findings binding. In this ADR, B2 requires durable file and directory synchronization before a receipt, B4 puts inline stable options in v1, and B5 requires deletion to remove the canonical file and write a content-free tombstone (`plan-pkg/plans/user-defined-forms-platform/review-fable.md:43-55`, `:64-82`). B1 and B3 constrain adjacent security and receipt-access work in ADR #92 but do not change these file schemas.

Current Lookie-Link persistence is a useful atomic-visibility precedent, not a durability implementation. Annotation writes perform an mtime precondition, write a sibling temporary file, and rename it, but do not fsync either the file or its parent directory (`gh-main/lib/annotations.js:243-291`); annotation create also performs an unguarded read/modify/write (`gh-main/lib/annotations.js:294-307`). The grant store similarly uses synchronous temp-write-plus-rename without fsync (`gh-main/lib/grant-store.js:67-81`). `safeResolve()` bounds an existing real path, but on `ENOENT` it falls back to a lexical target and therefore is insufficient by itself for attacker-influenced new-file creation (`gh-main/lib/path-utils.js:27-50`).

Binding decision provenance is explicit:

| Decision recorded here | Prior authority |
|---|---|
| Constrained custom field grammar; no repeatable groups in v1 | `plan-pkg/plans/user-defined-forms-platform/review-fable.md:121-124`; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:183-190` |
| Mounted/configured roots behind an adapter; core has no replication assumption | `refs/issue-93.md:41-45`; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:160-165` |
| Per-file immutable submissions, supersession, delete-with-tombstone | `refs/issue-90.md:13-22` (per-file immutability); `plan-pkg/plans/user-defined-forms-platform/review-fable.md:76-82` and `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:165,190` (supersession and tombstones) |
| Application deletion plus documented verified-purge runbook; tooling deferred, schema seam required | `refs/issue-93.md:37-49`; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:160-165` |
| Direct files are imports; receipt metadata is server-only; attestation is not yet a security boundary | `plan-pkg/plans/user-defined-forms-platform/review-fable.md:121-132`; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:183-195` |
| Inline stable options belong to the Phase 1 contract | `plan-pkg/plans/user-defined-forms-platform/review-fable.md:64-74`; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml:129-138` |

## Decision

### 1. Contract conventions

All canonical documents are objects with a `contractVersion` and `resourceKind`. v1 uses `contractVersion: 1`; readers reject an unsupported version rather than guessing, and every v1 schema rejects unknown fields except the explicitly namespaced tombstone `extensions` map. This generic discriminator anticipates future declarative resource kinds without adding pages to v1, as required by `refs/issue-93.md:33-35`.

**NEW DECISION — contract identifiers.** Definition IDs are 1–64 lowercase ASCII characters matching `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`; submission/import IDs are lowercase canonical UUIDs, generated as UUIDv4 in v1. A narrow portable alphabet prevents path and URL ambiguity, while random UUIDs provide collision resistance without coordinating replicas.

All IDs are opaque and immutable. `ownerId`, `principal.id`, and logical binding IDs use the same definition-ID grammar; IDs never contain a slash, dot segment, colon, URL, shell syntax, or deployment path. Human-facing slugs use the same grammar but are mutable only through an explicit form revision and are unique within an owner namespace.

Time values are RFC 3339 strings. Server times are UTC with millisecond precision and a `Z` suffix; an IANA zone is a canonical name in the deployed tz database, not an abbreviation or raw offset.

### 2. Constrained v1 field grammar

The public contract is a constrained custom grammar, not a JSON Schema subset. This ratifies the review decision: v1 has a small enumerable field set, while exposed JSON Schema composition, remote references, and regex features create unnecessary resource and builder complexity (`plan-pkg/plans/user-defined-forms-platform/review-fable.md:121-124`). A validator may use JSON Schema internally, but that is not public syntax and remote references remain prohibited.

#### Common field definition

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `id` | definition ID | yes | Stable within a template lineage; answer key and binding target. Never reused for a different semantic question. |
| `type` | enum | yes | One of `short-text`, `long-text`, `number`, `checkbox`, `date`, `time`, `datetime`, `select`, `multi-select`. |
| `label` | string, 1–200 chars | yes | Current display label. Submission answer snapshots preserve the label used at capture/import time. |
| `help` | string, 1–1000 chars | no | Plain text only. |
| `required` | boolean | yes | Whether omission is invalid. `false`, `0`, and an empty selected set are not treated as absent except where type constraints say so. |
| `default` | value of the field type | no | Render-time default, validated exactly like submitted data; prohibited for dynamically provided `select`/`multi-select` fields. |
| `component` | registered component ID | no | First-party renderer hint. Unknown components invalidate the definition; no HTML, CSS, script, or event-handler content is accepted. |
| `constraints` | object | no | Only the type-specific keys below; unknown keys are rejected. |
| `options` | option array, 1–1000 items | conditional | Exactly one of `options` or `providerSlot` is required for selection types; prohibited for other types. IDs must be unique, and the deployment may impose a lower limit. |
| `providerSlot` | definition ID | conditional | Logical slot bound by the form to an approved option provider; never a path, URL, query, or command. |

Type-specific values and constraints are:

| Type | Canonical answer value | Allowed `constraints` |
|---|---|---|
| `short-text` | string | `minLength` 0–256, `maxLength` 1–256 |
| `long-text` | string | `minLength` 0–10000, `maxLength` 1–10000 |
| `number` | finite JSON number | `minimum`, `maximum`, `integer` (boolean); NaN and infinities are invalid |
| `checkbox` | boolean | none |
| `date` | `YYYY-MM-DD` string representing a real calendar date | `minimum`, `maximum` in the same format |
| `time` | `HH:MM` or `HH:MM:SS` 24-hour string | none |
| `datetime` | RFC 3339 timestamp containing an explicit offset | `minimum`, `maximum` as RFC 3339 instants |
| `select` | one option ID | none beyond the option source |
| `multi-select` | ordered, duplicate-free option ID array | `minSelections`, `maxSelections` as nonnegative integers |

Length limits count Unicode code points after NFC normalization. Text is preserved as text—apart from NFC normalization, line endings normalized to LF, and rejection of NUL/control characters other than tab/LF—rather than trimmed or interpreted as markup. `required` text must contain at least one non-whitespace code point, and `minimum` may not exceed `maximum`.

**NEW DECISION — v1 grammar details.** v1 deliberately omits user regexes, computed fields, conditional logic, repeatable groups, arbitrary validation expressions, and attachment values. These features either create executable/resource-exhaustion surfaces or are explicitly deferred; session workflows represent repeated entries as separate durable submissions.

#### Inline option

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `id` | definition ID | yes | Stable within its field across template versions and never reused for a different meaning. |
| `label` | string, 1–200 chars | yes | Display label snapshotted into each selected answer. |
| `disabled` | boolean | no | Defaults to `false`; disabled options remain renderable historically but cannot be newly submitted. |

Changing a field or option label does not change its ID. A semantic replacement receives a new ID; removal is permitted only in a new template version and cannot affect historical snapshots.

**NEW DECISION — inline-option bound.** A field has at most 1000 inline options, matching the absolute v1 provider-result ceiling; this bounds validation, rendering, and snapshot work while allowing deployments to set a lower policy limit.

### 3. Resource schemas

#### 3.1 Template draft (`resourceKind: form-template`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `form-template`. |
| `templateId` | definition ID | yes | Stable identity; must match its directory. |
| `ownerId` | definition ID | yes | Authorization namespace, not a filesystem root. |
| `revision` | positive integer | yes | Monotonically increases on every accepted draft mutation; CAS precondition for API/direct activation. |
| `grammarVersion` | integer | yes | Must be `1`. |
| `title` | string, 1–200 chars | yes | Plain-text display title. |
| `description` | string, max 2000 chars | no | Plain text. |
| `tags` | sorted unique definition-ID array, max 32 | no | Discovery metadata; never copied to submission audit logs. |
| `lineage` | object | no | `{ relation, templateId, templateVersion? }`, where `relation` is `clone` or `fork`; IDs only, no source path or owner-private metadata. |
| `presentation` | object | no | Known safe hints only: optional `submitLabel` (1–80 chars) and `component` registry ID. |
| `fields` | field array, 1–200 items | yes | Ordered, unique field IDs using grammar v1. |

Drafts contain no published time, publisher, digest, destination, provider implementation, reaction configuration, route, URL, path, command, model, or prompt.

#### 3.2 Immutable template version (`resourceKind: form-template-version`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `form-template-version`. |
| `templateId`, `ownerId` | definition IDs | yes | Must equal the parent template identity. |
| `templateVersion` | positive integer | yes | Contiguous, monotonically increasing version within a template. |
| `sourceRevision` | positive integer | yes | Draft revision that was published. |
| `grammarVersion` | integer | yes | Must be `1`. |
| `publishedAt` | UTC RFC 3339 timestamp | yes | Publication event time. A direct-file publisher supplies it; it is provenance, not server attestation. |
| `publishedBy` | principal reference or `null` | yes | Server-resolved `{id,type}` for API publication; `null` for direct-file publication. |
| `title`, `description`, `tags`, `lineage`, `presentation`, `fields` | as draft | as draft | Immutable semantic snapshot. |
| `schemaDigest` | digest string | yes | `sha256:` plus 64 lowercase hex characters, recomputed and matched by the registry. |

The schema digest is SHA-256 over compact canonical JSON for exactly `{grammarVersion, fields}`, using the canonical JSON rules in §7. It excludes mutable registry observations and human metadata, so it identifies the validation/answer contract rather than a title change.

#### 3.3 Form instance (`resourceKind: form-instance`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `form-instance`. |
| `formId`, `ownerId` | definition IDs | yes | Stable identity and authorization namespace. |
| `slug` | definition ID | yes | Human route segment, unique within owner. |
| `revision` | positive integer | yes | Monotonic CAS revision. |
| `state` | enum | yes | `draft`, `active`, `paused`, or `archived`; only `active` accepts ordinary submissions. |
| `template` | object | yes | `{ templateId, templateVersion, schemaDigest }`, all matching an active immutable version. |
| `destinationId` | definition ID | yes | Logical adapter-backed destination alias approved for the owner. |
| `providerBindings` | array | no | Unique entries `{ slotId, providerId, providerRevision }` satisfying template slots. Defaults to `[]`. |
| `reactionBinding` | object | no | `{ bindingId, bindingRevision }` selecting one approved enabled binding. |
| `defaults` | object keyed by field ID | no | Form-specific typed defaults allowed by the pinned schema; cannot introduce unknown fields. |
| `presentation` | object | no | Only overrides explicitly allowed by the registered template component; plain text/known component IDs only. |

Storage roots are deployment properties behind the destination adapter. The same core contract applies whether a self-hosted operator maps aliases to mounted repositories or a service maps them to managed internal storage; definitions and clients cannot observe or select replication, direct visibility, paths, commands, URLs, or adapter credentials (`refs/issue-93.md:41-45`).

`destinationId` approval is deployment configuration owned by the storage adapter, not a v1 contract resource or a file that template authors can create. This ADR intentionally defines no destination-registry schema; an implementation must not infer one. Option providers and reaction bindings remain explicit contract resources because their revisions are pinned by forms.

#### 3.4 Option provider (`resourceKind: option-provider`)

This is a general approved READ SOURCE interface whose v1 form projection returns bounded options; it is named generically so later page sections can reuse the interface without expanding v1 scope.

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `option-provider`. |
| `providerId`, `ownerId` | definition IDs | yes | Stable identity and authorization namespace. |
| `revision` | positive integer | yes | Monotonic CAS revision pinned by forms. |
| `state` | enum | yes | `enabled` or `disabled`. |
| `readSourceId` | definition ID | yes | Logical operator-approved source adapter alias. |
| `parameters` | object | no | Only keys and JSON scalar/array values declared by that adapter's bounded parameter schema; defaults to `{}`. |
| `maxOptions` | integer 1–1000 | yes | Hard result bound, also capped by deployment policy. |

The provider result is an ordered array of `{id, label, catalogRevision?}` where `id` follows the option-ID grammar, `label` is 1–200 characters, and optional `catalogRevision` is an opaque string up to 128 characters. The provider registry—not a template—owns paths, queries, URLs, credentials, and code; unknown `readSourceId` or parameter keys invalidate activation.

#### 3.5 Reaction binding (`resourceKind: reaction-binding`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `reaction-binding`. |
| `bindingId`, `ownerId` | definition IDs | yes | Stable identity and authorization namespace. |
| `revision` | positive integer | yes | Monotonic CAS revision pinned by a form. |
| `state` | enum | yes | `enabled` or `disabled`. |
| `event` | literal | yes | `submission.accepted`. |
| `dispatcherId` | definition ID | yes | Logical operator-approved dispatcher alias. |
| `includeFieldIds` | unique definition-ID array | no | Optional least-data projection; every ID must exist in the pinned template. Omission means the operator-configured dispatcher policy decides. |

The binding contains no endpoint URL, command, prompt, model, credential, headers, or executable transform. Reaction dispatch begins only after the canonical submission file is durably committed; reaction failure cannot change the receipt or submission.

#### 3.6 Server-attested submission (`resourceKind: form-submission`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `form-submission`; only the server submission service may create it. |
| `submissionId` | UUID | yes | Collision-resistant immutable record ID; must match the filename identity. |
| `form` | object | yes | `{ formId, formRevision }` captured at validation time. |
| `template` | object | yes | `{ templateId, templateVersion, schemaDigest }` captured from the form pin. |
| `destinationId` | definition ID | yes | Resolved logical destination alias, not a path. |
| `principal` | object | yes | Server-resolved `{id,type}`; request-supplied values are rejected. |
| `receivedAt` | UTC RFC 3339 timestamp | yes | Trusted server clock after validation and before durable commit; never client supplied. |
| `capture` | object | yes | Server-derived `{ transport, originCheck, csrfCheck }`; see below. No origin URL or token is retained. |
| `eventTime` | object | no | `{ occurredAt, timeZone, clientUtcOffsetMinutes }` as defined below. |
| `answers` | answer snapshot array | yes | One entry per submitted schema field, ordered by template field order. Unknown/duplicate field IDs are rejected. |
| `supersedesRecord` | object | no | Discriminated direct predecessor `{ resourceKind, id }`, where `resourceKind` is `form-submission` or `form-submission-import`; see §6. |
| `idempotencyKeyDigest` | digest string | no | Server-computed scoped digest; raw key is never stored. |
| `requestDigest` | digest string | no | Server-computed digest of normalized submission intent, present when idempotency is used. |
| `attestation` | object | yes | `{ kind: "server", version: 1 }`; provenance only until receipts are cryptographically signed. |

`eventTime.occurredAt` is an RFC 3339 timestamp with an explicit numeric offset, `timeZone` is an IANA zone, and `clientUtcOffsetMinutes` is an integer from -840 through 840 that must equal the offset in `occurredAt` for that instant and zone. The whole object is optional; partial objects, timezone abbreviations, impossible local times, and offset/zone disagreements are rejected. `receivedAt` remains the only trusted receipt time.

`capture.transport` is `browser-form` or `json-api`; `originCheck` and `csrfCheck` are each `passed` or `not-applicable`, with combinations enforced by ADR #92. These values attest only which server checks ran, not the request's origin value, and clients cannot supply them.

Each answer snapshot is:

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `fieldId` | definition ID | yes | Stable template field ID. |
| `fieldType` | field-type enum | yes | Type at capture time. |
| `fieldLabel` | string | yes | Label at capture time. |
| `value` | canonical typed value | yes | Validated by the pinned template. |
| `selectedOptions` | array | selection types only | Exactly the selected IDs, each as `{ optionId, optionLabel, providerId?, providerRevision?, catalogRevision? }`. |

`selectedOptions` makes old submissions understandable after labels or dynamic catalogs change. For `select`, it has exactly one entry and `value` equals that option ID; for `multi-select`, its IDs equal `value` in the same order without duplicates. Provider metadata is included only for provider-backed choices and is identifier/revision metadata, never provider configuration.

Client submission bodies contain only `formRevision`, optional `eventTime`, an `answers` object mapping field IDs to raw typed values, and optional `supersedesRecord`; native HTML field names map into that same object before validation. Any client-supplied `submissionId`, template/destination reference, labels, option snapshots, `receivedAt`, `principal`, capture posture, attestation, idempotency digest, request digest, or schema digest is rejected rather than ignored; the server constructs the ordered canonical answer snapshots and all receipt metadata from active pinned resources.

In single-operator mode, `attestation.kind: server` is provenance bookkeeping because a direct filesystem writer can forge JSON. Before a second real user principal is enabled, receipt attestation must become MACed or signed, as directed by the operator decision recorded in the plan sidecar.

##### Receipt response (not a separate canonical resource)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `submissionId` | UUID | yes | Accepted canonical record ID. |
| `form` | object | yes | `{ formId, formRevision }`. |
| `template` | object | yes | `{ templateId, templateVersion, schemaDigest }`. |
| `receivedAt` | UTC RFC 3339 timestamp | yes | Same trusted value stored in the submission. |
| `storage` | object | yes | `{ status: "durable", destinationId }`; emitted only after §7's fsync boundary. |
| `attestation` | object | yes | Same provenance version as the canonical submission; signed/MAC fields are a future compatible contract version. |

An idempotent replay returns this original response byte-for-byte apart from transport headers. An import never produces this response; import APIs/views return an explicitly non-attested import descriptor.

#### 3.7 Direct-file submission import (`resourceKind: form-submission-import`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `form-submission-import`; a direct file using `form-submission` is rejected. |
| `importId` | UUID | yes | Stable immutable import identity; must match filename identity. |
| `form` | object | yes | `{ formId, formRevision }` naming a known revision. |
| `template` | object | yes | `{ templateId, templateVersion }` matching that form revision; no supplied digest. |
| `destinationId` | definition ID | yes | Approved logical alias matching the form revision. |
| `eventTime` | object | no | Same untrusted event-time structure as a submission. |
| `answers` | answer snapshot array | yes | Typed values plus author-supplied field/option label snapshots, validated against the named immutable template. |
| `supersedesRecord` | object | no | `{ resourceKind, id }`, where `resourceKind` is `form-submission` or `form-submission-import`; a new import expresses correction without rewriting either record. |

An import must not contain `submissionId`, `receivedAt`, `principal`, `capture`, `attestation`, `idempotencyKeyDigest`, `requestDigest`, or `schemaDigest`. The registry may record `observedAt`, validation outcome, and a computed digest in a rebuildable private index, but these observations are not canonical receipt fields and the API must label the record `import`, never `received` or `server-attested`.

**NEW DECISION — import immutability.** The first valid activation of an `importId` fixes its canonical byte digest; later content changes under the same ID are quarantined as integrity violations, and corrections use a new import. This gives direct imports the same no-silent-rewrite history property as accepted submissions without pretending the server witnessed their creation.

#### 3.8 Submission tombstone (`resourceKind: submission-tombstone`)

| Field | Type | Required | Semantics |
|---|---|---:|---|
| `contractVersion` | integer | yes | Must be `1`. |
| `resourceKind` | literal | yes | `submission-tombstone`. |
| `recordKind` | enum | yes | `form-submission` or `form-submission-import`. |
| `recordId` | UUID | yes | ID of the removed record. |
| `formId`, `ownerId`, `destinationId` | definition IDs | yes | Minimal routing and authorization metadata; no title or label. |
| `deletedAt` | UTC RFC 3339 timestamp | yes | Application deletion time. |
| `deletedBy` | principal reference | yes | Authorized principal or retention-service identity. |
| `canonicalRemoval` | object | yes | `{ status, completedAt? }`, where status is `pending` or `removed`; `removed` only after unlink and parent-directory fsync. |
| `idempotencyKeyDigest` | digest string | no | Retained only to prevent a deleted request key from recreating data. |
| `purge` | object | yes | `{ status, requestedAt?, verifiedAt?, verifiedBy? }`, where status is `unrequested`, `requested`, or `verified`. |
| `extensions` | map | no | Namespaced forward-compatible extension envelopes as described below. |

A tombstone is content-free: it contains no answers, event time, field/option labels, request digest, title, notes, free-text reason, source bytes, or receipt token.

**NEW DECISION — tombstone extension envelope.** This ADR interprets issue #93's “unknown-but-versioned tombstone fields” seam as one explicit `extensions` map rather than accepting arbitrary unknown top-level fields. Each key must be a reverse-DNS namespace and its value must be `{ version: positive integer, data: object }`; unknown namespaces are preserved and ignored by v1 readers, while unknown top-level fields are rejected. This preserves forward data without making field ownership or versioning ambiguous (`refs/issue-93.md:47-49`).

Tombstone state is monotonic: `canonicalRemoval` permits only `pending` → `removed`, and `purge` permits only `unrequested` → `requested` → `verified`. `completedAt`, `requestedAt`, and `verifiedAt`/`verifiedBy` are respectively required exactly when their states have reached `removed`, `requested`, and `verified`; prior timestamps are retained on later transitions. Every update preserves unknown extension envelopes and all unrelated fields.

### 4. Lifecycle, pinning, and migrations

1. **Draft.** Create a new template draft at `revision: 1`; each accepted edit uses an expected revision/content digest and increments exactly once. mtime alone is not a semantic precondition.
2. **Publish.** Validate and canonicalize a draft, compute `schemaDigest`, and exclusively create the next contiguous immutable version. API publication supplies server time/principal; direct-file publication supplies `publishedAt` and `publishedBy: null` and is recorded as direct provenance.
3. **Clone.** Copy an owned draft or published version to a new template ID and draft revision 1 under the same owner, retaining field/option IDs and adding `lineage.relation: clone`; do not copy versions, forms, bindings, submissions, or private provider configuration.
4. **Fork.** Copy an authorized published version into a new owner/template ID and draft revision 1 with `lineage.relation: fork`; copy only the public-safe declarative definition, never owner identifiers, destination/provider/reaction bindings, or data.
5. **Instantiate.** Create a form revision 1 from one published template version. Draft templates cannot be instantiated, and the form stores the template version and matching digest.
6. **Upgrade.** Explicitly CAS-update a form to a higher published version of the same template, after revalidating defaults, provider slots, field projections, and presentation overrides. No template publication silently changes a form; no upgrade rewrites a historical submission/import.
7. **Pause/archive.** A paused form retains its pin but refuses ordinary capture; archived forms are read-only and cannot be reactivated in v1. Cloning is the recovery path.

**NEW DECISION — direct publication and rollback.** A newly discovered valid version file may publish directly only when that version number has never been observed and all lower versions exist; after first activation, any byte/semantic change is rejected and the last-known-good immutable version remains active. v1 form upgrades are forward-only, preventing a route called “upgrade” from silently acting as rollback; an operator who needs old behavior instantiates a new form pinned to the older version.

**NEW DECISION — archive terminality.** `archived` is terminal in v1. Recovery creates a new form by cloning rather than reactivating the archived identity, keeping lifecycle history monotonic.

Field and option IDs are stable inside a lineage. A new template version may add, remove, relabel, or change constraints, but it may not change an existing field's type or reuse an ID for a new meaning; such a redesign uses a new field ID. These rules make version diffs and historical snapshots mechanically understandable.

`contractVersion` versions the resource envelope; `grammarVersion` versions field semantics; `templateVersion` versions one template's immutable content; `revision` versions a mutable definition; and `schemaDigest` identifies the exact field grammar instance. They are not interchangeable.

Readers support every contract/grammar version that active pinned records require. A migration is a pure, versioned read adapter from an older envelope to the current in-memory model; it never rewrites an immutable template version, submission, or import in place. Removing a reader is prohibited while any canonical form or record references it; incompatible future envelopes use a new major `contractVersion` and do not activate in v1.

### 5. Idempotency

The JSON and browser submission services accept an `Idempotency-Key` containing 1–128 visible ASCII characters, with at least 16 characters recommended. The raw key is never logged or stored. The canonical digest is `sha256:` plus SHA-256 of the UTF-8 sequence `principal.id`, NUL, `formId`, NUL, and the raw key; therefore the same text is scoped independently by principal and form.

The normalized request digest covers `formRevision`, `eventTime`, `answers`, and `supersedesRecord` using compact canonical JSON. A replay with the same scoped key and the same request digest returns the original receipt and creates no record or reaction; the same key with a different digest returns a conflict and creates nothing. Concurrent attempts serialize on the digest so at most one exclusive canonical record wins.

**NEW DECISION — idempotency lifetime and deletion behavior.** Idempotency has no time-based expiry while the canonical record or its tombstone exists; a replay after application deletion returns `410 Gone` and cannot recreate the record. Consequently the projection grows with retained tombstones, and reusing an old key for unrelated intent can permanently produce a conflict or `410`; deployments must budget/index this unbounded-by-time state and clients should generate a fresh key per intent. Before accepting submissions after restart, the service must rebuild the idempotency projection or perform a canonical-file/tombstone fallback lookup on every miss, closing the review's crash/rebuild duplicate window.

### 6. Correction, supersession, retention, and deletion

#### Correction and supersession

An accepted record is never edited. Both record kinds use the same discriminated `supersedesRecord: { resourceKind, id }` reference, and either a server submission or an import may supersede either kind. The predecessor must exist, be authorized, not deleted, and belong to the same owner, form, and destination; a correction may use a later form/template revision but is fully revalidated and snapshots its own interpretation. The predecessor remains independently readable until deletion or retention applies.

The submission service rejects correction of an already-superseded active leaf, so an idempotent retry of the winning service correction remains valid. Direct imports arrive outside that serialization boundary, so every activation/rescan also builds the supersession graph and detects multiple nondeleted children of one predecessor before computing current leaves. A server-attested child takes precedence over competing direct imports, which are quarantined with an integrity diagnostic. If two or more imports compete and no server-attested child exists, all competing imports and their descendants are quarantined and ignored as supersession links, leaving the predecessor as the active current leaf; no scan-order or lexicographic winner is chosen. Multiple server-attested children are an integrity failure and make the chain unavailable rather than selecting a winner.

An operator resolves a direct-import fork by moving every unintended competing file to the adapter's quarantine area, recording the affected kind/ID and byte digest in the redacted repair audit, and rescanning. Exactly one remaining valid import may then activate as the successor. Quarantine is outside the canonical roots and is not deletion or a receipt; moving a file back repeats full validation and fork detection. Thus every available chain has one current leaf, while an unresolved server/server integrity failure has none and fails closed.

Snapshots mean every chain member is interpreted with its own form revision, template version/digest, labels, options, and time context. Projections may show the current leaf by default but must offer authorized history and never mutate the old file to add a reverse link.

#### Retention

The default retention policy is indefinite until an explicit application deletion. A deployment may assign a bounded retention policy to an approved `destinationId`; expiry invokes the same application-deletion transaction under a named retention-service principal and emits the same redacted audit event. Retention is configuration, never author-supplied template/form content, and it does not imply verified purge.

Server receipts are responses/projections of canonical submissions, not a second canonical receipt file. On deletion, receipt tokens are revoked, cached receipt bodies and field-bearing index rows are removed, and later receipt access returns a content-free `410 Gone` derived from the tombstone. Redacted audit events and the content-free tombstone remain.

#### Operation 1: application deletion

Application deletion is the only delete operation exposed by the v1 forms API. It provides this guarantee: the selected canonical submission/import file has been durably unlinked from the adapter's primary storage, the application will no longer return its content, a content-free tombstone prevents resurrection, and current application indexes/receipt caches no longer expose its content. It does **not** guarantee that old bytes are absent from filesystem versioning, sync peers, storage snapshots, backups, logs created outside this contract, or downstream reaction consumers.

The durable transaction is:

1. Authorize and audit a deletion intent without values/titles.
2. Exclusively create and fsync a `canonicalRemoval: pending` tombstone, then fsync its parent directory. From this point the tombstone wins all reads and indexes even if the old canonical file is still present.
3. Durably unlink the canonical file and fsync its parent directory.
4. Remove content-bearing rebuildable index, outbox payload, and receipt-cache rows; any lagging reader must still consult tombstone state before returning content.
5. Atomically overwrite the existing tombstone through §7's tombstone-status-update path with `canonicalRemoval: removed` and `completedAt`, fsyncing the replacement file and directory, then return success.

After a crash, recovery completes any pending tombstone transaction. A tombstone plus old file is never served and the old file is removed/quarantined; a missing file plus pending tombstone is finalized. A missing canonical file with no tombstone is an unexplained gap: rebuilds tolerate it, suppress stale index content, raise a diagnostic, and never invent a deletion audit trail.

Tombstones dominate late or replicated copies with the same record ID, including direct-file imports. Reappearing content is quarantined and never reindexed. A deletion that bypasses the application by editing the filesystem has no claimed application-deletion guarantee until the API/operator repair process creates and durably completes a tombstone.

**CROSS-ADR REQUIREMENT — deletion authority.** This ADR defines the deletion transaction and requires a deletion-specific authorization decision, but ADR #92 owns and must ratify the capability grammar. The proposed capability for #92 is `forms.delete_submissions`, distinct from `forms.manage`, `forms.submit`, and `forms.read_submissions`; until #92 ratifies that name and implication rules, implementations must not add it independently or infer deletion from an existing capability. Application deletion may be performed only by the deletion authority ratified in #92 or by a configured retention-service principal, while verified purge is restricted to the deployment's designated purge operator.

The append-only audit projection records `deletion.requested`, `deletion.completed`, `deletion.failed`, `purge.requested`, and `purge.verified` as applicable. Each event contains only event ID, record kind/ID, form/template IDs and version, destination ID, acting principal ID/type, outcome class, event time, and tombstone digest/status—never answers, labels, title, notes, event time from the submission, deletion reason, receipt token, or storage path. Audit failure prevents starting a new deletion; a failure after the durable pending tombstone is itself recovered/audited before completion, and audit records are included in backup/purge policy without becoming a source of deleted content.

#### Operation 2: verified purging

Verified purging is a separate operator-driven procedure, not a v1 API claim or automated v1 feature. It provides this stronger but bounded guarantee: the responsible party has checked and removed retrievable record content from every storage location named in the deployment's purge inventory, then recorded verification in the tombstone. In self-hosted mode that party is the operator; in service-managed mode it is the service, a deployment parameter required by `refs/issue-93.md:41-45`.

The required v1 runbook must, for the selected record ID:

1. Confirm application deletion completed and preserve the content-free tombstone/audit event.
2. Enumerate every primary root, synchronization peer, conflict/archive area, filesystem version directory (including Syncthing `.stversions` where used), rebuildable database, cache, snapshot, and backup covered by deployment policy.
3. Remove or expire the old bytes at each location, verify the record cannot be retrieved from each available peer/version/backup, and account for offline or unavailable copies before claiming success.
4. Include any content-bearing downstream reaction target in scope or explicitly state it is outside the purge guarantee; application capture cannot retract already dispatched external data.
5. Atomically overwrite the tombstone through §7's tombstone-status-update path for each transition from `unrequested` to `requested` and finally `verified`, with responsible principal and timestamps, retaining the tombstone indefinitely by default.

`purge.status: verified` means verification over the documented managed inventory, not a promise of forensic erasure from storage media or an unknown third party. If any listed copy is unavailable or subject to an unexpired immutable backup policy, status remains `requested`; the user must be told the application copy is deleted but verified purge is incomplete. Purge tooling is expressly deferred, while this runbook and tombstone seam are mandatory in v1 (`refs/issue-93.md:37-49`).

### 7. Canonical files and direct-edit activation

#### Layout

The adapter maps logical roots to deployment storage. The core uses only these logical relative layouts:

```text
templates/<ownerId>/<templateId>/draft.yaml
templates/<ownerId>/<templateId>/versions/<templateVersion>.yaml
forms/<ownerId>/<formId>.yaml
option-providers/<ownerId>/<providerId>.yaml
reaction-bindings/<ownerId>/<bindingId>.yaml
submissions/<ownerId>/<formId>/<yyyy>/<mm>/<dd>/<yyyymmddThhmmssmmmZ>-<submissionId>.json
imports/<ownerId>/<formId>/<importId>.json
submission-tombstones/<ownerId>/<formId>/<recordId>.json
```

No contract field supplies any segment other than validated IDs and server-derived date/version components. The adapter resolves and bounds existing parents, rejects symlink ancestors/escapes, and uses exclusive leaf creation; the lexical `ENOENT` fallback in current `safeResolve()` is not sufficient for these writes.

Tombstone dominance is looked up by `(ownerId, formId, recordId)` in the flat tombstone layout, independently of the submission filename's date shard. Readers, rebuilds, and replicated-file ingestion must perform that record-ID check before serving or indexing any submission from any shard, including after loss of a rebuildable index.

#### Canonical serialization

Canonical JSON and YAML represent the same normalized object model: UTF-8 without BOM, Unicode NFC strings, LF line endings, exactly one terminal newline, no non-finite numbers, no negative zero, no duplicate keys, and no omitted required values. Unicode input containing an unpaired surrogate is invalid. Arrays preserve semantic order; set-like arrays (`tags`, ID allowlists) are deduplicated and lexicographically sorted before serialization. Optional absent properties are omitted rather than emitted as `null`, except the required `publishedBy: null` direct-publication marker.

**NEW DECISION — deterministic serializers.** An input number must match the JSON lexical grammar `-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?`; YAML-only spellings such as leading `+`, leading-zero integers, underscores, radix prefixes, `.5`, `1.`, and infinity/NaN tokens are rejected. The normalized numeric domain is finite IEEE 754 binary64. JSON and YAML numeric tokens are converted using round-to-nearest, ties-to-even; their source spelling and integer/float tag are not semantic, so `1`, `1.0`, and `1e0` all normalize to the same value. Integer-constrained fields must have an integral normalized value within `[-9007199254740991, 9007199254740991]`. Canonical JSON number output follows RFC 8785 §3.2.2.3 / ECMAScript `NumberToString`: the shortest decimal that round-trips to the same binary64 value, including its mandated exponent thresholds and lowercase `e`; negative zero and non-finite results are rejected rather than serialized.

Canonical JSON recursively sorts object keys by Unicode code point. Strings are delimited by `"`; quotation mark and reverse solidus become `\"` and `\\`; U+0008, U+0009, U+000A, U+000C, and U+000D use `\b`, `\t`, `\n`, `\f`, and `\r`; every other U+0000–U+001F code point uses a lowercase four-hex-digit `\u00xx` escape. All remaining NFC Unicode scalar values, including non-ASCII and `/`, are emitted unescaped as UTF-8. This pins the string rule rather than relying on an implementation's “standard JSON escaping.” Compact digest JSON has no whitespace except content inside strings and ends with one LF, which is included in the hashed bytes; disk JSON uses two-space indentation and the same terminal LF.

Canonical YAML recursively uses the same normalized numeric values, exact canonical JSON number spellings, key order, and string escaping, with two-space indentation, JSON-style double-quoted strings, lowercase booleans, and no anchors, aliases, tags, merge keys, directives, or multiple documents. Comments and author formatting may be accepted on YAML input but are not semantic and are not preserved by an API rewrite.

YAML parsing is restricted to the JSON-compatible scalar/object/array subset. Parse → normalize → validate → canonical-object is one shared pipeline for API and direct files; therefore semantically identical API JSON and direct YAML produce byte-identical canonical JSON and the same digest. The canonical serializer is generic over `resourceKind`, while each kind supplies its schema and preferred disk format.

#### Atomicity and durability

API replacement of mutable definitions and every update to an existing tombstone's `canonicalRemoval`, `purge`, or `extensions` state uses a sibling temporary file opened exclusively, complete write, file `fsync`, close, atomic overwriting rename, and parent-directory `fsync`; only then is the new revision/state acknowledged. Tombstone updates serialize by record ID and compare the expected canonical source digest immediately before rename, preventing deletion recovery and purge activity from losing each other's fields. New immutable versions, submissions, and imports accepted through a managed import API require an atomic no-replace commit (for example a platform no-replace rename or link/unlink strategy); ordinary overwriting rename is prohibited for those immutable resources.

Only initial tombstone creation uses the exclusive no-replace path: it publishes the `canonicalRemoval: pending` tombstone and fsyncs the parent before canonical unlink begins. Later tombstone status or extension transitions must atomically overwrite that same leaf through the preceding mutable-update path; they must not use no-replace. Newly created directories are bounded against symlinks and their creation is fsynced through the parent chain.

For an accepted server submission, a receipt and reaction event may be exposed only after: validate against the pinned active objects → write complete sibling temporary JSON → fsync its file descriptor → exclusive atomic publish to the final leaf → fsync the final parent directory. If any step fails or the platform adapter cannot provide file-plus-directory durability, capture fails, no receipt claims success, any temporary leaf is best-effort cleaned, and recovery quarantines leftovers. This intentionally hardens rather than copies the present annotation/grant idiom.

Direct filesystem writers receive no server durability promise because they do not use the API helper. Activation begins only after the registry observes a stable complete file and successfully parses, normalizes, validates, and recomputes identity/digests.

#### Last-known-good activation

Each injected registry stores the active canonical object, source-byte digest, semantic digest, revision/version, and diagnostic per logical identity. It combines explicit API invalidation with bounded rescans/directory fingerprints; correctness does not depend on `fs.watch` alone.

- A valid new draft/form/provider/binding with a higher expected revision atomically becomes active.
- A syntactically invalid, schema-invalid, unknown-version, identity/path-mismatched, stale/lower-revision, partially synchronized, or nonstable direct edit records a redacted diagnostic and leaves the last-known-good object active.
- A changed previously activated template version or import is an integrity violation and never replaces the immutable last-known-good object.
- On first startup with no last-known-good object, an invalid resource is unavailable rather than partially activated.
- A small durable runtime cache may preserve the last validated canonical object across restart; it is noncanonical operational state and may be discarded when source files are valid. If both source and cache are unusable, the resource fails closed.
- Direct removal of a mutable definition is not deletion: after a bounded missing-file confirmation it becomes unavailable, while immutable referenced versions remain readable. Lifecycle archive/delete APIs must be used for an audited semantic transition.

Diagnostics contain resource kind, IDs, path relative to the logical root, source digest when available, time, and error code/location; they omit document values and deployment paths. API validation failure and stale writes leave the filesystem and active registry unchanged.

### 8. Normative fixture set

The implementation must check these fixtures into its public schema test directory and validate both YAML and normalized JSON forms. The table is normative: equivalent literal fixtures may add only non-sensitive example data.

| Fixture | Valid? | Contract proven |
|---|---:|---|
| `template-minimal.yaml` | yes | Every core field type, stable inline IDs, provider slot, canonical YAML. |
| `template-version-minimal.yaml` | yes | Immutable envelope and recomputed digest. |
| `form-minimal.yaml` | yes | Exact template pin, destination alias, provider revision, reaction revision. |
| `option-provider-minimal.yaml` | yes | Approved read-source alias and bounded parameters/results. |
| `reaction-binding-minimal.yaml` | yes | Logical dispatcher only. |
| `submission-minimal.json` | yes | Server time, event time/zone/offset, snapshots, attestation. |
| `submission-import-minimal.json` | yes | Import provenance with no server-only receipt metadata. |
| `submission-corrects-import.json` | yes | A discriminated cross-kind predecessor reference. |
| `submission-tombstone-minimal.json` | yes | Content-free application deletion and purge seam. |
| `unknown-field.yaml` | no | Unknown fields rejected. |
| `duplicate-field-id.yaml` | no | Field IDs unique. |
| `option-id-reused.yaml` | no | Duplicate/reused option identity invalid. |
| `selection-two-sources.yaml` | no | Inline and provider source are mutually exclusive. |
| `arbitrary-binding.yaml` | no | URL/path/command instead of logical alias rejected. |
| `forged-receipt.json` | no | Client/direct file cannot claim server submission, principal, receipt time, attestation, idempotency, or schema digest. |
| `event-time-offset-mismatch.json` | no | IANA zone, embedded offset, and client offset must agree. |
| `supersession-bare-id.json` | no | A predecessor UUID without a resource-kind discriminator is rejected. |
| `import-fork-a.json` + `import-fork-b.json` | no (as an active pair) | Two imports targeting one predecessor are detected and quarantined rather than producing an arbitrary leaf. |
| `schema-digest-mismatch.yaml` | no | Recomputed digest controls activation. |
| `mutated-published-version.yaml` | no | Immutable version cannot replace last known good. |
| `tombstone-with-content.json` | no | Tombstone cannot retain values, labels, times, or reasons. |

Representative valid draft YAML:

```yaml
"contractVersion": 1
"fields":
  - "id": "activity"
    "label": "Activity"
    "options":
      - "disabled": false
        "id": "walk"
        "label": "Walk"
      - "disabled": false
        "id": "cycle"
        "label": "Cycle"
    "required": true
    "type": "select"
  - "constraints":
      "maxLength": 10000
    "id": "notes"
    "label": "Notes"
    "required": false
    "type": "long-text"
"grammarVersion": 1
"ownerId": "operator"
"resourceKind": "form-template"
"revision": 1
"tags":
  - "activity"
"templateId": "activity-log"
"title": "Activity log"
```

Representative valid direct import JSON:

```json
{
  "answers": [
    {
      "fieldId": "activity",
      "fieldLabel": "Activity",
      "fieldType": "select",
      "selectedOptions": [
        {
          "optionId": "walk",
          "optionLabel": "Walk"
        }
      ],
      "value": "walk"
    }
  ],
  "contractVersion": 1,
  "destinationId": "personal-records",
  "eventTime": {
    "clientUtcOffsetMinutes": -240,
    "occurredAt": "2026-07-19T08:30:00-04:00",
    "timeZone": "America/New_York"
  },
  "form": {
    "formId": "daily-activity",
    "formRevision": 1
  },
  "importId": "f9f25898-ec23-4f38-a868-1c7b192e2304",
  "resourceKind": "form-submission-import",
  "template": {
    "templateId": "activity-log",
    "templateVersion": 1
  }
}
```

Representative invalid forged receipt (rejected because imports cannot carry server-only fields and direct files cannot claim `form-submission`):

```json
{
  "answers": [],
  "attestation": { "kind": "server", "version": 1 },
  "contractVersion": 1,
  "principal": { "id": "operator", "type": "local-operator" },
  "receivedAt": "2026-07-19T12:30:01.000Z",
  "resourceKind": "form-submission",
  "submissionId": "dc971045-b152-460d-bf10-b1370d631296"
}
```

## Consequences

### Positive

- Historical records remain interpretable without live templates/catalogs because every record pins versions and snapshots field/option meaning.
- File, API, builder, and future CLI clients share one grammar and canonicalizer; direct edits remain portable without becoming a validation bypass.
- Immutable, exclusive per-record files avoid shared-append races and make SQLite disposable.
- File and directory fsync make a successful receipt an honest durability boundary within the configured primary adapter.
- Logical aliases and registries prevent declarative files from selecting code, paths, URLs, or credentials.
- Application deletion is useful immediately while verified purge states its stronger boundary honestly and leaves a forward-compatible automation seam.

### Negative and operational costs

- The custom validator, canonical serializers, safe-create helper, registry cache, tombstone recovery, and fixture matrix are meaningful implementation work before the vertical slice.
- Strict unknown-field rejection and forward-only upgrades require explicit contract-version migrations and can reject otherwise harmless hand edits.
- Snapshotting labels duplicates small amounts of metadata in every record, intentionally trading space for sovereign interpretability.
- Directory fsync and atomic no-replace behavior need adapter/platform tests; an adapter that cannot meet them cannot advertise server-attested durable capture.
- Tombstone creation needs exclusive no-replace support, while every later tombstone state transition needs crash-safe atomic overwrite; adapters must test both primitives.
- Indefinite tombstone-backed idempotency prevents resurrection but grows the lookup projection and makes accidental key reuse permanently conflict or return `410`.
- Application deletion does not erase replicated/versioned/backup bytes, so deployments collecting personal data must maintain and communicate a purge inventory/runbook.
- A content-free tombstone and redacted audit trail intentionally outlive deleted content; deployments needing even identifiers erased require a later, separately reviewed policy.

## Alternatives considered

### Expose a restricted JSON Schema subset

Rejected for v1. Composition, references, patterns, and uneven renderer mapping expand attack and compatibility surface without serving the enumerated field set; JSON Schema may remain an internal validator implementation.

### Treat a template as the runnable form

Rejected. Separate instances permit stable reusable versions with owner-specific logical destinations/providers/reactions, and explicit pins prevent publication from mutating live capture.

### Mutate published versions or migrate historical records in place

Rejected. It invalidates pins/digests and makes old receipts depend on current labels/catalogs; read adapters plus immutable snapshots preserve history.

### Store submissions in JSONL or SQLite

Rejected as canonical storage. Shared append/write coordination creates synchronization and crash-conflict risk, while SQLite is useful only as a rebuildable index/outbox.

### Trust direct submission files as receipts

Rejected. Lookie-Link cannot attest their actor, receive time, origin/CSRF posture, idempotency history, or server validation event; they are explicitly imports.

### Temp-write plus rename without fsync

Rejected. It provides atomic visibility but a power loss may still invalidate a receipt; current annotations and grants demonstrate this incomplete idiom.

### Corrections by overwriting and deletion by tombstone only

Rejected. Overwrite destroys evidence and interpretation, while tombstone-only deletion leaves the sensitive canonical bytes in primary storage; corrections supersede and application deletion durably unlinks plus tombstones.

### Claim application deletion also purges every copy

Rejected as misleading. Replication versions, offline peers, backups, snapshots, and downstream systems require a separately inventoried and verified operational procedure.

## Open-question flag list

None. The issue, approved plan, binding review, and recorded operator decisions resolve the v1 operator choices in this ADR; implementation discoveries that would change these contracts require an ADR amendment rather than an implicit assumption.
