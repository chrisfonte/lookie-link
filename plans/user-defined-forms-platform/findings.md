<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/findings.md -->

---
Title: User-Defined Forms Platform Current-State Findings
Owner: Lookie-Link Project
Author: Codex
Created: 2026-07-15
Last Updated: 2026-07-15
Version: 0.1.0
Status: Draft — Awaiting Independent Review
Summary: Evidence from the current Lookie-Link source, tests, documentation, roadmap research, pull requests, and issues that constrains the forms-platform architecture.
Source: Lookie-Link main branch plus active public issues and pull requests inspected 2026-07-15.
Tags:
  - findings
  - architecture
  - forms
Document URL: ~/projects/lookie-link/plans/user-defined-forms-platform/findings.md
---

# User-Defined Forms Platform Current-State Findings

## Summary

Lookie-Link already has most low-level ingredients—safe path resolution, atomic file writes, stale-write detection, scoped access checks, server rendering, annotations, and thin agent CLIs—but it does not have a general forms contract. Treating raw HTML controls or the generic file-save API as that contract would bypass ownership, validation, idempotency, audit, and submission semantics.

## Table of Contents

- [Findings](#findings)
- [Current Route Surface](#current-route-surface)
- [Roadmap Dependencies](#roadmap-dependencies)
- [Baseline Verification](#baseline-verification)
- [Revision History](#revision-history)

## Findings

### F-1: The product repo is the correct planning home

The work changes `server.js`, `lib/`, `public/`, `docs/`, tests, CLI/discovery, access control, and configuration. Keeping the primary plan elsewhere would create an immediate code/plan discovery split. Deployment-specific definitions and captured data remain external.

### F-2: Artifact HTML is not a forms platform

`lib/renderer.js` forbids `<form>` in sanitized content. Opt-in `/raw` HTML deliberately executes trusted same-origin scripts. That mode is valuable for interactive artifacts but is too privileged and too weakly typed to define general data capture. The forms runner must be a first-party route.

### F-3: The annotation UI proves the browser-to-sidecar loop

`public/annotations.js` constructs a native form, submits JSON to a fixed API, and refreshes state. `lib/annotations.js` validates inputs, stamps time, persists a JSON sidecar atomically, and supports stale-write protection. Forms should reuse shared persistence techniques, but submissions should not be modeled as annotations.

### F-4: Existing write safety is reusable but currently duplicated

The generic save endpoint and annotation store each implement temp-file/rename and concurrency logic. Forms would become a third copy unless the implementation extracts a narrow shared atomic-write/revision utility with regression coverage.

### F-5: Current access control is path-oriented, not yet user-owned-resource oriented

`lib/access-control.js` resolves unrestricted or token/grant-scoped callers and checks repo/path access. User-owned templates and private submissions add ownership, resource listing, metadata, and capability questions. A stable principal/capability adapter is needed; forms must not create a separate identity store.

### F-6: Native HTML POST needs a deliberate server boundary

The server globally enables JSON parsing but not URL-encoded bodies. Adding URL-encoded parsing globally would enlarge every route's input surface. The browser form route should install a strict, size-limited parser only for that route and call the same submission service as JSON clients.

### F-7: Same-origin raw HTML makes CSRF a release blocker

Raw HTML is intentionally trusted and same-origin so interactive artifacts work. It can therefore attempt requests to Lookie-Link APIs. Forms management and ambient-browser submission authority need CSRF/origin controls and explicit negative tests before state-changing routes ship.

### F-8: File-native storage aligns with the existing product direction

The publish/managed-repo roadmap treats Lookie-Link as file-backed and uses embedded databases for indexes, queues, or metadata. Forms should preserve the same portability boundary: YAML/JSON canonical data, optional rebuildable SQLite projections.

### F-9: One file per submission fits synchronized filesystems better than JSONL

A single JSONL log makes concurrent append behavior and Syncthing conflicts part of correctness. Immutable UUID-named JSON records avoid most write collisions and make partial-failure recovery inspectable. Summaries and combined logs can be projections.

### F-10: Template versioning is necessary before a builder

User-editable templates will evolve. Without immutable published versions and pinned form instances, historical submissions lose their schema meaning and active forms can change unexpectedly. A builder built first would encode undefined lifecycle behavior into UI.

### F-11: In-flight roadmap work cannot be treated as released foundation

Public issues and active development cover API keys, managed repos, publishing, discovery, bundle metadata, annotation permissions, and an admin page. The forms plan should align with these interfaces while retaining compatibility with current main. It must not copy in-development stores or block on speculative implementation details.

### F-12: Personal submission discovery must default closed

Artifact metadata and search are explicitly recognized as potential existence/content leaks in GitHub issues #82 and #83. Forms add more sensitive records. Templates may be discoverable within scope; submission bodies and snippets must remain excluded unless an authorized, explicit projection is designed.

### F-13: GitHub and the deployed development checkout are not one baseline

The deployed checkout contains substantial managed-repo, publish, API-key, discovery, generated-skill, annotation, and raw-HTML work that is not represented by current GitHub `main`; it is also behind newer commits on `main`. Public pull requests and issues do not fully describe the live capability surface. Reconciliation is a blocking prerequisite for trustworthy forms analysis and implementation.

### F-14: New-file creation needs a stronger path primitive

Existing `safeResolve()` is strongest when the target already exists. Submission capture creates new leaves. A safe-create helper must realpath and bound the existing parent, reject symlink-ancestor escape, and exclusively create/rename the new leaf. Reusing lexical fallback without this hardening would turn user-selected logical destinations into a path-security liability.

### F-15: Directly written records are imports, not trusted receipts

Direct files are appropriate for template authoring and portability. A directly created submission cannot prove the server actor, receipt time, idempotency, validation context, or CSRF check. It may be accepted as a marked import after validation, but must not impersonate an API-captured receipt.

### F-16: Stable option IDs and time provenance preserve history

Dropdown labels and catalogs change. Submission records need stable option IDs plus a label/catalog snapshot. They also need distinct server receipt time, optional event time, IANA timezone, and client offset so delayed entry and daylight-saving transitions remain interpretable.

### F-17: Forms should force modularization, not deepen concentration

Current route and renderer files already carry broad responsibilities. Forms should be mounted through injected route/store modules and a narrow shared viewer-shell extraction. Copying toolbar/theme/breadcrumb and atomic-write logic would create immediate drift; placing the feature inline would make later identity and builder work more expensive.

## Current Route Surface

As of the audit, current main exposes route families for:

- Repository discovery and rendered views.
- Raw assets and opt-in raw HTML.
- Editing, preview, and atomic full-file save.
- Annotation read/create/update.
- Managed grant lifecycle.

The live development direction additionally includes managed repos, publish artifacts, API keys, agent discovery, and search, but those surfaces must pass their own merge/release gates before forms can depend on them.

No general form-template, form-instance, submission, option-provider, receipt, or reaction endpoint exists.

## Roadmap Dependencies

| Existing work | Relationship to forms |
|---|---|
| GitHub #53 — agent-scoped access control | Foundation for central authorization; forms extends capabilities and ownership. |
| GitHub #82 — agent-readable artifact metadata | Future authorized discovery of templates/forms; submission privacy boundary. |
| GitHub #83 — ACL-safe metadata/bundle APIs | Required pattern for preventing template/provider/submission existence leaks. |
| GitHub #84 — permission annotations | Parallel proof that review/write permissions must be distinct and centralized. |
| GitHub #85 — protected configuration page | Future home for operator roots, bindings, provider registry, and status—not user template editing. |
| GitHub #87 — raw iframe anchor behavior | No direct dependency; reinforces that raw HTML has separate viewer concerns. |
| Active annotation pull requests | Browser form and atomic sidecar precedent; forms must not couple to unmerged UI code. |
| Publish/managed-repo roadmap | Storage adapter, audit, identity, discovery, and sync integration points. |

## Baseline Verification

On a clean clone of GitHub `main` dated 2026-07-15:

- `npm ci` completed.
- `npm test` passed 12 of 12 tests.
- `npm audit` reported existing dependency findings. This plan does not silently apply dependency upgrades; implementation issues must record the baseline and justify any new runtime dependency.

On the deployed development checkout during the same audit:

- `npm test` passed 27 of 27 tests.
- `npm run validate:editable` passed.
- `npm run validate:raw-html` failed because the validator still expects verbatim bytes while the newer raw route intentionally injects base, theme, and navigation behavior.

The difference is evidence of baseline drift, not evidence that one side should be discarded.

The plan branch changes documentation only. It must leave the test baseline unchanged.

## Revision History

- **v0.1.0 (2026-07-15)** — Initial current-state findings for independent review.
