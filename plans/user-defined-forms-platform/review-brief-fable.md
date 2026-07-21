<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/review-brief-fable.md -->

---
Title: Fable Review Brief — User-Defined Forms Platform
Owner: Lookie-Link Project
Author: Codex
Created: 2026-07-15
Last Updated: 2026-07-15
Version: 0.1.0
Status: Ready for Review
Summary: Independent analysis brief asking Fable to challenge the Lookie-Link forms-platform plan before implementation.
Source: Operator request dated 2026-07-15.
Tags:
  - review
  - fable
  - forms
  - architecture
Document URL: ~/projects/lookie-link/plans/user-defined-forms-platform/review-brief-fable.md
---

# Fable Review Brief: User-Defined Forms Platform

## Objective

Perform an independent, skeptical architecture and implementation-plan review. Do not implement the feature. Determine whether the plan minimizes long-term technical debt while fitting Lookie-Link's current code and credible roadmap.

## Required materials

1. `plans/user-defined-forms-platform/plan.md`
2. `plans/user-defined-forms-platform/findings.md`
3. `plans/user-defined-forms-platform/user-defined-forms-platform.yaml`
4. Current `server.js`, `lib/`, `public/`, `test/`, `scripts/`, `docs/API.md`, `docs/CONFIGURATION.md`, and `docs/AGENT-ACCESS-CONTROL.md`
5. `research/commercialization/lookie-link-publish-api-cli-public-link-evaluation-2026-06-01.md`, including addenda
6. Current GitHub issues #53 and #82–#85, active annotation pull requests, and any forms-plan issues linked from the package sidecar

Review current GitHub `main` and, when available, the deployed development checkout. They are materially different as of 2026-07-15. Distinguish merged product behavior, deployed-but-unreconciled behavior, active pull requests, and speculative roadmap behavior. Treat baseline reconciliation as a blocker; do not silently choose one side.

## Questions to answer

1. Does the proposed domain split—template, immutable template version, form instance, submission, option provider, reaction binding—have the right boundaries?
2. Is file-native/API-first coherent for Git, Syncthing, direct edits, server writes, and eventual multi-user operation?
3. Is one immutable JSON file per submission the correct canonical store? Identify correction, deletion, retention, scale, and indexing failure modes.
4. Does the plan reuse existing storage/auth/audit primitives without coupling to unstable in-flight work?
5. Are first-party rendering, route-scoped URL-encoded parsing, CSRF, and raw same-origin HTML boundaries sufficient?
6. Could direct-file and API mutation realistically share one validator/serializer and last-known-good activation model across platforms?
7. Which proposed capabilities and principal fields prevent a future identity rewrite, and which prematurely design multi-tenancy?
8. Is the issue decomposition independently mergeable and correctly ordered?
9. Which features should be removed from v1 to reduce risk without damaging the architecture?
10. Which missing tests, migrations, observability, backup, export, or recovery requirements would create expensive debt later?
11. Does the safe-create proposal adequately close new-file traversal and symlink-ancestor risks?
12. Is the distinction between directly imported records and server-attested receipts sufficient and understandable?

## Required review posture

- Prefer concrete counterexamples and failure sequences over general concerns.
- Cite exact files, routes, tests, issue numbers, or plan sections.
- Treat security, privacy, concurrent writes, synchronization, schema evolution, and restart recovery as adversarial surfaces.
- Reject a design choice when evidence warrants it; do not optimize for agreement.
- Do not assume unpublished roadmap code will land unchanged.
- Do not expand the project into a generic no-code application builder unless a requirement demands it.

## Requested output

Return:

1. Verdict: approve, approve with required changes, or reject/reframe.
2. Blocking findings, each with severity, evidence, failure mode, and specific correction.
3. Non-blocking improvements.
4. Decisions accepted as written.
5. Recommended phase/issue reorder, merges, or splits.
6. A compact revised architecture if the proposed one is materially wrong.
7. Explicit answers to every open decision in `plan.md`.

The review will be incorporated into this plan package before any implementation issue is marked ready.

## Revision History

- **v0.1.0 (2026-07-15)** — Initial independent-review brief.
