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

> **2026-06-01 addenda** appended at the bottom of this document.
> **Addendum b** expands the storage model to include a multi-agent shared "managed repo" primitive alongside the slug-addressed publish primitive, and elevates search API + CLI to a load-bearing phase 1 item.
> **Addendum c** expands the identity and auth model: first-class user identity (sessions, SSO via WorkOS) distinct from agent API keys, plus three public-share modes (anonymous / magic-link-lightweight / fully credentialed). Also records the commitment signal from Chris ("building this whether it becomes a public sellable thing or not") that removes commercialization as a gate on the build.
> **Addendum d** evaluates whether managed repos should optionally back to a real GitHub remote with full bidirectional git-sync (`pull AND push`) and a configurable sync scheduler. Designs the feature with per-repo `syncMode` choice (`bidirectional` default + `canonical` opt-in) and per-repo `scheduling` choice (`built-in` default + `external` + `both`). Proposes a phase 1.5 slot between phase 1 and phase 2 if Chris wants to lock it in. Phase 1's content does not change either way. *Note: the initial draft of this addendum framed the design as canonical-only sync; corrected after Chris clarified that multi-writer is the general case and a SaaS-product default.*
> **Addendum e** answers four questions Chris raised after addendum d: (1) cloud agents (OpenAI / cloud Claude / OpenClaw cloud) using the Lookie-Link API — reinforces existing design; flags FON-7058 as the transport that makes it reachable. (2) "Lookie-Link becomes the canonical location" — refactors the conceptual framing to "Lookie-Link as canonical content store with sync-to-other-systems as configurable plugins." (3) File versioning à la Syncthing for rollback, separate from git history — designs an optional `.versions/` sidecar layer per managed repo. (4) Database question and "are we over-complicating?" — direct answer: yes, SQLite (embedded, file-backed, no separate service), and no, this is the minimum for a serious product, not over-engineering.
> **Addendum f** addresses backup: (1) SaaS backup model — S3 / S3-compatible client-side-encrypted, per-tenant prefix, owned by the SaaS operator. (2) OSS backup — same mechanism exposed as operator-configurable: S3-compatible target (any vendor), local-rsync fallback for homelab. (3) "Is backup the versioning?" — partial yes, recommended design is complementary layers with unified API surface. (4) Phase slotting — proposes phase 1.7 (between phase 1.5 GitHub-backing and phase 2 CLI) for ~2–3 weeks of work, or defer to phase 4 if the operational stopgap (filesystem-level backup of the Lookie-Link host) is acceptable for the first months.
> **Addendum g** responds to Chris's "maybe we use Syncthing FOR the backup since it has the versioning anyway?" Genuine insight. Promotes the Syncthing-peer sync plugin from "future" (Addendum e) to a first-class phase 1.7 target type alongside S3. Honest about the split: Syncthing is excellent for self-hosted operators (peer-to-peer, built-in versioning, free, mature) but doesn't fit the SaaS-hosted-by-us pattern where the operator manages backup centrally — so phase 1.7 ships both target types from one abstraction. Also addresses whether the `.versions/` sidecar is still needed (yes — default-on for operators without Syncthing or with snapshot-granularity backup).
> The body of this document below is the original evaluation; the addenda are the current recommendation.

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

---

## Addendum 2026-06-01b — Multi-agent shared workspace ("managed repos") + search API

This addendum was added after Chris's first read of the original evaluation. He raised two load-bearing additions that the original analysis underweighted:

1. **Multi-agent shared "repo" storage.** A Lookie-Link-hosted, mutable, file-tree-shaped storage area that **multiple agents read and write to as their canonical shared workspace**. Not the same as the slug-addressed publish primitive, which produces immutable artifacts. The shared workspace is **the better answer to the original FON-10180 machine-locality pain point** — instead of every agent publishing a new slug per doc, agents accumulate work into a known shared tree that lives in one place and is the canonical view from any machine.
2. **Search API as a phase-1 must-have.** Agents need to search **before writing** to find what already exists, decide where to put new content, and read related context for their current task. Without search, the multi-agent shared workspace breaks: agent N+1 can't reliably find what agent N wrote, so the workspace devolves into duplicate copies of the same finding.

Both additions are consistent with the original "stay in lane, don't become a multi-tenant SaaS" framing. They expand what a single-operator self-hosted instance can do for its own agents — not what it does for the public internet.

### What changes vs. the original document

The original document framed Lookie-Link's write surface as a single primitive: slug-addressed publish artifacts. The revised model has **two write primitives** and **one read-augmentation primitive**, all sharing infrastructure (file-backed storage, the token model from [FON-3671](/FON/issues/FON-3671), the audit log, the existing edit pipeline):

| Primitive | Shape | Lifetime | Addressing | Use case |
|---|---|---|---|---|
| **Managed repo** (new) | Mutable tree | Long-lived | Path-based (`/<repo>/<path>`) | Multi-agent shared workspace — agents accumulate research, look up prior work, collaborate on a knowledge base |
| **Publish artifact** (original) | Immutable-ish bundle | Slug-lifetime | Slug-based (`/published/<slug>/`) | Finished artifact handed to a reviewer, optionally public-shared |
| **Search** (new) | Read augmentation | Real-time | Query-based | Find what exists before writing; find context to read; list what changed recently |

### Multi-agent shared workspace ("managed repo") primitive

#### Shape

A **managed repo** is a configured directory on the Lookie-Link host (separate from both the existing mounted-local-checkout repos and the publish area) where agents read and write via HTTP. The operator decides which managed repos exist; agents do not create managed repos via the API.

| Endpoint | Purpose |
|---|---|
| `GET /api/repos/<repo>/files/<path>` | Read raw file content (different from `/view/...` which renders) |
| `PUT /api/repos/<repo>/files/<path>` | Create or update a file; honors `expectedMtimeMs` for 409 stale-write detection |
| `DELETE /api/repos/<repo>/files/<path>` | Delete (soft via rename to `.trash/`; hard via `?hard=1` and elevated permission) |
| `POST /api/repos/<repo>/files/<path>/move` | Rename / move a file with body `{ "to": "<new-path>", "expectedMtimeMs": ... }` |
| `GET /api/repos/<repo>/list` | List with filters: `path=`, `modifiedAfter=`, `glob=`, `limit=`, `offset=` |
| `GET /api/repos/<repo>/tree` | Recursive directory tree for navigation (cap at configurable depth) |
| `GET /api/repos/<repo>/changes?since=<timestamp>` | What changed in the repo since a given timestamp (read-after-write for agents) |

#### Storage and versioning

- **File-backed**, same as the rest of Lookie-Link. Managed repos live under a configured `managed-repos/<repo-id>/` directory on the host.
- **Optional git backing**: each managed repo can be configured (`managedRepos.<repo-id>.git: true`) to auto-commit on every write. Commits attribute the author from the calling grant / token. This makes the managed repo simultaneously a git repo — diffable, restorable, exportable.
- **Atomicity**: temp-file + rename, same as the existing edit pipeline.
- **Concurrency**: `expectedMtimeMs` / 409 Conflict, same as the existing edit pipeline.
- **Audit**: every write logged with caller identity, path, operation, size.

#### Auth

A new permission on the token / grant model: `write` on a path scope inside a managed repo (different from the existing `edit` permission, which applies to mounted local-checkout repos). Operators allow `write` only on the managed repos / paths they explicitly want exposed.

#### Why this is the better solution to the FON-10180 pain point

The original machine-locality pain: *"research doc existed on one machine but Lookie-Link on another machine could not see it until repo synchronization caught up."* With slug-publish, the answer was: agents publish each doc as a new slug, the slug lives on the canonical Lookie-Link instance, every machine sees it. That works, but it converts a continuous workflow (research accumulates into folders over time) into a discrete one (each doc is a new published bundle).

With a managed repo, the answer is cleaner: the canonical Lookie-Link instance hosts a managed repo named e.g. `agent-research/`, every agent writes into it via the API, every machine reads through the same Lookie-Link instance. The folder structure that agents already use locally maps 1:1 to the managed repo. No new addressing scheme to learn. The publish primitive remains useful for the immutable-bundle case (a finished deliverable, a screenshot set, a public-share-target), but the everyday agent-research-writing loop runs through the managed repo.

#### What it is not

- **Not a replacement for git repos with code in them.** Source code stays in real git repos with real PRs and real review. Managed repos are for content that benefits from agents writing into a shared mutable tree — research notes, accumulated findings, working documents, deliverables-in-progress.
- **Not a multi-tenant primitive.** Each Lookie-Link instance has its own managed repos; there is no cross-instance sync, no managed-repo-as-a-service offering. The single-operator model from the original analysis is preserved.
- **Not a content-delivery network.** Managed repos serve their operator's agents and humans; they are not optimized for serving anonymous public readers at scale.

### Search API

