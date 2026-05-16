# Lookie-Link as a Self-Hosted `here.now` Alternative — Positioning Analysis

**Created**: 2026-05-16
**Status**: Active — positioning analysis, not committed strategy
**Purpose**: Evaluate the specific strategic option of positioning Lookie-Link as the open-source, self-hosted alternative to `here.now` — the way Plausible Analytics is to Google Analytics, Sentry was to Bugsnag, Mattermost is to Slack, or Coolify is to Vercel/Heroku. This doc takes the question seriously as its own thing rather than as one row in a four-option matrix.
**Companions**:
- [`competitors/here-now-vs-lookie-link-2026-05-16.md`](../competitors/here-now-vs-lookie-link-2026-05-16.md) — feature-level comparison; concluded "stay in lane, add bounded public-share." This doc revisits that recommendation against a different framing question.
- [`lookie-link-public-saas-options-2026-05-16.md`](./lookie-link-public-saas-options-2026-05-16.md) — four-path SaaS options analysis. This doc is effectively a fifth path that the previous doc folded into Path 1 ("skip — stay OSS-only") but which deserves separate treatment.

## TL;DR

"Self-hosted alternative to `here.now`" is a **real, well-precedented commercial category** distinct from "build a competing SaaS." It is the open-core pattern that Plausible, Sentry, Mattermost, PostHog, Cal.com, and Coolify have all monetized — open-source software that customers run themselves on their own infrastructure, sold via either (a) optional managed hosting, (b) enterprise-tier features, (c) support/consulting, or (d) some mix.

The case for adopting this positioning is **strong on three dimensions** (distribution mechanics, audience fit for privacy-conscious teams, low operational burden compared to building a SaaS) and **weak on two** (the most ergonomic part of `here.now`'s product — anonymous public publishes from any agent on the internet — does not translate cleanly to a self-hosted deployment, and Lookie-Link's actual differentiator is the renderer and edit pipeline, not the publish primitive). The honest answer is that **Lookie-Link can credibly host a self-hosted-`here.now`-shaped capability without becoming "the self-hosted `here.now`"** — and the choice of which framing to lead with is a marketing/positioning decision, not an engineering one.

This doc lays out the precedent category, what specifically would have to land in Lookie-Link to make the claim defensible, the cases where this framing is right vs. wrong, and a recommended sequencing.

## Why this question came up

The prior options analysis ([`lookie-link-public-saas-options-2026-05-16.md`](./lookie-link-public-saas-options-2026-05-16.md)) framed the commercial choice as four paths centered on whether to *operate a hosted SaaS*. Path 1 was "skip — stay OSS-only." That path was treated as the do-nothing default.

But "stay OSS-only" is **not the same as** "be the open-source alternative to a specific commercial SaaS." The former is a non-commercial posture; the latter is a deliberate commercial positioning that uses the OSS distribution as its primary product and monetizes via auxiliary services. These are different products, different growth models, different community contracts.

The reframe being explored here: *What if Lookie-Link's commercial story is not "build a competing SaaS" or "stay quietly OSS" but "be the open, self-hostable version of `here.now`"?*

That framing changes:
- What features are roadmap priorities (the publish primitive becomes load-bearing, not optional).
- How the OSS distribution is documented (a comparison page with `here.now` becomes a first-class artifact).
- What the auxiliary commercial offering looks like (optional managed hosting, optional enterprise features, optional support — not a multi-tenant SaaS rebuild).
- Where the project sits in the ecosystem (named alternative in a known category, not a niche tool).

## The precedent category: open-source self-hosted alternatives to commercial SaaS

This is one of the best-studied patterns in software commercialization. A short tour of comparables, framed by what they do and how they monetize:

