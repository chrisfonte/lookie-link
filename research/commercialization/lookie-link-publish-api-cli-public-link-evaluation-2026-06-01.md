# Lookie-Link Publish API, CLI, and Public-Link Model — Evaluation

**Created**: 2026-06-01
**Status**: Active — evaluation with recommendation, pending board confirmation on the phased plan
**Source issue**: [FON-10180](/FON/issues/FON-10180)
**Purpose**: Decide whether Lookie-Link should grow beyond read-only local-repo viewing into a publish/storage API with a CLI and bounded public-link governance — and if so, what the right next step is (research, architecture, or a limited prototype). Connect the decision back to the three prior commercialization analyses and three prior Lookie-Link tickets named in the source issue.

**Companions** (read in this order if cold):
- [`./lookie-link-public-saas-options-2026-05-16.md`](./lookie-link-public-saas-options-2026-05-16.md) — four-path SaaS options analysis (skip / partner / managed instances / multi-tenant SaaS).
- [`./self-hosted-here-now-alternative-2026-05-16.md`](./self-hosted-here-now-alternative-2026-05-16.md) — open-source-`here.now`-alternative positioning. Names the publish primitive, the CLI, the `agent.json` advertisement, and the bounded public-share as the load-bearing v0 feature set.
- [`./lookie-link-as-agent-native-wiki-2026-05-16.md`](./lookie-link-as-agent-native-wiki-2026-05-16.md) — agent-native wiki positioning. Treats the same publish/CLI/public-share items as v0 bricks for a larger wiki play.
- [`../competitors/here-now-vs-lookie-link-2026-05-16.md`](../competitors/here-now-vs-lookie-link-2026-05-16.md) — `here.now` feature comparison; identifies the same five candidate roadmap items.

## TL;DR

**Yes — this belongs in the Lookie-Link roadmap, and the right next step is a limited prototype, not more research or open-ended architecture work.** The strategic analysis was completed across three commercialization docs and a competitor doc in May 2026; all four converge on the same five-item roadmap (publish primitive, CLI, `agent.json` + OpenAPI, read/write token split, bounded public-share). FON-10180 supplies the concrete forcing function that elevates these items from "strategically endorsed" to "ship this": the machine-locality pain point ("research doc existed on one machine but Lookie-Link on another couldn't see it until git sync caught up") is exactly the failure mode a publish API to a single canonical Lookie-Link instance would eliminate.

What is **not** changing:
- Lookie-Link does **not** become a multi-tenant SaaS. The 6–9 month engineering build laid out in Path 4 of the SaaS options doc is still rejected.
- Lookie-Link does **not** replace git as the version control layer. Publish artifacts live in a configured publish area on disk; the underlying tree is still git-trackable if the operator chooses.
- Lookie-Link does **not** become public-by-default. Bounded public-share is opt-in per instance and per artifact, with expiry and optional password — the operator owns the public-internet exposure decision (the Pangolin path of [FON-7058](/FON/issues/FON-7058) handles "how does the instance reach the public internet" separately from "what does the instance expose").

What is **new** in this doc relative to the prior analyses:
1. A concrete sequencing of the five roadmap items into three small, shippable phases (each independently mergeable).
2. A specific resolution of the trust / auth / audit / versioning model questions from FON-10180.
3. The connection back to the three prior tickets ([FON-7057](/FON/issues/FON-7057), [FON-7058](/FON/issues/FON-7058), [FON-3671](/FON/issues/FON-3671)) and an explicit statement of how each one slots in.
4. A proposed set of child issues, scoped so each is mergeable in days not weeks.

## Why the source issue raised this now

The motivating pain in [FON-10180](/FON/issues/FON-10180) is specific and worth repeating:

> a research doc existed on one machine but Lookie-Link on another machine could not see it until repo synchronization caught up
>
> this created friction around local files, git synchronization, and machine locality

This is **not really a publish-API problem on its own** — it is a "where does the canonical Lookie-Link instance live" problem. There are two structurally different solutions, and FON-10180 is implicitly asking about both:

