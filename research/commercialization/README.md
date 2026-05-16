# Commercialization Research

Options analyses for how (or whether) to layer a hosted commercial service on top of Lookie-Link without compromising the open-source MIT core. Includes open-core strategy, pricing structure, engineering scope estimates, and decision frameworks.

## Scope

This folder is for **options analyses**, not decided strategy. Each doc should:

- Frame the question being explored (e.g. *"could a hosted Lookie-Link SaaS make sense as a complement to the OSS distribution?"*).
- Walk the design space without committing to a single answer up front.
- Close with a recommended decision framework — *under what conditions is each option right* — not a single pre-chosen verdict.
- Be readable as standalone research by someone who is not the original author.

Things that **should not** be in this folder:

- Revenue projections or financial forecasts tied to a specific operator's books.
- Internal pricing details under negotiation with specific customers.
- Anything that would only make sense to someone inside one specific company.

Those belong in private operator-side companion docs, not in this public repo.

## Current docs

- [`lookie-link-public-saas-options-2026-05-16.md`](lookie-link-public-saas-options-2026-05-16.md) — What it would take to run a public hosted version of Lookie-Link as a paid SaaS, keeping the OSS core intact. Engineering scope, auth/multi-tenancy, abuse model, open-core split, pricing positioning vs. `here.now`, and a four-path decision framework.