#### Shape

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=<query>&scope=<repo-list>&type=<content-type>&limit=&offset=` | Full-text + path + frontmatter search across allowed scopes |
| `GET /api/search/suggest?q=<prefix>&scope=<repo-list>&limit=` | Autocomplete for filename / path prefixes (cheap; no full-text) |
| `POST /api/search/reindex?scope=<repo>` | Operator-only; force a reindex of a scope (after large bulk imports) |

#### What it indexes

Phase-1 search covers three dimensions:

1. **Full-text content** — markdown body, code text, YAML values, sanitized HTML body. Indexed via sqlite-fts5 (no external dependency) or ripgrep-on-demand (no index, slower for large corpora). Pick during implementation; sqlite-fts5 is the recommended default.
2. **Path / filename** — substring + glob match. Cheap, separate index.
3. **YAML frontmatter and YAML file keys** — structured field match (e.g., `?type=research-doc&status=draft`). Reuses the existing YAML anchor extraction.

What it does **not** cover in phase 1: semantic / embedding search. That is a phase-N upgrade per the wiki doc's roadmap, deferred until there is observed demand and a clear embedding backend choice.

#### What the agent gets back

Each result includes:
- `repo`, `path`, `score`
- `snippet` — surrounding text around the match (configurable length)
- `lastModified`
- `frontmatter` if present
- `viewUrl` (the `/view/...` URL) and `rawUrl` (the `/api/repos/.../files/...` URL)

Limit / offset pagination, default `limit=20`, max `limit=100`.

#### Auth

Search results are **scoped by the caller's permissions**. A token that only has `view` on managed-repo `agent-research/` cannot see results from any other repo. The search index is per-repo so this enforcement is cheap.

#### Why search is load-bearing for phase 1, not phase 2

Without search:
- The agent writing a new finding cannot know whether a similar finding already exists. Duplicates accumulate.
- The agent picking up a task cannot find the prior research that informs the task. Context gets lost.
- The human reviewing a managed repo has no way to find what the agents wrote about topic X without browsing a tree by hand.

These are not nice-to-haves — they break the multi-agent shared-workspace value proposition. Search has to ship alongside the managed-repo primitive.

### Revised auth model

Three new permissions on the grant / token model, joining the existing `view` / `edit`:

| Permission | Applies to | Grants |
|---|---|---|
| `write` | Managed-repo path scope | `PUT`/`DELETE`/`POST move` on `/api/repos/<repo>/files/<path>/*` |
| `publish` | Publish-area scope | `POST /api/publish` and `POST /api/publish/<slug>` |
| `share` | Slug or path scope | `POST /api/publish/<slug>/share` or `POST /api/repos/<repo>/files/<path>/share` |

Search (`GET /api/search`) is gated by `view` (same surface as `/view/...`). No new permission needed.

The existing `edit` permission stays scoped to mounted-local-checkout repos and does not extend to managed repos. This keeps the two storage models cleanly separated and prevents accidental cross-grants.

### Revised phased plan

The original three-phase plan grows to **four phases**, and phase 1 expands to include managed repos + search alongside the publish primitive:

| Phase | Scope | Effort | Gate |
|---|---|---|---|
| **1** | Managed-repo primitive (read/write/list/tree/changes), search API (`/api/search` + suggest), publish primitive (`POST /api/publish` + update), new token permissions (`write` / `publish`), audit + docs + validation | **4–5 weeks** | This confirmation |
| **2** | `/.well-known/agent.json` + `/openapi.json` + `lookie-link-cli` npm package (`lookie write/read/list/search/publish`) + skill packages for Claude Code / Cursor / Codex | 1–2 weeks | Phase 1 lands cleanly |
| **3** | Bounded public-share with expiry / password / rate limiting / audit, applied to both managed-repo paths and published slugs, `share` permission | 2 weeks | Real public-share demand AND/OR [FON-7058](/FON/issues/FON-7058) lands |
| **4 (optional, deferred)** | Semantic / embedding search; managed-repo collaboration ergonomics (comments, locks, change subscriptions); migration importers | TBD | Observed demand |

Phase 1 grew from 2–3 weeks to 4–5 weeks because managed-repo + search are real additions, not nice-to-haves. The trade-off is honest: a smaller phase 1 ships a less useful product. The managed-repo + search combination is what makes the publish surface load-bearing for actual multi-agent workflows.

### Revised child-issue list

Phase 1 grows from 5 issues to 9 issues:

| Issue | Phase | Scope | Blocks |
|---|---|---|---|
| Managed repo: read endpoints (`GET /api/repos/<repo>/files/...`, `list`, `tree`, `changes`) | 1 | route handlers, managed-repo mount, audit log | foundation |
| Managed repo: write endpoints (`PUT` / `DELETE` / `POST move`) with `expectedMtimeMs` 409 guard and atomic write | 1 | extends managed-repo primitive | managed-repo reads |
| Managed repo: optional auto-commit-to-git on write (config-flag) | 1 | git integration | managed-repo writes |
| Token model: `write` permission on managed-repo scopes | 1 | extend AGENT-ACCESS-CONTROL.md | managed-repo writes |
| Search API: `GET /api/search` with sqlite-fts5 + path index + frontmatter index | 1 | new index + route | managed-repo reads (so search indexes them) |
| Search API: `GET /api/search/suggest` autocomplete | 1 | cheap prefix index | search base |
| Publish API: `POST /api/publish` + `POST /api/publish/<slug>` update + `expectedRevision` 409 guard | 1 | route handler, publish-area mount, audit log | foundation (independent of managed-repo) |
| Token model: `publish` permission on managed grants + static tokens | 1 | extend AGENT-ACCESS-CONTROL.md model | publish API base |
| Docs: `docs/MANAGED-REPOS.md`, `docs/PUBLISHING.md`, `docs/SEARCH.md`, plus `docs/API.md` expansion | 1 | documentation | all phase-1 endpoints |
| Validation: managed-repo + search + publish scenarios in `scripts/validate-editable-mode.js` (or new validator) | 1 | extends existing validator | all phase-1 endpoints |
| `/.well-known/agent.json` + `/openapi.json` advertisement | 2 | discovery surface | phase 1 (so capabilities are accurate) |
| `lookie-link-cli` package with `write` / `read` / `list` / `search` / `publish` / `revoke` | 2 | new package, thin HTTP wrapper | phase 1, agent.json |
| Skill packages for Claude Code / Cursor / Codex marketplaces | 2 | distribution artifacts | CLI |
| Public-share: `POST /api/publish/<slug>/share` + `POST /api/repos/<repo>/files/<path>/share` + `GET /share/...` | 3 | new route group, expiry, password gate | phase 1 |
| Public-share: token model `share` permission | 3 | extends token model | phase 1, public-share routes |
| Public-share: rate limiting + audit events | 3 | hardening | public-share routes |
| Docs: `docs/PUBLIC-SHARES.md` + security model | 3 | documentation | public-share routes |

### Revised answers to the FON-10180 questions

The two additions also sharpen the answers to questions 1 and 4 in the original body of this document. The revised answers:

- **Question 1 (publish API for file/document creation and update?)** Yes, with **two write surfaces**: the slug-addressed publish primitive (immutable artifacts) and the managed-repo primitive (mutable shared workspace). Both are file-backed; both share the token / audit infrastructure.
- **Question 4 (storage / control plane for some classes of files?)** Yes, expanded: Lookie-Link owns storage for (a) transient slug-addressed artifacts via the publish primitive, **and (b) long-lived multi-agent shared content via managed repos**. The original answer of "transient outputs + reviewable bundles" was correct but incomplete — the managed-repo case is the more strategically important one and was underweighted in the original analysis. Source code and per-project git-tracked content still stay in real git repos.

### Risks specific to the additions

- **Managed repos blur the line with real git repos.** Operators might be tempted to put source code into a managed repo for the convenience of API-driven writes. They shouldn't. The docs should explicitly call out the storage class taxonomy (the table in question 4 of the original document) and steer operators to real git repos for code.
- **Search index size.** A large managed repo with thousands of files indexed via sqlite-fts5 produces a real index file. Phase 1 should include index-size monitoring and a clear path to rebuild / shrink. Operators with huge corpora may need to fall back to ripgrep-on-demand search.
- **Read-after-write consistency.** Multiple agents writing concurrently into the same managed repo need to see each other's writes promptly. The `expectedMtimeMs` model handles overwrites; the `GET /api/repos/<repo>/changes?since=` endpoint handles "what did other agents write while I was working." Phase 1 design should validate both flows end-to-end.
- **Managed-repo deletion footgun.** A `DELETE` permission is dangerous in a multi-agent setting. Phase 1 should default to soft-delete (rename to `.trash/`), with hard-delete requiring an elevated permission and an explicit `?hard=1` flag. Operators can audit / restore from `.trash/` for as long as they choose.
- **Search auth surface.** A search result with a snippet might leak content from a path the caller cannot directly fetch if the per-result auth check is wrong. Phase 1 must enforce auth **per result** (not just per query scope), so an unauthorized path never appears in search output regardless of how broad the query is.

### What this means for the recommendation

The recommendation is the same as the original: **approve phase 1 and start the prototype**. The expansion does not change the verdict — it makes phase 1 more useful, somewhat larger (2–3 weeks → 4–5 weeks), and more aligned with the multi-agent workflows the source issue actually described. Phases 2 and 3 remain mechanical follow-ons; phase 4 (semantic search, collaboration ergonomics) is deferred.

The fresh `request_confirmation` interaction created after this addendum targets the revised plan. The original confirmation (`confirmation:FON-10180:plan:cad6a3ed-29bc-4d9a-83d9-5e6e5ca78f85`) is superseded.

---

## Addendum 2026-06-01c — Identity and auth model + commitment signal

This addendum was added after Chris's second-round comment. He raised two things:

1. **Commitment signal.** "This is something I want to build WHETHER it becomes a public sellable thing or not." This removes commercialization validation as a gate on the build. Phase priority and feature scope should optimize for **build value** (the workflow the operator's own agents and team will use), not for **commercial readiness** (a paying-customer wedge). The three companion commercialization docs remain useful as positioning context for if/when the operator chooses to commercialize, but they are no longer the deciding lens.
2. **Identity & auth deeper concern.** "We need to consider credentials for agentic and user use AND / vs. public shares (with credentials or not?), maybe a way to do SSO (WorkOS?), API keys for agents." The v1 and v2 plans underspecified user identity — they extended the existing token model with new permissions but treated all callers as "a token." A real product needs a first-class user identity layer, first-class agent API keys distinct from user sessions, an SSO integration for human auth, and a deliberate choice about whether public shares require credentials.

### What changes vs. the prior addenda

The prior auth model (across the original document body and Addendum b) was:

- Existing managed-grant model from [FON-3671](/FON/issues/FON-3671) handles tokens.
- New permissions `write` / `publish` / `share` extend the existing permissions array.
- Public shares are anonymous + URL + optional password.
- No user identity layer. No SSO. No differentiation between agent and user actions in the audit log.

The revised model adds three new layers:

1. **First-class user identity.** A users table, browser sessions, authentication via SSO or local password. Distinct from agents.
2. **First-class agent API keys.** Promote the existing token concept to a first-class "API key" resource with labels, rotation, scoped permissions, owner identity, and audit lineage. Agents can never log into the browser UI; users can never use an API key as a session.
3. **Three public-share modes** instead of one. Anonymous + URL + password (the original spec); magic-link-lightweight identity (recipient verifies an email); fully credentialed (recipient must log into a real user account).

Below: the full identity model, the credential model, the public-share modes, the SSO integration, and the revised phasing.

### Identity types

| Identity | Who | How they authenticate | Session model |
|---|---|---|---|
| **Operator** | The human running the Lookie-Link instance | Configured root credentials at install (env var or first-run setup), or escalated from a user with the `operator` role | Browser session with elevated audit log entries; cannot be impersonated by a magic-link user |
| **User** (internal) | A human member of the operator's team | SSO (WorkOS) or local username/password | Browser session, cookie-based, configurable timeout, MFA optional in phase 1 |
| **Agent** | A Paperclip / OpenClaw / Claude-Code agent | API key (bearer token) — never a session | No session. Every request is stateless and authenticated with the key. |
| **Anonymous share recipient** | An external party who has a public-share URL | URL only (optionally + password) | No session. Each access is independent. |
| **Magic-link share recipient** | An external party invited to view a share with email verification | Magic link → short-lived recipient session | Lightweight session: email-only identity, limited to the share scope, expires with the share |
| **Credentialed share recipient** | A named external user invited to view a share | SSO or local account login | Full user session, same as an internal user, scoped to the share |

The operator distinguishes between **internal users** (people on their team — paid seats if commercialized) and **external share recipients** (people they're sharing one artifact with). Internal users see the full workspace; share recipients see only the specific share they were granted access to.

### Credential types

| Credential | Used by | Lifetime | Revocable | Audited |
|---|---|---|---|---|
| **Session cookie** | Operator + users + credentialed share recipients | Configurable (default 24h, sliding) | Yes (server-side session store) | Yes — all actions tagged with `user.id` and `session.id` |
| **API key** | Agents | Long-lived; rotatable; no automatic expiry by default | Yes (revoke by id) | Yes — all actions tagged with `agent.id` and `key.id` |
| **Managed grant token** | Cross-company Paperclip agents (existing model from [FON-3671](/FON/issues/FON-3671)) | Bounded expiry, renewable | Yes (revoke by id) | Yes — already audited via the existing grant audit log |
| **Share token** | Embedded in the public-share URL | Bounded expiry (matches share expiry); max 90 days | Yes (revoke by id, or auto-expire) | Yes — share access events |
| **Magic-link token** | Single-use, email-issued, for verifying lightweight share recipients | Short (15 min default, configurable) | Single-use → consumed on first use | Yes — tied to the recipient email |
| **MFA TOTP secret** | Users with MFA enabled (deferred to phase 4 unless asked sooner) | Permanent until rotated | Yes | Audited at MFA setup / change |

### Agent API key model

The single largest auth change is promoting agent tokens to first-class API keys. Endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/keys` | Mint a new API key (operator-only by default; users with `manage_agent_keys` permission can mint keys for agents they own) |
| `GET /api/keys` | List keys (returns metadata only; never the secret) |
| `GET /api/keys/<id>` | Get a single key's metadata + audit summary |
| `POST /api/keys/<id>/rotate` | Mint a replacement secret; old secret remains valid for a configurable grace window |
| `DELETE /api/keys/<id>` | Revoke immediately |

Each API key has:

- `label` — human-readable purpose ("research-bot prod", "overnight ingest", "ace1236a backup")
- `ownerType` + `ownerId` — which agent this key belongs to (so audit log entries can attribute back to a single identity)
- `permissions` — same shape as the managed-grant permissions array (`view`, `edit`, `write`, `publish`, `share` scoped to repos / paths)
- `expiresAt` — optional; null means no automatic expiry, but rotation is recommended
- `lastUsedAt` — surfaced in the UI for the operator to identify dormant keys
- `createdBy` — user or operator who minted the key

API keys are presented to the operator and to the agent **once at creation**; the server stores only a hash. Rotation gives a new secret without losing the audit lineage of the key id.

#### Why not just use the existing token system?

The existing static-config-tokens model from [FON-3671](/FON/issues/FON-3671) is a valid v0; the new model is a strict superset. Migration:

- Static config tokens continue to work in phase 1 (backwards-compatible).
- Static tokens are tagged in the audit log as `kind: static-config`.
- New API keys are tagged as `kind: api-key` with their full owner/label/rotation lineage.
- Operators can gradually replace static tokens with API keys; static tokens can be deprecated in phase 2 or later.

### User identity model + SSO

A new users table with first-class identity:

| Field | Notes |
|---|---|
| `id` | UUID |
| `email` | Unique, lowercased |
| `name` | Display name |
| `role` | One of `operator`, `user`, `external` (for magic-link recipients) |
| `ssoProvider` | `workos` / `local` / `none` (for magic-link external users) |
| `ssoSubject` | Provider-issued stable identifier for SSO users |
| `passwordHash` | argon2id; null for SSO-only or external users |
| `mfaSecret` | nullable, TOTP — phase 4 unless asked sooner |
| `createdAt`, `updatedAt`, `lastLoginAt` | standard |

#### WorkOS as the SSO provider

WorkOS is the right phase 1 choice because:

- Single integration covers SAML, OIDC, magic-link, multi-IdP — operators with enterprise IdPs don't need a custom integration per IdP.
- Their pricing scales with usage and is reasonable for small operators.
- They handle the parts of SSO that are easy to get wrong (IdP-initiated SAML, group claims, just-in-time provisioning).
- The hosted login UI (AuthKit) is optional — operators can also embed WorkOS auth into a Lookie-Link-owned login page.

Phase 1 supports WorkOS only. Phase 2+ can add other IdPs (Okta, Google Workspace, Azure AD direct) if operators ask for them. Local username/password remains available as a fallback for non-SSO deployments (homelabbers, small teams without an IdP).

Integration shape:

- `GET /auth/login` — initiate auth (renders local form OR redirects to WorkOS depending on instance config)
- `GET /auth/sso/callback` — WorkOS OAuth callback; creates session, optionally provisions a user record on first login
- `POST /auth/logout` — destroy session
- Just-in-time provisioning: an SSO-authenticated user whose email is not in the users table is created with default `role: user` and the operator can promote them
- WorkOS configuration stored in instance config: `LOOKIE_LINK_WORKOS_CLIENT_ID`, `LOOKIE_LINK_WORKOS_API_KEY`, `LOOKIE_LINK_WORKOS_CONNECTION_ID` (or `organizationId` for multi-org)

#### Local username/password

For deployments that don't want SSO (homelab, small team, no IdP):

- `POST /auth/login` with email + password
- argon2id hashing
- Password reset via email magic-link (reuses the magic-link infrastructure from share recipients)
- Operator can disable local password auth entirely (SSO-only mode) via config flag

### Public share modes

The bounded public-share feature from the original document spec is one of **three** share modes. Operators choose which modes their instance supports; modes can be enabled / disabled independently.

| Mode | Recipient identity | Authentication | Use case | Audit lineage |
|---|---|---|---|---|
| **Anonymous** | None | URL + optional password (argon2id) | Quick share with someone you don't need to identify (the Planet Fitness public-doc case) | IP + referrer + timestamp only |
| **Magic-link lightweight** | Email-verified only | Recipient enters email → server emails magic-link → recipient clicks → short session | Share with a known external party where you want audit but don't need them to log in | Verified email + IP + timestamp |
| **Credentialed** | Full user record | SSO or local account login | Share with a named external collaborator where you want a real ongoing relationship + audit | User id + session id + timestamp |

The operator chooses **per-share** which mode applies. Default is "anonymous + URL + password" for backwards compatibility with the original phase 3 spec. A share-creation request body can specify:

```json
{
  "expiresAt": "...",
  "mode": "anonymous" | "magic-link" | "credentialed",
  "password": "...",                  // anonymous mode
  "invitedEmails": ["..."],           // magic-link or credentialed mode
  "allowedReferrers": ["..."],        // any mode, optional
  "maxAccessCount": 100               // any mode, optional
}
```

Magic-link and credentialed modes use the same email-delivery infrastructure (SMTP via the operator's choice of provider; same plumbing as password-reset).

### Audit log differentiation

The audit log gains a first-class `actor` field that records both the identity type and the credential used:

| Actor shape | When emitted |
|---|---|
| `{ "type": "operator", "userId": "...", "sessionId": "..." }` | Operator action (browser session, elevated) |
| `{ "type": "user", "userId": "...", "sessionId": "..." }` | User action (browser session) |
| `{ "type": "agent", "agentId": "...", "keyId": "...", "keyLabel": "..." }` | Agent action (API key) |
| `{ "type": "grant", "grantId": "...", "sourceCompanyId": "..." }` | Cross-company Paperclip grant (existing model) |
| `{ "type": "share-anonymous", "shareToken": "...", "ip": "...", "referrer": "..." }` | Anonymous share access |
| `{ "type": "share-magic-link", "shareToken": "...", "email": "..." }` | Magic-link share access |
| `{ "type": "share-credentialed", "shareToken": "...", "userId": "..." }` | Credentialed share access |

This distinction is **load-bearing**: without it, operators cannot answer "did agent X edit this file or did a human edit it" with the same audit query. Phase 1 emits the new actor field on every audit-logged operation; existing static-config-token actions continue to emit the legacy actor shape with a `kind: static-config` flag for backwards compatibility.

### Revised permission model

Phase 1 permissions, with identity-aware naming:

| Permission | Applies to | Granted to | Example |
|---|---|---|---|
| `view` | Repo / path scope | Any identity | Read `/api/repos/<repo>/files/...` and `/view/...` |
| `edit` | Local-checkout repo / path scope | Any identity | Write existing files in mounted-local-checkout repos |
| `write` | Managed-repo / path scope | Any identity | Create/update/delete files in managed repos |
| `publish` | Publish area | Any identity | Mint slug-addressed publish artifacts |
| `share` | Repo / path / slug | Any identity | Mint public-share URLs (any mode) |
| `manage_users` | Instance-wide | User with `operator` role only | CRUD on users table, SSO config |
| `manage_agent_keys` | Per-agent scope | User with `operator` role, or users with the permission delegated | Mint / rotate / revoke API keys for an agent |
| `manage_grants` | Instance-wide | User with `operator` role, or grant-admin token (existing FON-3671 model) | Existing grant lifecycle endpoints |
| `manage_shares` | Per-scope | Any identity with `share` already | Revoke shares that the identity minted |

The permission model is **uniform across credential types** — an API key with `view + write + share` permissions can do exactly what a user session with the same permissions can do, except the API key cannot access the browser UI's user-management surfaces.

### Revised phasing (v3)

Phase 1 grows to include a parallel auth-foundation track that lands alongside the storage/search/publish work:

| Phase | Scope | Effort | Gate |
|---|---|---|---|
| **1A — Identity & auth foundation** | Users table + sessions + WorkOS SSO + local password fallback + first-class agent API key model + audit log actor differentiation + permission model expansion | 2–3 weeks (overlapping with 1B) | This confirmation |
| **1B — Storage & write surface** | Managed-repo primitive + search API + publish primitive + new permissions consumed by 1A's identity layer | 4–5 weeks (overlapping with 1A) | This confirmation |
| **2** | `/.well-known/agent.json` + `/openapi.json` + `lookie-link-cli` + skill packages | 1–2 weeks | Phase 1 lands |
| **3** | Bounded public-share with **three modes**: anonymous (URL + password), magic-link-lightweight (email verification), credentialed (must log in) | 3 weeks (up from 2 in v2) | Phase 1 + phase 2 land, and [FON-7058](/FON/issues/FON-7058) public-internet endpoint exists OR demand is real |
| **4 (deferred)** | MFA enforcement, multi-IdP SSO beyond WorkOS, semantic search, managed-repo collaboration ergonomics, migration importers | TBD | Observed demand |

Phase 1 total: **5–6 weeks** of focused engineering with two tracks running concurrently. Tracks 1A and 1B land together as one prototype.

### Revised child-issue list

Phase 1 grows from 10 issues (v2) to **15 issues** (v3) with the auth-foundation track added. Phase 3 grows from 4 to 6 with the three share modes:

**Phase 1A — Identity & auth foundation (5 issues):**

1. Users table + session model + browser cookie auth (operator + user roles, local password via argon2id)
2. WorkOS SSO integration (`/auth/login`, `/auth/sso/callback`, just-in-time provisioning, instance config)
3. First-class agent API key model (`POST/GET/DELETE /api/keys`, `POST /api/keys/<id>/rotate`, owner attribution, label, rotation grace window)
4. Audit log actor field differentiation (new actor shape for all credential types, backwards-compatible)
5. Permission model expansion (`manage_users`, `manage_agent_keys`, `manage_shares` added; existing `view` / `edit` / `write` / `publish` / `share` aligned with the new identity model)

**Phase 1B — Storage & write surface (10 issues, same as v2):**

6. Managed repo: read endpoints (`GET /api/repos/<repo>/files/...`, `list`, `tree`, `changes`)
7. Managed repo: write endpoints (`PUT` / `DELETE` / `POST move`) with `expectedMtimeMs` 409 guard + atomic write
8. Managed repo: optional auto-commit-to-git on write (per-repo config flag)
9. Token model: `write` permission on managed-repo scopes (consumes 1A's identity model)
10. Search API: `GET /api/search` with sqlite-fts5 + path index + frontmatter index
11. Search API: `GET /api/search/suggest` autocomplete
12. Publish API: `POST /api/publish` + `POST /api/publish/<slug>` update + `expectedRevision` 409 guard
13. Token model: `publish` permission on managed grants + static tokens + API keys
14. Docs: `docs/MANAGED-REPOS.md`, `docs/PUBLISHING.md`, `docs/SEARCH.md`, `docs/AUTH.md`, plus `docs/API.md` expansion
15. Validation: managed-repo + search + publish + auth scenarios in `scripts/validate-editable-mode.js` (or new validator)

**Phase 2 (3 issues, unchanged from v2):**

16. `/.well-known/agent.json` + `/openapi.json` advertisement
17. `lookie-link-cli` package with `write` / `read` / `list` / `search` / `publish` / `revoke`
18. Skill packages for Claude Code / Cursor / Codex marketplaces

**Phase 3 (6 issues, up from 4 in v2):**

19. Public-share base: `POST /api/publish/<slug>/share` + `POST /api/repos/<repo>/files/<path>/share` + `GET /share/...`
20. Public-share mode: anonymous (URL + password + expiry + rate limit)
21. Public-share mode: magic-link-lightweight (email verification, recipient session)
22. Public-share mode: credentialed (must log in, scoped session)
23. Public-share audit log: share-anonymous / share-magic-link / share-credentialed actor types
24. Docs: `docs/PUBLIC-SHARES.md` + security model + mode comparison

**Phase 4 (deferred — not in this confirmation request).**

### Revised connections to prior tickets

- [FON-3671](/FON/issues/FON-3671) **done** → token-scoped grant foundation; phase 1A promotes the concept to a first-class API key model with backwards-compatible coexistence. Existing managed grants continue to work; new API keys are the recommended path forward.
- [FON-7057](/FON/issues/FON-7057) **backlog** → orthogonal; no change.
- [FON-7058](/FON/issues/FON-7058) **backlog** → with Chris's commitment signal removing commercialization as a gate, the case for picking this up alongside phase 3 strengthens. The public-internet endpoint is the transport that makes credentialed shares with external collaborators actually reachable beyond the tailnet. Recommend explicitly: pick up FON-7058 in parallel with phase 3 (no longer "consider," now "do this").

### What the commitment signal changes

Chris said: "this is something I want to build WHETHER it becomes a public sellable thing or not." This shifts three things:

1. **Phase 3's gate.** Was "real public-share demand AND/OR FON-7058 lands." Becomes "phase 2 lands cleanly." Build for the operator's own needs; commercialization is downstream.
2. **The commercialization companion docs become optional reading.** They remain useful for the commercialization decision if and when Chris pursues it, but they no longer gate any phase.
3. **The bias toward "minimum viable everything."** Builds for personal/team use get to be **good** — not minimum-viable. The phase 1 expansion to include first-class identity, real SSO, and three share modes is the build that supports a serious internal product; the v1 plan was the minimum-viable read on a commercialization-conditional build.

### Risks specific to the identity additions

- **WorkOS lock-in.** Phase 1 makes WorkOS the only SSO provider. If WorkOS pricing changes or the service degrades, swapping providers is a real lift. Mitigation: the integration is small (under 500 LOC) and isolated; the rest of the auth model (sessions, users, permissions) is provider-agnostic. Swap cost is bounded.
- **Magic-link delivery dependence.** Magic-link share mode and password reset both need SMTP. Operators have to configure an SMTP provider (Resend / SES / SendGrid / Postmark are all fine). Phase 1 documentation should walk through the choice clearly.
- **Audit-log schema migration.** Adding the `actor` field to all audit events is a schema change. Phase 1A includes a migration script that backfills existing audit records with a synthetic `{type: "legacy"}` actor; no data is lost.
- **API key UI surface area.** First-class API keys means a real UI for minting / listing / revoking keys, with the once-shown secret pattern. Done badly, operators leak keys. Phase 1A docs should cover the operational practices (rotate quarterly, label clearly, use the lowest-permissions scope possible).
- **Phase 1 weeks vs. delivery anxiety.** Phase 1 is now 5–6 weeks not 2–3. That is a real commitment. Mitigation: tracks 1A and 1B are deliberately parallel so the calendar time is bounded by the longer track (1B), not their sum. With two engineers (or one engineer + Claude / Codex assistance), 1A and 1B finish around the same time.

### What this means for the recommendation

Same verdict, larger scope: **approve phase 1 (v3) and start the prototype**. The expansion is right-sized to Chris's commitment: build identity-and-auth as a real foundation (because it has to be right eventually, and refactoring auth later is painful), build the storage / search / publish surface alongside it, and ship them together. Phase 2 (discovery + CLI) and phase 3 (three share modes) follow.

The fresh `request_confirmation` interaction created after this addendum targets the v3 plan revision. The v2 confirmation (`confirmation:FON-10180:plan:f4bee764-11ba-4657-8b9b-dd41ee291877`) is superseded.

---

## Addendum 2026-06-01d — GitHub push-to-origin for managed repos (optional phase 1.5)

This addendum responds to Chris's third comment: *"one more thing we MIGHT want to include is a 'push to origin' GitHub config and workflow from Lookie-Link itself."*

The framing is tentative — Chris is asking whether this belongs in scope, not committing to it. This addendum does the design carefully, proposes where it would slot if locked in, and surfaces the decision cleanly. **Phase 1's content does not change either way.**

### Revision history of this addendum

- **Initial draft (2026-06-01 afternoon)**: framed as "Lookie-Link is canonical, GitHub is mirror" with `alert-on-divergence` as the default fetch policy and `--to-local --force-push` as the recommended divergence resolution. Assumed single-writer model (one Lookie-Link instance = the only thing writing to a given GitHub repo).
- **Corrected (2026-06-01 evening)**: after Chris clarified — "*Just because I am using Syncthing, not everyone would be. So some machines may be pushing to the same repo*" — the canonical-only framing was too narrow. The current design is **proper bidirectional git-sync** with the canonical-only mode as an explicit opt-in policy (`syncMode: canonical`). The default mode is `bidirectional` with `auto-rebase` pull semantics, which is what real multi-writer git workflows look like. This is also the correct shape for a public SaaS product where operators have multiple machines independently pushing to the same repo without Syncthing replication.
- Also added: a **sync scheduling architecture** section addressing Chris's question about whether the sync cron belongs inside Lookie-Link or as a separate system. Short answer: hybrid — built-in scheduler by default with manual-trigger endpoints always available for external orchestration.

### What the feature is

A managed repo's optional **GitHub remote backing**: in addition to the existing auto-commit-to-git-on-write design from Addendum b, the managed repo can be configured with a GitHub remote URL. Writes flow:

```
agent → POST/PUT /api/repos/<repo>/files/<path>
      → Lookie-Link writes file
      → auto-commits to managed repo's local git
      → push queue picks it up
      → fast-forward push to GitHub remote (dedicated branch by default)
```

And the inverse:

```
periodic fetch (configurable; default 60s)
  → if origin has new commits on the tracked branch
  → fast-forward merge into the managed repo's local git
  → on conflict: surface in audit log + UI, do not auto-resolve
```

Net effect: the managed repo on the Lookie-Link instance and the GitHub repo stay in sync via real bidirectional git semantics. Other machines can also push to the same GitHub repo (this is the multi-writer general case); Lookie-Link's sync engine reconciles by fetching + rebasing/merging according to the operator's chosen sync mode.

This closes the loop on the original FON-10180 machine-locality pain point cleanly:

- Agent writes via Lookie-Link API → file is immediately visible from every machine through Lookie-Link.
- Lookie-Link pushes to GitHub on its own schedule → other machines that prefer the local-checkout pattern can still `git pull` from GitHub on their own schedule.
- Other-machine writes to GitHub (via the web UI, via a CLI on a different machine) flow back into Lookie-Link via the fetch loop.

### Why this is interesting on top of the existing managed-repo design

Without push-to-origin, managed repos are **Lookie-Link-local storage**. They live only on the Lookie-Link host. If that host disappears, the data disappears. The operator's mitigations are filesystem-level (backups, snapshots) — same as any self-hosted file storage.

With push-to-origin, managed repos are **Lookie-Link-fronted GitHub repos**. GitHub provides durability, branch protection, code review (if the operator wants it on the dedicated branch), and the entire familiar collaboration surface for the humans on the team. The Lookie-Link host can disappear and the data is safe.

This is a meaningful operational upgrade for any managed repo whose content the operator cares about long-term.

### Design

#### Configuration

Per managed repo, optional config block:

```yaml
managedRepos:
  agent-research:
    path: ./managed-repos/agent-research
    git:
      enabled: true                       # auto-commit on write (Addendum b)
      autoCommitGrace: 5s                  # batch writes within this window into one commit
    remote:
      url: git@github.com:chrisfonte/agent-research-storage.git
      branch: main                         # tracked branch on origin

      # Sync mode — the load-bearing policy choice
      syncMode: bidirectional              # bidirectional (default) | canonical

      # Push side
      pushOnCommit: batched                # batched | immediate | manual
      pushBatchInterval: 60s
      pushBatchSize: 25                    # whichever comes first

      # Pull side
      pullPolicy: auto-rebase              # auto-rebase | auto-merge | alert-on-divergence
      pullInterval: 60s

      # Scheduler (see "Sync scheduling architecture" below)
      scheduling: built-in                 # built-in (default) | external | both

      # Auth
      authMode: deploy_key                 # deploy_key | pat | github_app
      credentialKey: agent-research-deploy-key
```

#### Sync mode: bidirectional vs canonical

| Mode | What it means | When to pick it |
|---|---|---|
| `bidirectional` (default) | Lookie-Link is one git peer among potentially many. Other machines may also push to the same GitHub repo independently. Lookie-Link fetches + rebases (or merges, depending on `pullPolicy`) and pushes on its own cadence. Standard multi-writer git workflow. | The general case. The right default for a public SaaS product. The right answer for any operator who has multiple machines (their laptop, a CI runner, a teammate's machine) independently writing to the same GitHub repo. |
| `canonical` | The operator declares the Lookie-Link host as the sole writer for this repo. Anything that shows up on origin without going through Lookie-Link is treated as an exception. Default `pullPolicy` flips to `alert-on-divergence`; default conflict-resolution recommendation flips to `--to-local --force-push`. | Single-writer deployments where the operator has designated this Lookie-Link host as the only writer. Chris's Syncthing-replicated setup is the canonical example: Syncthing distributes state, only one machine talks to GitHub. Also the right pick for operators following the [FON-10193](/FON/issues/FON-10193) "Lookie-Link host is the authority" policy for a specific repo. |

The sync mode is **per-repo**, not per-instance. A single Lookie-Link instance can have some repos in `bidirectional` mode (shared with other writers) and other repos in `canonical` mode (this instance is sole writer).

#### Authentication

Three auth modes, supported in this order:

1. **Deploy key (default for v1).** Lookie-Link generates an SSH key per managed repo on operator request; operator pastes the public half into the GitHub repo's deploy-keys settings with write access. Lookie-Link stores the private key encrypted at rest. Scope: one repo per key. Revocation: operator removes the deploy key from GitHub.

2. **Personal access token (PAT).** Operator brings a fine-grained PAT scoped to the specific GitHub repo with content read/write. Lookie-Link stores encrypted. Scope: whatever the PAT covers; the operator owns scoping. Revocation: operator revokes the PAT in GitHub settings.

3. **GitHub App (v2+ — deferred).** Lookie-Link is registered as a GitHub App; operator installs it on the specific repos. Cleaner permissions and revocation, but real engineering work to register and host the App. Defer until asked.

Phase 1.5 ships with deploy-key + PAT. GitHub App in phase 4 if demand.

#### Branch model

The branch to push to is operator-configurable per repo:

- **In `bidirectional` mode**: default to `main` (or whatever the operator's existing primary branch is). The repo is genuinely multi-writer; agents writing through Lookie-Link share a branch with humans writing through other tools. Branch protection on the upstream side (required reviews, status checks) applies the same as for any other writer.
- **In `canonical` mode**: default to a dedicated branch (e.g., `lookie-link/main`). The operator gets a sanity check before merging Lookie-Link-side commits into `main`. Bad-data flush from a runaway agent doesn't directly poison the canonical history.

Operators can override either default in config (`remote.branch: <branch-name>`). The defaults are sane starting points, not hard constraints.

#### Push semantics

| Mode | Behavior |
|---|---|
| `batched` (default) | Push after `pushBatchInterval` seconds OR `pushBatchSize` commits, whichever comes first |
| `immediate` | Push after every commit (noisy; useful for low-traffic repos) |
| `manual` | Don't push automatically; operator triggers via `POST /api/repos/<repo>/push` |

All modes use fast-forward-only push by default. If FF fails (origin moved between our last fetch and our push), the push queue:

1. Pauses pushes for this repo
2. Triggers an immediate fetch
3. Attempts FF merge of origin → local
4. On clean FF: resumes pushing
5. On conflict: audit-log entry, UI alert, repo enters "diverged" state until operator resolves

#### Pull / fetch semantics

Three pull policies, operator-selectable per repo. The right default depends on `syncMode`:

| Policy | Behavior | Default for |
|---|---|---|
| `auto-rebase` | On periodic fetch: if origin has new commits, rebase Lookie-Link's pending commits onto origin's head and continue. Produces linear history. Standard `git pull --rebase` semantics. If rebase has a content conflict, fall back to `alert-on-divergence` for that incident. | `bidirectional` mode (the product default) |
| `auto-merge` | On periodic fetch: if origin has new commits, create a merge commit. Preserves history of both sides as it was. Standard `git pull` (no rebase) semantics. If merge has a content conflict, fall back to `alert-on-divergence`. | Operators who prefer merge commits over rebased linear history |
| `alert-on-divergence` | On periodic fetch: if origin has new commits, do nothing automatically. Emit audit-log entry + UI alert. Operator resolves. | `canonical` mode (Chris's Syncthing setup; explicit single-writer operators) |

Periodic fetch runs on `pullInterval` (default 60s). On fetch:

1. Run `git fetch origin <branch>`
2. If local is at-or-ahead of origin: no action
3. If origin is ahead and clean reconciliation is possible per the policy: reconcile; emit audit-log entry recording the merge/rebase
4. If reconciliation requires content-conflict resolution OR policy is `alert-on-divergence`: enter `state: origin-ahead`; push pauses until operator resolves; writes to the managed repo continue to succeed locally

Operator can trigger an immediate fetch via `POST /api/repos/<repo>/fetch` (or the combined `POST /api/repos/<repo>/sync` which does both fetch + push). Resolution endpoints from the conflict-handling section apply.

#### Initial sync

When operator first configures a managed repo with a remote:

1. Lookie-Link `git clone`s the remote into the managed-repo path (if the path is empty)
2. If the path is non-empty, Lookie-Link refuses and asks the operator to either point at an empty path or do a manual `git init` + `git remote add` first
3. Once cloned, the periodic fetch / push loops are scheduled

#### Conflict handling

On conflict (auto-rebase / auto-merge produced a content collision, or policy is `alert-on-divergence` and origin moved):

1. Audit-log entry with full conflict detail (commit hashes, files involved, our SHA, theirs SHA, conflict markers if available)
2. Repo enters `state: origin-ahead` (or `state: diverged` for true divergence) and writes to the managed repo continue locally (Lookie-Link's storage), but commits are queued and not pushed (writes never lose data; sync just pauses until resolved)
3. UI surfaces an alert
4. Operator resolves via:
   - `POST /api/repos/<repo>/reset --to-origin` (drop pending local commits; accept origin's state)
   - `POST /api/repos/<repo>/reset --to-local --force-push` (overwrite origin with Lookie-Link's history)
   - `POST /api/repos/<repo>/reset --rebase-onto-origin` (try the rebase again after the operator has manually resolved the conflict files via the Lookie-Link UI or a shell)
   - Manual git resolution in a shell on the Lookie-Link host followed by `POST /api/repos/<repo>/sync --resume`

**No recommended-default resolution.** The right choice depends on what diverged and why — that's a judgment call the operator has to make. The previous version of this addendum recommended `--to-local --force-push` as the default; that was correct under the canonical-only mental model but wrong under the bidirectional default. Under bidirectional sync, divergence is a normal multi-writer event and force-pushing your version over a teammate's commits is a real footgun.

In `canonical` mode, an operator can configure a `defaultResolution: force-push-local` flag that surfaces that recommendation in the UI when divergence happens (still requires the operator to actually click; never silent). In `bidirectional` mode, no recommendation is surfaced — the UI shows the conflict and the three options with equal weight.

Auto-resolution is still off the table. Auto-merge of conflicting agent-written content can produce garbage; auto-rebase past a content conflict mangles history; auto-force-push is dangerous if the operator doesn't know it's happening. Stop and surface clearly.

#### Failure modes

- **Network down**: pushes queue locally; writes still succeed; push queue drains when reconnect.
- **Auth expired (PAT rotation, deploy-key removed)**: push fails → audit-log entry + UI alert + operator-action-required state. Writes still succeed locally.
- **Origin disappears (repo deleted on GitHub)**: same as auth-expired.
- **Lookie-Link restart**: the push queue persists across restarts (sqlite-backed); pending pushes resume.

#### Sync scheduling architecture

Chris's question: *"MAYBE a sync cron could be part of the configuration? Or should that be separate? In some other system? In a public SAS product, therefor in this architecture?"*

Right answer: **hybrid** — Lookie-Link ships with a built-in scheduler that runs by default, and exposes manual-trigger endpoints that external orchestration can use instead of or in addition to it. Operators can disable the built-in scheduler if they want external-only control.

Three scheduling modes, operator-selectable per repo:

| Mode | Behavior | Right for |
|---|---|---|
| `built-in` (default) | Lookie-Link's own process owns the schedule. Runs fetch on `pullInterval` and push on `pushBatchInterval` / `pushBatchSize`. Handles back-off + retry on failure. | The default. Works out-of-the-box without external dependencies. The only correct answer for a public SaaS deployment, where operators don't have access to the hosting infrastructure. |
| `external` | Disable the built-in scheduler entirely. Sync only happens when an external trigger hits the manual-trigger endpoints. | Self-hosted operators with their own centralized sync orchestration (CI, k8s CronJob, system cron, a dedicated sync service). Lookie-Link becomes one of several systems on a shared schedule. |
| `both` | Built-in scheduler runs at its configured interval. External triggers can still drive immediate sync on demand (useful for "sync now" UX). | Self-hosted operators who want a steady-state background cadence plus the ability to force-sync from external systems (e.g., "after deploy, push the latest agent-generated docs immediately"). |

Manual-trigger endpoints (always available regardless of `scheduling` mode):

| Endpoint | Purpose |
|---|---|
| `POST /api/repos/<repo>/sync` | Fetch + reconcile (per `pullPolicy`) + push (per `pushOnCommit`). The "do everything now" trigger. |
| `POST /api/repos/<repo>/fetch` | Fetch + reconcile only. |
| `POST /api/repos/<repo>/push` | Push pending local commits only. |
| `POST /api/repos/<repo>/sync --resume` | Resume sync after a conflict was manually resolved. |

The cron schedule **is** the configuration: `pullInterval` and `pushBatchInterval` are the periods. In `built-in` mode, those configure the in-process scheduler. In `external` mode, those values still appear (as advice / documentation) but are not acted on by Lookie-Link itself; the external scheduler reads them or ignores them as it chooses.

Why this design fits both worlds:

- **Public SaaS product**: operators get sync that "just works" out-of-the-box (`built-in`, default settings). They don't need to set up infrastructure. They can still hit the manual-trigger endpoints from their own tools when they want to (`both`).
- **Chris's self-hosted setup**: he gets the same out-of-the-box experience. If he later decides he wants Syncthing to drive sync timing (replicate then push from the one machine that has GitHub auth), he flips `scheduling: external` and writes whatever trigger logic he wants. Lookie-Link cooperates either way.
- **Larger self-hosted operators**: they can keep their existing sync orchestration in place. Lookie-Link doesn't fight them.

The sync scheduling architecture lives **inside Lookie-Link** as a first-class part of the managed-repo + remote config — not in some other system. The reason: the schedule has to coordinate with Lookie-Link's own write queue (don't push mid-batch-commit), its fetch state (don't double-fetch), and its conflict state (don't push from origin-ahead state). External-only scheduling can paper over that by always going through the manual endpoints, but the coordination logic still has to live in Lookie-Link.

#### Combined sync endpoint

`POST /api/repos/<repo>/sync` returns a structured result describing what happened:

```json
{
  "fetched": { "newCommits": 3, "from": "abc123", "to": "def456" },
  "reconciled": { "strategy": "rebase", "localCommitsRebased": 2, "conflicts": 0 },
  "pushed": { "commits": 5, "from": "def456", "to": "ghi789" },
  "state": "in-sync"
}
```

Or on failure:

```json
{
  "fetched": { "newCommits": 3 },
  "reconciled": { "strategy": "rebase", "localCommitsRebased": 0, "conflicts": 2 },
  "pushed": null,
  "state": "origin-ahead",
  "alert": "Content conflicts in files: [a.md, b.md]. Operator action required."
}
```

### Auth implications (interaction with Addendum c)

The push-to-origin feature introduces a new credential type — **GitHub deploy keys / PATs stored as managed-repo secrets**. These are not user credentials and not agent API keys; they are operator-configured infrastructure credentials.

The audit log gets one new actor type:

| Actor shape | When emitted |
|---|---|
| `{ "type": "git-sync", "repoId": "...", "direction": "push" | "fetch" }` | Background push or fetch operation |

This is distinct from agent / user actions — the git-sync is initiated by Lookie-Link itself, not by a specific identity. The commits being pushed retain their original committer (the agent or user who wrote the file).

The permission model adds one new permission:

| Permission | Granted to | Allows |
|---|---|---|
| `manage_repo_sync` | Operator role only by default | Configure remote URL, push/fetch settings, manage stored credentials, trigger manual push/fetch, resolve diverged states |

Agents do **not** get `manage_repo_sync`. Their writes flow through the managed-repo write surface; the sync is an operator-controlled infrastructure layer.

### Storage class taxonomy revisited

The taxonomy table from the original document's Question 4 now has another column:

| Class | Lookie-Link primitive | GitHub backing |
|---|---|---|
| Source-of-truth code / docs | Mounted local-checkout repo (existing) | The local checkout is already a real git repo on GitHub |
| Long-lived research artifacts that belong with a project | Mounted local-checkout repo (existing) | Same |
| Transient agent outputs needing a URL now | Publish area (Addendum b) | Not applicable; ephemeral by design |
| Reviewable immutable bundles | Publish area (Addendum b) | Not applicable; immutability is the point |
| **Long-lived multi-agent shared content** | **Managed repo (Addendum b)** | **Optional GitHub backing via push-to-origin (this addendum)** |
| Public-share content | Publish area or managed-repo paths (Addendum b + c) | Not applicable; the share is the surface |
| Multi-GB binary blobs | None — use object storage | None |

The new column resolves a sharp design question: when does a managed repo benefit from GitHub backing? Answer: **when its content is long-lived enough to be worth durably backing up.** Operator-judged per repo.

### Where this slots — phase 1.5 or phase 4

Two options for sequencing:

**Option A — Phase 1.5 (recommended if Chris wants this near-term).** Inserts between phase 1 and phase 2:

| Phase | Scope | Effort |
|---|---|---|
| 1A + 1B | (unchanged from v3) | 5–6 weeks parallel |
| **1.5 — GitHub remote backing** | Deploy-key + PAT auth, push queue with batching + FF-only, periodic fetch, conflict surface, operator UI for stored credentials + sync state | **1–2 weeks** |
| 2 | (unchanged from v3) | 1–2 weeks |
| 3 | (unchanged from v3) | 3 weeks |

Total phase 1.5 child issues (4):

1. Git-sync engine: clone on configure, push queue, fetch scheduler, FF-only enforcement, conflict-state machine
2. Credential storage: encrypted deploy-key + PAT storage, mint deploy-key endpoint, rotate-credential endpoint
3. Operator endpoints + UI: `POST /api/repos/<repo>/push`, `POST /api/repos/<repo>/fetch`, `POST /api/repos/<repo>/reset`, sync-state surface
4. Docs: `docs/MANAGED-REPOS.md` GitHub section + `docs/GIT-SYNC.md` (auth modes, branch model, conflict resolution)

**Option B — Phase 4 (deferred until asked).** Park the design here; revisit when phase 1 + 2 + 3 are landed and operational experience tells the operator whether they want GitHub backing.

### Recommendation

**Option A — lock in phase 1.5** if Chris's "MIGHT" hardens into "yes" on first read of this addendum. The reasoning:

- The feature closes the loop on the original FON-10180 machine-locality pain point. Without it, managed repos are Lookie-Link-local; the GitHub backing is what makes them durably canonical.
- 1–2 weeks is a small phase by current standards. It does not push phase 2 out meaningfully.
- The design is straightforward — well-known git operations + a credential store + a queue + a conflict-state machine. No experimental tech.
- Operators who don't want GitHub backing simply don't configure it; the feature is opt-in per repo. No tax on the no-backing path.

The argument for **Option B (defer)** is honest but weaker:

- Phase 1 is already 5–6 weeks. Adding 1.5 makes the road to "prototype with shares" longer (10–11 weeks → 12–13 weeks).
- Operators who don't need GitHub backing get phase 2 + 3 sooner if 1.5 is deferred.

The deciding question: **does Chris want managed repos to be durably backed by GitHub from day one, or is "Lookie-Link-local with filesystem-level backups" good enough for the first 2–3 months?** If the former, lock in phase 1.5. If the latter, leave it as phase 4 and revisit.

### What this addendum does not change

Phase 1's content is identical to v3. The v3 confirmation (`confirmation:FON-10180:plan:f1db5aff-7ced-4784-b834-790917773971`) remains alive and is the active approval path for phase 1. This addendum surfaces the phase-1.5 design and the decision; locking in phase 1.5 would require a separate plan update (v4) and a separate confirmation, both of which can wait until after phase 1 approval lands.

### Risks specific to this feature

- **Credential storage is the highest-risk component.** A leak of a deploy-key or PAT gives an attacker write access to the operator's GitHub repo. Encrypted-at-rest with a key derived from operator-configured material (env var or HSM-backed) is the minimum bar; phase 1.5 documentation should walk operators through the security model.
- **Diverged states will happen.** Operators committing via the GitHub UI while agents are also writing will produce conflicts. The clear-conflict-surface design (audit log + UI alert + diverged state + manual resolution) is right, but operators have to be trained on it.
- **Push batching latency surprises.** A 60-second push interval means GitHub doesn't see new content for up to 60 seconds. For operators who expect immediate GitHub-side visibility, this is a surprise. Documentation has to be clear; `pushOnCommit: immediate` mode is the override.
- **GitHub rate limits.** A noisy managed repo with `pushOnCommit: immediate` can hit GitHub's per-installation rate limits. Batched mode is the default for this reason; phase 1.5 should monitor rate-limit headers and back off cleanly.

### Relation to FON-10193 (Syncthing + GitHub authority model)

This addendum is the **product-side mechanism** that supports any of the policy outcomes being decided in [FON-10193](/FON/issues/FON-10193) ("Decide Syncthing + GitHub authority model for git-backed repos"). The phase 1.5 design as currently written supports the full range of multi-machine sync architectures via the `syncMode` config (`bidirectional` vs `canonical`) and the `scheduling` config (`built-in` / `external` / `both`).

FON-10193's current hypothesis is:

> for Lookie-served repos, the Lookie host should ideally be the same machine that acts as the authoritative git publisher or guaranteed up-to-date mirror

The previous version of this addendum read that as "Lookie-Link is canonical, full stop" and tuned the defaults accordingly. That was wrong — Chris clarified in his follow-up comment that the canonical-only model is correct for **his** setup (because Syncthing handles state replication and only one machine talks to GitHub) but is **not** the right default for the product, where many operators will have multiple machines pushing to the same GitHub repo independently.

**Updated mapping of FON-10193 outcomes to FON-10180 phase 1.5**:

| FON-10193 outcome | Recommended `syncMode` for Lookie-served repos | What changes in phase 1.5 |
|---|---|---|
| **"Lookie-Link host is the authority for repos it serves (and other machines replicate via Syncthing or read-only)"** | `canonical` per repo where Lookie-Link is sole writer | Phase 1.5 ships unchanged; operators using this policy set `syncMode: canonical` and get the alert-on-divergence + force-push-reassert defaults. |
| **"Multiple machines remain independent git authors"** | `bidirectional` per repo | Phase 1.5 ships unchanged; operators using this policy keep the product default (`bidirectional` + `auto-rebase`). |
| **"Syncthing distributes among peers; one machine (the authority) talks to GitHub"** | `canonical` on the authority machine; managed repos without GitHub backing on the others | Phase 1.5 ships unchanged; same as the first outcome for the authority machine. |
| **"Hybrid by repo class — some repos are canonical-only, others are multi-writer"** | Per-repo `syncMode` choice | Phase 1.5 already supports this — `syncMode` is per-repo, not per-instance. |

In all four outcomes, phase 1.5's design is correct without modification. The policy choice in FON-10193 determines **which `syncMode` operators configure for which repos** — not whether the product supports either mode.

**Recommended sequencing**:

1. **Resolve [FON-10193](/FON/issues/FON-10193)** — the policy question. It is in `in_review` and is a small focused decision. The policy outcome determines how operators (including Chris) will configure their own repos; it does not change what phase 1.5 of FON-10180 builds.
2. **Decide FON-10180 phase 1.5 lock-in** — independent of FON-10193's outcome. Phase 1.5 either lands now (in which case operators get `syncMode` as a configurable choice) or it's deferred to phase 4 (in which case managed repos stay Lookie-Link-local with no GitHub backing).

The two decisions are **no longer coupled in design**. They are still useful to make together because they answer related operator questions, but FON-10193's outcome no longer dictates phase 1.5's design.

The phase 1.5 lock-in / defer decision is now standalone:
- **Lock in**: get durable GitHub backing for managed repos in ~1–2 weeks, with operator-selectable sync mode per repo. Total timeline: phase 1 (5–6 wks) → 1.5 (1–2 wks) → 2 (1–2 wks) → 3 (3 wks) = ~10–13 weeks.
- **Defer**: ship phase 1 → 2 → 3 first (~10–11 weeks), revisit GitHub backing in phase 4 once operational experience tells you whether the durability gap matters.

---

## Addendum 2026-06-01e — Cloud agents, canonical-store framing, file versioning, and the database question

This addendum responds to Chris's fifth comment, which surfaces four substantive items:

1. **Cloud-hosted agents using the API.** *"Agentic tools 'in the cloud' could benefit from this, like an OZ [OpenAI?] agent being able to tweak files via API as well, for this whole concept I mean. Whether it's a git repo or not."*
2. **Lookie-Link as the canonical location.** *"Everything 'stays in sync' with this concept — the whole concept of the lookie-link API — because it then becomes some canonical location."*
3. **File versioning, Syncthing-style.** *"BUT, would we then want versioning? Like Syncthing, for example, has? To roll back changes? And how would these be stored?"*
4. **Database vs. over-complicating.** *"ULTIMATELY, do we need a database? Or are we over-complicating?"*

Each answered below.

### 1. Cloud-hosted agents using the API

**The design already supports this. The transport (public reachability) is the gating concern, not the API surface.**

Cloud-hosted agents — OpenAI's hosted code-interpreter agents, ChatGPT custom GPTs with actions, Cursor's cloud workers, OpenClaw cloud instances, Claude API agents calling tools, n8n / Zapier-style automation, the Paperclip cloud control plane — are functionally identical to local-tailnet agents for the purposes of Lookie-Link's write surface. They authenticate with an API key (bearer token), hit the same `/api/repos/<repo>/files/<path>` and `/api/publish` endpoints, get the same audit log entries (`actor.type: agent`), and operate within the same permission model. **Phase 1A's API key model is designed for this exact use case** — that's why API keys are owner-attributed, long-lived, rotatable, and never tied to a browser session.

What does need to be in place for cloud agents to actually reach a Lookie-Link instance:

- **Public HTTPS reachability**. The Lookie-Link instance has to be on a hostname the cloud agent can resolve and reach over the public internet. Tailnet-only deployments don't work for cloud-agent calling. This is the [FON-7058](/FON/issues/FON-7058) Pangolin work (or equivalent — Cloudflare Tunnel, ngrok, a public VPS, etc.).
- **Valid TLS**. Cloud agent runtimes typically refuse self-signed certs. Let's Encrypt via the reverse proxy is the standard answer.
- **CORS** if the cloud agent's runtime calls Lookie-Link from a browser-context environment. Phase 1A's session/auth design should set sensible CORS defaults (block by default, allow operator-configured origin allowlist).
- **Inbound rate limiting** that's strict enough to not become a public DDoS target. Phase 1's existing rate-limiting plans (per IP / per API key / global) cover this.
- **OpenAPI + agent.json discovery** so cloud agent runtimes that consume those formats (everyone moving in that direction) can self-configure against the instance. Phase 2 ships this.

**No new phase scope is needed for cloud-agent support specifically.** What changes is the **operator's expected deployment topology**: instead of "Lookie-Link on the tailnet only," it's "Lookie-Link on the tailnet for human / local-agent calls, AND publicly reachable for cloud-agent calls." [FON-7058](/FON/issues/FON-7058)'s work is now strictly more strategic, because it's not only "credentialed-share recipients can reach the instance" but also "cloud agents can reach the instance to write."

This further strengthens the prior recommendation to pick up [FON-7058](/FON/issues/FON-7058) in parallel with phase 3 — or even earlier if cloud-agent writes are an immediate need.

### 2. "Lookie-Link as canonical content store, sync-to-other-systems as configurable plugins"

This is a useful **conceptual reframe** of the entire managed-repo + publish + sync design. The current document body and addendum b describe the storage primitives bottom-up (managed-repo is one thing, publish is another, sync is a feature on managed-repo). The cleaner top-down framing:

**Lookie-Link is a canonical content store.** Agents, users, and external systems read and write content via the Lookie-Link API. The instance's storage is the source of truth.

**Synchronization to other systems is a configurable plugin set.** Each managed repo can opt into one or more sync mechanisms:

| Sync plugin | What it does | When operators choose it |
|---|---|---|
| **None** (default) | Storage is purely Lookie-Link-local | Transient content; the operator owns filesystem-level backups |
| **GitHub remote** | Bidirectional / canonical git-sync to a GitHub repo (Addendum d) | Long-lived content; want durable backup + collaborator access via GitHub UI |
| **Syncthing peer** (future) | Lookie-Link acts as a Syncthing endpoint; other machines replicate via the Syncthing protocol | Multi-machine deployments where Syncthing is the team's existing replication choice |
| **S3 / object store mirror** (future) | Periodic snapshot to an S3 bucket | Operators wanting cheap durable backup without GitHub semantics |
| **External webhook** (future) | Lookie-Link calls an operator-configured webhook on every write, with the file payload | Operators wanting to wire content writes into custom downstream pipelines (search indexes, knowledge bases, etc.) |

In this framing:

- The **canonical content store** is what Lookie-Link IS. Not a viewer-with-write-mode; a content store with a render-friendly surface.
- The **sync plugins** are how the canonical store talks to other systems. Each plugin is independent. Operators mix and match per repo.
- The **rendering pipeline** (markdown, code, YAML, audio, etc.) operates on the canonical store. Render works regardless of which sync plugins are active.
- The **public-share modes** (Addendum c) and **search API** (Addendum b) also operate on the canonical store. They are surfaces, not storage.

This framing doesn't change phase 1's content. It does sharpen the marketing and product positioning. The README opener (which Addendum c recommended updating) should lead with "canonical content store for multi-agent + multi-machine workflows," not "private-network file viewer." Phase 1 of the implementation is what makes the new framing honest.

Phase 1.5 (Addendum d) is **the first sync plugin** under this framing. Subsequent sync plugins (Syncthing peer, S3 mirror, external webhook) can land as later phases without architectural surgery — they all conform to the same plugin contract: read from the canonical store, write to it when the remote source moves, emit audit events for both directions.

### 3. File versioning à la Syncthing — should we?

**Yes. As an opt-in per managed repo. Without requiring git backing.**

Currently the design provides versioning in two ways:

| Mechanism | Where | What it gives you |
|---|---|---|
| Optional git backing (Addendum b) | Per managed repo with `git.enabled: true` | Full git history, branch / diff / blame, restore any historical version |
| Append-only publish revisions | Publish-area slugs | Each `POST /api/publish/<slug>` update is a numbered revision; old revisions remain reachable via `?version=<n>` |
| `expectedMtimeMs` stale-write detection | All writes | Concurrency control, not versioning — protects against accidental overwrite of newer content, doesn't give you history |

**The gap**: managed repos without `git.enabled` have no versioning at all. Just current state. An agent that mistakenly overwrites a file has destroyed the prior content. That's a real product hole if Lookie-Link is the canonical store.

Syncthing's approach is the right model — it's been operationally proven in this exact class of system (multi-machine sync with rollback). Their options are: `none`, `simple` (one prior version per file), `staggered` (decreasing density of versions over time), `trash can` (only deleted files preserved), `external` (custom command).

Proposed design — **`.versions/` sidecar layer per managed repo, opt-in**:

```yaml
managedRepos:
  agent-research:
    versioning:
      policy: staggered          # none (default) | simple | staggered | trash-can | external
      maxAge: 90d                # for staggered; how far back to keep versions
      maxCount: 50               # per-file cap regardless of age
      storagePath: .versions/    # relative to repo root; hidden from /view/ rendering
      excludeGlob: ["*.lock", "*.tmp"]   # don't version these
```

Storage shape — for managed repo `agent-research` at path `/managed-repos/agent-research/`:

- File `docs/research.md` is currently version 7
- On overwrite, the prior version is copied to `/managed-repos/agent-research/.versions/docs/research.md/2026-06-01T20:42:33.123Z.md` (timestamp + original extension)
- Periodic cleanup runs per the policy

API surface — added to managed-repo endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/repos/<repo>/files/<path>/versions` | List versions: timestamp, size, hash, who wrote it (from audit log lineage) |
| `GET /api/repos/<repo>/files/<path>/versions/<id>` | Get a specific historical version's content |
| `POST /api/repos/<repo>/files/<path>/restore?version=<id>` | Restore a historical version as the current file (creates a new version for the current state first) |
| `DELETE /api/repos/<repo>/files/<path>/versions/<id>` | Manually purge a version (operator only) |

Versioning operates independently of git backing. Operators can enable both:

- Git backing gives full commit history with diff/blame at the repo level
- File versioning gives simple per-file rollback without git semantics

Both are useful in different contexts:

- An agent overwrites a file by mistake → use file versioning to restore the most recent prior version (one click, no git knowledge)
- A teammate wants to see how a doc evolved over a quarter → use git history (diff between commits)

Implementation is **small**: write a copy on overwrite to a sidecar dir, schedule cleanup. ~2-3 days of implementation including the API endpoints. ~1 week including docs + tests.

**Storage cost**: this is the honest trade-off. For a managed repo with frequent agent writes to large files, version history can balloon. Operators tune `maxCount` and `maxAge` per repo. Default policy choices:

- `none` (default) — no versioning; minimum storage
- `simple` (recommended starter) — one prior version per file; bounded storage
- `staggered` (Syncthing's smart default) — full recent history, sparse older history
- `trash can` — only versions deleted files (still useful for accidental deletes; cheaper than file versioning)

**Where it slots**: I recommend adding it to phase 1B's managed-repo write endpoints as a sub-feature. It's tightly coupled to writes (every write becomes "write current to versions, then write new") and there's no clean separation. Adding it later is possible but means refactoring the write endpoints.

| Option | Effort | Trade-off |
|---|---|---|
| **A. Phase 1B addition** | +1 week to phase 1B (now 5–6 weeks instead of 4–5) | Phase 1 grows to 6–7 weeks calendar time, bounded by 1B. Ships as part of the prototype. |
| **B. Phase 1.6 (alongside or after 1.5)** | 1 week as a standalone phase | Phase 1 ships at 5–6 weeks unchanged; versioning lands shortly after. Refactor cost is small if the write endpoints are designed with the future in mind. |
| **C. Defer to phase 4** | Park the design | Managed repos without git backing have no rollback for the first several months. Bad UX hole. Recommended against if the canonical-store framing is the headline. |

**My recommendation**: **Option A — add it to phase 1B.** The canonical-store positioning (point 2 above) doesn't hold up if "agent overwrites a file by accident" is unrecoverable. Phase 1B going from 4–5 to 5–6 weeks is a small price for closing that hole. Phase 1's calendar time goes from 5–6 to 6–7 weeks, bounded by the longer 1B track.

### 4. "Do we need a database? Or are we over-complicating?"

Honest answer: **yes, SQLite. No, this isn't over-complicating — it's the minimum for a serious product.**

Let me itemize what state the design needs to track and where it should live:

| State | Right home | Why |
|---|---|---|
| **Managed-repo content files** | Filesystem | The files ARE the content. Storing them in a database makes no sense. |
| **Git history (`.git/` per managed repo)** | Filesystem | Same — git owns its own storage. |
| **File version sidecars (`.versions/`)** | Filesystem | Versions are also content; storing in filesystem is the right answer for the same reason as the live files. |
| **Publish-area content** | Filesystem | Same as managed-repo content. |
| **Audit log** | Filesystem (JSONL, append-only) OR SQLite | Either works. SQLite gets you queryability (e.g., "all writes by agent X this week") that JSONL doesn't. JSONL is simpler to operate. Recommendation: JSONL for v1, migrate to SQLite if queryability is needed. |
| **Search index** | SQLite (fts5) | Already chosen in Addendum b. |
| **Users + sessions + SSO records** | SQLite | Multi-row relational data with queries (lookups, joins, indexes). The only sane choice. |
| **API keys (metadata; hashed secrets only)** | SQLite | Same. Owner attribution, rotation history, last-used tracking. |
| **Share tokens + share records** | SQLite | Same. Expiry queries, audit lookup, revocation. |
| **Magic-link tokens** | SQLite or signed JWTs | Both work. SQLite means the token state is server-controllable (instant revoke); JWTs mean stateless but you can't instantly revoke. SQLite is the recommendation. |
| **Push queue (persistent across restarts)** | SQLite | Operations queue with ordering, retry counts, transitions. Database-shaped. |
| **Managed-repo sync state (conflict state, fetch cursor)** | SQLite | Multi-row state per repo; SQLite is the right answer. |
| **Managed-grant records (existing from FON-3671)** | Currently file-backed (`access.grants.storePath`); can migrate to SQLite | Phase 1A is the right window to migrate this if migration is wanted; not required. |
| **Operator-facing configuration** | YAML config files (existing) | Config is human-edited; stays in YAML. |
| **Render output cache (if added)** | Filesystem or SQLite | Either works; phase 4 concern. |

**SQLite specifically** (not Postgres, not MySQL, not anything else):

- **Single-process embedded.** No separate database service to run. Critical for both self-hosted operators (don't make them install Postgres) and SaaS deployment (don't run a separate DB tier).
- **File-backed.** A `lookie-link.db` file. Backups are file copies. Fits the project's existing "files on disk" mental model.
- **Battle-tested.** Powers iMessage, Firefox, Android, every embedded system worth naming. Reliability is not in question.
- **Node ecosystem ready.** `better-sqlite3` is the standard, synchronous, fast, fits Express's middleware patterns.
- **fts5 included.** The search index from Addendum b uses the same database, no extra moving parts.
- **No operational complexity.** Single file. No replication, no clustering, no high-availability story (the operator's filesystem backup IS the HA story).

**Why this isn't over-complicating:**

The alternative is "everything in JSON files." That works at very small scale (where Lookie-Link is today). But at the scope under discussion — users / sessions / API keys / share tokens / push queue / sync state / search index — JSON files become brittle. Concurrent writes need locking. Queries are linear scans. Transactional consistency is manual. Operational tooling (backup, restore, migrate) is custom. You eventually rebuild SQLite, poorly.

The alternative on the other end is "Postgres / MySQL / a real database service." That IS over-complicating for this product class. Operators have to run a separate DB tier, manage credentials, handle network access. SaaS deployment costs balloon. The benefits (replication, sharding) are for a class of system Lookie-Link explicitly is not.

SQLite sits exactly in the right spot for this product's scale and operational model. **One file. Zero operational tax. Everything queryable, transactional, recoverable.** That's the right minimum.

**What this means for phase 1A**: phase 1A's effort estimate (2–3 weeks) already assumed sqlite for sessions / users / API keys (couldn't reasonably be anything else). This addendum just makes that explicit. No phase 1A scope change.

**What this means for phase 1B**: search index was already sqlite-fts5. Push queue + sync state move to the same database. No phase 1B scope change beyond the file-versioning addition discussed in point 3.

**What this does NOT mean**: a separate "database choice / setup" child issue. SQLite is the implementation choice within the existing phase 1A and 1B issues. It does mean a single new doc item — `docs/DATABASE.md` covering the schema, migration policy, backup recommendation, and the JSONL-vs-SQLite audit log choice. That can be a small addition to phase 1A's docs item or its own tiny issue.

### Net effect on phase 1

Summary of what this addendum changes in phase 1:

| Item | Change |
|---|---|
| Phase 1A scope | No change — SQLite was already implicit |
| Phase 1B scope | **+1 week** if file versioning is locked in here; phase 1B becomes 5–6 weeks; phase 1 calendar time becomes 6–7 weeks |
| Database choice | Explicit: SQLite, file-backed, embedded. Docs item to capture. |
| Cloud-agent transport | No phase change; reinforces FON-7058's strategic weight |
| Conceptual framing | "Canonical content store with sync plugins" becomes the headline framing; README opener (in Addendum c's plan) should reflect this |

Two new decisions for Chris (independent of the phase 1.5 GitHub-backing decision still open):

1. **File versioning**: lock into phase 1B (Option A — phase 1 grows 1 week) / split as phase 1.6 (Option B — phase 1 unchanged, versioning ships after) / defer to phase 4 (Option C — leave the rollback hole open for several months).
2. **Audit log storage**: JSONL files (simpler) or SQLite tables (queryable). Recommendation: JSONL for v1, migrate to SQLite if querying becomes needed. Low-stakes; can default to JSONL and not bother Chris.

### "Are we over-complicating?" — direct answer

No. Each piece earns its place:

- **Identity + SSO + API keys** (phase 1A) — the build is "good not minimum" per the commitment signal. You can't refactor auth in retrospect without pain.
- **Managed repos + search + publish** (phase 1B) — solves the original FON-10180 pain point and powers the multi-agent canonical-store positioning.
- **GitHub backing** (phase 1.5, lock-in pending) — durability for content the operator cares about long-term.
- **File versioning** (this addendum, lock-in pending) — closes the "agent overwrite is unrecoverable" hole that the canonical-store framing exposes.
- **SQLite** — the right minimum for a real product. Not over-engineering.
- **Three public-share modes** (phase 3) — answers the actual range of operator share scenarios (anonymous quick-share, audited external collaborator, full team member access).
- **CLI + agent.json** (phase 2) — distribution surface; without it the API is invisible to agent runtimes.

What's deliberately NOT in scope and would be over-complicating:

- Multi-tenant SaaS infrastructure (rejected since v1).
- Embedding / semantic search (deferred to phase 4).
- Real-time collaborative editing (Notion-style; deferred indefinitely).
- Plugin system for custom renderers (could be tempting; deferred — current renderer covers the cases).
- Multi-IdP SSO beyond WorkOS (deferred — WorkOS itself supports SAML / OIDC / multi-IdP via one integration).
- GitHub App as auth mode (deferred to phase 4; deploy keys + PAT cover the case).
- The Syncthing peer / S3 mirror / webhook sync plugins (later phases under the new framing).
- Notification systems, ChatOps integrations, custom dashboards (defer indefinitely).

The total phase-1 commit (5–6 weeks → 6–7 weeks with file versioning) is meaningful but is the right size for the build Chris committed to. The product that results IS a serious agent-native canonical content store. The alternative — a minimum-viable read where every piece gets cut — produces something that has to be rebuilt within a year. That would be the actual over-complication, paid in refactor cost rather than upfront cost.

---

## Addendum 2026-06-01f — Backup model (SaaS + OSS); is backup the versioning?

This addendum responds to Chris's sixth comment: *"AND as a SaaS, a backup model??? To S3, however I'd do it on the SaaS host? Worth building this method into the open source model too most likely? Maybe the backup IS the versioning somehow?"*

Three questions, each answered below.

### 1. SaaS backup model — yes, load-bearing

If Lookie-Link runs as a SaaS hosting customer data (managed-repo content, publish artifacts, SQLite state), **backup is non-negotiable**. The customer is paying for durability they don't have to think about; losing their content because the host disappeared is a contract-ending failure.

The right SaaS backup model:

- **Target**: S3 (or any S3-compatible object store the SaaS operator chooses — AWS S3 for AWS-hosted deployments, R2 for Cloudflare, B2 for Backblaze, etc.).
- **Encryption**: client-side, before upload. The backup target operator (Amazon, Cloudflare, Backblaze) never sees plaintext. Per-tenant encryption keys, managed by the SaaS operator (Lookie-Link Inc). Customer never sees the keys; the SaaS operator's recovery procedures handle key access.
- **Schedule**: continuous incremental (every write triggers an async upload of the changed object, encrypted) + periodic snapshots (e.g., every 15 minutes, retained per a tiered policy: 24 hourly, 30 daily, 12 weekly, 24 monthly).
- **Cross-region**: at least one secondary target in a different region for disaster recovery. The SaaS operator chooses the regions.
- **Restore**: customer-facing UI for self-serve restore of any file to any prior point-in-time snapshot, with reasonable retention limits. SaaS operator runs the disaster-recovery muscle (full-instance restore from secondary region) without customer involvement.
- **Customer-facing surface**: a dashboard showing last backup time, retention coverage, and a one-click restore. Customer never sees the bucket; the backup is invisible infrastructure.

This is the operational discipline a paying customer expects. It is not a feature — it is the durability promise.

### 2. OSS backup — yes, same mechanism exposed as operator-configurable

Building the backup mechanism for the SaaS and not exposing it to OSS operators would be a missed product opportunity. Self-hosted operators want backup that "just works" — they don't want to roll their own with cron + rsync + GPG + retention scripts. Pattern-matching the OSS-alternative comparables surveyed in the companion docs: Plausible, Mattermost, Sentry, Outline all ship first-class backup in their OSS distributions.

OSS backup design:

- **Operator configures targets via YAML**: any S3-compatible endpoint (AWS, R2, B2, Wasabi, MinIO, Garage, etc.); local rsync to a mounted filesystem for homelab / NAS deployments; or both for belt-and-suspenders durability.
- **Operator owns encryption key**: argon2id-derived from operator-configured passphrase or env-var-injected raw key. SaaS operator's key-management story is not the OSS operator's story; OSS keeps it simple.
- **Operator picks schedule and retention** via YAML config.
- **Restore via the same UI surface** as SaaS — operators get the self-serve point-in-time restore experience.
- **No telemetry, no phone-home**: backup runs entirely within the operator's environment. The OSS distribution never knows whether backup is configured.

The mechanism is identical between SaaS and OSS at the code level. SaaS just configures it with the SaaS operator's defaults and key-management; OSS exposes the config knobs to the operator. **Single implementation, two configurations.**

### 3. "Maybe the backup IS the versioning somehow?" — partial yes, but the honest answer is complementary layers

Useful intuition. Let me unpack it carefully.

**Where the intuition is right**: a backup at time T contains the state of every file at time T. If you have backup checkpoints every 15 minutes for the last 30 days, you implicitly have 30 days of file history at 15-minute granularity. Asking "what was file X like 3 days ago?" is the same operation as "fetch the file from the 3-day-old backup checkpoint." If the backup is content-addressed (each unique file blob stored once by hash, à la restic / borg / kopia / git's object store), the storage cost is also minimized through dedupe.

**Where the intuition is incomplete**:

- **Granularity**: backup checkpoints run on a schedule (every 15 minutes is the SaaS sweet spot). An agent that writes to a file 10 times between checkpoints leaves only one prior version recoverable (the state at the last checkpoint). Per-write granularity matters for "the agent just made a mistake; restore the version from 90 seconds ago."
- **Restore latency**: `.versions/` sidecar is a local filesystem read (milliseconds). Backup restore is a remote S3 fetch (seconds to tens of seconds for a single file, minutes for an instance restore). The rollback UX wants the fast path; disaster recovery wants the durable path.
- **Availability without backup configured**: a self-hosted operator who hasn't configured a backup target has no versioning if the only mechanism is backup. The `.versions/` sidecar layer (Addendum e) works regardless of backup configuration.

**Recommended architecture: complementary layers with a unified API surface.**

| Layer | What it gives you | When it kicks in |
|---|---|---|
| **`.versions/` sidecar** (Addendum e, phase 1B) | Per-write granularity. Fast local rollback. Works without any backup target. Recent-history window bounded by retention policy. | Every overwrite produces a sidecar version. Cleanup runs per the policy. |
| **Backup to object store** (this addendum, phase 1.7) | Periodic snapshot granularity. Slower restore. Requires backup target configured. Long-history window (months/years), durable across host loss. | Every snapshot interval, plus continuous incremental for the SaaS model. |
| **Unified API surface** | The agent / user doesn't care which layer holds a given prior version | `GET /api/repos/<repo>/files/<path>/versions` returns both sources merged + ranked by recency, with origin tag (`source: local | backup`). Restore from either is one endpoint. |

This is more robust than either layer alone. The recent-history fast-path is local; the long-history durable-path is in the backup target; the API hides the distinction.

A future architecture (phase 4+) could refactor managed-repo storage to be content-addressed (each blob keyed by hash; current state is a path-to-hash pointer table). In that world, backup and versioning collapse architecturally — the backup IS the content-addressed store, and `.versions/` becomes redundant. But this is a real rearchitecture, not a phase-1 thing. The complementary-layers approach gets there incrementally without prematurely committing to the more complex storage model.

### Design

#### Targets

```yaml
backup:
  enabled: true
  
  targets:
    - id: primary-r2
      type: s3
      endpoint: https://<accountid>.r2.cloudflarestorage.com
      bucket: lookie-link-backups
      prefix: instance-foo/
      region: auto
      credentialKey: backup-r2-key       # references credential in encrypted store
      encryption:
        algorithm: aes-256-gcm
        keySource: env:BACKUP_ENCRYPTION_KEY  # or vault:... / file:... / passphrase:...
    
    - id: secondary-b2
      type: s3
      endpoint: https://s3.us-west-001.backblazeb2.com
      bucket: lookie-link-backups
      prefix: instance-foo/
      credentialKey: backup-b2-key
      encryption: { ... }
    
    - id: local-nas
      type: local-rsync
      path: /mnt/nas/lookie-link-backups
      encryption: { ... }                # still encrypt local backups for at-rest protection
```

Three target types in v1:

| Type | What it is | When to use |
|---|---|---|
| `s3` | Any S3-compatible API (AWS S3, R2, B2, Wasabi, MinIO, Garage, ...) | The recommended default. Works for SaaS, works for self-hosted operators with cloud accounts. |
| `local-rsync` | rsync to a mounted filesystem | Homelab / NAS deployments without object storage. Cheap, reliable, but doesn't protect against host-site disaster. |
| `restic` (future) | Use restic as the backup engine | Deferred — restic is a separate binary dependency. Once added, gets dedupe + encryption + snapshots out of the box. |

Multiple targets can be configured simultaneously (primary + secondary, cloud + local, etc.). Backup runs in parallel against each target; success is reported per target.

#### Encryption

Client-side, before upload. Algorithm: AES-256-GCM (authenticated encryption). Key source is operator-configurable:

| Source | When right |
|---|---|
| `env:` | Operator manages the key as an environment variable (recommended baseline) |
| `vault:` | Operator uses HashiCorp Vault or equivalent KMS (recommended for production) |
| `file:` | Operator stores the key in a file on disk (acceptable for homelab) |
| `passphrase:` | Argon2id-derived from operator-supplied passphrase (acceptable for low-stakes deployments) |

**Lookie-Link never sees the plaintext encryption key in any persistent storage.** The key lives in memory while backup operations run; persistence is via the key source the operator chose.

For SaaS: per-tenant keys, managed by the SaaS operator's KMS. Customer plaintext never touches the backup target.

#### Schedule

```yaml
backup:
  schedule:
    continuous: true                  # async upload on every write (in addition to snapshots)
    snapshotInterval: 15m             # full-instance snapshot cadence
    snapshotRetention:
      hourly: 24
      daily: 30
      weekly: 12
      monthly: 24
```

**Continuous mode**: every write to a managed repo, the publish area, or SQLite triggers an async encrypted upload of the changed object(s). Recovery point objective (RPO) is bounded by upload latency (typically seconds). Recommended for SaaS.

**Snapshot mode**: at each `snapshotInterval`, Lookie-Link takes a consistent point-in-time snapshot of the entire backed-up state and uploads it under a snapshot identifier. Retention policies prune older snapshots per the tiered schedule.

Both can be enabled together (continuous for low-RPO; snapshots for clean point-in-time recovery markers).

#### What gets backed up

- All managed-repo content paths (live files + `.versions/` sidecars)
- Publish-area content
- `lookie-link.db` (SQLite — consistently snapshotted via the SQLite backup API)
- Operator config files (excluding plaintext secrets, which live in the encrypted credential store separately)
- Git histories of managed repos with `git.enabled: true` (so restore is a real git history, not just current state)

Explicitly **not** backed up:

- Render output caches (regenerable)
- Search index (regenerable from content)
- Build / runtime artifacts (none in current design)

Plaintext credentials are excluded by default. Encrypted credential blobs (from the encrypted credential store) are included so a full restore can resume sync to GitHub / SMTP / SSO providers; the decryption key is restored separately (operator's responsibility under their existing key-management).

#### Restore

API surface:

| Endpoint | Purpose |
|---|---|
| `GET /api/backup/snapshots` | List available snapshots across targets with timestamps and target id |
| `GET /api/backup/snapshots/<id>` | Get a snapshot's metadata (size, contents summary) |
| `POST /api/backup/restore?snapshotId=<id>&scope=<all|repo:X|path:Y>` | Restore from a snapshot; scope-restricted to avoid full-instance restore by mistake |
| `POST /api/repos/<repo>/files/<path>/restore?version=<id>` | Restore a single file, version can be a `.versions/` id OR a backup snapshot id (unified per the recommendation above) |
| `GET /api/backup/status` | Last backup time per target, next scheduled snapshot, current state |

Restore operations are operator-permission-gated (`manage_backup`, new permission, operator-only by default).

#### Sync-plugin framing (continuity with Addendum e)

Backup-to-S3 is **the second sync plugin** under the canonical-store-with-sync-plugins framing introduced in Addendum e. It joins:

| Sync plugin | Direction | Phase |
|---|---|---|
| GitHub remote | Bidirectional (or canonical outbound) | 1.5 (Addendum d) |
| **S3 backup** | **Outbound, periodic + continuous** | **1.7 (this addendum)** |
| Syncthing peer | Bidirectional, real-time | Future |
| External webhook | Outbound, per-write | Future |

Each plugin has its own configuration, credentials, scheduling, conflict semantics. They all hang off the same canonical store. Operators mix and match per repo (or globally for backup, which applies instance-wide).

This is conceptually clean: backup is not a special feature; it is one of N sync mechanisms the canonical store supports.

#### Failure modes

- **Backup target unreachable**: continuous uploads queue locally (SQLite-backed); snapshots that fail to upload retry on the next interval. Audit log + UI alert if persistent.
- **Credentials expired or revoked**: same as auth-expired for GitHub backing. Audit + alert + operator-action-required.
- **Encryption key unavailable at upload time**: backup pauses, audit + alert. Writes to Lookie-Link still succeed; backup resumes when key is available.
- **Backup state file corruption**: rebuild from the backup target's manifest; non-fatal.
- **Restore from a corrupted snapshot**: detected via integrity hashes; snapshot marked corrupt; fall back to a prior snapshot.

#### Auth implications

New permission added to the model from Addendum c:

| Permission | Granted to | Allows |
|---|---|---|
| `manage_backup` | Operator role only by default | Configure targets, manage credentials, trigger manual snapshot, perform restore |

Agents do **not** get `manage_backup`. Backup is operator-controlled infrastructure.

New audit actor type:

| Actor shape | When emitted |
|---|---|
| `{ "type": "backup", "operation": "snapshot" \| "continuous-upload" \| "restore", "targetId": "..." }` | Backup operations initiated by Lookie-Link itself |

Distinct from agent / user / git-sync actions.

### Phase slotting

Two options:

**Option A — Phase 1.7 (recommended for SaaS commitment).** Lands after phase 1.5 GitHub backing (if locked in) and before phase 2 CLI. 2–3 weeks of focused work, 5 child issues:

1. Backup target abstraction + S3 implementation + credential storage integration
2. Local-rsync target implementation
3. Backup scheduler (continuous + snapshot modes, retention policy enforcement)
4. Restore endpoints + UI (snapshots list, point-in-time restore, scope-restricted restore)
5. Docs: `docs/BACKUP.md` covering targets, encryption, schedule, restore procedure, OSS vs SaaS configuration differences

Phase 1.7 adds 2–3 weeks to the timeline; total to "prototype with shares" becomes ~13–16 weeks (with phase 1.5 GitHub backing and file versioning in 1B).

**Option B — Defer to phase 4.** Self-hosted operators use filesystem-level backup as a stopgap (rsync the entire Lookie-Link host on a cron, do file-level restore manually). The SaaS launch (if/when it happens) becomes blocked on shipping the backup mechanism before opening to paying customers. Total to "prototype with shares" stays ~10–13 weeks.

**My recommendation: Option A (phase 1.7)** because:

- If Lookie-Link is on a serious-product trajectory (Chris's commitment signal), backup is not optional — it's the durability promise.
- The mechanism is identical between SaaS and OSS at the implementation level. Building it once during phase 1.7 unlocks both.
- 2–3 weeks is a small marginal cost relative to phase 1's 5–6 weeks. The total commit becomes ~13–16 weeks for a substantially more durable product.
- Self-hosted operators get a first-class backup story without waiting for "later." The OSS-alternative comparables (Plausible, Mattermost, Sentry) all shipped first-class backup early; following that pattern is right.
- Deferring backup means starting to take real content (Chris's research, agent-generated artifacts) before a recovery path exists. That's a reversal cost if the host has a hardware failure or a misconfigured `DELETE` operation in early use.

The argument for Option B is honest: phase 1 + 1.5 + 1.7 + 2 + 3 starts to add up. A stopgap of "back up the host's filesystem with the operator's existing tools" works for the first months. If Chris explicitly wants the shortest path to phase-2 distribution surface and is comfortable with the operational stopgap, defer is reasonable.

### Risks specific to backup

- **Encryption key management is the highest-risk component.** A lost encryption key means the backup is unrecoverable; a leaked key means an attacker who has access to the backup target can decrypt everything. Phase 1.7 documentation should walk operators through the key-management options and recommend `vault:` for production, `env:` with strong rotation discipline as a minimum.
- **Continuous-upload bandwidth cost.** Operators with constrained upload bandwidth (residential connections, mobile uplinks) will feel continuous mode. Default to snapshots-only for self-hosted with continuous as an opt-in; SaaS deployments get continuous by default.
- **Restore footgun.** A full-instance restore that's mistakenly aimed at the wrong snapshot can roll back hours of legitimate work. Scope-restricted restore endpoints (single file, single repo) are the default surface; full-instance restore requires explicit `?scope=all` and a confirmation step.
- **Object-store API cost.** Frequent small uploads to S3 (continuous mode) can produce thousands of PUT requests per day. Per-target cost monitoring is operator-visible; defaults batch small writes to reduce cost.
- **SQLite consistency.** SQLite backup must use the SQLite backup API or `VACUUM INTO` for consistency, not just a file copy of a database that's open for writes. Phase 1.7 must get this right.

### Net effect on phase planning

| Phase | Without phase 1.7 | With phase 1.7 |
|---|---|---|
| 1 (incl. 1A+1B with versioning) | 6–7 weeks | 6–7 weeks (unchanged) |
| 1.5 (GitHub backing, if locked in) | 1–2 weeks | 1–2 weeks |
| 1.7 (backup) | — | **2–3 weeks** |
| 2 (CLI + agent.json) | 1–2 weeks | 1–2 weeks |
| 3 (three share modes) | 3 weeks | 3 weeks |
| **Total to "prototype with shares"** | **~11–14 weeks** | **~13–16 weeks** |

The marginal cost of backup is bounded. The marginal value is large: the product becomes a serious canonical store that operators can trust with content, both in self-hosted and SaaS modes.

### Decisions now open for Chris

Four independent lock-in / defer decisions, each of which phase 1 ships unchanged regardless:

| Decision | Default if not picked | My recommendation |
|---|---|---|
| Phase 1.5 GitHub backing (Addendum d) | Defer to phase 4 | **Lock in** |
| File versioning placement (Addendum e) | Defer | **Phase 1B (Option A)** |
| Audit log storage (Addendum e) | JSONL for v1 | JSONL for v1 (low stakes) |
| **Phase 1.7 backup (this addendum)** | **Defer to phase 4** | **Lock in (Option A)** |

If all three lock-ins land (1.5 + 1B-versioning + 1.7), the prototype-with-shares timeline becomes ~13–16 weeks. The product that ships is a serious canonical content store with durable backing, versioning, GitHub sync, identity, search, publish, CLI, and three share modes. That is the build worth doing for the operator's own use, the open-source distribution, and a future SaaS — all on the same code base.

---

## Addendum 2026-06-01g — Syncthing as a backup target (and Chris was right)

This addendum responds to Chris's seventh comment: *"Maybe we use Syncthing FOR the backup since it has the versioning anyway???"*

**Short answer**: yes, for self-hosted operators — Syncthing is an excellent backup mechanism that solves backup + versioning + cross-machine replication in one tool that already exists. **But**: SaaS deployments where Lookie-Link Inc. hosts customer data don't fit the Syncthing peer-to-peer model and still need S3-backed backup. Phase 1.7's right design is **both target types from one abstraction**, not "Syncthing replaces S3."

This sharpens Addendum f's design rather than replacing it.

### Why Syncthing is genuinely good for backup-as-versioning

Syncthing already has, mature and battle-tested, every property Addendum f's custom backup design was reaching for:

| Backup concern | Custom S3 design (Addendum f) | Syncthing |
|---|---|---|
| Continuous replication | Custom: every-write async upload | **Built-in**: continuous file sync between peers |
| Periodic snapshots | Custom: 15-min snapshots, tiered retention | **Built-in**: versioning policies (simple / staggered / trash-can / external) |
| Encryption | Custom: AES-256-GCM client-side | **Built-in**: TLS in transit; encrypted folders for untrusted receivers |
| Peer discovery + NAT traversal | N/A (S3 endpoint is known) | **Built-in**: discovery, introducer, relay |
| Cross-region / multi-target | Custom: configure multiple S3 targets | **Built-in**: send to N peers; each peer has its own retention |
| Conflict handling | Custom: state machine for divergence | **Built-in**: per-file conflict markers + reconciliation |
| Restore UX | Custom: API + UI for point-in-time | Via Syncthing's `.stversions/` directory (file-system-native) |
| Cost | S3 storage + egress | **Zero** (just the operator's bandwidth + receiver storage) |
| Operational complexity | Operator manages S3 credentials + KMS | Operator runs Syncthing as a sidecar (already mature) |

For a self-hosted operator who is comfortable running an extra process, this is **substantially less work** than the custom S3 design — and provides equivalent or better functionality for versioning + replication + backup.

Chris's insight is correct: **backup-as-versioning collapses cleanly when the backup mechanism already has versioning**. Syncthing is the right tool for this collapse in the self-hosted case.

### Why SaaS still needs S3-backed backup

The Syncthing model doesn't fit a SaaS where Lookie-Link Inc. is hosting customer data. Reasons:

1. **SaaS backup is centrally operated by the SaaS provider.** Customers expect "you handle backup, don't make me think about it." Syncthing's peer-to-peer model puts the receivers somewhere — either with the customer (who doesn't want to operate them) or with Lookie-Link Inc. (which is fine but is just "running Syncthing receivers" rather than "running a backup service"). The standard SaaS pattern of "encrypted backup to managed object store" doesn't naturally map onto Syncthing.

2. **Object storage is the SaaS economics.** S3 / R2 / B2 are dirt-cheap per GB for long-retention backup. Syncthing-receiver storage is a VM or a NAS — same cost class as primary compute, much more expensive per GB at retention scales.

3. **Recovery procedures want standard tooling.** When something fails in production, the on-call engineer wants `aws s3 cp` and a familiar restore runbook. Syncthing-based recovery is unfamiliar territory for most SREs.

4. **Compliance posture.** Many compliance regimes (SOC 2, ISO 27001, HIPAA-adjacent) have well-trodden patterns for "encrypted backups to a versioned object store with documented retention." Syncthing-based backup has fewer industry templates.

5. **Cross-region durability.** S3 cross-region replication is a one-config-line setup. Syncthing's equivalent (peers in different regions) works but is more operationally intensive at the SaaS scale.

For self-hosted operators, none of these matter (or matter less). For SaaS, all of them matter.

### Right design: both target types from one abstraction

Phase 1.7 (Addendum f) ships **a backup target abstraction**. Target implementations:

| Target type | What it is | Primary use case |
|---|---|---|
| `s3` | Any S3-compatible API with custom scheduler + retention + encryption | SaaS deployments; self-hosted operators with object-storage accounts; operators who want a familiar industry-standard backup path |
| `syncthing-peer` | **Lookie-Link knows how to coexist with a Syncthing folder watching its content paths**, surfaces Syncthing-side versioning in the unified versions API, and reads Syncthing's `.stversions/` directory for restore | **Self-hosted operators with Syncthing already in their stack (Chris's case)**; homelab operators who want backup + replication + versioning in one free tool |
| `local-rsync` | rsync to a mounted filesystem | Homelab / NAS deployments without object storage AND without Syncthing |
| `restic` (future) | restic as the backup engine | Self-hosted operators who want dedupe + encryption + snapshots from a familiar tool |

Operators can configure **multiple targets simultaneously**. A self-hosted operator might use `syncthing-peer` for live replication + recent versioning AND `s3` for long-retention encrypted off-site backup. A SaaS deployment uses `s3` primary + `s3` secondary cross-region.

### Syncthing-peer target — design

Lookie-Link doesn't bundle Syncthing or run it as a subprocess. The integration is **coexistence + introspection**:

1. **Operator configures Syncthing externally** to watch the Lookie-Link data directories (`managed-repos/`, `published/`, optionally `lookie-link.db` — though SQLite-while-open replication has caveats).
2. **Operator declares the Syncthing folder in Lookie-Link config**, telling Lookie-Link where Syncthing's `.stversions/` directory lives (per-folder by default).
3. **Lookie-Link reads `.stversions/` on demand** when the unified `GET /api/repos/<repo>/files/<path>/versions` endpoint is queried. Syncthing-managed versions appear in the result alongside `.versions/` sidecar entries (Addendum e) and S3 snapshot entries (Addendum f), each tagged `source: local | backup | syncthing`.
4. **Restore from a Syncthing version** copies the file from `.stversions/` back to its live path. Same endpoint as other restore sources.
5. **Lookie-Link does NOT manage Syncthing's lifecycle** — start, stop, peer configuration, version policy all stay in Syncthing's domain. Operator owns Syncthing the same way they'd own any infrastructure component.
6. **Backup status surface** in Lookie-Link's admin UI reports "Syncthing folder seen, last version: X minutes ago" by inspecting the folder timestamps. This is honest health-reporting without taking ownership of Syncthing.

```yaml
backup:
  enabled: true
  targets:
    - id: syncthing-primary
      type: syncthing-peer
      folderPath: /managed-repos                      # the path Syncthing is watching
      versionsPath: /managed-repos/.stversions        # Syncthing's versions directory
      managedExternally: true                          # operator runs Syncthing themselves
      healthChecks:
        maxVersionAge: 24h                             # alert if no new versions within this window
        checkInterval: 5m

    - id: cold-s3
      type: s3
      endpoint: https://<accountid>.r2.cloudflarestorage.com
      bucket: lookie-link-backups
      prefix: instance-foo/
      credentialKey: backup-r2-key
      encryption: { ... }
      schedule:
        continuous: false
        snapshotInterval: 6h
        snapshotRetention:
          daily: 30
          weekly: 12
          monthly: 24
```

The example: live versioning + replication via Syncthing (fast, free, frequent), plus a cold-storage S3 backup every 6 hours for long-retention off-site durability. Both targets active simultaneously.

### Implementation cost vs. the pure-S3 design

Phase 1.7 with Syncthing-peer added as a target type:

| Phase 1.7 sub-deliverable | Effort vs. Addendum f |
|---|---|
| Backup target abstraction | Unchanged |
| S3 target implementation | Unchanged (~1 week) |
| Syncthing-peer target implementation | **+0.5–1 week** (small: read `.stversions/`, surface in unified versions API, restore by copy, health check) |
| Local-rsync target implementation | Unchanged (~0.5 week) |
| Scheduler + retention | Unchanged (only applies to S3 + rsync targets) |
| Restore endpoints + UI | Unchanged |
| Docs covering Syncthing config recipe | **+0.5 week** (a recipe doc, screenshots, Syncthing version policy recommendations) |

Net phase 1.7 effort: 2.5–3.5 weeks (up from 2–3 weeks). Still small.

The investment is right-sized because Syncthing-peer is genuinely the right backup mechanism for a meaningful operator segment (homelab, single-operator self-hosted, hobbyist) and adds zero ongoing maintenance to Lookie-Link.

### Implication for the `.versions/` sidecar (Addendum e)

Open question: **if Syncthing has versioning, do we still need the `.versions/` sidecar?**

Honest answer: **yes, default-on, for three reasons**:

1. **Per-write granularity.** Syncthing's versioning happens when the file syncs to a peer — typically within seconds, but bounded by sync latency. For "agent overwrote the file 90 seconds ago, restore the version from 95 seconds ago," `.versions/` sidecar is faster and finer-grained.

2. **Available without any backup configured.** A self-hosted operator who hasn't set up Syncthing OR S3 still gets local versioning from `.versions/`. The default UX is "rollback works out of the box."

3. **No external dependency.** `.versions/` is a Lookie-Link feature; Syncthing is an external dependency. Operators who don't want the operational complexity of running Syncthing still get versioning.

For operators who DO run Syncthing, they can disable `.versions/` (`versioning.policy: none`) and rely on Syncthing's `.stversions/` for all versioning. The unified `GET /versions` API serves either source equally well.

The default policy stays `simple` (one prior version per file) — small storage cost, fast rollback, works regardless of backup. Operators who run Syncthing can flip to `none` if they want to avoid double-storage.

### Sync-plugin framing updated

The canonical-store + sync-plugins framing from Addendum e now has explicit positioning for Syncthing:

| Sync plugin | Direction | Phase | Backup-capable? |
|---|---|---|---|
| GitHub remote | Bidirectional (or canonical outbound) | 1.5 (Addendum d) | Partial — git history serves as a backup of sorts; not a clean disaster-recovery substitute |
| S3 backup | Outbound, periodic + continuous | 1.7 (Addendum f) | **Yes, primary SaaS backup mechanism** |
| **Syncthing peer** | **Bidirectional, real-time** | **1.7 (this addendum)** | **Yes, primary self-hosted backup mechanism** |
| Local-rsync | Outbound, scheduled | 1.7 (Addendum f) | Yes, homelab fallback |
| External webhook | Outbound, per-write | Future | No (write-side notification, not backup) |

Operators pick the sync plugins that fit their deployment. The canonical store is the source of truth; sync plugins are how the canonical store talks to the rest of the world.

This is now a complete first-pass sync-plugin landscape. Future plugins (e.g., S3 + restic combined, Tigris, IPFS, Borg) can land as later phases without architectural surgery.

### Updated phase 1.7 lock-in question

The decision Chris was already asked stays the same — lock in phase 1.7 or defer to phase 4 — but the **content** of phase 1.7 is now richer:

| Option | Effort | What it ships |
|---|---|---|
| **A. Phase 1.7 with both S3 + Syncthing-peer** (recommended) | 2.5–3.5 weeks; 6 child issues | Backup target abstraction + S3 target + Syncthing-peer target + local-rsync target + unified versions API + restore UI. Operators pick the mix that fits their deployment. SaaS launch unblocked. Self-hosted Syncthing operators (Chris) get optimal experience. |
| **B. Phase 1.7 with S3 only** (Addendum f's original scope) | 2–3 weeks; 5 child issues | S3-based backup only. Syncthing operators can still run Syncthing externally; Lookie-Link just doesn't integrate with it. Versions API doesn't surface Syncthing's `.stversions/`. |
| **C. Phase 1.7 with Syncthing-peer only** | 1.5–2 weeks; 4 child issues | Syncthing-peer target only. SaaS launch is blocked on shipping S3 backup later. Self-hosted operators without Syncthing have no first-class backup. |
| **D. Defer to phase 4** | Phase 1.7 not built. Self-hosted operators use Syncthing externally with no Lookie-Link integration. SaaS launch blocked. |

**Recommendation: Option A.** The additional 0.5–1 week to add the Syncthing-peer target is small relative to the value:

- Self-hosted operators with Syncthing get the optimal experience (Chris's case)
- Self-hosted operators without Syncthing get S3-based backup
- SaaS gets the durable S3-based backup it requires
- The sync-plugin framing is complete and the architecture is honest

### Net effect on the cumulative plan

Phase 1.7 grows from "S3 backup" to "backup with multiple target types including Syncthing-peer." Effort grows from 2–3 weeks to 2.5–3.5 weeks. Total timeline with all lock-ins (1.5 + 1B-versioning + 1.7-with-Syncthing) becomes **~13.5–16.5 weeks** to "prototype with shares." Effectively unchanged from Addendum f's estimate, with substantially better fit for self-hosted operators (especially Chris).

### Updated decision list

The four lock-in decisions remain, with #4's content sharpened:

| Decision | Default if not picked | My recommendation |
|---|---|---|
| Phase 1.5 GitHub backing (Addendum d) | Defer to phase 4 | **Lock in** |
| File versioning placement (Addendum e) | Defer | **Phase 1B (Option A)** |
| Audit log storage (Addendum e) | JSONL for v1 | JSONL for v1 (low stakes) |
| **Phase 1.7 backup (Addendum f + g)** | **Defer to phase 4** | **Lock in (Option A — both S3 + Syncthing-peer target types)** |

If you (Chris) lock in all three substantive decisions (1.5 + 1B-versioning + 1.7-with-Syncthing), the prototype that ships in ~13.5–16.5 weeks is a serious canonical content store with: real identity + SSO, managed-repo + search + publish, optional GitHub backing, optional Syncthing-peer or S3 backup, per-write versioning, CLI + agent.json, three public-share modes. That is a product worth being proud of for your own use, the OSS distribution, and a future SaaS — all on the same code base.

Chris's "maybe we use Syncthing for backup" insight gets a clean architectural home: **Syncthing-peer is a first-class backup target type alongside S3.** The architecture supports both; operators pick what fits their deployment.