| Solution | Problem it solves | Existing ticket |
|---|---|---|
| **A. Single canonical Lookie-Link instance** that every machine and every agent points at, reachable over the tailnet (or public internet for the public subset) | Eliminates the machine-locality question entirely. There is one Lookie-Link, and it shows what the authoritative repo state is. | [FON-7058](/FON/issues/FON-7058) (public-internet hosting via Pangolin) + a tailnet-internal equivalent |
| **B. Publish API** that lets a local agent push files directly to that canonical instance without waiting for git push + git pull on the receiver machine | Eliminates the git-sync latency for artifacts that the receiver needs immediately, even when they are not yet committed (or never will be). | This issue (FON-10180) |

**(A) without (B)** still helps if every doc is committed and pushed by the time anyone wants to read it; the friction is only the sync window.
**(B) without (A)** is incoherent — there is nowhere to publish to.
**(A) + (B) together** is what FON-10180 actually wants.

The good news: the strategic analysis from May 2026 already endorsed (B) on independent grounds (the `here.now`-alternative positioning, the wiki play, the competitor analysis). FON-10180 supplies the operational reason to do it.

The other motivating example — "for some outputs (for example public-safe research like the Planet Fitness teen summer pass doc), it would be valuable to generate a sendable public link with optional controls" — is the bounded public-share feature that the competitor doc already recommended. Same convergence.

## Answering the six questions from FON-10180

The source issue lays out six explicit questions. Each is answered below with a reference to where the prior analysis grounded the answer.

### 1. Should Lookie-Link support a publish API for file/document creation and update?

**Yes — as a small, well-scoped extension.** The right shape is the one already sketched in the competitor doc's roadmap item 4 and the `here.now`-alternative doc's roadmap item 2: a `POST /api/publish` endpoint that accepts a manifest + files, writes them under a configured publish-area directory (separate from mounted repos) under an unguessable slug, and returns a URL that resolves through the existing render pipeline.

What this is:
- A write surface for **artifacts the operator wants Lookie-Link to own** (not a replacement for writing to git-tracked repos).
- File-backed: the publish area is a directory on disk like any other Lookie-Link mount.
- Atomic: writes use the existing temp-file + rename pattern.
- Concurrency-controlled: an extension of the existing `expectedMtimeMs` / 409 pattern to slug-addressed artifacts.

What it is not:
- A replacement for the existing local-repo mount model. Agents that produce work meant to be committed to a git repo should keep doing that; they push to Lookie-Link's publish area when they want artifact semantics (immutable-ish, slug-addressed, shareable) instead of file-in-a-tree semantics.
- A vendor object store. There is no S3 / R2 / blob-store dependency. Operators who want object storage can mount one as a filesystem; Lookie-Link itself stays file-backed.

### 2. Should that API also drive a CLI for agent workflows?

**Yes.** The CLI is named in both the `here.now`-alternative doc (roadmap item 7) and the wiki doc (roadmap item 7) as load-bearing for distribution in agent-runtime marketplaces. The right shape is a small Node CLI (`lookie publish <files>`, `lookie share <slug>`, `lookie list`) that hits the publish API using a configured bearer token.

The CLI's existence enables three things the bare API does not:
1. **A skill package** that drops into Claude Code / Cursor / Codex marketplaces, parallel to `heredotnow/skill`.
2. **Discovery via `agent.json`** — the CLI can announce itself the same way `nlm` does for `here.now`.
3. **Friction-free agent adoption** — an agent that knows how to run a shell command can publish without learning a custom API.

Scope: thin wrapper over HTTP, no extra magic. Ships in a separate package (`lookie-link-cli` on npm) or as a sidecar binary in the main repo — pick during implementation.

### 3. Should Lookie-Link support public/share links with expiration, visibility, governance?

**Yes — bounded.** The competitor doc named this as roadmap item 3 ("Bounded public-share for a single file") and the `here.now`-alternative doc kept it as a load-bearing v0 feature. The right shape:

- **Per-artifact opt-in**, off by default. The act of sharing is an explicit API call: `POST /api/publish/<slug>/share { expiresAt, password?, allowedReferrers? }`.
- **Unguessable slug** for the public URL (cryptographic random, not predictable from the artifact slug).
- **Mandatory expiry** — no infinite-lifetime public shares. Operator-configurable maximum; default 7 days; never longer than 90.
- **Optional password gate** — argon2id-hashed, stored alongside the share record.
- **Per-instance config flag** — the operator decides whether their Lookie-Link instance accepts share-creation requests at all. Off by default.
- **Audit trail** — every share creation, password attempt (success / failure), and access logged with caller / referrer / timestamp.
- **No payment gating, no fork/remix, no stablecoin** — explicitly out of scope, consistent with the competitor doc's recommendation.

