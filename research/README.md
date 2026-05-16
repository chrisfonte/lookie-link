# Lookie-Link Research

Background research that informs Lookie-Link's design decisions. Lives alongside the code because the trade-offs documented here aren't visible from the source tree — they're the "why we chose A, not B" context that would otherwise be lost.

## Layout

- **`competitors/`** — Adjacent products in the agent-output-publishing and file-viewing space. Each doc is a deep look at one competitor or one comparable open-source project, with a final section that maps the comparison back onto Lookie-Link's roadmap.
- **`commercialization/`** — Options analyses for how (or whether) to layer a hosted commercial service on top of Lookie-Link without compromising the open-source core. Open-core strategy, pricing, build scope, decision frameworks.
- (Future) **`patterns/`** — Cross-cutting design patterns (e.g. agent-facing OpenAPI surfaces, presigned-URL upload flows) that may apply across multiple competitors.
- (Future) **`history/`** — Decisions that were considered and rejected, with the reasoning preserved so we don't re-debate them.

## Conventions

- One topic per file. Filename pattern: `<topic>-<YYYY-MM-DD>.md`.
- Front-matter style: `**Created**`, `**Purpose**`, `**Status**` (Active / Archived / Superseded), `**Source Type**`.
- Every doc ends with a `## Sources` section listing the URLs the analysis was built from.
- Competitor docs end with a "What this means for Lookie-Link" section. Otherwise it's just research with no project anchor.

## Audience

Maintainers and contributors deciding what to build next in Lookie-Link.