| Project | Commercial-SaaS comparable | OSS license | How they monetize |
|---|---|---|---|
| Plausible Analytics | Google Analytics, Fathom | AGPL | Managed hosting + enterprise license |
| Sentry (pre-FSL) | Bugsnag, Rollbar | BSL (was Apache) | Managed hosting + enterprise tier |
| Mattermost | Slack | MIT (core) | Enterprise edition + managed cloud |
| PostHog | Mixpanel, Amplitude | MIT (core) | Managed cloud + enterprise features |
| Cal.com | Calendly | AGPL | Managed cloud + enterprise/team features |
| Coolify | Vercel, Heroku, Netlify | Apache 2.0 | Cloud-hosted version + sponsorships |
| Outline | Notion | BSL | Managed cloud + self-hosted enterprise |
| Excalidraw+ | Lucidchart, Miro | MIT (core) | Hosted "+" tier + integrations |
| Appsmith | Retool | Apache 2.0 | Cloud + enterprise tier |
| GitLab | GitHub | MIT (core, large) | Enterprise tiers + managed |
| Supabase | Firebase | Apache 2.0 + permissive | Managed cloud + enterprise |
| n8n | Zapier | Sustainable Use License | Cloud + enterprise |
| Listmonk | Mailchimp | AGPL | Donations; no commercial offering yet |

The pattern these share:

1. **The OSS project is the primary product, not a stripped-down loss leader.** Customers can run the full thing on their own infrastructure without paying. This is the load-bearing claim — break it and the category breaks.
2. **A specific closed-source SaaS is the named comparable.** "X is the open-source Y" is the positioning. Search rankings, press, conference talks, and HN threads all use that framing. It is **the** discovery mechanism.
3. **Monetization is via operations, not features.** The commercial tier is "we run this for you," "we support you running it," or "we provide enterprise-shaped affordances (SSO, audit, SLAs) that a small team running themselves doesn't need." Gating *features* that an OSS user expects breaks the category contract — Sentry's relicensing controversy is the cautionary tale.
4. **The OSS distribution is operationally credible.** A `docker-compose up` deployment that actually works is table stakes. If installing the OSS version is harder than signing up for the SaaS, the category positioning fails on impact.
5. **Privacy/sovereignty is the primary buying motivation.** The customer is either (a) at a company that can't put data on a third-party SaaS for compliance/legal/political reasons, (b) a hobbyist/homelabber who likes self-hosting, or (c) a developer who is suspicious of vendor lock-in. None of these audiences are price-sensitive in the way a generic SaaS customer is — they pick on principle, then optimize within that principle.

This is the category being considered. The next question is whether `here.now`'s primitive fits well into it.

## Does `here.now`'s primitive translate to self-hosted?

This is the key empirical question. Three sub-questions.

### Sub-question 1: Is there a real audience for "self-hosted `here.now`"?

There is, but the audience is not "everyone who would use `here.now`." It is a subset:

- **Privacy-sensitive teams** whose agents produce outputs containing customer data, regulated information, or competitive IP. These teams cannot publish an agent's HTML report to a third-party SaaS even with a password gate. They need the rendering surface inside their own perimeter.
- **Air-gapped or restricted environments** — finance, defense, healthcare — where the agent runs in an environment with no public-internet egress.
- **Hobbyists / homelabbers** who self-host on principle. This audience has shown willingness to adopt other self-hosted equivalents (Plausible, Mattermost, Coolify, Authentik). They are loud advocates and good ambassadors.
- **Vendor-lock-in skeptics** — people who don't want to bet a workflow on a small startup's continued existence. This is a more dispersed audience but contributes meaningfully to early adoption.
- **Teams already running Tailscale / a private mesh** for whom "private network" is the default deployment topology and "give the agent a public URL" is a square peg in a round hole.

The audience for the *original* `here.now` SaaS is broader than any of these — the convenience of `nlm publish` with no infrastructure is real and attracts users who would never bother self-hosting. The self-hosted audience is the **principled subset**, not the **convenience-seeking majority**. That's the structural reality of the category — Plausible's audience is also smaller than Google Analytics'. It is not zero, and it is willing to install software.

### Sub-question 2: Can Lookie-Link credibly cover what `here.now` covers?

This is where the analysis has to be honest about feature gaps. The [competitor doc](../competitors/here-now-vs-lookie-link-2026-05-16.md) walks through these in detail; the executive view:

**`here.now` capabilities that Lookie-Link covers today or trivially can:**

- Public URL for a rendered artifact → bounded public-share (roadmap item, small)
- Static file serving (HTML, PDF, images, audio) → already covered
- Markdown rendering → already covered (and Lookie-Link is better than `here.now` here)
- Themed presentation → already covered
- Bearer-token auth → already covered (managed-grant model)
- Custom hostname → covered for self-hosted operators who own DNS