The public-share endpoint does **not** require the Lookie-Link instance to be publicly reachable. Operators who run instances only inside a tailnet still get the share-creation feature; the URL just isn't reachable from outside the tailnet. Operators who want true public reach pair this with [FON-7058](/FON/issues/FON-7058)'s Pangolin path.

### 4. Should Lookie-Link become a storage/control plane for some classes of files instead of relying only on GitHub-backed repos?

**Partially — and with discipline.** Storage class taxonomy:

| Class | Where it should live | Why |
|---|---|---|
| **Source-of-truth code / docs** | Git repo, mounted in Lookie-Link | Version control, code review, branch hygiene, multi-machine sync, blame. None of this is Lookie-Link's job. |
| **Long-lived research artifacts** that belong with a project | Git repo (operations-research / operations-fontastic / etc.), mounted in Lookie-Link | Same as above. The machine-locality problem from FON-10180 is a *Lookie-Link-instance topology problem*, not a "git is the wrong layer" problem. |
| **Transient agent outputs** that need a URL now and don't need to live in git forever | Lookie-Link publish area | This is exactly what the publish API is for. |
| **Reviewable artifacts** that benefit from immutability + slug addressing (a one-time research bundle, a generated report, a screenshot set, a public-safe summary) | Lookie-Link publish area | Same. |
| **Public-share content** for non-tailnet recipients | Lookie-Link publish area + the public-share extension | Same. |
| **Multi-GB binary blobs** | Neither. Use object storage with its own URL. | Lookie-Link's value is rendering + access control, not bulk storage. |

The rule: Lookie-Link owns storage **for artifacts that benefit from being inside Lookie-Link's rendering + access-control surface**. Anything else stays where it already lives.

### 5. How does this interact with the prior assumption that Lookie-Link may not be a public-facing product?

**It does not contradict it.** The prior assumption — preserved in all three commercialization docs — is that Lookie-Link is not a multi-tenant SaaS, does not host data for arbitrary internet users, and does not become a `here.now`-shaped public service.

What this issue proposes is consistent with that:
- The publish API is **for the operator's own agents** (and their grant-tokened delegates), writing into **the operator's own self-hosted instance**.
- The bounded public-share is **the operator choosing, per-artifact, to expose one thing for a limited window**, the same way a homelabber chooses to expose a file from their NAS.
- There is no signup flow, no multi-tenant account model, no Stripe.

The line: Lookie-Link is **operator-controlled software** that can produce public links if its operator wants it to. It is not a **public service** that anyone-with-a-credit-card can use. That distinction is the entire commercialization framework from the May 2026 docs, and FON-10180's proposal sits cleanly inside it.

### 6. What trust, auth, audit, and versioning model is required?

#### Trust

The trust model is unchanged at the perimeter: the tailnet (or operator-configured public endpoint) is still the access boundary. What changes is **per-API-call authorization** for the new write surface.

#### Auth

Three categories of caller, each with a clear authentication path:

1. **Human operator** — existing browser session; can mint and revoke tokens; can configure the publish-area path and the public-share allow-flag.
2. **Local-tailnet agent** — bearer token from a managed Paperclip grant. The grant adds two new permissions beyond view/edit:
   - `publish: true` — may call `POST /api/publish` to create new slugs within an allowed publish-area subpath
   - `share: true` — may call `POST /api/publish/<slug>/share` to mint public shares
3. **Token-only agent (no grant)** — static config token with explicit `publish` / `share` scopes, same shape as the existing view/edit tokens from [FON-3671](/FON/issues/FON-3671).

The **read/write token split** flagged in the competitor doc (roadmap item 2) becomes mandatory: a token that can publish should not implicitly be able to share publicly, and vice versa. Permissions are an array, not a tier.

#### Audit

Every state-changing publish/share operation writes an audit record (append-only JSONL in the existing grant store directory) with:

- Timestamp
- Caller identity (agent id + grant id + source company for managed grants; token name for static tokens; user id for human operators)
- Operation (`publish`, `update`, `share-create`, `share-revoke`, `share-access-success`, `share-access-failure`)
- Slug + path
- Source IP / referrer where applicable

