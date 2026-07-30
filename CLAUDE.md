# CLAUDE.md

## What this is

Lookie-Link is a private-network web viewer for configured local directories. It renders documents and media, supports caller-scoped access, and optionally enables editing, annotations, managed repositories, and immutable publishing.

The authoritative route, authorization, configuration, CLI, discovery, and library inventory is [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md). Do not create another endpoint list or document forms, templates, or submissions as implemented.

This repository is public. [`AGENTS.md`](AGENTS.md) defines the public boundary: what belongs here and what must never be added (product strategy, roadmaps, draft decisions, build prompts, private paths). Read it before adding documentation.

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
