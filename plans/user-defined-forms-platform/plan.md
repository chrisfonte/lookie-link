<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/plan.md -->

---
Title: User-Defined Forms Platform Implementation Plan
Owner: Lookie-Link Project
Author: Codex
Created: 2026-07-15
Last Updated: 2026-07-15
Version: 0.1.0
Status: Draft — Awaiting Independent Review
Summary: Plan a file-native, API-first forms platform in which users and agents define reusable templates, Lookie-Link renders first-party forms, and submissions become durable sovereign records before optional agent reactions run.
Source: Operator co-design conversation dated 2026-07-15; current Lookie-Link source, tests, roadmap research, pull requests, and GitHub issues.
Tags:
  - planning
  - forms
  - templates
  - api
  - file-native
  - security
Document URL: ~/projects/lookie-link/plans/user-defined-forms-platform/plan.md
---

# User-Defined Forms Platform Implementation Plan

## Summary

Build forms as a first-class Lookie-Link subsystem, not as privileged raw HTML and not as generated server code. A user or agent supplies a versioned declarative template; Lookie-Link validates it, renders a first-party browser interface, accepts HTML or JSON submissions through fixed endpoints, stamps and atomically persists each submission, returns a receipt, and only then emits an optional reaction event.

The architectural posture is **file-native, API-first**:

- YAML form templates and form instances are portable, directly editable source files.
- The API is the preferred mutation surface because it can validate, authorize, audit, and prevent stale writes.
- Direct file edits remain supported and pass through the same validator before activation.
- Each submission is an immutable JSON file with a collision-resistant ID; shared JSONL files and synchronized SQLite databases are not canonical storage.
- Any local database is a rebuildable index, queue, or audit projection—not the sole copy of user data.

This package is deliberately a draft. Independent review must close or explicitly defer its open decisions before implementation begins.

## Table of Contents

