# Lookie-Link as a Public, Hosted SaaS — Options Analysis

**Created**: 2026-05-16
**Status**: Active — options analysis, not committed strategy
**Purpose**: Explore what it would take to run a public, paid hosted version of Lookie-Link as a commercial service while keeping the MIT open-source core intact. Identify the engineering scope beyond the current OSS surface, the auth / multi-tenancy / abuse-control requirements, the open-core split, pricing positioning relative to `here.now` and adjacent products, and the conditions under which building this is worth doing.
**Companions**:
- [`competitors/here-now-vs-lookie-link-2026-05-16.md`](../competitors/here-now-vs-lookie-link-2026-05-16.md) — establishes the feature delta this doc commercializes.
- [`self-hosted-here-now-alternative-2026-05-16.md`](./self-hosted-here-now-alternative-2026-05-16.md) — focused analysis of the specific "be the open-source alternative to `here.now`" positioning, treated as its own thing rather than as one row in this doc's four-path matrix. **Recommended read after this one.**

## TL;DR

A hosted Lookie-Link SaaS is **technically achievable**, **commercially uncertain**, and **strategically optional** — not strategically necessary. The OSS project's value proposition is internally consistent without ever being commercialized; layering a paid service on top is a separate, larger product than the one that exists today.

The most credible commercial wedge is not "Lookie-Link, but on the public internet" — that's `here.now`'s lane and the deltas are small. The credible wedge is **"a hosted markdown / code / YAML / PDF / audio rendering surface with multi-repo, agent-token-scoped access, edit + save-back, and optional public-share — sold as a managed service for teams whose repos can't live on a vendor's static-hosting bucket."** That sentence is much further from `here.now` than "static site hosting for agents." It is *also* a much bigger build than a thin SaaS wrapper around the existing renderer.

Four paths emerge. Section "Decision framework" at the bottom of this doc lays them out.

## Question being explored

Could Lookie-Link sustainably support a hosted, public, paid service tier — keeping the open-source distribution as the canonical product, but offering an operated cloud version with auth, multi-tenancy, custom domains, and billing for users who don't want to self-host?

The question has three sub-questions:

1. **Engineering scope.** What needs to be built beyond what exists today?
2. **Open-core split.** Which capabilities stay MIT in the public repo, and which become commercial-only? What is the line that keeps the OSS core honest?
3. **Business shape.** What does the service charge for, who is the buyer, and what is the competitive position relative to `here.now` and adjacent products?

This doc takes each in turn, then closes with a decision framework.

## What "hosted Lookie-Link" would have to add

Lookie-Link today is a single-process Express server that reads a YAML config, mounts a small set of local directories, and serves rendered views to clients on a trusted private network. Promoting that to a public hosted service is not "the same product with internet exposure." It is a different product that *reuses the renderer*. The deltas:

### 1. Multi-tenancy

Today's mental model is "one operator, one machine, one config, one set of repos." A hosted service has many operators, many tenants, and isolation between them. That implies:

- **Tenant model.** Account → workspace → mounted repo(s). One tenant must not be able to see another tenant's files even with a path-traversal attempt.
- **Per-tenant storage.** Either each tenant gets a logical bucket in an object store (S3 / R2), or each tenant runs in an isolated filesystem on the host. Object store is the only realistic answer at scale; that means a storage abstraction has to land in the codebase so the render pipeline can pull from either local FS *or* object store transparently. This is the single biggest engineering item.
- **Per-tenant config.** Each tenant has their own theme defaults, their own repo mappings, their own enabled features.

### 2. Identity and auth

Today: no auth. The network is the access boundary. A hosted service needs:

