<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/CHANGELOG.md -->

# User-Defined Forms Platform Plan Changelog

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
