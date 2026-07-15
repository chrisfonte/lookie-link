<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/plan.md -->

---
Title: User-Defined Forms Platform Implementation Plan
Owner: Lookie-Link Project
Author: Codex
Created: 2026-07-15
Last Updated: 2026-07-15
Version: 0.3.0
Status: Draft — Review Incorporated (v0.3 reconciliation pass; ready for planning-PR merge decision)
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
- [Open Decisions — Answered by Independent Review](#open-decisions--answered-by-independent-review)
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

Raw HTML currently executes as same-origin trusted content when enabled. CSRF tokens alone cannot hold this boundary — a same-origin script can read a token out of any page it can fetch. The load-bearing control is **origin isolation**: `/raw` responses carry `Content-Security-Policy: sandbox allow-scripts` (opaque origin even on direct navigation), so raw-served documents have no ambient authority against forms routes. Origin/Referer checks are the primary browser-side gate on mutations; CSRF tokens are defense-in-depth; explicit permissions still apply. Merely being served from `/raw` must not confer forms privileges. (Corrected per independent review finding B1; implementation: issue #106, ADR: #92.)

### AD-10: Schema versioning precedes builder UX

The API and file schema are the product foundation. A visual or conversational builder is a client of that contract. Builder convenience must not define storage semantics.

### AD-11: Forms ship as modules, not more monolith code

Mount forms routes from a dedicated route module with injected definition, submission, index, clock, ID, audit, and principal services. Put schema, registry, renderer, and stores under a forms module. Extract atomic-persistence primitives with regression tests instead of growing `server.js` and `lib/renderer.js` or copying their internals. Viewer-shell extraction is **deferred** per review: forms ships a minimal shell first (#131); shared-shell adoption becomes a later issue if still wanted.

## Current-System Constraints

The design must preserve these Lookie-Link characteristics:

- Express and server-rendered HTML, with no required frontend build step.
- Existing `safeResolve()` path-boundary behavior for all filesystem access.
- Existing stale-write protection, and the temp-file-plus-rename pattern as a starting point to **harden, not preserve as-is**: no current write site fsyncs the file or parent directory, so the idiom is atomic but not durable. Submission receipts return only after write → fsync(file) → rename → fsync(parent) completes (review finding B2; issue #107).
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

The same-origin threat (trusted `/raw` scripts) defeats token-only CSRF schemes, because same-origin scripts can fetch a form page and read its token. The policy is therefore layered: (1) origin isolation of `/raw` via CSP sandbox so raw documents carry no ambient authority (issue #106); (2) Origin/Referer validation on all browser mutations as the primary check; (3) CSRF tokens as defense-in-depth. Bearer-authenticated agents use the JSON API and are not authenticated by browser ambient state. Query-string tokens are explicitly refused on all forms mutation routes (they leak through URLs and referrers; issue #111).

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

Raw artifacts may link to a first-party form. They do not receive special form API privileges. The raw-HTML boundary is enforced by origin isolation (CSP sandbox on `/raw`, issue #106) — not by CSRF tokens, which same-origin scripts can harvest — and verified by negative browser tests (#133) before forms mutations ship.

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

### User-defined pages (successor direction)

Operator direction (2026-07-15, [#135](https://github.com/chrisfonte/lookie-link/issues/135)): forms are the first section type of a broader **user-defined pages** platform — versioned declarative page compositions (markdown blocks, embedded forms, provider-bound lists/tables) created through the API or as YAML and rendered first-party, under the same template/version/instance, logical-binding, and capability doctrine. Pages are **not** part of this epic; they become their own post-slice epic. What this plan owes them now is only shape: the #93 contract carries a resource-kind field rather than forms-only naming, #92's capabilities are a resource-kind grammar (`forms.*` now, `pages.*` later), #100's providers are framed as general approved read sources, and the #98-family renderer is a component registry. Design-input notes recording this are on #92 and #93; zero v1 scope is added. An interim hardcoded read-only `/workstreams` page (issues [#136](https://github.com/chrisfonte/lookie-link/issues/136)–[#138](https://github.com/chrisfonte/lookie-link/issues/138), children of #135) ships outside this epic's critical path and is later reimplemented as a built-in page template.

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
3. Mount forms through dedicated route/module seams rather than extending monolith files (viewer-shell extraction deferred per review — forms ships a minimal shell).
4. Add a forms-specific capability/CSRF policy and negative-test harness before exposing mutations.

Exit gate: schema fixtures validate; rejected writes are proven side-effect free; existing tests remain green.

### Phase 1: Minimal vertical slice

1. Implement file-backed template and form registries with direct-edit reload and last-known-good behavior.
2. Implement draft/publish/clone template API and pinned form-instance API.
3. Implement first-party server-rendered forms for the core field set: select, multi-select, number, checkbox, date/time, short text, and textarea/notes. Repeatable groups are **out of v1** per review (open decision 2): sessions (#99) deliver repeated entries as independent submissions, which is also the durability-friendlier shape; revisit after pilot-alpha evidence.
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

### GitHub issue map

| Issue | Scope | Depends on |
|---|---|---|
| [#90](https://github.com/chrisfonte/lookie-link/issues/90) | Parent epic and readiness gate | PR #89 review |
| [#91](https://github.com/chrisfonte/lookie-link/issues/91) | Reconcile deployed development checkout, GitHub, docs, validators, PRs, and issues | None; blocks implementation |
| [#92](https://github.com/chrisfonte/lookie-link/issues/92) | Ownership, permissions, CSRF, and raw-HTML ADR | #91 |
| [#93](https://github.com/chrisfonte/lookie-link/issues/93) | Versioned schemas, files, direct edits, and attestation ADR | #91 |
| [#94](https://github.com/chrisfonte/lookie-link/issues/94) | Tracking umbrella: shared persistence/principal/audit/route-seam children #107–#113 (viewer shell deferred) | #91, #92, #93 |
| [#95](https://github.com/chrisfonte/lookie-link/issues/95) | File-backed template and form registries | #93, #94 |
| [#96](https://github.com/chrisfonte/lookie-link/issues/96) | Template and form lifecycle APIs | #92, #93, #95 |
| [#97](https://github.com/chrisfonte/lookie-link/issues/97) | Immutable submission store, idempotent API, and receipts | #92–#95 |
| [#98](https://github.com/chrisfonte/lookie-link/issues/98) | First-party server-rendered form runner | #94, #96, #97 |
| [#99](https://github.com/chrisfonte/lookie-link/issues/99) | Session and repeatable-entry workflows | #97, #98 |
| [#100](https://github.com/chrisfonte/lookie-link/issues/100) | Dynamic option providers only (catalog/history); inline static options moved to #116 in Phase 1 | #92, #93, #95, #97 |
| [#101](https://github.com/chrisfonte/lookie-link/issues/101) | User template and form builder | #96, #98, #100 |
| [#102](https://github.com/chrisfonte/lookie-link/issues/102) | Durable outbox and operator-controlled reactions | #92, #97 |
| [#103](https://github.com/chrisfonte/lookie-link/issues/103) | Discovery, CLI, OpenAPI, and skill packages | #96, #97, #100 |
| [#104](https://github.com/chrisfonte/lookie-link/issues/104) | Pilot-beta: builder/provider validation (pilot-alpha split to #134, which depends on #99 + #116 only) | #99, #101, #100; optional #102; #134 findings |

**Granular decomposition (2026-07-15).** Per the independent review ([review-fable.md](./review-fable.md)) and operator direction, the implementation issues above were decomposed into PR-sized child issues #105–#134, each with its own explicit test gate; #94–#98 became tracking umbrellas whose bodies carry the child checklists. Standalone additions: [#105](https://github.com/chrisfonte/lookie-link/issues/105) (CI on every PR — the repo previously had none), [#106](https://github.com/chrisfonte/lookie-link/issues/106) (CSP-sandboxed `/raw`, review finding B1), [#111](https://github.com/chrisfonte/lookie-link/issues/111) (query-token deny on mutations), [#116](https://github.com/chrisfonte/lookie-link/issues/116) (inline static options moved from #100 into Phase 1, review finding B4), and [#134](https://github.com/chrisfonte/lookie-link/issues/134) (pilot-alpha on the Phase-1 slice, split from #104). Phase-2/3 issues #100–#103 stay whole and are decomposed the same way just before work starts. The machine-readable child map lives in the [package sidecar](./user-defined-forms-platform.yaml).

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
| Raw same-origin artifacts call privileged APIs | Origin isolation of `/raw` via CSP sandbox (load-bearing; #106), Origin checks on mutations, CSRF tokens as defense-in-depth, granular permissions, bearer-only agent mutations, negative browser tests (#133). |
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

## Open Decisions — Answered by Independent Review

All ten were answered with evidence in [review-fable.md](./review-fable.md) §7 (2026-07-15). Answers below are the working decisions; final ratification happens in the ADR issues (#92, #93) during Phase 0. Cross-model review (2026-07-15) concurred and added the purge-boundary refinement to answer 5.

1. **Field grammar:** Constrained custom grammar, hand-validated with fixtures; no exposed JSON Schema subset and no new schema dependency in v1. Ratify in #93.
2. **Repeatable groups:** Not in v1. Sessions (#99) deliver repeated entries as independent submissions. Revisit after pilot-alpha (#134) evidence.
3. **Principal:** Configured stable local principal (`{id, type: "local-operator"}`) stamped server-side; unrestricted mode maps to all capabilities; aligns with the roadmap identity taxonomy so SSO/local accounts map in later without record migration. Ratify in #92.
4. **Definition roots:** Operator-configured mounted roots only in v1, behind a storage-adapter boundary; managed-repo adapter added later, after #91 reconciles that work.
5. **Event model:** One immutable file per submission, corrections as supersession records, plus a first-class delete operation (physical canonical-file removal + content-free tombstone; indexes tolerate missing records). **Honest boundary (cross-model refinement):** application-level deletion removes the canonical record but Syncthing versioning (`.stversions`) and backups may retain old bytes — the #93 ADR must distinguish ordinary application deletion from verified multi-peer/backup purging and document what each guarantees. Ratify in #93 before #97-family readiness.
6. **Audit fields:** IDs (submission/form/template), template version, schema digest, principal ID, outcome class, timestamps, byte counts, destination binding ID. Never field values, notes, or titles. Ratify in #92.
7. **CSRF posture:** Layered — CSP-sandbox origin isolation of `/raw` (load-bearing; #106), Origin/Referer checks on browser mutations (primary), CSRF tokens (defense-in-depth), bearer-only agent mutations, query tokens refused (#111). Token-only schemes cannot hold the same-origin boundary. Ratify in #92.
8. **Shared interfaces from in-flight work:** Extract only from merged main — the temp+rename idiom (hardened per B2), `safeResolve` (extended with safe-create), and the `canAccessPath` seam. Nothing from the unreconciled deployed tree until #91 closes.
9. **Issue decomposition:** Resolved by the 2026-07-15 granular decomposition (#105–#134): #94 and #104 were too broad and were split; ordering otherwise stood.
10. **Direct submission files:** Imports only, explicitly marked, validated on ingest, never presented as receipts. Server-only fields: `receivedAt`, `principal`, `attestation`, idempotency key digest, CSRF/origin posture, computed schema digest. In single-operator mode attestation is provenance bookkeeping, not a security boundary; multi-user needs signed receipts first. Ratify in #93.

## Revision History

- **v0.3.0 (2026-07-15)** — Reconciliation pass after cross-model review (GPT 5.6) found the canonical plan lagging the incorporated issue graph: raw-HTML boundary language corrected to CSP origin isolation as the load-bearing control (B1); temp+rename constraint restated as harden-with-fsync (B2); repeatable groups removed from v1; viewer-shell extraction marked deferred; issue-map rows for #94/#100/#104 updated to post-decomposition scopes; all ten open decisions converted to answered form with ADR ratification pointers; deletion answer gains the application-delete vs verified-purge boundary (Syncthing versioning/backups retain bytes).
- **v0.2.1 (2026-07-15)** — Recorded the user-defined pages successor direction (#135) with ADR design inputs on #92/#93 (resource-kind contracts, capability grammar, providers as read sources, renderer component registry — no v1 scope change), and the approved interim read-only workstreams page (#136–#138).
- **v0.2.0 (2026-07-15)** — Independent Fable review incorporated ([review-fable.md](./review-fable.md)): verdict approve with required changes (B1 raw-origin isolation via CSP sandbox, B2 fsync durability, B3 submit-only receipt access, B4 pilot/static-option resequencing, B5 deletion contract in #93). Issue graph decomposed into PR-sized, individually tested children #105–#134 at operator direction.
- **v0.1.0 (2026-07-15)** — Initial draft from the operator co-design session, current source/test audit, existing forms brainstorm, commercialization roadmap, and open GitHub work. Establishes file-native/API-first architecture, user-owned templates, first-party rendering, immutable per-submission records, capability/CSRF boundaries, phased delivery, and verification gates.