- [Outcome and Acceptance Contract](#outcome-and-acceptance-contract)
- [Placement Decision](#placement-decision)
- [Architectural Decisions](#architectural-decisions)
- [Current-System Constraints](#current-system-constraints)
- [Domain Model](#domain-model)
- [File and Storage Model](#file-and-storage-model)
- [API and Browser Surface](#api-and-browser-surface)
- [Identity, Authorization, and Safety](#identity-authorization-and-safety)
- [Integration With Existing and Planned Features](#integration-with-existing-and-planned-features)
- [Implementation Phases](#implementation-phases)
- [Testing Strategy](#testing-strategy)
- [Rollout Strategy](#rollout-strategy)
- [Non-Goals](#non-goals)
- [Risks and Mitigations](#risks-and-mitigations)
- [Open Decisions for Independent Review](#open-decisions-for-independent-review)
- [Revision History](#revision-history)

## Outcome and Acceptance Contract

The completed platform must let an authorized user:

1. Create, clone, edit, preview, publish, and version a personal form template through API or direct YAML.
2. Instantiate one or more forms from a pinned template version.
3. Open a mobile-usable first-party Lookie-Link form without trusting artifact-supplied code.
4. Submit dropdowns, multi-selects, numbers, dates/times, checkboxes, short text, and notes.
5. Receive a durable receipt containing submission ID, form ID, schema version, server timestamp, and storage result.
6. Find the same canonical template, form, and submission as files outside Lookie-Link.
7. Optionally trigger later processing without making agent availability a prerequisite for capture.

The platform is not complete until all acceptance gates below pass:

| Gate | Acceptance criterion | Verification |
|---|---|---|
| Contract | Versioned template, form-instance, submission, option-source, and reaction-event schemas are documented and validated. | `npm run validate:forms` |
| Direct-file parity | A valid direct YAML edit becomes visible; an invalid edit is rejected while the last valid version remains active. | `node --test test/forms-registry.test.js` |
| API parity | API-created and file-created definitions serialize to the same canonical format. | `node --test test/forms-api.test.js` |
| Capture durability | Concurrent submissions create unique immutable JSON records with no loss or overwrite. | `node --test test/forms-submissions.test.js` |
| Idempotency | Repeating a request with the same idempotency key returns the original receipt without creating another record. | `node --test test/forms-submissions.test.js` |
| Browser flow | Native HTML POST and JSON API submission produce equivalent validated records; successful HTML POST uses Post/Redirect/Get. | `npm run validate:forms-e2e` |
| Authorization | Unauthorized callers cannot enumerate templates, infer form existence, submit, read records, or change bindings. | `node --test test/forms-access-control.test.js` |
| CSRF | A cross-origin or raw-artifact request without a valid CSRF token is refused and creates no record. | `node --test test/forms-security.test.js` |
| Injection safety | Field values remain data, render escaped, cannot select storage paths, and cannot become executable prompts or commands. | `node --test test/forms-security.test.js` |
| Compatibility | Existing view, asset, raw HTML, edit, annotation, grant, discovery, managed-repo, and publish tests remain green. | `npm test` |
| Recovery | Restarting after a completed write preserves the receipt and permits index/outbox reconstruction. | `node --test test/forms-recovery.test.js` |

At least one negative canary must prove each state-changing route leaves the filesystem unchanged after rejected validation, authorization, CSRF, traversal, oversized-body, and stale-write requests.

## Placement Decision

The plan and implementation belong in the Lookie-Link repository because they change product routes, schemas, rendering, storage adapters, authorization, documentation, CLI/discovery, and tests. A separate planning repository would split design from the code and increase drift.

Deployment-specific form definitions may live in operator-selected private or Git-backed data repositories. Personal submissions do not belong in this public source repository. Operations-system tracking may point here, but it must not become a second implementation plan.

## Architectural Decisions

### AD-1: Stable generic API; no per-form server code generation

Creating a form creates data, not Express routes or JavaScript modules. All templates use fixed route families. This prevents arbitrary-code injection, reload complexity, route collisions, and a migration burden for every user-created form.

### AD-2: Lookie-Link renders the normal human interface

Users and agents provide a declarative definition. Lookie-Link produces accessible HTML using first-party renderer components. Hand-authored HTML remains an advanced artifact type, not the trusted source of form behavior.

### AD-3: File-native, API-first

The canonical representation is portable YAML/JSON. API writes and direct edits converge on the same parser, validator, canonical serializer, authorization checks, and revision rules. Direct edits are never a second behavior path.

### AD-4: Templates and forms are different resources

A template is a reusable recipe. A form instance pins a published template version and binds approved destinations, option providers, presentation settings, and optional reaction policy. Updating a template never silently mutates active forms.

### AD-5: Immutable per-submission records

Each accepted submission becomes one JSON record created with exclusive, atomic semantics. A single append-only JSONL file is convenient but creates multi-writer and Syncthing conflict risk. SQLite may index the records but must be rebuildable.

### AD-6: Server receipt time and user event time are separate

Every submission records an authoritative server receipt timestamp. A form may also collect an editable `occurredAt` value for delayed or corrected entry. The two values must never be conflated.

### AD-7: Record first, react second

Submission success means the canonical record is durable. Agent, webhook, workflow, or clerk reactions run from a durable outbox after capture. Their failure cannot roll back or hide a successful submission.

### AD-8: Logical bindings, not arbitrary paths or commands

Definitions reference operator-approved destination IDs, option-provider IDs, and reaction IDs. They cannot name arbitrary filesystem paths, URLs, shell commands, model names, or executable prompt text.

### AD-9: First-party forms are isolated from raw artifact trust

Raw HTML currently executes as same-origin trusted content when enabled. Form management and submission APIs therefore require explicit permissions and CSRF protection. Merely being served from `/raw` must not confer forms privileges.

### AD-10: Schema versioning precedes builder UX

The API and file schema are the product foundation. A visual or conversational builder is a client of that contract. Builder convenience must not define storage semantics.

### AD-11: Forms ship as modules, not more monolith code

Mount forms routes from a dedicated route module with injected definition, submission, index, clock, ID, audit, and principal services. Put schema, registry, renderer, and stores under a forms module. Extract the smallest reusable viewer-shell and atomic-persistence primitives with regression tests instead of growing `server.js` and `lib/renderer.js` or copying their internals.

## Current-System Constraints

The design must preserve these Lookie-Link characteristics:

- Express and server-rendered HTML, with no required frontend build step.
- Existing `safeResolve()` path-boundary behavior for all filesystem access.
- Existing stale-write protection and temp-file-plus-rename patterns.
- DOMPurify as the final step for sanitized artifact rendering.
- Opt-in editing, annotations, and raw HTML.
- Token/grant path scoping and compatibility with unrestricted single-operator mode.
- Existing thin CLI and generated agent-discovery direction.

Forms also expose gaps that the implementation must address rather than route around:

- Sanitized content forbids `<form>`, while trusted raw HTML may execute scripts on the same origin. Neither is an acceptable general submission contract.
- The current public release does not provide a general human-account/session system. Ownership and principal resolution must have a stable single-operator representation and a forward-compatible authenticated representation.
- Some managed-repo, publish, API-key, discovery, and bundle-metadata capabilities are in active development or open issues. Forms must consume shared interfaces only after those interfaces land; it must not copy their stores or permission checks.
- The current JSON body parser is global. URL-encoded parsing for native browser forms should be route-scoped and size-limited.
- The deployed development checkout and GitHub `main` currently contain materially different capabilities and test counts. Baseline reconciliation is a blocking precondition, not background cleanup.
- `safeResolve()` is designed around existing paths. Creating new submission files requires a hardened safe-create primitive that resolves and bounds the existing parent, rejects symlink escapes, and exclusively creates the new leaf.

## Domain Model

### Template

A user-owned reusable definition containing:

- Stable template ID and owner namespace.
- Draft revision and immutable published versions.
- Title, description, tags, and optional template lineage.
- Ordered field definitions and validation rules.
- Presentation hints that cannot inject arbitrary markup or scripts.
- Compatibility metadata and schema version.

### Template version

An immutable snapshot of a published template. Forms pin this version. A newer version may be offered as an explicit upgrade, never silently applied.

### Form instance

A runnable configuration containing:

- Stable form ID, slug, owner, and lifecycle state.
- Pinned template ID and version.
- Approved destination binding.
- Approved option-provider bindings.
- Optional defaults and presentation overrides permitted by the template.
- Optional approved reaction binding.

### Submission

An immutable accepted record containing:

- Submission ID and optional idempotency key digest.
- Form ID, form revision, template ID, and template version.
- Actor/principal reference when available.
- `receivedAt`, optional `occurredAt`, and timezone/offset context.
- Stable option IDs plus label/catalog snapshots needed to interpret historical dropdown selections.
- Canonical validated values, including notes.
- Attachment references when that later capability is enabled.
- Reaction state reference, never embedded executable instructions.

### Option provider

A named, permission-checked source of dropdown or multi-select choices. Phase 1 supports inline static options. Later providers may read an approved catalog or history projection through a constrained interface. Templates cannot read arbitrary files.

### Reaction binding

An operator-approved mapping from accepted submission events to a named dispatcher. Field values are passed as typed untrusted data. A user-defined template may select an allowed binding but cannot define executable code or broaden its permissions.

## File and Storage Model

### Definitions

Suggested canonical layout under an operator-configured logical definition root:

```text
templates/<owner-id>/<template-id>/
  draft.yaml
  versions/1.yaml
  versions/2.yaml

forms/<owner-id>/<form-id>.yaml
```

Definitions are YAML because they are user/agent authored and benefit from comments and readable diffs. Published versions are immutable. API changes to drafts use revision or mtime preconditions and atomic rename.

### Submissions

Suggested canonical layout under an operator-configured logical submission root:

```text
submissions/<owner-id>/<form-id>/<yyyy>/<mm>/<dd>/
  <timestamp>-<uuid>.json
```

Each record is created once. Corrections create a new correction/supersession record referring to the original; they do not rewrite history silently. Human-readable daily or topical summaries are projections and can be regenerated.

Records created directly on disk are imports. They may be validated and indexed, but they are not equivalent to API-captured receipts because Lookie-Link cannot attest their actor, server receipt time, CSRF posture, or idempotency history.

### Local indexes and queues

SQLite is acceptable for rebuildable indexes, idempotency lookup, audit, or a durable reaction queue located on the Lookie-Link host. It is not the canonical submission store and must not be synchronized as a live database between peers.

New-file creation must use an exclusive safe-create helper, not a lexical join followed by an ordinary write. The helper resolves and bounds the existing parent directory, refuses symlink-ancestor escape, writes a unique temporary leaf, and atomically renames without overwriting an existing submission ID.

### Direct file changes

Correctness must not depend solely on `fs.watch`, which can be unreliable across platforms and synchronized filesystems. The registry should combine explicit API invalidation with mtime/directory-fingerprint checks or bounded rescans. Invalid or partially synchronized definitions remain inactive, produce a visible diagnostic, and do not replace the last known-good version.

## API and Browser Surface

The exact naming remains reviewable, but the semantic resource boundaries should be stable:

```text
GET    /api/form-templates
POST   /api/form-templates
GET    /api/form-templates/:templateId
PATCH  /api/form-templates/:templateId
POST   /api/form-templates/:templateId/validate
POST   /api/form-templates/:templateId/preview
POST   /api/form-templates/:templateId/publish
POST   /api/form-templates/:templateId/clone

GET    /api/forms
POST   /api/forms
GET    /api/forms/:formId
PATCH  /api/forms/:formId
POST   /api/forms/:formId/upgrade-template

GET    /forms/:slug
POST   /forms/:slug/submissions
POST   /api/forms/:formId/submissions
GET    /api/forms/:formId/submissions
GET    /api/form-submissions/:submissionId
```

Browser submission uses route-scoped `application/x-www-form-urlencoded` parsing and Post/Redirect/Get. Programmatic submission uses JSON. Both call the same submission service and produce the same receipt schema.

State-changing definition routes require stale-write protection. Submission routes support an `Idempotency-Key`. Collection reads use cursor pagination and never expose unauthorized existence through counts or errors.

## Identity, Authorization, and Safety

### Capabilities

Forms should extend one central access decision path with granular capabilities rather than build endpoint-local auth:

- `forms.view`
- `forms.manage`
- `forms.submit`
- `forms.read_submissions`
- `forms.manage_bindings`

Unrestricted single-operator mode may map to all capabilities, but stored records still carry a stable configured local principal. Future browser sessions or SSO map into the same principal contract.

### CSRF and same-origin risk

Cookie/session or unrestricted-browser mutations require CSRF tokens and origin checks. Bearer-authenticated agents use the JSON API and are not authenticated by browser ambient state. Query-string tokens should not authorize form-management mutations because they leak through URLs and referrers.

### Validation

Use a versioned, constrained field grammar validated by a mature schema validator. If JSON Schema is used internally, disable remote references and other features that could cause network access or uncontrolled resource consumption. Unknown fields are rejected by default.

### Rendering

Labels, option text, help text, notes, receipts, and historical values are escaped. Presentation hints map to known components and CSS classes. Template content cannot insert script, event handlers, arbitrary CSS, form actions, or raw HTML.

### Audit and privacy

Audit template publication, form lifecycle changes, binding changes, submission acceptance/rejection class, and reaction dispatch. Avoid logging field values by default. Personal or health-related submissions are private by default and are excluded from search, public sharing, and artifact metadata unless explicitly and safely projected.

## Integration With Existing and Planned Features

### Editing and direct files

The generic file editor may edit form YAML for advanced users, but the forms API owns semantic validation and publication. Saving syntactically valid YAML does not automatically publish an invalid form.

### Raw HTML

Raw artifacts may link to a first-party form. They do not receive special form API privileges. Existing same-origin raw-HTML risk should be documented and covered by CSRF/permission tests before forms mutations ship.

### Annotations

Reuse the annotation subsystem's proven atomic sidecar and stale-write patterns by extracting shared persistence helpers where appropriate. Do not encode submissions as annotations; their schemas, retention, authorization, and lifecycle are different.

### Access control, API keys, and grants

Extend the shared principal and capability model. Do not introduce a forms-only token store. This work depends on the access-control foundation represented by GitHub issue #53 and must remain compatible with active API-key/grant work.

### Managed repos and mounted repositories

Use a storage adapter boundary that can target an approved mounted or managed root without depending on the managed-repo HTTP API. Forms must not recreate repo registration, path scoping, audit, sync, or soft-delete logic.

### Publish and public sharing

Form templates may eventually be published or shared as inert definitions. Forms and submissions are never public by default. Sharing a template must not copy private option values, destination bindings, reaction bindings, submission history, or owner identifiers.

### Artifact metadata and agent web

Coordinate with GitHub issues #82 and #83 so form/template metadata is discoverable only when authorized. Submission metadata must not leak through bundle or validation endpoints.

### Configuration UI

GitHub issue #85 may later expose operator-level forms roots, destination bindings, provider registries, and capability summaries. User template building remains separate from operator configuration.

### CLI, OpenAPI, and skill packages

After the API stabilizes, add `lookie forms`/`lookie templates` commands and advertise capability URLs through the existing discovery direction. Do not teach agent runtimes an unstable schema.

### Search

Index templates and forms only within caller scope. Exclude personal submission contents by default. Any opt-in submission search must enforce authorization per result and avoid snippet leakage.

## Implementation Phases

GitHub issues created from this plan are planning-stage until independent review is incorporated. Issue numbers and links are recorded in the package sidecar after creation.

### Preflight: Reconcile the product baseline

1. Preserve and decompose the deployed development checkout's outstanding work.
2. Reconcile it with current GitHub `main` without discarding either side.
3. Resolve superseded annotation pull requests and re-scope/close stale issues based on actual shipped behavior.
4. Restore a green raw-HTML validator or revise its contract to match intentional base/theme/navigation injection.
5. Update stale architecture, test, changelog, and API documentation.
6. Record one authoritative current route/capability matrix for reviewers and implementers.

Exit gate: GitHub, the deployed checkout, docs, issues, and all default validators describe the same baseline. Forms implementation issues remain blocked until this gate closes.

### Phase 0: Contract and shared foundations

1. Approve the architectural decision record, threat model, schemas, storage layout, and compatibility contract.
2. Extract or define shared atomic-file, safe-create, canonical-serialization, revision, principal, audit, and path-binding interfaces without changing existing behavior.
3. Extract a narrow reusable viewer shell and mount forms through dedicated route/module seams rather than extending monolith files.
4. Add a forms-specific capability/CSRF policy and negative-test harness before exposing mutations.

Exit gate: schema fixtures validate; rejected writes are proven side-effect free; existing tests remain green.

### Phase 1: Minimal vertical slice

1. Implement file-backed template and form registries with direct-edit reload and last-known-good behavior.
2. Implement draft/publish/clone template API and pinned form-instance API.
3. Implement first-party server-rendered forms for the core field set: select, multi-select, number, checkbox, date/time, short text, textarea/notes, and repeatable groups if the schema review accepts them for v1.
4. Implement JSON and native HTML submission paths through one service.
5. Persist one immutable JSON file per submission with receipt timestamp, optional event time, IANA timezone and client offset, actor, schema versions/digest, stable option IDs/label snapshots, and idempotency.
6. Add receipt/detail views and private submission list API.

The dogfood fixture is a session-style activity log with repeated entries and notes. Meal and medication-event fixtures validate that the schema is reusable rather than gym-specific; they do not provide medical advice.

Exit gate: an authorized user can create a template, instantiate a form, submit from a mobile browser, inspect the resulting file, restart Lookie-Link, and retrieve the same receipt.

### Phase 2: User builder and reusable ecosystem

1. Add a first-party builder UI that edits the same draft schema as the API.
2. Add explicit template upgrades, lineage/forking, import/export, and “save form as template.”
3. Add approved dynamic option providers for catalogs and history projections.
4. Add CLI, OpenAPI/discovery, and skill-package support.
5. Add safe template sharing/export after privacy stripping is verified.

Exit gate: API-, file-, builder-, and CLI-created templates round-trip to the same canonical representation.

### Phase 3: Durable reactions and richer capture

1. Add a durable outbox and idempotent dispatcher contract.
2. Add operator-approved reaction bindings for named workflows or agents.
3. Add attachment references and bounded upload handling after storage, MIME, quota, and privacy decisions are approved.
4. Evaluate offline/PWA capture only after the online submission contract is stable.

Exit gate: capture succeeds during dispatcher outage, queued reactions resume after restart, and malicious field values cannot alter dispatch instructions or permissions.

### Deferred product extensions

- Community template marketplace and trust/signing model.
- Complex computed fields and cross-form analytics.
- Collaborative simultaneous template editing.
- Anonymous/public form collection.
- Regulated-health compliance claims.
- Arbitrary plugin code supplied by template authors.

## Testing Strategy

### Unit and schema tests

- Meta-schema validation and version migrations.
- Every field type, default, constraint, conditional, and canonical serialization rule.
- Unknown fields, duplicate names, invalid option values, remote references, cycles, oversized schemas, and pathological regex/input rejection.
- Template lineage, immutable published versions, and explicit upgrade behavior.

### Route integration tests

- Unrestricted local operator, scoped bearer token, denied caller, and future principal fixtures.
- JSON and URL-encoded parity.
- CSRF, Origin, content type, body size, idempotency, stale revision, and cursor pagination.
- Permission-filtered listings with no existence leaks.
- Logical binding enforcement and path traversal rejection.

### Filesystem and concurrency tests

- Temp-file/rename cleanup on failure.
- Exclusive creation and duplicate ID handling.
- Concurrent submissions and definition edits.
- Partial or invalid direct file writes preserve last known-good state.
- Simulated synchronization arrival order and restart recovery.
- Rebuildable indexes/outbox from canonical files.
- New-file path safety against traversal and symlink-ancestor escape.
- Directly imported submission records remain distinguishable from server-attested receipts.

### Browser tests

- Mobile and desktop form rendering, labels, keyboard behavior, dropdowns, validation errors, notes, repeated entries, and receipt navigation.
- Post/Redirect/Get prevents accidental resubmission.
- Raw HTML cannot submit through ambient authority without CSRF.
- Stored untrusted values render escaped in forms, receipts, lists, and any metadata surface.

### Backward-compatibility tests

- Existing routes and renderer behavior remain unchanged when forms are disabled.
- Forms feature flags and roots fail closed when misconfigured.
- Existing annotation, editing, raw HTML, grant, discovery, managed-repo, publish, and metadata tests stay in the default suite as those features land.

## Rollout Strategy

1. Land schemas, storage adapters, and negative tests behind a disabled feature flag.
2. Enable only on a trusted development instance with a non-sensitive fixture root.
3. Run the activity-session vertical slice without reactions.
4. Inspect records, receipts, direct-file edits, restarts, and synchronization behavior.
5. Enable a private dogfood form with backups and bounded retention.
6. Add reactions only after capture reliability and auditability are demonstrated.
7. Keep public/anonymous form submission out of the rollout until a separate threat model is approved.

Rollback is feature-flag disablement plus removal of rebuildable indexes. Canonical template and submission files remain readable and exportable without the server.

## Non-Goals

- Generating custom Express routes or server code for each form.
- Treating a saved HTML DOM as the submission record.
- Requiring an agent to be online for successful capture.
- Allowing template authors to choose arbitrary filesystem paths, commands, URLs, models, or prompts.
- Replacing Git, Syncthing, mounted repos, managed repos, or publish artifacts.
- Making personal submissions public or searchable by default.
- Synchronizing a live SQLite database between machines.
- Shipping a drag-and-drop builder before the schema and API stabilize.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Raw same-origin artifacts call privileged APIs | First-party routes, granular permissions, CSRF/origin enforcement, bearer-only agent mutations, negative browser tests. |
| Forms duplicate storage/auth/audit systems | Shared adapters and principal/capability interfaces; explicit dependencies on existing roadmap foundations. |
| Direct edits diverge from API behavior | One parser/validator/serializer; last-known-good activation; canonical round-trip tests. |
| Syncthing conflicts or partial files | One immutable file per submission, atomic rename, bounded rescans, no shared append file or synced live DB. |
| New-file writes escape configured roots | Parent-realpath safe-create primitive, symlink-ancestor tests, exclusive creation, and logical destination bindings. |
| Template upgrades corrupt history | Immutable published versions and pinned form instances; explicit upgrade workflow. |
| Dynamic options leak private history | Named providers, permission checks, bounded outputs, no arbitrary paths, metadata redaction. |
| Agent reactions become an injection channel | Record first, typed untrusted payload, operator-approved bindings, separate durable dispatcher, least privilege. |
| Builder UX becomes a second schema | Builder operates only through the same draft API and canonical format. |
| Future multi-user support requires rewrite | Stable principal/owner fields and capabilities now; single-operator mapping is one provider, not a special schema. |
| Dependency growth conflicts with small-core design | Prefer standard library; justify and pin any schema/CSRF dependency; monitor bundle/runtime and vulnerability impact. |

## Open Decisions for Independent Review

1. Should v1 use a constrained custom field grammar backed by JSON Schema validation, or expose a carefully restricted JSON Schema subset directly?
2. Should repeatable field groups ship in the vertical slice or follow after single-event capture?
3. What is the minimal stable principal representation before browser user accounts exist?
4. Should form-definition roots initially target mounted repos only, or also consume the managed-repo storage adapter when that work stabilizes?
5. Is one-file-per-submission sufficient as the canonical event model, including corrections and deletion/retention, or is an explicit append-only event envelope required?
6. Which audit fields may be stored without leaking sensitive submission values?
7. What CSRF posture is required for unrestricted private-network mode given trusted raw HTML is same-origin?
8. Which parts of the planned managed-repo/publish/API-key work are stable enough to extract as shared interfaces before forms begin?
9. Does the proposed issue sequence isolate independently mergeable changes, or are any slices still too broad?
10. Should directly created submission files be supported only as explicitly marked imports, and what attestation fields must remain server-only?

Independent review should answer these with evidence and should identify missing failure modes rather than merely confirm the plan.

## Revision History

- **v0.1.0 (2026-07-15)** — Initial draft from the operator co-design session, current source/test audit, existing forms brainstorm, commercialization roadmap, and open GitHub work. Establishes file-native/API-first architecture, user-owned templates, first-party rendering, immutable per-submission records, capability/CSRF boundaries, phased delivery, and verification gates.