- **Account signup.** Email + password at minimum; OAuth (Google/GitHub) for friction reduction. `here.now`-style "agent-assisted signup" via email verification code, so an agent can complete onboarding without a human in the loop.
- **Session management.** Browser cookies for human users, API keys for agents.
- **Per-tenant API keys** with scoped capabilities. The existing managed-grant model is a starting point but needs the same lifecycle as Stripe API keys: create, list, rotate, revoke, audit.
- **Read/write split** on tokens (this is already a recommended OSS improvement; it's mandatory in a hosted product).
- **Optional team accounts.** Multiple operators sharing one workspace, with per-user audit trails.

### 3. Public surface (DNS, TLS, custom domains)

Today: bind to a tailnet hostname, no TLS termination. A hosted service needs:

- **Wildcard DNS.** `<workspace>.lookie.link` (or whatever the domain becomes) routes to the right tenant.
- **Automated TLS.** Let's Encrypt / managed certs at the edge.
- **Custom-domain support.** Customer brings a domain, points a CNAME at the service, the service obtains a cert. This is a real engineering item (DNS validation flows, cert lifecycle, edge routing logic).
- **CDN / edge layer.** Static asset delivery should not hit the origin every time. Cloudflare in front is the default; the rendering pipeline has to be cache-friendly.

### 4. Storage backend

Today: local filesystem with `safeResolve()` boundary checks. A hosted service needs:

- **Object store.** S3 / R2 / equivalent for primary storage.
- **Per-tenant key prefixes** with bucket-level ACL discipline.
- **Concurrency model.** The existing `expectedMtimeMs` stale-write guard needs an ETag-based equivalent for object stores; same pattern, different primitive.
- **Versioning.** OSS today assumes git is the version control; a hosted service has tenants who aren't using git. The product either requires a git-backed workspace (one path), or owns its own versioning layer (another, larger, path).
- **Atomicity.** Temp-file-and-rename doesn't translate; object-store equivalents (multipart upload + finalize, or write-then-copy) are needed.

### 5. Abuse, moderation, and SRE

This is the part open-source maintainers most often underestimate. A public hosted service has:

- **Rate limiting.** Per-IP, per-account, per-API-key. Anonymous publishes (if offered) need their own quota story.
- **Content moderation policy.** What happens when someone hosts malware, phishing, CSAM, or trademark violations through your service. You will need a takedown process whether you offer anonymous publishing or not.
- **DMCA address and response process.**
- **TOS, privacy policy, AUP.** Real legal documents, ideally lawyer-reviewed.
- **On-call.** When the rendering service goes down, customers expect SLA-level response. This is a person + runbook + status-page commitment.
- **Backup and disaster recovery.** Object store durability + cross-region replication + tested restore.
- **Monitoring.** Latency, errors, abuse signals, billing reconciliation.
- **Security disclosure process.** Mailbox + response SLA + patch cadence.

### 6. Billing

- **Stripe integration** (or equivalent) for subscription billing.
- **Metering.** Storage GB, bandwidth GB, render requests / month — pick which dimensions matter and instrument them.
- **Per-tenant usage dashboards** so customers can see why they're being charged what they're charged.
- **Free-tier abuse controls.** Free signups attract abuse; figure out what stops a single actor from making 10,000 free accounts.

### 7. Admin and support

- **Admin console** for the operator to inspect tenants, suspend accounts, refund charges, debug.
- **Support inbox** with realistic SLA on customer questions.

### Honest scope estimate

A single engineer working full-time, with no other distractions, could probably get a *very minimal* MVP — single-tenant signup, S3-backed storage, basic auth, TLS, a Stripe checkout, no custom domains, no team accounts, no admin console — in **3–4 months**. To get to something that could responsibly take paying customers without burning the operator's nights and weekends, **6–9 months** of focused work is a more honest number. That estimate assumes the OSS renderer doesn't have to change much — but it almost certainly will need to, because the abstractions in `lib/renderer.js` and the path-safety code assume local FS, and lifting them to plug into S3 is not a one-day task.

## The open-core split

The hardest design decision in any open-core project is *what stays open*. The Lookie-Link OSS sentence — "self-hosted file viewer for AI-agent workflows on a private network" — is honest and complete. Sand off too much of it for commercial reasons and the OSS distribution loses trust. Leave too much in and the hosted version has no wedge.

A defensible split:

### Stays MIT in the OSS repo

- The full render pipeline (markdown, HTML, code, YAML, PDF, images, audio, themes, anchors, cross-links, lightbox, YouTube embed).
- Single-tenant config-driven mounting.
- The managed-grant model for agent tokens (single-instance scope).
- The edit-and-save-back pipeline.
- The grant projection writer.
- A `/.well-known/agent.json` + OpenAPI surface (added per the competitor doc's roadmap).
- A bounded "single-file public share" feature for self-hosted instances that operators choose to expose (also per the competitor doc).
- Single-binary or Docker-compose deployment guides.

The principle: **everything an individual or team can run themselves on their own hardware stays MIT**. The OSS distribution is fully usable without paying anyone anything, ever.

### Lives in the commercial service (not in the OSS repo)

- Multi-tenant account system + signup flows.
- Multi-tenant storage abstraction with object-store backend.
- Wildcard DNS + automated TLS + custom-domain provisioning.
- Stripe billing + metered usage.
- Hosted admin console, audit logs, support tooling.
- Public-internet abuse controls (rate limiters tuned for the hosted scale, takedown workflows, content moderation).
- Edge / CDN integration.
- Team-account UX for the hosted product.

These features have **no meaningful self-hosted value**. A single operator running their own instance does not need multi-tenancy. The commercial product's value isn't the code — it's the operated service.

### Things that are *not* open-core gates

A trap to avoid: gating *features the OSS user would expect*. A few principles:

- **Do not gate auth in OSS.** If a single self-hosted operator wants per-user accounts on their own instance, that should stay in the OSS distribution. The commercial service charges for *running it for you*, not for the right to have accounts.
- **Do not gate themes.** Themes are core UX.
- **Do not gate the rendering of any file type.** Adding a new renderer is a community-friendly contribution path; gating it is a hostile move.
- **Do not gate API access.** The OpenAPI surface is in the OSS distribution and stays that way.

The line is: *infrastructure operations* are commercial; *features* are not.

## Pricing positioning

`here.now` is the most direct comparable; pricing positioning has to start with their published structure.

### `here.now`'s structure (as captured in the competitor doc; verify before quoting downstream)

- **Anonymous tier:** 250 MB per file, 5 publishes/hour, 24-hour expiry. No account.
- **Free authenticated tier:** 5 GB per file, 60 publishes/hour, permanent, 10 GB total storage.
- **Paid tiers:** scaling up to 2 TB storage on a "Developer" plan, unlimited sites. Exact pricing not captured at the time of this analysis — re-verify.

The shape: an extremely generous free tier with a steep storage ceiling, paid tiers that buy storage and remove site-count caps. Bandwidth is not metered separately on the public docs at the time of capture.

### Three positions a hosted Lookie-Link could take

**Position A: "Same shape, different wedge."**

Match `here.now`'s tiering with comparable numbers, but compete on the *rendering pipeline* (markdown, themes, audio, PDFs) and on the *multi-repo workspace model* rather than on raw static hosting. The buyer is "an agent team that wants the agent's markdown/code/YAML output to render correctly without pre-rendering it." Risks: thin wedge, easily copied by `here.now` if they decide rendering matters.

**Position B: "Workspace-as-a-service."**

Reframe the product entirely. Don't sell "publish a site"; sell "a hosted workspace where your agents drop files and humans review them." The unit of value is the workspace, not the site. Pricing per workspace (-/mo), with storage and bandwidth bundled. Buyer is a team running a small fleet of agents that all need a place to drop deliverables. Wedge: nobody else is shaped like this, and the friction of "set up a tailnet, self-host the viewer" is real for teams that aren't comfortable with infra.

**Position C: "BYO storage with managed render."**

Charge for the rendering + auth + edge layer, but let customers bring their own S3-compatible storage bucket. Buyer is mid-market: teams that already have an object store, already have compliance posture around it, and just want the viewing surface as a service. Lower COGS for the operator (no storage costs), lower price point, narrower buyer.

### Pricing notes regardless of position

- **A free tier is required** for any consumer-facing or developer-facing product in this category. The free tier exists to seed the funnel, not to make money.
- **Charge for storage, not for renders.** Rendering is cheap; storage is durable cost. Bandwidth metering only matters at very high scale; defer.
- **Per-seat pricing kicks in at team accounts.** Solo operator: workspace-based pricing. Team: per-seat add-on or workspace-tier upgrade.
- **Don't compete on price with `here.now`.** They've set the anchor at "free, period, for the casual case." Anything trying to undercut that loses; anything competing on differentiation can charge more.

### Anti-patterns

- **Stablecoin payment gating** like `here.now`'s experimental feature. Don't follow them down that path. It signals "novelty," not "product."
- **Charging for the OSS distribution.** Don't. Ever.
- **Charging for a "support plan" without operating the service.** That's a different business (enterprise support / consulting). Don't blur the lines.

## Competitive positioning vs. `here.now`

If a hosted Lookie-Link launched tomorrow, it would *not* be a better `here.now`. They occupy different shape:

| Dimension | `here.now` | Hypothetical hosted Lookie-Link |
|---|---|---|
| Default artifact | A publish (immutable, slug-addressed) | A workspace (mutable, repo-shaped, browse-able) |
| Buyer | Agent / developer wanting a public URL fast | Team wanting a hosted review surface for agent output |
| Primary unit | The site | The workspace |
| Differentiation | Frictionless agent-facing publish | Renderer + multi-repo + edit + scoped tokens |
| Free-tier shape | Anonymous-friendly, expiring | Account-required, persistent within limits |
| When to pick it | One-off artifact share | Recurring review loop with the same content |
| Where it loses | If the artifact needs rich rendering | If the recipient just wants a URL and walks away |

The honest read is that `here.now` and a hosted Lookie-Link could **coexist** rather than compete. `here.now` is for one-off agent publishes; a hosted Lookie-Link would be for ongoing workspaces. If both sit on a team's agent-output stack, they don't displace each other.

The risk to plan for: `here.now` adds workspace-style persistence + a real rendering pipeline. They are well-positioned to do so. Time-to-market matters.

## Distribution and go-to-market

A few non-obvious points specific to this category:

1. **The OSS repo is the funnel.** Every star, every fork, every "self-hosted on Tailscale" deployment is a candidate hosted-tier conversion. The OSS distribution should make the hosted option visible (a "Run this on a managed instance" link in the README, never paywalled features in the OSS distribution).
2. **The agent ecosystem is the distribution channel.** Being a discoverable, install-with-one-command skill in Claude Code / Cursor / Codex marketplaces matters more than ad spend. `here.now` got this exactly right with their `heredotnow/skill` package; a hosted Lookie-Link should ship a parallel skill.
3. **Self-hosted operators are evangelists.** Treat them well — fast bug fixes, no surprise feature removal, clear roadmap — and they'll surface the hosted option to colleagues who don't want to self-host.
4. **Hosted-tier feature additions should backport to OSS where they're not infrastructure.** If the hosted version adds a new theme, a new renderer, a UI improvement — those go to OSS. Otherwise the OSS distribution decays into bait.

## Risks and the "should we even" question

Honest risks of running a hosted Lookie-Link service:

- **Operator time sink.** Running a public SaaS is a real ongoing commitment. On-call, support tickets, abuse reports, billing disputes, security disclosures. If the operator already has a full-time job, this is a serious quality-of-life decision, not just a financial one.
- **Liability.** A public hosted service has DMCA exposure, GDPR exposure, payment-processing exposure, and abuse-related exposure. Some of these are manageable (DMCA: have an agent on file, respond promptly); some are structural (GDPR: real data-handling discipline required).
- **Concentration risk.** A small SaaS lives or dies by a small number of customer relationships. The economics work or they don't, but it takes 6–12 months to find out.
- **Opportunity cost.** The same engineering capacity that builds the SaaS could build new OSS features that grow the funnel. Both are reasonable; only one is paid up-front.
- **Existential question.** If `here.now` (or anyone else) builds the workspace-shaped product first and well, the wedge collapses. Time-to-meaningful-differentiation matters.

## Decision framework

The right next move depends on the operator's situation. Four paths:

### Path 1: Skip — stay open-source-only

**When this is right:**

- The operator does not want a SaaS operations job.
- The OSS distribution is doing its job (private-network file viewer for agent workflows).
- No paying customer has explicitly asked for "managed hosting" yet.
- `here.now` plus self-hosted Lookie-Link covers the operator's own use cases adequately.

**Cost**: zero. **Upside**: zero. **Downside**: zero. This is the default and it's defensible.

### Path 2: Partner with `here.now`

**What this looks like:**

Reach out to `here.now`. Propose that they integrate the Lookie-Link rendering pipeline into their Sites primitive so a publish that's just markdown renders correctly without the agent pre-rendering it. Or propose a deeper integration where `here.now` Drives can be mounted into a Lookie-Link viewer. Reciprocal value: Lookie-Link gets distribution, `here.now` gets rendering capability without building it.

**When this is right:**

- The operator wants the renderer to reach more eyeballs than self-hosted Lookie-Link gets.
- The operator does not want to run a SaaS.
- The renderer is good enough to be valuable to `here.now` in its own right.

**Cost**: outreach + integration engineering (small).
**Upside**: distribution without operating costs; possible revenue share.
**Downside**: dependent on another small company's roadmap and continued existence.

### Path 3: Minimum-viable hosted instance — one workspace per customer, lightweight

**What this looks like:**

Don't build a multi-tenant SaaS. Build a *one-Lookie-Link-instance-per-customer* hosted offering, where each customer gets a managed VM running stock OSS Lookie-Link with a managed domain, TLS, backups, and an admin panel for repo mappings. The operator's job is provisioning, monitoring, and updates. Each customer pays a flat /mo for a managed instance.

**When this is right:**

- The operator wants some commercial validation without a multi-tenant rewrite.
- The customers are sticky and willing to pay for ops outsourcing.
- The volume is modest (single-digit or low-double-digit customers).

**Cost**: provisioning automation + monitoring + an admin UI. Much smaller than a multi-tenant SaaS. Probably 1–3 months focused work.
**Upside**: real revenue from a small number of paying customers, validates the demand without a full multi-tenant build.
**Downside**: unit economics get rough above ~20–30 customers (each one is a separate VM with separate cost and separate on-call obligation).

### Path 4: Full multi-tenant SaaS

**What this looks like:**

The 6–9 month build outlined in the engineering-scope section above. Object-store backend, multi-tenant auth, wildcard DNS, billing, abuse controls, admin console. Aimed at "Workspace-as-a-service" positioning (Position B from the pricing section).

**When this is right:**

- The operator has explicit signal — multiple potential customers asking for hosted Lookie-Link, ideally several willing to pre-commit.
- The operator can dedicate 6+ months of focused engineering capacity.
- A meaningful budget is available for the GTM motion that follows the build.
- The operator is willing to commit to operating it for 3+ years.

**Cost**: large engineering investment + ongoing ops + GTM spend.
**Upside**: a real commercial product line, defensible position if execution is good.
**Downside**: hardest path; failure mode is "spent 9 months on a SaaS nobody bought."

### Recommended sequencing

Most operators should start at Path 1 by default and only move to Path 2 or 3 when explicit signal arrives. Path 4 is only justified by either (a) clear customer commitments before any engineering is started, or (b) an operator who genuinely wants to be in the SaaS business as their primary work.

A reasonable practical sequence:

1. **Implement the OSS roadmap items** identified in [the here.now competitor doc](../competitors/here-now-vs-lookie-link-2026-05-16.md) — the agent.json + OpenAPI, the read/write token split, the bounded public-share. Cheap, accretive, makes the OSS distribution more visible to agents.
2. **Add a "managed hosting interest" link** to the README that captures email signups for a hypothetical hosted tier.
3. **Wait for explicit signal.** Don't build a SaaS speculatively. Build it when N real prospects (where N is "more than two, fewer than ten") have asked unprompted for managed hosting.
4. **If signal arrives, start with Path 3 (per-customer managed instances)**, not Path 4. Validate with a handful of paying customers before committing to a multi-tenant rewrite.

## Open questions deliberately not resolved here

This is options analysis, not committed strategy. The following are real questions that need answers before any commercial path is chosen, but they require facts this analysis doesn't have:

- **Who is the customer?** What team profile, what size, what problem urgency? Without a real ICP, pricing is guesswork.
- **What is the actual willingness-to-pay?** Even rough numbers from real conversations would change the analysis significantly.
- **Is `here.now`'s team open to partnership?** A 15-minute conversation could resolve a lot of the Path 2 vs. Path 4 question.
- **What is the operator's appetite for operating a public SaaS?** Half this analysis depends on the honest answer.

These belong in a private operator-side companion doc with real numbers — not in this public options analysis.

## Sources

- [Companion competitor analysis: `here.now` vs. Lookie-Link](../competitors/here-now-vs-lookie-link-2026-05-16.md)
- [Public canonical research on `here.now`](https://github.com/chrisfonte/operations-research/blob/main/ai-tools/here-now/here-now-instant-web-hosting-for-agents-2026-05-16.md)
- Open-core SaaS reference points worth studying before any commitment: Plausible Analytics, Sentry, GitLab, Mattermost, PostHog, Cal.com, Coolify, Appsmith. Each one made a different open-core split and pricing call; the patterns and the tradeoffs are well-documented in their public writeups.
