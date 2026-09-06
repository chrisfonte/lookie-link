# Lookie-Link Public Code Repository

> Single orientation document for all AI assistants and contributors in this repo.
> `CLAUDE.md` is a one-line pointer at this file; do not grow a second orientation doc.

## What this is

Lookie-Link is a private-network web viewer for configured local directories. It renders documents and media, supports caller-scoped access, and optionally enables editing, annotations, managed repositories, and immutable publishing.

The authoritative route, authorization, configuration, CLI, discovery, and library inventory is [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md). Do not create another endpoint list or document forms, templates, or submissions as implemented.

Before building, read the house standards router — the Tier-0 `AGENTS.md` in the maintainer's operations workspace — and its Rules Card. The Boundary below keeps that workspace's paths out of this repository; resolve them from the router itself, and never link public navigation or documentation to them.

## Boundary

This repository is public. Treat every tracked file as publishable.

- Keep runtime source, tests, scripts, examples, license and package metadata,
  generated skill packages, changelog history, and implemented contributor,
  operator, security, configuration, feature, and API documentation here.
- Do not add product strategy, roadmaps, draft decisions, review discussions,
  market or competitor analysis, historical build prompts, private integration
  planning, internal ticket IDs, private paths, deployment facts, credentials,
  or unresolved options.
- When a private decision is implemented, promote only the stable, sanitized
  public contract needed to use, secure, operate, integrate, or contribute to
  the engine. Do not link public navigation to a private repository.
- `docs/CAPABILITIES.md` is the authoritative implemented route, authorization,
  configuration, CLI, discovery, and library inventory.
- Commit messages and branch names must not contain internal ticket IDs (e.g.
  `FON-*`) or internal planning-doc names; reference issues generically or via
  public issue numbers only.

## Standards this project inherits (read before building)

House standards bind this project but live outside it, in the maintainer's operations workspace; the Boundary above keeps their paths out of this repository. Cite them rather than re-deriving rules — the Rules Card in the Tier-0 router resolves each keyword below.

- **Ending a review / is ACCEPT final / another round? / findings vs blockers** → the Rules Card entry of that name, resolving to the Adversarial Review Protocol §46.7. An ACCEPT with zero open findings from one independent non-author reviewer is terminal; only blocking findings withhold release; two-round cap.

## Commands

- `npm test` — Node test suite, including the discovery-to-documentation matrix check
- `npm run validate:raw-html` — raw/transformed HTML regression checks
- `npm run validate:editable` — editor, annotation, and compatibility CLI regression checks
- `npm run check:skill-packages` — verify generated skill packages match `docs/SKILL-SPEC.md`
- `npm start` — start the server from resolved YAML/environment configuration

## Architecture

- `server.js` registers every HTTP route and applies runtime flags, resolved caller access, store availability, safe path resolution, and response behavior.
- `lib/config.js` reads server, repositories, access, managed-repository, publishing, and theme configuration.
- `lib/access-control.js`, `lib/api-key-store.js`, and `lib/grant-store.js` resolve static tokens, managed API keys, and managed grants into the same permission/scope model.
- `lib/managed-repo-store.js`, `lib/managed-repo-search.js`, `lib/publish-store.js`, and `lib/annotations.js` implement the mutable stores and sidecars.
- `lib/agent-discovery.js` derives caller-visible capabilities and endpoint templates from actual registered routes.
- `lib/renderer.js` and `lib/embed-html.js` implement sanitized viewers and the opt-in transformed HTML runtime.
- `bin/lookie.js` is the unified CLI. `bin/lookie-read.js` and `bin/lookie-annotations.js` remain compatibility executables.

## Safety invariants

- Resolve user paths with `safeResolve`; managed and published stores add realpath/symlink checks.
- Treat `write` as the canonical mutation permission; `edit` is only a legacy credential alias.
- Reject query credentials on every mutation. Prefer bearer headers for all agent calls.
- Editing, annotations, and raw HTML are independent opt-in flags and default off.
- `/raw` serves trusted authored HTML verbatim on the application origin. Enable it only where every served HTML file is trusted.
- Never expose repository roots, store paths, credentials, token names, or private publish metadata in browser/API/discovery output.
- Preserve immutable publish revisions and optimistic concurrency guards for source and managed-file writes.

## Verification

Run `npm test` and the documented validators before considering changes done.
Keep generated skill packages synchronized with `docs/SKILL-SPEC.md`.
