# `here.now` vs. Lookie-Link

**Created**: 2026-05-16
**Status**: Active
**Purpose**: Decide where Lookie-Link should and should not try to match the agent-facing static-hosting service `here.now`, with the option of extending Lookie-Link to cover the same primitive (and more) on top of its existing file-viewer foundation.
**Source Type**: Hands-on understanding of Lookie-Link, plus the external research at [`here-now-instant-web-hosting-for-agents-2026-05-16`](https://github.com/chrisfonte/operations-research/blob/main/ai-tools/here-now/here-now-instant-web-hosting-for-agents-2026-05-16.md) (this is the public canonical doc; the lookie-link doc you are reading right now is the project-side companion focused on roadmap implications).

**Companion analyses** (commercialization angle):
- [`../commercialization/lookie-link-public-saas-options-2026-05-16.md`](../commercialization/lookie-link-public-saas-options-2026-05-16.md) — four-path SaaS options analysis.
- [`../commercialization/self-hosted-here-now-alternative-2026-05-16.md`](../commercialization/self-hosted-here-now-alternative-2026-05-16.md) — positioning analysis specifically for the "be the open-source alternative to `here.now`" play, distinct from the four SaaS paths.

> **Reading order.** The public canonical describes `here.now` end-to-end; this doc assumes you have skimmed it and asks the only question that matters for Lookie-Link itself: *should Lookie-Link try to be a here.now-shaped service, and if so, how?*

## TL;DR

`here.now` and Lookie-Link occupy *almost* the same conceptual primitive — "give the agent's output a URL" — but their threat models diverge so completely that they end up as different products:

| Dimension | `here.now` | Lookie-Link |
|---|---|---|
| Default reach | **Public web** (Cloudflare edge) | **Private network** (Tailscale-style mesh) |
| Default access policy | Public-but-unguessable URL; optional password | Implicit trust of the tailnet; optional token-scoped agent access |
| Persistence model | Per-publish immutable artifact | Live view of a directory tree on disk |
| Editing | None — re-publish to change | First-class — opt-in save-back, conflict detection |
| Markdown rendering | None — the publisher must pre-render | First-class — CommonMark, syntax highlight, cross-links, anchors |
| Storage backend | Object storage with presigned URLs | Local filesystem with `safeResolve()` boundary checks |
| Onboarding for the agent | Zero — anonymous publishes, 24h expiry | Zero on the publisher side — but the *viewer* must be on the tailnet |
| Inter-agent file handoff | Drives + scoped tokens | Managed Paperclip grants + grant projection writer |
| Revenue / scale model | SaaS with paid tiers | Self-hosted, MIT-licensed, single-binary-ish |

The honest read: **Lookie-Link is not a `here.now` competitor today**, and a straight feature-parity rebuild would dilute the project. But there is a *coherent extension* — a "publish view" mode that exposes a Lookie-Link rendering to a wider audience via a public URL — that would land Lookie-Link on the same primitive without losing what it currently is. The rest of this doc decomposes which parts of that extension are worth doing and which are not.

## Side-by-side feature map

Bucket-by-bucket comparison, using Lookie-Link's existing conceptual buckets.

### Browse

| | `here.now` | Lookie-Link |
|---|---|---|
| Directory listing | ❌ — sites are flat per publish | ✅ — directory listing with breadcrumbs |
| Multi-repo navigation | ❌ — each publish is a single bundle | ✅ — repo mappings, cross-repo `[[link]]` |
| Deep-link to a file's section | ⚠️ — only via the site's own anchors | ✅ — `/view/<repo>/<path>#<anchor>` |

**Reading**: 🟦 fundamentally different category. `here.now` doesn't try to be a browse surface at all — a publish is one bundle. Lookie-Link is "live mirror of a tree of repos." These are not comparable, and trying to make them comparable is the wrong move.

### Render

| | `here.now` | Lookie-Link |
|---|---|---|
| HTML rendering | ✅ — serves whatever you upload | ✅ — sanitized HTML view with Raw toggle |
| Markdown rendering | ❌ — must pre-render | ✅ — CommonMark + extensions, themed |
| Syntax-highlighted code | ❌ | ✅ — highlight.js, theme-aware |
| YAML rendering with anchors | ❌ | ✅ — anchor links on every key |
| PDF viewer | ✅ — serves the file | ✅ — embedded viewer page |
| Image lightbox | ❌ | ✅ |
| Audio playback | ❌ | ✅ — inline `<audio>`, themed player page |
| Themes | ❌ | ✅ — 10 built-in, dark/light, custom-via-YAML |
| YouTube embeds | ❌ | ✅ — sandboxed |
| Auto-linkified URLs | ❌ | ✅ |

**Reading**: ❌ one but not the other. Lookie-Link is overwhelmingly the more capable renderer. The `here.now` design assumes the publisher (the agent) produced finished HTML; the Lookie-Link design assumes the publisher (also the agent) wrote markdown / code / YAML and wants it rendered for them. Both designs are internally consistent. Lookie-Link should not give up the rendering pipeline; it is the reason the project exists.

### Share

| | `here.now` | Lookie-Link |
|---|---|---|
| Public URL | ✅ — global edge | ❌ — tailnet only |
| Password-gated URL | ✅ | ❌ — uses agent token model instead |
| Custom domain | ✅ | ⚠️ — bind to any hostname you control, but no first-class custom-domain UX |
| Forkable artifact | ✅ | ❌ |
| Payment-gated artifact | ⚠️ — experimental stablecoin | ❌ |
| 24h-expiry anonymous publish | ✅ | ❌ |

**Reading**: ✅ here.now is the more capable sharing surface, by design. This is the cell where the most coherent Lookie-Link extension lives — see the roadmap section below.

### Edit

| | `here.now` | Lookie-Link |
|---|---|---|
| Edit existing artifact in place | ❌ — re-publish to change | ✅ — opt-in editable mode |
| Concurrency control | ❌ — last-writer-wins per publish | ✅ — `expectedMtimeMs` / 409 Conflict |
| Atomicity | ⚠️ — finalize step | ✅ — temp file + rename |
| Preview before save | ❌ | ✅ — debounced preview pane |

**Reading**: ❌ one but not the other. Lookie-Link is "agent and reviewer collaborate on a living document." `here.now` is "agent ships an immutable artifact." Different products, same nominal primitive.

### Access control

| | `here.now` | Lookie-Link |
|---|---|---|
| Agent-scoped token | ✅ — Drive tokens, path-restricted | ✅ — managed Paperclip grants with audit history |
| Read-only vs. write tokens | ✅ | ⚠️ — grant model is grow-and-expire, not split read/write |
| Path-prefix restriction | ✅ | ✅ — repo-and-path tokens |
| Cross-org guardrails | ❌ | ✅ — Paperclip grant rejected outside allowed filesystem roots |
| Public-but-unguessable URL | ✅ — default | ❌ |
| Password gate | ✅ | ❌ |

**Reading**: ⚠️ partial overlap. Both have a scoped-token model; the threat models differ. `here.now` is built for "the URL is public-by-default, control access with a token or password." Lookie-Link is built for "the network is trusted-by-default, control access with a token only when crossing org boundaries." Neither is wrong; they answer different deployment realities.

### Persistence

| | `here.now` | Lookie-Link |
|---|---|---|
| Versioning | ⚠️ — Drive versions, but each Site publish is a new artifact | ❌ — relies on git |
| ETag concurrency | ✅ — on Drive operations | ⚠️ — `expectedMtimeMs` for edits, not for reads |
| Durable storage SLA | Implicit; vendor-managed | Whatever the host filesystem provides |

**Reading**: ❌ one but not the other. `here.now`'s versioning lives at the artifact level; Lookie-Link assumes the underlying tree is git-tracked and lets the VCS own history. This is the right call for the projects Lookie-Link serves.

### Agent API

| | `here.now` | Lookie-Link |
|---|---|---|
| OpenAPI surface | ✅ — `openapi.json` | ⚠️ — `docs/API.md`, not auto-generated |
| `/.well-known/agent.json` | ✅ | ❌ |
| Bearer-token auth | ✅ | ✅ — token-scoped agent access |
| Anonymous publish | ✅ | ❌ — no anonymous write surface |
| Three-call publish pipeline | ✅ — manifest, upload, finalize | ❌ — Lookie-Link writes through the filesystem; publishing isn't a concept yet |
| MCP | ❌ | ❌ |

**Reading**: ⚠️ partial overlap. The agent-API shape is the most direct gap. `here.now` advertises itself to agents in the way the ecosystem is consolidating around. Lookie-Link could adopt the same discovery and OpenAPI conventions without committing to the public-hosting model.

## What Lookie-Link would need to be a `here.now` peer

If the goal were to **match `here.now`'s public-hosting product** — not just adjacent overlap, but actually compete on the same primitive — these capabilities would have to land:

1. **Public-facing serving mode.** Today Lookie-Link assumes tailnet trust. A public-mode would require:
   - A hosted instance (someone has to operate the public endpoint; Lookie-Link is shipped as software, not a service)
   - Per-artifact unguessable slugs
   - A real auth layer (password-gated URLs, scoped tokens that don't presume a tailnet)
   - Rate limiting, abuse handling, content moderation policy
   - TLS, custom-domain CNAME flow
2. **Publish-not-mount model.** Today Lookie-Link mounts a directory tree on disk. To match `here.now`, it would need a "publish" verb that takes a manifest + files, gives back a URL, and isolates the artifact from the rest of the mounted tree. This is a new resource type and a new storage path.
3. **Anonymous-publish primitive.** Lookie-Link has no concept of "an agent that isn't pre-provisioned." Adding it implies abuse controls (the only way to stop the public anonymous endpoint from becoming a malware host).
4. **OpenAPI + `agent.json`.** Lookie-Link has a docs/API.md but no machine-readable advertisement; adopting this is small and worth doing regardless of the public-hosting question.
5. **Drive-equivalent object storage.** A scoped-token, path-prefixed, ETag-concurrent object store is a real engineering project, not a feature flag. `here.now`'s Drives sit on top of cloud object storage; a Lookie-Link equivalent would need the same.
6. **Forking / remixing.** Lookie-Link's edit model is single-tree; forking implies cloning artifacts under a different owner.
7. **Payment / monetization.** The experimental stablecoin gating on `here.now` isn't strategic — it can be skipped.

## What Lookie-Link should *actually* take from this comparison

Three honest categories.

### Worth doing — pure-upside borrowings

- **`/.well-known/agent.json` + OpenAPI.** Cheap, makes Lookie-Link discoverable in the same agent-runtime ecosystem `here.now` is already advertising into. No deployment-model implications.
- **Read-only vs. write distinction on agent tokens.** Today the managed-grant model conflates "I can see this" and "I can modify this." `here.now`'s Drive-token split is a clean pattern. Adopting it doesn't change the trust model — it just makes the existing trust model more expressive.
- **A `/healthz`-style capability summary endpoint** that an agent can hit to learn what the instance is mounted with, what extensions are enabled, and what the maximum file size for edits is. Already partially present; align it with `agent.json` conventions.

### Worth considering — feature-shaped extensions that don't break the threat model

- **"Public artifact share" mode for a single file.** A bounded extension: from the editable-mode UI, a tailnet-side operator can "share this file as a public URL for N hours," with a generated unguessable slug, optional password, and an expiry timer. The hosted location is the same Lookie-Link instance (no new infrastructure); the public-URL surface is a small, well-scoped route group with its own rate limiting and abuse story. This addresses the case where a tailnet-local agent has produced something a non-tailnet recipient needs to see, without abandoning the private-by-default posture for everything else.
- **Manifest-based publish endpoint** that takes a small set of files (HTML/PDF/image/etc.) and serves them as an immutable artifact under `/published/<slug>/`. This is the smallest version of `here.now`'s Sites primitive. Useful even on a purely-private instance, because it lets agents drop bundled outputs without writing to the mounted tree.
- **Drive-equivalent**: a scoped, append-only, ETag-controlled blob store under `/drive/<account>/<path>`. The right time to do this is when there's an actual use case that the current grant model can't cover. Until then it's premature.

### Not worth doing — features that would break Lookie-Link

- **Public hosting as the default.** Lookie-Link's value proposition is "your repos, on your network, without a SaaS in the loop." Going public-by-default is a different product.
- **Anonymous publish.** Anonymous-publish is `here.now`'s most ergonomic feature *and* the one that requires a serious abuse, moderation, and infrastructure cost story. A self-hosted MIT project should not take this on.
- **Payment gating.** Stablecoin-gated views are a SaaS revenue feature; they have no role in a self-hosted file viewer.
- **Replacing the rendering pipeline with raw-HTML hosting.** The rendering pipeline is the project. Don't sand it off.

## Recommendation

**Stay in lane on the core product. Adopt the agent-discovery and token-shape conventions. Add a tightly-scoped public-share extension when the use case justifies it.**

The Lookie-Link sentence does not become "self-hosted alternative to `here.now`" — it stays "private-network file viewer and editor for agent-driven workflows, with optional bounded public-share for the cases where you actually need it."

If a `here.now`-shaped public-hosting service is genuinely the right tool for someone's workflow, `here.now` itself is a perfectly serviceable answer and the cost of building a self-hosted equivalent is large. Reframe Lookie-Link as a *complement*, not a *competitor*: the private-by-default surface where work happens, with a public-share escape hatch for the small fraction of artifacts that need to leave the tailnet.

## Concrete roadmap items to file (if/when picked up)

These are written as candidate roadmap items, not commitments. Each is independent and can be picked up or dropped on its own.

1. **`/.well-known/agent.json` advertisement.** Publish the existing API surface as `agent.json` + OpenAPI. Smallest borrow from `here.now`; pure upside.
2. **Read/write split on agent grants.** Add a read-only flag to the managed-grant model so an agent can be granted view-only access to a path. Backwards-compatible default = current behavior.
3. **Bounded public-share for a single file.** New route group, opt-in per instance, off by default. Generates an unguessable slug, optional password, mandatory expiry. The instance still has to be reachable from the public internet for the slug to resolve — operator's choice.
4. **Manifest-based publish.** A `/api/publish` endpoint that accepts a manifest + files, writes them under `/published/<slug>/` (a path the operator configures), and returns the URL. Even on private instances this is useful for the "agent dumps a bundle" case.
5. **Capability discovery endpoint** aligned with `agent.json` conventions, returning the instance's enabled features and limits.

None of these break the existing design; none of them require Lookie-Link to become a SaaS; none of them touch the renderer.

## Sources

- Public canonical doc on `here.now` (this is the doc the comparison is grounded in): [`here-now-instant-web-hosting-for-agents-2026-05-16`](https://github.com/chrisfonte/operations-research/blob/main/ai-tools/here-now/here-now-instant-web-hosting-for-agents-2026-05-16.md)
- Lookie-Link [README](../../README.md), [CLAUDE.md](../../CLAUDE.md), [docs/AGENT-ACCESS-CONTROL.md](../../docs/AGENT-ACCESS-CONTROL.md), [docs/PAPERCLIP-GRANT-WORKFLOW.md](../../docs/PAPERCLIP-GRANT-WORKFLOW.md), [docs/FEATURES.md](../../docs/FEATURES.md), [docs/API.md](../../docs/API.md)
- `here.now` homepage, docs, `/.well-known/agent.json`, the `heredotnow/skill` GitHub repo, and a third-party walkthrough by Steven Gonsalvez on dev.to (full URLs in the public canonical doc)
