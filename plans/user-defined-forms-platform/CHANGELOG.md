<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/CHANGELOG.md -->

# User-Defined Forms Platform Plan Changelog

## 0.4.0 - 2026-07-19

- Wave-0 execution artifacts added (authored by codex 5.6 workers, adversarially reviewed by Opus reviewers, revisions applied; process per the public headless-fleet orchestration standard):
  - `adr-92-forms-ownership-permissions-draft.md` (rev 2) — ownership, permissions, CSRF, raw-HTML boundary; all review code-claims verified against source; operator decision recorded 2026-07-19: `/raw` sandbox profile is `allow-scripts allow-forms allow-popups`, never `allow-same-origin`; zero open operator questions.
  - `adr-93-versioned-contracts-draft.md` (rev 2) — versioned template/form/submission/direct-file contracts incl. fsync durability (B2) and the full deletion/tombstone/purge contract (B5); rev 2 pins canonical serialization grammar, splits tombstone create/update, adds discriminated supersession with fork detection.
  - `issue-91-reconciliation-plan.md` (rev 2, sanitized copy) — 13-step preservation-first reconciliation; Step 1 (preservation) EXECUTED 2026-07-19: 12 GC-safe keep refs, dual checksum-verified archives, per-stash object verification, throwaway restore reproducing all 44 dirty paths. Private evidence record retained in the operator's system repo.
- Baseline sanitization PR #140 opened and extended (private hostnames, personal paths, internal ticket IDs, private repo/client names — fix-forward; history handling recorded as operator accepted-risk decision).

## 0.3.1 - 2026-07-15

- Recorded six operator decisions from the post-review co-design Q&A (sidecar `operator_decisions_2026_07_15`; full text on the referenced issues): multi-user principal contract from day one (#92); storage roots as deployment properties behind the adapter, SaaS-compatible (#93); purge tooling deferred with a tombstone purge-status seam (#93); webhook as the first dispatcher adapter (#102); documents-are-content/agents-are-principals confirmation clearing #106; workstreams v1 reads todos + plan sidecars (#136).

## 0.3.0 - 2026-07-15

- Reconciliation pass prompted by cross-model review (GPT 5.6), which concurred with the Fable verdict but found the canonical plan text lagging the incorporated issue graph in eight places.
- plan.md: raw-HTML boundary restated with CSP origin isolation as the load-bearing control (CSRF tokens demoted to defense-in-depth); temp+rename constraint restated as harden-with-fsync; repeatable groups removed from v1 (sessions instead); viewer-shell extraction marked deferred in AD-11 and Phase 0; issue-map rows for #94/#100/#104 updated to post-decomposition scopes; open-decisions section converted to answered form with ADR ratification pointers.
- Deletion answer refined (cross-model input): the #93 ADR must distinguish application-level deletion from verified multi-peer/backup purging — Syncthing versioning and backups may retain old bytes after canonical-file removal.
- Sidecar: decisions marked accepted_by_review (AD-9 mechanism corrected), open_decisions replaced by answered_decisions, cross_model_review block added.
- GitHub: #92 acceptance language corrected (origin isolation, not token-based, holds the raw boundary); #93 gains the purge-boundary deliverable; #105 gains the branch-protection requirement.

## 0.2.1 - 2026-07-15

- Recorded the user-defined pages successor direction (#135): forms become the first section type of declarative, API-created pages; ADR design inputs added to #92/#93 (resource-kind contract, capability grammar, providers as read sources, renderer component registry) with no v1 scope change.
- Recorded the approved interim read-only workstreams page (#136 parser, #137 page, #138 config/ACL), outside this epic's critical path.
- Added the `successor_direction` map to the sidecar.

## 0.2.0 - 2026-07-15

- Incorporated the independent Fable review (`review-fable.md`): approve with required changes.
- Blocking findings recorded: B1 raw-origin isolation via CSP sandbox (issue #106), B2 fsync durability (#107), B3 submit-only receipt access (#128), B4 pilot/static-option resequencing (#116, #134), B5 deletion/tombstone contract required in #93 before #97-family readiness.
- Decomposed implementation issues into PR-sized children #105–#134 at operator direction; #94–#98 converted to tracking umbrellas with child checklists; #100 rescoped to dynamic providers; #104 split into pilot-alpha (#134) and pilot-beta.
- Added CI as a prerequisite discipline (#105) — the repo previously had no CI to enforce per-issue test gates.
- Updated the sidecar with review verdict and the machine-readable granular child map.

## 0.1.0 - 2026-07-15

- Created the product-repo plan package.
- Defined file-native/API-first architecture and user-owned template lifecycle.
- Separated templates, forms, submissions, option providers, and reactions.
- Selected immutable per-submission JSON records as proposed canonical capture storage.
- Added current-state findings, security and compatibility gates, phased implementation, and test strategy.
- Added a machine-readable sidecar and independent Fable review brief.
- Added product-baseline reconciliation as a blocking preflight after discovering drift between GitHub and the deployed development checkout.
- Added safe-create, direct-import attestation, stable option identity, time provenance, and modular route/store requirements from independent source review.
- Linked draft plan PR #89, parent epic #90, and dependency-ordered issues #91–#104.