Audit records are surfaced via the same `GET /api/grants?includeAudit=1` endpoint that already returns grant lifecycle events, with new event types.

#### Versioning

Three layers, in order of cost:

1. **Append-only by default.** A publish slug is conceptually a directory; updates write new files into it without deleting old ones. The render layer serves the latest. Old versions remain on disk and are reachable via `?version=<n>` (or `/view/published/<slug>/<file>?version=<n>`).
2. **Optional git tracking.** Operators who want full history can configure the publish area as a git-tracked directory. The publish API commits on write (configurable: every write / batched / disabled).
3. **No vendor versioning service.** No append-only object-store versioning, no in-DB blob versioning. The two layers above cover the operational cases; deeper history needs are deferred until asked for.

The existing `expectedMtimeMs` stale-write guard extends naturally to slug-based updates: `POST /api/publish/<slug>` with a manifest can include `expectedRevision` (the integer version number of the current slug state); a mismatch returns 409.

## Connecting back to the three prior tickets

| Ticket | Status | How it connects |
|---|---|---|
| [FON-7057](/FON/issues/FON-7057) — translate github.com URLs to local file paths | backlog | The github.com → local translation is a **reader-side** fix for the same machine-locality pain that motivated FON-10180. Both tickets address the same UX problem from different angles: FON-7057 lets the reader find local files by clicking github.com links; this issue lets the writer push files into a single canonical Lookie-Link instance so the reader doesn't need a local checkout at all. They are complementary; neither obviates the other. Pick FON-7057 up when the reader-side surface is the bottleneck (most github.com link clicks today). Pick this issue's prototype up when the writer-side surface is the bottleneck (machines that haven't yet synced via git). |
| [FON-7058](/FON/issues/FON-7058) — public-internet hosting via Pangolin | backlog | This is the **transport** that makes bounded public-share usable beyond the tailnet. The two tickets are layered: FON-7058 decides "how does the instance reach the public internet"; this issue decides "what does the instance expose when it's exposed." Either ticket is useful on its own; together they give the full Planet Fitness-link use case. **Recommendation: pick up FON-7058 in parallel with phase 2 of this work** (the bounded public-share phase). The Pangolin decision is small (DNS + tunnel + repo-scope flag) and unblocks the public-share value proposition. |
| [FON-3671](/FON/issues/FON-3671) — phase 1 token-scoped repo/path access | done | This is the **foundation** the publish API extends. The existing token model (`view` / `edit`) gains `publish` / `share` scopes. No rewrite required; the managed-grant model already handles per-token capability arrays. Phase 1 of the new work mostly inherits FON-3671's plumbing. |

## Phased plan

Three phases, sized for incremental shipping. Each phase ends with a usable surface that an agent can adopt.

### Phase 1 — Publish primitive on a single instance (2–3 weeks of focused work)

**Deliverable**: an agent can publish a manifest + files via HTTP, get back a slug-addressed URL, and have humans / other agents view the result through the existing render pipeline.

In scope:
- `POST /api/publish` route: accepts JSON manifest (slug | optional explicit slug, list of files with content, optional metadata) + writes files to a configured publish-area path. Atomic via temp-dir + rename. Returns slug + URL.
- `POST /api/publish/<slug>` update: same body shape; writes new revision. Honors `expectedRevision` for 409 stale-write detection.
- `GET /view/published/<slug>/...` already works via existing render pipeline once the publish area is mounted; one config-time addition only.
- New grant/token permissions: `publish` (boolean per scope path). Adds to the existing `view` / `edit` permissions in [docs/AGENT-ACCESS-CONTROL.md](../../docs/AGENT-ACCESS-CONTROL.md).
- Audit-log writes for `publish` / `update` events.
- Operator config flag (`publish.enabled`, `publish.areaPath`, `publish.maxRevisions`).
- Docs update: `docs/API.md` gains a Publish section; new `docs/PUBLISHING.md` walks through the flow.

Out of scope for phase 1:
- Public sharing.
- The CLI (separate phase).
- `agent.json` advertisement (separate phase).

Validation:
- Extend `scripts/validate-editable-mode.js` with publish-mode validation scenarios.
- Smoke: an agent on a different machine than the publisher can fetch the published URL successfully without git sync.

### Phase 2 — CLI + `agent.json` + capability discovery (1–2 weeks)

**Deliverable**: a `lookie` CLI on npm that wraps the publish API; an `/.well-known/agent.json` that advertises Lookie-Link's surface to agent runtimes.

In scope:
- `/.well-known/agent.json` route returning the OpenAPI surface + instance capabilities (publish enabled? share enabled? max file size? supported render types?). Format aligned with `here.now`'s convention so existing agent runtimes can consume it.
- `/openapi.json` auto-generated from route handlers (or hand-maintained and validated in CI).
- `lookie` CLI: `lookie publish <files...> [--metadata file.json]`, `lookie list`, `lookie revoke <slug>`. Reads token from `LOOKIE_LINK_TOKEN` env or `~/.config/lookie-link/auth.yaml`. Ships as `lookie-link-cli` on npm (parallel to `nlm`).
- Skill packages for Claude Code / Cursor / Codex marketplaces, parallel to `heredotnow/skill`.
- Docs update: new `docs/CLI.md` walks through CLI install, auth, and the agent-runtime skill setup.

Out of scope:
- Public sharing (next phase).
- Drive-equivalent object storage (deferred indefinitely per the competitor doc).

### Phase 3 — Bounded public-share with expiry and password (2 weeks)

**Deliverable**: an operator can opt their instance into accepting share-creation requests; an authorized caller can mint a per-artifact public URL with expiry and optional password.

In scope:
- `POST /api/publish/<slug>/share { expiresAt, password?, maxAccessCount? }` returns a share token + URL.
- `GET /share/<share-token>/...` resolves to the published slug, gated by expiry / password / access-count.
- `POST /api/publish/<slug>/share/<share-token>/revoke` to revoke before expiry.
- New permission: `share` (boolean per scope path).
- Operator config flag (`share.enabled`, `share.maxLifetimeDays`, `share.requirePassword`).
- Argon2id password hashing; per-share salt.
- Rate limiting on the `/share/*` route group (per-IP + per-share-token); operator-configurable.
- Audit-log writes for `share-create`, `share-revoke`, `share-access-success`, `share-access-failure` events.
- Docs update: new `docs/PUBLIC-SHARES.md` documents the operator config flow + the security model.

Out of scope:
- Forking / remixing shared artifacts.
- Payment-gated artifacts (stablecoin or otherwise).
- Multi-tenant share semantics (different operators' shares cross-isolated). Each Lookie-Link instance is one operator.

### Reference / follow-on work (not in this plan)

- **Read/write token split** as a standalone refactor — already on the table in the competitor doc; preferably landed before Phase 1 but not a hard blocker (the new `publish` / `share` permissions are additive and the split can land alongside).
- **Pangolin / public-internet exposure** for instances that want public-share URLs to actually be public — covered by [FON-7058](/FON/issues/FON-7058).
- **github.com URL translation** — orthogonal and complementary, covered by [FON-7057](/FON/issues/FON-7057).
- **Agent-native wiki extensions** (stable page identity, first-class backlinks query API, edit-history surface, agent-metadata schema) — deferred to a separate decision per [`./lookie-link-as-agent-native-wiki-2026-05-16.md`](./lookie-link-as-agent-native-wiki-2026-05-16.md). This issue's phased plan is compatible with that path but does not commit to it.

## Risks specific to this plan

- **Scope creep into multi-tenant SaaS.** The publish primitive is one HTTP route + one config-time mount. If it accretes signup flows, billing, multi-tenant isolation, or wildcard DNS support, it has become Path 4 from the SaaS options doc and the operator should stop and re-decide. Hard rule: phase 1 ships in 2–3 weeks or the scope is wrong.
- **Audit-log volume.** A noisy agent could fill the audit log quickly. Phase 1 should include log rotation (size-based + age-based) configured by default.
- **Password gate as security theatre.** A 4-character user-chosen password on a public URL is not meaningfully secure. The implementation should enforce a minimum entropy floor (e.g., minimum length + character-class checks) or require operator-chosen passphrases from a dictionary. Phase 3 design item.
- **CLI install pollution.** Shipping a global `lookie` binary risks colliding with other tools. Namespace the binary (`lookie-link` as the global name; `lookie` as an optional alias the user installs themselves).
- **`agent.json` discovery semantics.** `here.now` published this convention; we should follow it without forking it. Phase 2 should verify the format against `here.now`'s live `.well-known/agent.json` and stay compatible.

## Recommendation

1. **Approve the three-phase plan** above as the publish/CLI/share roadmap for Lookie-Link.
2. **Skip more research / open-ended architecture work** — the strategic analysis from May 2026 plus this synthesis is sufficient grounding to begin implementation.
3. **Start with Phase 1** (the publish primitive). Single small route group, file-backed, no public surface yet. 2–3 weeks of focused work.
4. **Phase 2 follows immediately** if Phase 1 lands cleanly. The CLI + `agent.json` work is mostly mechanical once the publish primitive exists.
5. **Phase 3 is gated on real demand for public-share.** Build it when the Planet Fitness-style use case becomes recurrent (or when [FON-7058](/FON/issues/FON-7058) lands a public-internet endpoint, which makes the feature actually useful).
6. **In parallel with Phase 3**, pick up [FON-7058](/FON/issues/FON-7058) so the public-share URLs have a transport to reach non-tailnet recipients.
7. **Leave [FON-7057](/FON/issues/FON-7057) (github.com URL translation) for a later separate decision.** Useful, complementary, but orthogonal to the publish/share workstream.

If the recommendation is approved, the proposed child issues are:

| Issue | Phase | Scope | Blocks |
|---|---|---|---|
| Publish API: `POST /api/publish` with manifest + file write | 1 | route handler, publish-area mount, atomicity, audit log | nothing (foundation) |
| Publish API: `POST /api/publish/<slug>` update + `expectedRevision` 409 guard | 1 | extends the publish primitive | publish API base |
| Token model: `publish` permission on managed grants + static tokens | 1 | extend AGENT-ACCESS-CONTROL.md model | publish API base |
| Docs: `docs/PUBLISHING.md` + `docs/API.md` publish section | 1 | documentation | publish API base, token model |
| Validation: publish-mode scenarios in `scripts/validate-editable-mode.js` | 1 | extends existing validator | publish API base |
| `/.well-known/agent.json` + `/openapi.json` advertisement | 2 | discovery surface | nothing (independent) |
| `lookie-link-cli` package with `publish` / `list` / `revoke` | 2 | new package, thin HTTP wrapper | publish API base, agent.json |
| Skill packages for Claude Code / Cursor / Codex marketplaces | 2 | distribution artifacts | CLI |
| Public-share: `POST /api/publish/<slug>/share` + `GET /share/...` | 3 | new route group, expiry, password gate | publish API base, token model |
| Public-share: token model `share` permission | 3 | extends token model | token model, public-share routes |
| Public-share: rate limiting + audit events | 3 | hardening | public-share routes |
| Docs: `docs/PUBLIC-SHARES.md` + security model | 3 | documentation | public-share routes |

These child issues are sized so each is mergeable independently in days, not weeks. The phase boundaries are batch points, not gates — phase 2 issues can begin once phase 1's foundational tickets land, even if other phase 1 tickets are still in flight.

## Open questions deliberately not resolved here

- **Token rotation cadence.** Today the managed-grant model has expiry but not rotation. Should `publish` / `share` tokens rotate automatically? Defer to phase 1 implementation; pick a sensible default; revisit if operators ask.
- **Storage quotas per token / per scope path.** The publish area is a directory on disk; the operator's filesystem owns quota. Could grow into Lookie-Link if a noisy agent fills the disk. Defer until observed.
- **Migration path for existing tailnet-internal sharing patterns.** Today operators share via `[[name]] (~/repo/path.md)` cross-links. The new public-share URL scheme is additive; existing patterns continue to work. No migration needed, but a doc note that explains when to use which is worth writing.

## Sources

- This repo's [`docs/AGENT-ACCESS-CONTROL.md`](../../docs/AGENT-ACCESS-CONTROL.md), [`docs/PAPERCLIP-GRANT-WORKFLOW.md`](../../docs/PAPERCLIP-GRANT-WORKFLOW.md), [`docs/API.md`](../../docs/API.md), and [`docs/FEATURES.md`](../../docs/FEATURES.md) as the grounding for the existing surface.
- Companion analyses: the three commercialization docs and the competitor doc named at the top of this file.
- Source issue: [FON-10180](/FON/issues/FON-10180).
- Prior tickets cited inline: [FON-7057](/FON/issues/FON-7057), [FON-7058](/FON/issues/FON-7058), [FON-3671](/FON/issues/FON-3671).
