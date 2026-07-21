<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/review-fable.md -->

---
Title: Fable Independent Review — User-Defined Forms Platform
Owner: Lookie-Link Project
Author: Fable (Claude Fable 5)
Created: 2026-07-15
Last Updated: 2026-07-15
Version: 1.0.0
Status: Complete
Summary: Independent adversarial review of the forms-platform plan (PR #89, issues #90–#104) — verdict, blocking findings, open-decision answers, and issue-graph corrections.
Source: plans/user-defined-forms-platform/review-brief-fable.md; plan package v0.1.0; GitHub main @ 97bfd60; issues #53, #82–#85, #90–#104; research/commercialization evaluation incl. addenda.
Tags:
  - review
  - fable
  - forms
  - architecture
Document URL: ~/projects/lookie-link/plans/user-defined-forms-platform/review-fable.md
---

# Fable Independent Review: User-Defined Forms Platform

## Review basis

- Read in full: `plan.md`, `findings.md`, `user-defined-forms-platform.yaml`, `review-brief-fable.md`, issues #90–#104, issues #53/#82–#85, the commercialization evaluation (all addenda), `server.js`, `lib/` (all six modules), `test/`, `scripts/validate-*`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/AGENT-ACCESS-CONTROL.md`.
- Independently reproduced: clean clone of `main` @ `97bfd60`, `npm ci && npm test` → **12/12 pass**, matching the plan's baseline claim.
- Independently confirmed key findings claims: F-2 (`FORBID_TAGS: ['script','object','embed','form']`, `lib/renderer.js:643-648`), F-6 (only `express.json({limit:'2mb'})`, `server.js:341`; no urlencoded/multipart parser in `package.json`), F-7 (same-origin risk documented at `lib/config.js:357-360`), F-14 (`safeResolve` ENOENT lexical fallback, `lib/path-utils.js:33-42`). The deployed-checkout claims (27 tests, raw-HTML validator failure) were not independently reproducible from this machine and are taken as reported.

## 1. Verdict

**Approve with required changes.** The architecture is correct: AD-1 through AD-11 all survive adversarial scrutiny and are individually grounded in real code evidence. No reframe is needed. Five findings block implementation-readiness of specific issues; none invalidates the design.

## 2. Blocking findings

### B1 — CSRF tokens cannot hold the raw-HTML boundary; origin isolation is required (HIGH)

**Evidence.** `/raw` serves verbatim same-origin HTML with executing scripts (`server.js:1377-1457`); the code itself documents that such a file "could call the /api/save or /api/grants endpoints with the current viewer's token" (`lib/config.js:357-360`). Auth today is never cookie-based (`lib/access-control.js:171-199`) — in unrestricted single-operator mode there is **no credential at all**, so every same-origin request is authorized ambiently.

**Failure sequence.** Operator enables `rawHtmlEnabled`. A malicious or compromised HTML artifact in any mapped repo runs `fetch('/forms/gym-log')`, parses the CSRF token out of the returned form page (same-origin reads are unrestricted), then POSTs a forged submission — or PATCHes a template draft via `/api/form-templates/...` — presenting a valid token. CSRF tokens defend against *cross-origin* attackers; the threat here is a *same-origin scripted* attacker, which tokens cannot stop. The acceptance criteria in #92 ("Raw HTML cannot use ambient browser authority to mutate forms without CSRF") and #98 ("Same-origin raw HTML cannot exercise ambient form authority") are **unachievable as stated**.

**Correction.** #92's ADR must adopt origin isolation for raw content, not just tokens:

1. Serve `/raw` responses with `Content-Security-Policy: sandbox allow-scripts` (add `allow-popups`/`allow-forms` only if artifacts need them — omitting `allow-same-origin` is the point). The sandbox directive gives the document an **opaque origin even on direct navigation**, so its fetches arrive cross-origin without ambient authority and fail the forms routes' Origin check. This preserves interactive artifacts (scripts still run) while removing their API reach.
2. Keep Origin/Referer validation on all form mutations as the primary browser-side check, CSRF tokens as defense-in-depth.
3. Bearer-only for all agent/JSON mutations (already planned).
4. Add a negative test: a `/raw`-served page attempting a form POST must be refused. This test is only meaningful after (1); write it against the CSP-sandboxed behavior.

Note the interaction with #91: the deployed checkout's raw-HTML validator dispute is about *injected* base/theme/navigation behavior. Whatever contract #91 lands on, the CSP sandbox header should become part of it.

### B2 — The durability gate cannot be met by the existing temp+rename idiom: no fsync exists anywhere (HIGH)

**Evidence.** All three current atomic-write sites — `/api/save` (`server.js:924-931`), annotations (`lib/annotations.js:270-277`), grant store (`lib/grant-store.js:67-75`) — write a temp file and rename with **no fsync/fdatasync of the file and no fsync of the parent directory**. That idiom gives atomicity of visibility, not durability.

**Failure sequence.** Submission accepted → temp+rename completes → receipt returned → power loss before the kernel flushes. On ext4/APFS the rename or the file contents may not have reached disk; the record is truncated or absent after reboot, yet the client holds a receipt claiming durable capture. This directly violates AD-7 ("Submission success means the canonical record is durable") and the Recovery acceptance gate.

**Correction.** #94's extracted helpers must define the contract as: write temp → fsync(temp fd) → rename → fsync(parent dir fd) → only then report success. Receipts return only after the full sequence. #97 inherits this via the shared helper. Plan.md's Current-System Constraints ("existing temp-file-plus-rename patterns") should be amended — the existing pattern is a starting point to *harden*, not preserve as-is.

### B3 — Submit-only principals cannot reach the receipt they are redirected to (MEDIUM, contract contradiction)

**Evidence.** #97 acceptance: "Submit-only permission does not grant listing or historical read." #98 scope: successful HTML POST uses Post/Redirect/Get and users navigate to a durable receipt view.

**Failure sequence.** A submit-only browser principal POSTs successfully, gets a 303 to `/form-submissions/<id>` (or equivalent), and receives 403/404 on the very receipt the flow just promised — or, if the receipt route is opened up, submit-only silently becomes read-by-guessing-IDs.

**Correction.** Resolve in #92: either (a) the redirect carries a scoped one-time receipt token authorizing exactly that submission's receipt view, or (b) receipts are readable by the submitting principal only ("read-own-submission" as a distinct implied capability, not `forms.read_submissions`). Specify what the receipt page shows in each case. Add a test fixture for the submit-only browser round trip.

### B4 — The pilot is gated behind the builder UI, contradicting the file-native premise (MEDIUM, sequencing)

**Evidence.** #104 depends on #99, #101, #100. But the whole point of file-native/API-first (AD-3, AD-10) is that the operator can author templates as YAML without a builder — and Phase 1's exit gate already describes the complete pilot loop ("create a template, instantiate a form, submit from a mobile browser, inspect the resulting file, restart, retrieve the same receipt"). As written, real-world validation waits for the largest UI issue (#101) plus the provider framework (#100).

There is also an internal inconsistency: plan.md's domain model says "Phase 1 supports inline static options," but the issue graph places *all* option work — including static — in #100 (Phase 2). A dropdown-heavy gym form cannot ship its vertical slice without static options.

**Correction.**
1. Move inline static options (stable option IDs + label snapshots) into the schema contract (#93) and registries (#95). #100 keeps only dynamic providers (catalog/history) and the provider *interface*.
2. Split #104: **#104a** — pilot on the Phase-1 slice with YAML-authored templates and inline options, depending on #99 only; **#104b** — builder/provider validation after #101/#100. Real usage feedback then reaches the builder's design instead of arriving after it.

### B5 — Deletion/retention cannot remain an open decision past #93 (MEDIUM, privacy)

**Evidence.** Open decision 5 defers correction/deletion/retention semantics. #97 ships the immutable store; #104 puts personal health-adjacent data into it; Syncthing replicates every record to multiple peers; the plan's privacy posture ("private by default") is otherwise strong.

**Failure sequence.** Pilot data accumulates under "immutable, corrections never rewrite history." The operator later needs a record actually gone (mis-entered medication event, data shared in error). Supersession doesn't erase; there is no defined tombstone semantics, no index-rebuild tolerance for missing files, no statement of what Syncthing propagation of a deletion means for peers' rebuildable indexes. Retrofitting deletion onto a store designed as append-only is exactly the expensive-debt class the brief asks about (Q10).

**Correction.** #93 must close this before #97 is marked implementation-ready: define a first-class delete operation = physical removal of the canonical file + a tombstone record (ID, deletion time, actor, no content), with indexes required to tolerate tombstoned/missing records and a stated Syncthing propagation story. Retention bounds (if any) are configuration, not code.

## 3. Non-blocking improvements

- **N1 — Prefer revision/digest preconditions over mtime.** The plan says "revision or mtime preconditions" (plan.md, Definitions). mtime has coarse granularity on some filesystems and Syncthing preserves mtimes, making ABA collisions plausible. The existing `expectedMtimeMs` pattern (`server.js:904-921`) is fine for the editor; registries should use a monotonic revision or content digest.
- **N2 — Fix the annotation-create race while extracting #94.** `createAnnotation` (`lib/annotations.js:294-308`) is read-modify-write with no concurrency guard (unlike `updateAnnotation`); two concurrent creates lose one. This is live proof of AD-5's whole-file-rewrite hazard and should be fixed when the shared helper lands, with the regression test #94 already requires. Note there is currently **no test coverage at all for `lib/annotations.js`** — the closest precedent subsystem is untested, so "existing routes pass unchanged regression tests" in #94 needs tests written first.
- **N3 — No module-singleton registries.** `getConfig()` caches into a module global with no invalidation (`lib/config.js:126-133`). Make "registry state lives in injected store instances, never module-level singletons" an explicit #95 requirement so forms don't inherit restart-to-reload semantics.
- **N4 — Do not copy grant-store's synchronous I/O.** `lib/grant-store.js` uses `readFileSync`/`writeFileSync` inside request handlers, blocking the event loop. The injected-async-store direction in AD-11 is right; state it as a requirement in #94/#95.
- **N5 — Idempotency window on restart.** If the idempotency index is a rebuildable SQLite projection, a replay arriving after crash but before rebuild completes would duplicate. #97 should require rebuild-before-serve or a canonical-file fallback check on idempotency misses.
- **N6 — Name the LAN exposure.** In unrestricted mode any device on the private network can submit and manage forms — no credential exists to steal (`lib/access-control.js`). Acceptable for the personal threat model, but #92's ADR should state it explicitly and consider requiring scoped auth for `forms.manage`/`forms.manage_bindings` even on otherwise-unrestricted instances. There is also no rate limiting anywhere; a size- and rate-bounded submission route is cheap insurance (#97/#98).
- **N7 — Attestation is provenance, not security, in single-operator mode.** Any filesystem writer can forge `attestation: server` in a dropped file; nothing distinguishes it cryptographically. That is fine within the stated threat model, but #93 should record it, and note that a future multi-user mode needs MAC/signed receipts before attestation carries authorization weight.
- **N8 — Audit by ID, not title.** Form/template titles ("Medication log") leak sensitive context into audit streams. #92's redaction contract: audit records carry IDs, outcome classes, principals, timestamps — titles resolve at display time under the reader's own authorization.
- **N9 — Timebox #91.** Its acceptance criteria are good but "reconcile without discarding either side" is unbounded, and it is the single largest schedule risk in the package. Predefine an acceptable fallback outcome: deployed work parked on named branches with an inventory, main green, docs matching main — full re-landing of deployed features can trail the forms preflight.
- **N10 — Query tokens need an explicit deny on forms routes.** The plan prohibits query-string tokens for management mutations; since `?token=` extraction exists today (`lib/access-control.js:171-199`), #96/#97 need an explicit rejection (and a test), not just an omission.

## 4. Decisions accepted as written

- **AD-1** (no per-form server code), **AD-2** (first-party renderer), **AD-3** (file-native/API-first, one validator), **AD-4** (template vs form instance), **AD-6** (receipt time vs event time), **AD-7** (record first, react second), **AD-8** (logical bindings), **AD-10** (schema before builder), **AD-11** (modules, not monolith growth — `createApp` is a single ~1,190-line function; the seam is overdue).
- **AD-5** (one file per submission): affirmed with extra evidence — the annotation-create race (N2) demonstrates today what shared-file writers cost; JSONL would make that a permanent property. The date-sharded layout is fine at personal scale.
- **AD-9** (raw gets no forms privileges): affirmed in intent; B1 corrects the mechanism.
- **Placement in the product repo**: correct, and consistent with the operations-system doctrine so long as the private todo hub remains the coordination pointer (it does). The plan package contains no PII, credentials, private hostnames, or health data.
- **F-1 through F-17**: every findings claim I could check against source held up, including the exact `FORBID_TAGS` list, the global JSON-only parser, and the `safeResolve` ENOENT gap. Notably, F-14's gap is currently *latent* — every existing write path targets pre-existing files or server-derived sidecar paths — so forms would be the **first** caller to exercise the lexical fallback with attacker-influenced segments. The safe-create primitive is genuinely a precondition, not gold-plating.
- **Baseline reconciliation as a blocker (#91)**: correct call. 12 vs 27 tests is not a cosmetic gap.

## 5. Recommended issue-graph changes

| Change | Rationale |
|---|---|
| Split #94 into (a) atomic-replace + safe-create + fsync helpers, (b) principal/audit normalization, (c) route-module seam, (d) viewer-shell extraction | Four independently mergeable, independently revertible changes are bundled; (d) is the riskiest and least necessary — forms can ship a minimal shell and adopt the shared shell later. (a) is the true dependency for #95/#97. |
| Move inline static options from #100 into #93/#95 | Resolves the plan-vs-issue-graph inconsistency (B4); a dropdown form is not viable in the vertical slice without them. |
| Split #104 into pilot-on-slice (#104a, after #99) and builder/provider validation (#104b) | Real-usage feedback should precede the builder, not follow it (B4). |
| #93 gains the deletion/tombstone contract as an explicit deliverable | B5. |
| #92 gains the raw-origin-isolation decision (CSP sandbox) and the receipt-access model | B1, B3. |
| Otherwise: ordering stands | The #91 → ADRs → foundations → slice → ecosystem → reactions sequence is correct, and #102 (outbox) correctly depends only on #97 + #92. |

## 6. Revised architecture

Not required. The proposed architecture is sound; corrections above are contract- and sequencing-level.

## 7. Answers to the open decisions

1. **Field grammar vs JSON Schema subset:** Constrained custom grammar. The codebase has no schema library and validates by hand everywhere (`annotations.js`, `grant-store.js`); v1's field set is small and enumerable. A "restricted JSON Schema subset" invites scope creep, pathological-regex and composition (`anyOf`) surface, poor builder-facing error messages, and a new pinned dependency the plan itself is reluctant to take. Version the grammar (`grammarVersion`), test with valid/invalid fixtures. If a schema engine is ever adopted, it becomes an internal implementation detail, not the public contract.
2. **Repeatable groups in v1:** No. Sessions (#99) already deliver repeated entries as independent submissions, which is also the durability-friendlier shape (each set saved immediately). Repeatable groups inside one record add schema, rendering, and validation complexity to the slice for no pilot requirement. Revisit after #104a evidence.
3. **Minimal principal:** A configured stable local principal — `{ id: <configured, default "operator">, type: "local-operator" }` — stamped server-side on every record, with unrestricted mode mapping to all capabilities. This matches the identity taxonomy the commercialization evaluation already anticipates (operator/user/agent/share-recipient), so a later WorkOS/SSO or local-account provider maps into the same fields without a record migration. Never trust a request-supplied principal (already in #92).
4. **Definition roots:** Operator-configured mounted roots only for v1. The managed-repo surface exists only in the unreconciled deployed tree; coupling to it before #91 lands would violate the plan's own F-11. Keep the storage-adapter boundary so the managed-repo root can be added as a second adapter later.
5. **One-file-per-submission sufficiency:** Yes as the canonical event model — with the deletion/tombstone contract required by B5 and correction-as-supersession as planned. An explicit append-only event envelope adds nothing at this scale that the per-file model plus rebuildable indexes doesn't provide, and reintroduces shared-file writers.
6. **Audit fields:** submission/template/form IDs, template version, schema digest, principal ID, outcome class (accepted / rejected-validation / rejected-authz / rejected-csrf / rejected-idempotency), timestamps, payload byte count, destination binding ID. Never field values, never notes, never titles (N8).
7. **CSRF posture in unrestricted mode:** Origin/Referer checks on all browser mutations + CSP-sandboxed `/raw` (B1) as the load-bearing controls; synchronizer tokens as defense-in-depth; bearer-only for agent mutations; query-string tokens explicitly refused on all forms routes (N10). Without raw-origin isolation, no token scheme achieves the stated acceptance criteria.
8. **Stable interfaces from in-flight work:** From merged `main` only: the temp+rename idiom (hardened per B2), `safeResolve` (extended with safe-create), and the `canAccessPath` seam in `lib/access-control.js`. Extract nothing from the deployed checkout's managed-repo/publish/API-key work until #91 reconciles it; #53/#82–#85 are direction, not dependencies, and forms should define the capability interface it needs and let that epic implement against it.
9. **Issue decomposition:** Ordering is right; #94 and #104 are too broad — split per §5. Everything else is independently mergeable as scoped.
10. **Direct submission files:** Imports only, explicitly marked, validated on ingest, never presented as receipts. Server-only fields: `receivedAt`, `principal`, `attestation`, `idempotencyKeyDigest`, CSRF/origin posture, schema digest as computed. With N7's caveat recorded: in single-operator mode this is provenance bookkeeping, not a security boundary.

## Revision History

- **v1.0.0 (2026-07-15)** — Initial independent review against plan package v0.1.0 and main @ 97bfd60. Verdict: approve with required changes (B1–B5).