**`here.now` capabilities that Lookie-Link does not cover and would have to build:**

1. **Slug-addressed immutable artifact (the "publish a Site" verb).** Today Lookie-Link mounts a tree; it doesn't have a notion of "an agent uploaded these files, lock them in, give me back a URL." This is the publish primitive. It is well-scoped (one new route group, one storage path) and is on the existing roadmap.

2. **`/.well-known/agent.json` + OpenAPI surface.** Cheap, on the roadmap, pure-upside.

3. **Anonymous-publish-style ergonomics.** The most ergonomic feature of `here.now` is that an agent with no credentials at all can publish something for 24 hours from a single HTTP call. Replicating this on a self-hosted instance is **architecturally fine but operationally fraught** — anyone with the URL of the self-hosted instance can publish. That is fine inside a tailnet (already the access boundary) but reduces to "the operator runs an instance and exposes it publicly" if the goal is "anonymous agents on the public internet can publish." Most self-hosted operators will not want this; some will. The right answer: **expose anonymous-publish as a config flag, off by default, with built-in rate limiting and an expiry timer**. Operators who want a public anonymous-publish endpoint can enable it on a public-facing instance; everyone else gets the safer default.

4. **Drives (scoped object storage).** This is a separate primitive from Sites. `here.now` bundles them; Lookie-Link doesn't have to. A v1 self-hosted-`here.now` can ship without Drives; the value proposition still holds because the primary `here.now` use case (publish a static artifact) is Sites, not Drives. A later Drives-equivalent is possible but is a real engineering project and should be deferred until there is a clear use case Lookie-Link's grant model can't cover. **Be explicit in positioning** — "self-hosted Sites" not "self-hosted Sites + Drives."

5. **Custom-domain provisioning with automated TLS.** For a self-hosted operator, this is "configure your reverse proxy" — not a feature Lookie-Link needs to own. `here.now` owns this because they're the cloud; Lookie-Link doesn't need to because the operator is.

6. **Edge / CDN.** Same — not Lookie-Link's problem. The operator's deployment topology owns this.

7. **Stripe-gated views / paid artifacts.** Skip. Not strategic. (`here.now`'s stablecoin-gating is experimental and weird; ignore.)

8. **Fork / remix of an artifact.** Not strategic for the self-hosted use case. Skip until asked for.

**The honest read on parity:** Lookie-Link can credibly claim to be a self-hosted alternative for *the primary `here.now` use case* (agent publishes a rendered artifact, gets a URL, hands it to a reviewer) after **one focused engineering pass**: the publish primitive, the `agent.json` + OpenAPI surface, the bounded public-share, the read/write token split, and the optional anonymous-publish config flag. The roadmap items are already on the table from the competitor doc. They just need to be sequenced and shipped under the umbrella of "self-hosted `here.now` v1."

The features Lookie-Link will not match in v1 (Drives, anonymous-by-default at scale, edge / CDN) are also the features the principled self-hosted audience cares about least.

### Sub-question 3: Is "self-hosted alternative to X" actually a defensible position when X is a small startup?

This is a subtler concern. The classic open-source-alternative-to-SaaS plays (Plausible, Mattermost, Sentry) named comparables that were already large, well-funded, name-brand companies. Naming yourself the alternative to a small, recent, possibly-fragile SaaS introduces some risk:

- **If `here.now` doesn't make it**, the comparable goes away. The positioning then has to migrate ("the open-source agent-facing publish service" rather than "the open `here.now`").
- **If `here.now` pivots dramatically**, the feature parity story has to keep moving.
- **If `here.now` itself open-sources or commodifies their core**, the category-naming play loses force.

But the risk is mostly upside-asymmetric:

- If `here.now` succeeds and grows, the open alternative grows with it (this is how Plausible benefited from Google Analytics' ubiquity).
- If `here.now` fails, Lookie-Link's underlying value (private-network agent file viewer with a publish surface) doesn't change. The positioning loses its anchor but the product doesn't.

There is also a more powerful version of the positioning: not "the open-source `here.now`" but **"the open-source agent file workspace"** with `here.now` named as the closest commercial comparable in marketing copy without being the brand handle. That's more durable.

## What this positioning would mean concretely

If "self-hosted `here.now` alternative" becomes a deliberate positioning, the following things change.

### Roadmap reshuffling

The items already identified in the competitor doc get reordered and accelerated:

1. **`/.well-known/agent.json` + OpenAPI surface.** Becomes table stakes (the category positioning requires that `here.now`-aware agent runtimes can hit the self-hosted instance the same way they hit `here.now`).
2. **Publish primitive (`POST /api/publish` with manifest + finalize).** Becomes load-bearing — without this, the "publish a Site" comparison fails immediately. Currently optional/considered; needs to ship.
3. **Bounded public-share for individual files.** Becomes table stakes for the same reason as #2.
4. **Read/write token split on grants.** Stays high-priority; the documentation will reference it as the equivalent of `here.now`'s read vs. write Drive tokens.
5. **Capability discovery endpoint** aligned with `agent.json` conventions. Stays straightforward.
6. **Optional anonymous-publish config flag.** New item — off by default, with built-in rate limiting and expiry, for operators who want to expose a `here.now`-style anonymous-publish endpoint on a public-facing instance.
7. **An `nlm`-equivalent CLI** (or named alongside, possibly `lookie publish` — pick a name). The `heredotnow/skill` package is a major distribution channel for `here.now`; the open alternative needs a parallel skill that drops into Claude Code / Cursor / Codex marketplaces.

Drives, edge / CDN, custom-domain provisioning, fork/remix, payment-gating are **deliberately out of scope** for v1. They can land later if signal warrants.

### Documentation changes

- **A "Compare to `here.now`" page** in the main docs (not the research repo) becomes a first-class artifact. Headline of the page: "What's the same, what's different, when each one is the right pick."
- **An `agent.json` block** documented in the README so a developer can confirm in five seconds that Lookie-Link advertises the same agent-facing surface.
- **A migration guide** ("Here's how to move from `here.now` to a self-hosted Lookie-Link") — this is the kind of doc that wins the category-positioning Google ranking.
- **Reframed README opener.** Today's positioning is correct but understated. A reframed opener: "Lookie-Link is an open-source, self-hosted file viewer for AI agent workflows — like a private `here.now` for your own network, with a richer rendering pipeline and live editing." (Wording to be refined; the structure matters more than the exact phrase.)

### Distribution mechanics

- **Listings on awesome-selfhosted, awesome-selfhosted-alternatives, awesome-AI-agents, awesome-claude-code-skills.** Each one is small individually; collectively they are the long-tail discovery path for self-hosted audiences.
- **Skill packages in agent-runtime marketplaces** (Claude Code, Cursor, Codex), parallel to `heredotnow/skill`. The skill should look at the active project and prefer a configured Lookie-Link endpoint, falling back to `here.now`-style anonymous publish only if no self-hosted instance is configured.
- **A "Show HN: open-source `here.now`" launch** when the v1 capability lands. This is the conventional GTM motion for the category and works well when the underlying product is real.
- **Strategic contribution** to projects in the agent ecosystem that need a publish surface (overnight-agent dashboards, evaluation result viewers, Terminal-Bench-style replay viewers). Each integration is a candidate evangelist.

### What the commercial offering looks like (if there is one)

The cleanest commercial wrapper for "self-hosted `here.now` alternative" is **optional managed hosting for operators who don't want to run it themselves**. This is the Path 3 ("per-customer managed instances") of the SaaS options doc — but the framing is different: it's not "we built a SaaS," it's "if you don't want to self-host this open-source thing, we run an instance for you."

Pricing is per-managed-instance, flat fee, possibly with a free or low-cost shared tier for individual hobbyists. Differential against `here.now`: Lookie-Link's hosted-by-the-project tier is a *backstop* for the OSS, not the main product.

Other monetization possibilities (any subset is viable):

- **GitHub Sponsors / Open Collective.** Coolify and Listmonk run on this; it doesn't scale to a full-time engineering team but it scales to "the maintainer can keep maintaining."
- **Enterprise edition with SSO, audit logs, multi-tenant team accounts.** Mattermost's model. Defer until a real enterprise prospect asks unprompted.
- **Support contracts.** A second business that is meaningfully different from the SaaS business. Less compatible with one-operator capacity.
- **No monetization at all.** Plausible operates a paid managed hosting tier; Listmonk doesn't. Both are viable for the OSS.

**Important constraint:** the moment any of these becomes the *main* business, the positioning starts to drift away from "open-source alternative" and toward "SaaS with an open-source loss leader." That's a different category and a worse one. The positioning works only if the OSS is the headline.

## Comparison: this positioning vs. the four paths in the prior options doc

The prior SaaS options doc laid out:

- **Path 1:** Skip — stay OSS-only
- **Path 2:** Partner with `here.now`
- **Path 3:** Per-customer managed instances
- **Path 4:** Full multi-tenant SaaS

The "self-hosted `here.now` alternative" positioning is most naturally a **deliberate version of Path 1** — staying OSS-only, but with sharpened positioning, sharpened roadmap, and a clear category placement. It is not zero-effort; it is the difference between "the project exists" and "the project is the named open alternative."

Relative to each path:

- **vs. Path 1 (passive OSS):** This positioning is *more deliberate*. Same nominal lane, much more focused execution. Strictly better than passive Path 1 for any operator who wants the project to actually grow.
- **vs. Path 2 (partner with `here.now`):** These are not exclusive. A partnership with `here.now` (e.g., "Lookie-Link integrates with `here.now` Drives") is compatible with positioning as the open alternative — same logic as Mattermost integrating with Slack, or Plausible offering Google Analytics import. Both are good.
- **vs. Path 3 (managed instances):** This positioning *includes* Path 3 as the optional commercial wrapper. They are layered, not alternatives.
- **vs. Path 4 (multi-tenant SaaS):** These *are* exclusive in spirit. A multi-tenant SaaS is a different product. The open-alternative positioning means the SaaS is auxiliary, not the headline.

**The honest reframe of the four paths:** the strongest commercial position for Lookie-Link is *Path 1 executed deliberately, with Path 3 as an optional sidecar, and Path 2 as a non-exclusive integration story*. Path 4 is the option the open-alternative positioning rules out.

## Risks and the "is this the right framing" question

Honest risks specific to this positioning:

- **Dilution of Lookie-Link's actual differentiator.** Lookie-Link is meaningfully better than `here.now` at rendering markdown, code, YAML, and audio, and at live editing. Positioning as "the open `here.now`" might lead a reviewer to compare on `here.now`'s strongest dimensions (anonymous publish, edge / CDN, frictionless onboarding) and miss the rendering / edit value. The marketing copy has to lead with the renderer-and-editor story and use `here.now` as the locator, not the headline.

- **Category-naming dependency.** As covered in sub-question 3 above: if `here.now` doesn't make it as a service, the positioning has to migrate. Manageable, not fatal.

- **Audience asymmetry.** The self-hosted audience is smaller than `here.now`'s SaaS audience. This is a feature, not a bug, but a reviewer comparing user counts will see Lookie-Link as the smaller project and may conclude "weak." The OSS-alternative pattern accepts this asymmetry by design — Plausible has fewer users than Google Analytics and it is fine.

- **Roadmap pressure.** Adopting the positioning means shipping the publish primitive, the `agent.json` / OpenAPI surface, and the bounded public-share. These are already on the roadmap, but elevating them from "nice to have" to "load-bearing for the positioning" creates real schedule pressure.

- **Marketing bandwidth.** "Open-source alternative to X" is the most effective positioning when it is consistently asserted — across the README, the docs, the launch post, the conference talk, the comparison page. Inconsistent assertion dilutes the category placement. The operator has to be willing to do the marketing work for the positioning to compound.

- **`here.now` reaction risk.** A small named-comparable startup may or may not appreciate the positioning. The conventional outcome (Plausible vs. Google Analytics, Mattermost vs. Slack) is that the larger party ignores the smaller. With a same-size or smaller comparable, the reaction is less predictable. Worth a brief courtesy heads-up if the positioning ships, more as good-citizenship than risk management.

## When this positioning is the right call

The framing is the right call **if and only if** the operator is willing to:

1. **Ship the load-bearing roadmap items** (publish primitive, `agent.json`, public-share, anonymous-publish flag) on a real timeline — 1–3 focused months of work, not 6+.
2. **Do the marketing work** to assert the positioning consistently (README, docs, comparison page, listings, skill package, launch post).
3. **Operate the OSS distribution credibly** — `docker-compose up` works, the install path is honest, breaking changes are documented, issues get triaged.
4. **Accept the smaller-audience trade**. The self-hosted audience will never be `here.now`'s audience; positioning works because of, not in spite of, that.
5. **Optionally** add a managed-hosting backstop (Path 3) for the subset of buyers who like the OSS but don't want to run it themselves.

The framing is the **wrong** call if any of:

- The operator does not actually want to do the marketing work (in which case the positioning is wasted and Path 1 passive is honest).
- The roadmap items can't be shipped in a focused timeframe (in which case "self-hosted alternative to X" is asserted without backing, and the category placement fails on first contact with a reviewer).
- The operator's actual ambition is to compete with `here.now` as a SaaS (in which case Path 4 is the honest path and the positioning is misleading).

## Recommended sequencing

If this positioning is adopted, the right order of operations:

1. **Ship `/.well-known/agent.json` + OpenAPI.** Smallest, on the roadmap, no commitment implications. Do this regardless of any positioning question.
2. **Ship the publish primitive (`POST /api/publish`).** This is the load-bearing feature. Until it ships, the positioning cannot be asserted credibly.
3. **Ship the bounded public-share for single files** with an unguessable slug, optional password, mandatory expiry. Off by default.
4. **Ship the read/write token split** on the grant model.
5. **Build the parallel agent-runtime skill** (`lookie-link/skill` or whatever the package name becomes). This is the discovery surface for agent users.
6. **Write the "Compare to `here.now`" doc** in the main docs, and the migration guide ("Move from `here.now` to a self-hosted Lookie-Link"). These are the SEO and category-placement artifacts.
7. **Reframe the README opener** to lead with the open-alternative positioning.
8. **Launch announcement** on HN / X / agent-focused Discords / agent-focused subreddits. "Show HN: open-source `here.now`."
9. **Apply for listings** on awesome-selfhosted, awesome-selfhosted-alternatives, awesome-AI-agents, awesome-claude-code-skills.
10. **Optional, later:** stand up a managed-hosting backstop (one or two paying customers; learn what they actually want before committing to anything else).

Total effort, end to end: **roughly 2–4 months of focused engineering + a few weeks of marketing prep, distributed across the timeline.** Considerably smaller than Path 4 (6–9 months for a SaaS) and considerably more deliberate than Path 1 passive (zero effort, zero positioning).

## Open questions deliberately not resolved here

These need facts this analysis does not have. They are the right things to find out before committing to the positioning:

- **Has `here.now`'s team thought about open-sourcing their core?** A quiet email could resolve a lot of the positioning question — if they plan to open-source, the alternative-to-X play is a bad bet against a moving target. Worth asking.
- **Is there an existing community of people self-hosting `here.now` workarounds?** Forums, Discords, or GitHub repos with names like "self-hosted here.now" or "open here.now" would change the urgency. As of capture, no such project is visible.
- **What is the operator's appetite for marketing work?** The positioning compounds only if it is asserted consistently. Honest answer required.
- **Is the renderer / editor pipeline more strategic than the publish primitive?** If yes, the headline may want to invert: "open-source AI agent workspace with rich rendering and live editing (and yes, `here.now`-style publishing too)." The framing question is real and deserves more thought than this doc gives it.

## Sources

- [Companion competitor analysis: `here.now` vs. Lookie-Link](../competitors/here-now-vs-lookie-link-2026-05-16.md)
- [Companion options analysis: Lookie-Link as a public hosted SaaS](./lookie-link-public-saas-options-2026-05-16.md)
- [Public canonical research on `here.now`](https://github.com/chrisfonte/operations-research/blob/main/ai-tools/here-now/here-now-instant-web-hosting-for-agents-2026-05-16.md)
- Comparables studied for the open-source-alternative-to-SaaS pattern: Plausible Analytics, Sentry, Mattermost, PostHog, Cal.com, Coolify, Outline, Excalidraw, Appsmith, GitLab, Supabase, n8n, Listmonk. Each makes a different open-core / monetization call; the patterns and tradeoffs are well-documented in their public writeups.
