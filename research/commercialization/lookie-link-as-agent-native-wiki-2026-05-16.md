# Lookie-Link as an Agent-Native Self-Hosted Wiki — Positioning Analysis

**Created**: 2026-05-16
**Status**: Active — positioning analysis, not committed strategy
**Purpose**: Evaluate the strategic option of pairing Lookie-Link with wiki / knowledge-base structure to position it as an **agent-native, self-hosted alternative to Notion / Outline / Confluence / Wiki.js**, with agents as first-class authors and consumers — not an afterthought plugin. This is the third positioning lens explored for Lookie-Link, after the four-path SaaS analysis and the open-source-`here.now`-alternative analysis.
**Companions**:
- [`lookie-link-public-saas-options-2026-05-16.md`](./lookie-link-public-saas-options-2026-05-16.md) — four-path SaaS options analysis.
- [`self-hosted-here-now-alternative-2026-05-16.md`](./self-hosted-here-now-alternative-2026-05-16.md) — open-source-alternative-to-`here.now` positioning analysis. The framing in this doc is *adjacent* to that one but not the same: `here.now` is publish-and-share-an-artifact; a wiki is structure-and-curate-a-knowledge-base. Same underlying primitives, different center of gravity.
- [`../competitors/here-now-vs-lookie-link-2026-05-16.md`](../competitors/here-now-vs-lookie-link-2026-05-16.md) — feature-level comparison with `here.now`.

## TL;DR

"Agent-native self-hosted wiki" is a **real, underserved category** distinct from "open-source `here.now` alternative" — and it is a category where Lookie-Link's existing primitives (file mounts, markdown rendering, live editing, themed presentation, scoped grants, on-disk storage) are unusually well-aligned with what would have to be built. The existing wiki ecosystem is overwhelmingly human-first, retrofitted to AI via after-the-fact plugins; no incumbent has positioned the wiki itself as "designed for agents and humans as co-equal authors."

The case for this positioning is **strong on three dimensions** (Lookie-Link is already most of a wiki without anyone calling it that; the agent-native angle is genuinely differentiated; the file-backed / git-friendly architecture aligns with how research agents already work in practice), **weak on two** (a wiki is a meaningfully bigger product than a file viewer, with real new surfaces — search, hierarchy/graph, multi-user write coordination, page-level permissions, history — and "wiki" as a category has a broader feature expectation than "publish-a-link"), and **load-bearing on one unproven hypothesis** (that "agent-native" is the *differentiator* customers buy on rather than a feature an established wiki could add in a quarter).

The honest answer is that the wiki framing may be the **biggest version of Lookie-Link** — bigger than the `here.now`-alternative framing, with a larger audience and a more durable category position — but it is also the **most engineering-expensive** to claim credibly, and the most exposed to "Notion adds agent features and the differentiation evaporates" risk. This doc lays out the landscape, the feature gap, the cases where the framing is right vs. wrong, and a sequencing that does *not* require committing the full wiki investment up front.

## Why this question came up

The prior two commercialization docs framed Lookie-Link as (a) a renderer / viewer with optional publish primitive, and (b) the open-source alternative to a specific commercial publish-and-share service. Both framings keep Lookie-Link in its current shape and ask different questions about how to take it to market.

The wiki framing asks a different question: *what if Lookie-Link is not the open-source `here.now`, but the open-source agent-native knowledge base — the thing teams use to organize what their agents know, write, and have done?*

That reframe changes the center of gravity:

- The atomic unit is no longer "a file in a mount" or "a published artifact" — it is **a page in a knowledge graph**, with backlinks, tags, history, and a stable identity that survives renames and moves.
- The primary user is no longer "an agent that wants to share output" — it is **a team (some human, some agent) collaboratively building a shared knowledge base**.
- The competitive comparable is no longer `here.now` — it is **Notion / Outline / Confluence / Wiki.js** for the human-facing surface, and **Notion AI / Mem.ai / Khoj** for the agent-facing surface, with the observation that no one is sitting cleanly in the intersection.

This is a more ambitious positioning. It is also a more durable one — wikis and knowledge bases are a mature, well-funded category, with stable buyer language ("we need a wiki"), well-understood deployment patterns, and decades of precedent for how teams use them. The agent-native angle is the new layer; the underlying need is not new.

## The wiki / knowledge-base landscape

A short tour of the comparables, grouped by what they actually do.

### Mature self-hosted wikis (the OSS-alternative tradition)

| Project | Commercial-SaaS comparable | License | Architecture | Agent posture |
|---|---|---|---|---|
| **Outline** | Notion | BSL | Postgres, rich-text (ProseMirror), API-first | API exists; no native agent identity |
| **BookStack** | Confluence | MIT | Laravel + MySQL, WYSIWYG + markdown | API exists; human-shaped |
| **Wiki.js** | Confluence, Notion | AGPL | Node + Postgres, modular | API exists; no agent specialization |
| **HedgeDoc** (formerly CodiMD) | HackMD | AGPL | Real-time markdown collaboration | Collaborative editing, not agent-aware |
| **MediaWiki** | (the Wikipedia stack) | GPL | LAMP, PHP, very mature | Bots are first-class but human-coded |
| **DokuWiki** | (file-based simplicity) | GPL | Flat files, no DB | File-backed → friendly to git/agents |
| **ikiwiki** | (git-backed) | GPL | Static gen from git repos | Git-native → naturally agent-friendly |

**Observation:** The closer the wiki is to "files on disk in a git repo" (DokuWiki, ikiwiki) the more agent-friendly it incidentally is. The closer it is to "rich app with a database" (Outline, BookStack, Wiki.js) the more featureful but less agent-native. Nobody is *deliberately* in the agent-native quadrant.

### Personal-knowledge / digital-garden tools

| Project | Commercial comparable | License | Architecture | Agent posture |
|---|---|---|---|---|
| **Logseq** | Roam Research | AGPL | Local-first, markdown files, graph | Plugins exist for LLM use; not native |
| **Trilium** | (personal) | AGPL | SQLite-backed tree | API exists; human-shaped |
| **Obsidian** | (proprietary, files-on-disk) | proprietary | Markdown files in a vault | Strong plugin ecosystem (Smart Connections etc.); not first-party |
| **Anytype** | Notion | Anytype OS License | Local-first, encrypted, P2P | Not agent-aware |
| **Silverbullet** | (note-taking with scripting) | MIT | Markdown + Lua-style space-script | Agent-friendly via API and scripting hooks |
| **TiddlyWiki** | (single-file) | BSD | A single HTML file | Curio not natively agent-aware |
| **Dendron** | (hierarchical notes) | GPL | VSCode-native, markdown | Tool-agnostic |
| **Quartz** | (digital-garden publisher) | MIT | Static-site generator over markdown | Agent-friendly via git |

**Observation:** The "markdown files in a folder" pattern (Obsidian, Logseq, Dendron, Quartz, Silverbullet) is the closest natural fit for agent workflows because the wire format *is* what an LLM produces. These tools are powerful for individuals but most do not solve multi-user/multi-agent coordination, web access for non-installers, or shared-team semantics.

### AI-native knowledge tools (proprietary)

| Project | License | What it is | Agent posture |
|---|---|---|---|
| **Notion AI** | proprietary | Wiki + AI assistant grafted on | "Assistant" model — humans drive |
| **Mem.ai** | proprietary | AI-first notes app | AI surfaces and summarizes; not author |
| **Reflect** | proprietary | Personal AI notes | Similar to Mem |
| **Capacities** | proprietary | Object-based knowledge | AI features added |
| **Khoj** | AGPL (open) | Self-hosted AI assistant *over* docs | Reader, not author — consumes existing wikis |
| **AppFlowy** | AGPL | Open Notion alternative with AI tier | AI features added; not author-first |

**Observation:** The closed AI-native tools (Notion AI, Mem, Reflect, Capacities) treat AI as an *assistant to the human author*. The open AI-native tool (Khoj) treats AI as a *reader of human-authored knowledge*. Nobody treats agents as *first-class authors with identity, accountability, and write semantics designed for them*. That is the open lane.

### What "agent-native" would actually mean

Different from any of the above, an agent-native wiki would have:

1. **Agent identity as a first-class concept.** Every edit attributable to a specific agent (not just "API token X") with grant lineage, an audit trail, and a way to ask "what does agent Y currently believe about topic Z?"
2. **An OpenAPI-described surface** discoverable via `/.well-known/agent.json`, designed so that any agent runtime can read, search, link, and edit pages without learning a proprietary client.
3. **Programmatic graph operations.** Backlink discovery, tag traversal, page-tree navigation, and full-text + semantic search — all exposed as first-class API endpoints, not screen-scrape-the-rich-text-editor.
4. **Conflict semantics that handle interleaving agent + human edits.** The `expectedMtimeMs` / 409 pattern Lookie-Link already uses for files extends naturally to pages; most rich-text wikis assume single-author-at-a-time or last-writer-wins.
5. **Provenance and source attribution baked into the schema.** When an agent writes a page, the sources, the prompt context, and the run identifier are part of the page metadata — not a free-text footer the agent might forget to include.
6. **File-backed storage that is also a wiki.** A page is a markdown file (plus a small sidecar of structured metadata) on disk. This means the wiki is also a git repo, also an Obsidian vault, also a static-site source — useful properties for agents, for backup, and for migration in or out.
7. **Multi-agent write coordination that doesn't require humans to mediate.** Page locks, append-only sub-sections, or row-level claims that allow two agents to work on the same topic without stepping on each other.

None of the wiki tools surveyed do all of these. Most do none of them by design.

## Does Lookie-Link's primitive translate to a wiki?

The empirical question. Three sub-questions.

### Sub-question 1: Is there a real audience for "agent-native self-hosted wiki"?

There is, and it is larger and more buyable than the self-hosted-`here.now` audience. Components:

- **Privacy-sensitive teams using agents at scale** who need a shared knowledge base their agents can author into, but cannot put on Notion / Confluence Cloud / Outline-hosted for compliance, IP, or sovereignty reasons. This audience already exists; today they fall back to a folder of markdown in a private git repo, or to running Outline/Wiki.js with custom integrations.
- **Research-heavy teams (academic labs, intelligence shops, R&D groups) running long-running agent workflows** that produce findings their humans need to read, sometimes weeks after the run. A self-hosted wiki the agent writes into is a far better artifact than a transient `here.now` URL.
- **Operators of agent fleets / overnight task systems** (the user of this very repo is one) who need a knowledge layer their agents write into during work and read from during context-setting. The pattern of "agent writes a research doc to a known location, the doc is linked from a hub, cross-doc backlinks help future runs find prior work" is the latent wiki shape; today it is implemented by hand.
- **Hobbyists / homelabbers** who would adopt an OSS Notion alternative the same way they adopted Plausible or Outline, plus a meaningful subset who would adopt it *specifically because* the agent-native posture is interesting.
- **Privacy-conscious individual knowledge workers** who run Obsidian or Logseq locally today but would adopt a self-hosted multi-user team-shaped version if it existed. (Obsidian's commercial team product is Sync + Publish + plugins; it is not the same primitive.)

The total addressable audience is meaningfully larger than the self-hosted-`here.now` audience, because the underlying need ("a place where my team's knowledge lives") is more universal than the underlying need ("a URL to share an agent-produced artifact"). The agent-native angle is what makes Lookie-Link's version differentiated; the wiki shape is what makes it broadly desirable.

### Sub-question 2: What features need building?

This is where the analysis has to be most honest. A wiki is meaningfully more product than a file viewer + publish primitive.

**Lookie-Link capabilities that translate directly:**

- ✅ Markdown rendering (page rendering)
- ✅ Live editing with conflict detection (page editing — the hardest part of most wikis)
- ✅ File-backed storage (pages-as-files; trivially git-able)
- ✅ Themes / themed presentation
- ✅ Scoped grants and token model (page-level access control)
- ✅ Inline code, YAML, audio, image rendering (rich page content without a heavy editor)
- ✅ Cross-repo `[[link]]` syntax (the backlink primitive in nascent form)
- ✅ Search (existing surface, extends naturally)
- ✅ Anchor links on YAML keys and headings (deep-link to page sections)

**New surfaces that need building for credible "wiki" positioning:**

1. **Page identity that survives moves and renames.** Today a Lookie-Link URL is path-based. A wiki page needs a stable identity (slug, UUID, or some equivalent) so that `[[Auth Strategy]]` resolves correctly even after the file moves from `decisions/auth.md` to `architecture/auth-strategy.md`. This is real engineering and changes the data model. Implementable on top of the current file-backed storage by adding a sidecar index, but non-trivial.

2. **First-class backlinks as a queryable graph.** Today cross-links are textual; rendering them is fine, but querying "what links to this page?" requires a build step. The wiki contract assumes backlink queries are real-time and cheap.

3. **Page hierarchy / tree navigation as a first-class concept.** Today Lookie-Link has a filesystem tree; that maps to wiki hierarchy in the simple case. A real wiki needs reorderable, friendly-named sections (Outline's "collections," BookStack's "shelves") that aren't tied 1:1 to filesystem layout. Possible with a sidecar manifest; another data-model addition.

4. **Page-level permissions distinct from mount-level.** Lookie-Link grants are mount + path-prefix. A wiki needs "this page is readable by anyone in the workspace, but only the security team can edit." This extends the grant model rather than replaces it, but the extension is real work.

5. **Edit history with diff view.** Today Lookie-Link is "see the current state of the file." A wiki needs "see the page as of last Tuesday, diff against today, restore an old version." Achievable via the git layer if pages are git-tracked; achievable via app-level history if not. Either way, real work to expose it well.

6. **Comments / page discussions.** Standard wiki feature; not present in Lookie-Link. Storage is straightforward (sidecar or DB); UI is real work.

7. **Real-time presence / multi-cursor edit (optional).** HedgeDoc and Notion offer this. It is *not* required for a credible wiki — BookStack and most enterprise wikis ship without it — but its absence is felt.

8. **Full-text search that scales.** Lookie-Link's existing search is fine for browsing; a wiki search experience expects ranked, multi-term, facet-able. Real engineering but well-trodden (sqlite-fts5, meilisearch, sonic).

9. **Semantic search / embeddings (the AI-native upside).** A wiki that lets an agent semantically search the team's knowledge before writing a new page is qualitatively more useful than one that doesn't. Not table stakes — Outline, Notion, Confluence all shipped for years without it — but the differentiator if the positioning is "agent-native."

10. **Multi-user identity model.** Today Lookie-Link's identity model is the grant. A wiki needs users + agents + groups, with the wiki knowing who said what. Real work on auth, session, and identity surfaces — though SSO / OIDC / local-only-mode are all well-trodden patterns.

11. **Page metadata schema for agents.** Author agent identity, source citations, run identifier, prompt-context fingerprint, last-verified timestamp. The properties that make "agent-authored" credible rather than "free text on the internet." New surface, but small.

12. **Migration in/out.** Importers from Notion exports, Confluence exports, Outline exports, plain folders of markdown; exporters to git, to Obsidian-vault format, to static HTML. Real work; multiplies with each format; partially deferrable.

**The honest read on scope:** to claim "Lookie-Link is an agent-native wiki" credibly, items 1–6 plus 10 plus 11 plus a real first pass at 8 are load-bearing. That is **6–9 months of focused engineering**, roughly 2–3× the scope of the self-hosted-`here.now` framing. Items 7, 9, and 12 can land later.

The scope can be staged: a v0 that ships items 1, 2, 3, 5, 10, 11 (the structural minimum) gets credible "agent-friendly knowledge base" positioning, then items 4, 6, 8 follow. The full claim of "agent-native wiki, peer to Outline / Wiki.js / BookStack" is not achievable in a 3-month sprint, and asserting it before it is true would fail on impact.

### Sub-question 3: Is "agent-native" defensible positioning?

The hardest sub-question. The risk is that "agent-native" is a feature, not a category — and that Notion / Outline / Wiki.js / Confluence add agent-friendly APIs in a quarter and the differentiation evaporates.

The argument *for* "agent-native" being a real, durable positioning:

- **Schema-shaped, not feature-shaped.** Treating agents as first-class authors changes the data model (provenance, identity, conflict semantics, source attribution as structured fields). These are choices an incumbent cannot easily retrofit without breaking existing customers' data and workflows. Notion bolting "AI" onto a human-shaped schema is structurally different from a wiki whose schema was designed for agents from day one.
- **API-first by construction.** Most wikis have an API as an afterthought (Outline is unusual in being API-first; Notion's API is famously partial; Confluence's API is enterprise-grade-painful). A wiki whose primary author is an agent has an API that is the canonical surface, not a secondary one. Catching up to this requires rewriting client/server contracts.
- **OSS distribution + agent ecosystem fit.** The wiki tools that are taking the open-Notion-alternative market (Outline, AppFlowy, BookStack) are pursuing the *human* OSS-alternative buyer. None are pursuing the agent-fleet operator. That is a different audience with different criteria and a different growth loop.
- **The buying moment is different.** A human-wiki buyer asks "does the editor work, does my team like it, do permissions match my org?" An agent-fleet buyer asks "can my agents reliably read, write, search, and link without a human in the loop?" These produce different feature priorities and different evaluation criteria. The product that wins the second buyer is not the product that wins the first.

The argument *against*:

- **Notion already has hundreds of millions of users and a multi-billion-dollar warchest.** If they decide "agent-native" is the next strategic frontier, they will out-engineer any OSS project on raw feature count.
- **The agent-native angle is currently small.** Most teams running agents are not yet at the scale where they need a shared knowledge base for them; they get by with markdown in git. The TAM for "team with a fleet of agents that need a wiki" is growing fast but is small today.
- **"Agent-native" is a positioning claim, and positioning claims live and die on consistency of execution.** If even one quarter of the year is spent on a non-agent feature, the positioning weakens.

The honest read: **agent-native is a defensible position for an OSS project, but it is not a moat against an incumbent that decides to compete on the same axis**. The OSS-alternative pattern accepts this — Plausible is not the analytics moat against Google; it is the audience-specific alternative for the buyers who self-select. The same logic applies. The win condition is **owning the agent-fleet-operator buyer**, not **competing with Notion across all buyers**.

## What this positioning would mean concretely

If "agent-native self-hosted wiki" becomes a deliberate positioning, the following things change.

### Roadmap reshuffling

The items in sub-question 2 get sequenced. A defensible v0 ships:

1. **Stable page identity.** Slug-based, with rename-resilient backlink resolution.
2. **First-class backlinks as a query API.** `GET /api/page/{id}/backlinks`.
3. **Page hierarchy via sidecar manifest** (not solely filesystem layout).
4. **Edit history surface** (either git-backed or app-level), exposed in the UI and API.
5. **Multi-user identity model.** Local-only mode + OIDC.
6. **Page metadata schema for agents.** Author agent identity, source citations, run identifier, prompt-context fingerprint, last-verified timestamp. Required fields when an agent writes; optional when a human writes.
7. **An `nlm`-equivalent CLI for the wiki** — `lookie page create`, `lookie page link`, `lookie page search`, with `agent.json` discovery so any agent runtime can use it.
8. **`/.well-known/agent.json` + OpenAPI surface** covering the page/graph/search/edit-history endpoints. Shared with the `here.now`-alternative roadmap.

A v1 that earns the "agent-native wiki" claim outright then adds:

9. **Page-level permissions** distinct from mount-level.
10. **Comments / page discussions.**
11. **Full-text search with rank + facets.**
12. **Real-time presence (optional, not load-bearing).**

A v2 that earns "this is the agent-native wiki" then adds:

13. **Semantic search / embeddings.**
14. **Importers (Notion, Confluence, Outline export formats; folder-of-markdown).**

This is **6–9 months of focused engineering to v0**, another **3–6 months to v1**, and another **3–6 months to v2** — call it 12–24 months end-to-end to fully claim the positioning. The positioning can be *asserted* earlier than v2, but each tier of the claim wants its corresponding feature set in place.

### Documentation changes

- **The README opener becomes the wiki framing.** "Lookie-Link is an open-source, self-hostable wiki and knowledge base built for teams of humans *and* AI agents — file-backed, markdown-native, with agents as first-class authors. Like a private Notion that your agents can write to over an API." (Wording to refine; structure is the point.)
- **A "Compare to Notion / Outline / Wiki.js / BookStack" matrix** in the main docs. Standard for the category.
- **An agent-author quickstart.** "Connect your Claude Code / Cursor / Codex skill, point it at your wiki, watch it write." Five-minute onboarding for the differentiated buyer.
- **A schema reference** documenting the agent-metadata fields (source citations, run ids, provenance) as first-class artifacts of the project.

### Distribution mechanics

- **Skill packages in agent-runtime marketplaces** — `lookie-link-wiki` skill for Claude Code, equivalent for Cursor / Codex. The CLI surface (`lookie page ...`) becomes a primary discovery path.
- **Listings on awesome-selfhosted (Notion-alternative section, Wiki section, Knowledge-management section), awesome-AI-agents, awesome-claude-code-skills.**
- **A launch motion** that targets *both* audiences: "Show HN: open-source Notion alternative built for AI agents." Same product, two valid framings depending on the launch surface.
- **Strategic integrations** with agent platforms (Paperclip-style task runners; Claude Code overnight workflows; LangChain / LlamaIndex / DSPy as consumers of the wiki as a knowledge source).

### Commercial offering

Same shape as in the `here.now`-alternative analysis, with one difference: the wiki audience is larger and has more demonstrated willingness to pay for managed hosting than the publish-and-share audience. Outline's hosted tier and AppFlowy's hosted tier both monetize meaningfully.

- **Optional managed hosting per workspace.** Per-workspace flat fee or per-seat pricing — both work; per-workspace is friendlier to the agent-fleet buyer (whose "seats" include agents whose numbers vary).
- **Enterprise tier** with SSO + audit + workspace-level isolation. Defer until pulled.
- **No required commercial tier.** The OSS is the headline; managed hosting is the convenience backstop.

The constraint from the `here.now`-alternative doc applies even more strongly here: the moment the SaaS becomes the main business, the positioning drifts toward "OSS-with-a-SaaS-on-top" and the agent-native authenticity erodes. The OSS distribution stays the primary product.

## Comparison: this positioning vs. the `here.now`-alternative positioning

The two positionings are **largely compatible** but have different centers of gravity. Side-by-side:

| Dimension | `here.now`-alternative | Agent-native wiki |
|---|---|---|
| Primary primitive | Publish an artifact, get a URL | Page in a knowledge graph |
| Atomic unit | A site / a published bundle | A page / a section |
| Primary buyer | Agent operator who wants share-a-URL | Agent operator who wants shared-knowledge |
| Named SaaS comparable | `here.now` | Notion / Outline / Confluence / Wiki.js |
| Engineering scope | 1–3 months focused work | 6–9 months to v0; 12–24 months to full claim |
| TAM | Smaller (publish-and-share is a niche) | Larger (knowledge base is universal) |
| Defensibility | Tied to `here.now`'s continued existence | Tied to "agent-native" being a real category |
| Risk if wrong | Comparable disappears or pivots | Notion adds agent features in a quarter |
| Roadmap fit with Lookie-Link today | High (5 items, all on the table) | Medium (8+ items, several new data-model surfaces) |
| Time to credible v0 | 1–3 months | 6–9 months |
| Marketing motion | "Show HN: open `here.now`" | "Show HN: open-source Notion built for AI agents" |

**Key observation:** the agent-native wiki framing **subsumes** the `here.now`-alternative framing in capability — a wiki that lets an agent publish a page and share it with a URL is doing everything `here.now` does. The reverse is not true: `here.now`-shape doesn't give you a knowledge graph.

The two are not exclusive. The smartest sequencing is:

1. Ship the `here.now`-alternative roadmap first (1–3 months). This delivers the publish primitive, the `agent.json` + OpenAPI surface, the bounded public-share, the read/write token split, and the parallel agent-runtime skill. All of these are load-bearing for the wiki framing too.
2. Decide whether to lead with the `here.now`-alternative positioning or the wiki positioning during that first launch window. The deciding factor is which buyer the operator wants to attract first.
3. If the wiki path is chosen as the longer game, continue with the v0 wiki roadmap (items 1–8 above) over the next 6–9 months.
4. v1 and v2 of the wiki play layer on later.

Equivalently: **the `here.now`-alternative play is a beachhead; the wiki play is the long-term position**. They are not competing options — they are sequential ones.

## Risks specific to this positioning

- **Scope creep is severe.** A wiki has ~20 features customers expect by default; missing any of the table-stakes ones (history, search, hierarchy, permissions, comments) reduces the claim from "yes, that's a wiki" to "well, sort of." The discipline required to ship a credible v0 without trying to match Notion feature-for-feature is real.
- **The "agent-native" claim is the moat — and the moat is unproven.** If the agent-native angle turns out to be a feature an incumbent can ship in a quarter, the differentiation collapses to "OSS Notion alternative #N." That is still a valid project, but it is no longer a category position.
- **Notion / Outline / Confluence / Wiki.js incumbents have real product-market fit.** Convincing buyers to switch is harder than convincing them to adopt a new primitive. The OSS-alternative play works because the buyer is *selecting on principle* (privacy, sovereignty, agent-native) — not because the new tool is feature-better at the same job.
- **The renderer-and-editor differentiator gets diluted.** Lookie-Link is already meaningfully better at rendering markdown, code, YAML, and audio than any incumbent wiki. In the wiki framing this becomes "feature A of many" rather than "the reason the project exists." That is a positioning loss if not managed deliberately.
- **Two-positioning narrative is hard to communicate.** Launching as "the open `here.now`" then later asserting "we are also the agent-native wiki" creates the perception of a product searching for a market. Cleaner to commit to one framing and ride it.
- **Engineering investment is large.** 12–24 months of sustained focus is a real commitment. If the operator's actual availability is closer to 3–6 months, the wiki framing should be deferred and the `here.now`-alternative framing chosen instead.
- **Multi-user write semantics are genuinely hard.** Wikis without real conflict / merge / presence semantics feel broken to teams; getting these right is non-trivial engineering. Lookie-Link's existing `expectedMtimeMs` / 409 model is a strong foundation but is not a complete solution at the page level.

## When this positioning is the right call

The framing is the right call **if and only if** the operator is willing to:

1. **Commit 12–24 months of focused engineering** to the wiki feature set, with discipline about what is in v0 vs. v1 vs. v2.
2. **Treat "agent-native" as a thesis to be proven, not a label.** Ship the agent-metadata schema, the API-first surface, the agent-identity model. Tell agent-fleet operators specifically what makes the product for them and not just for humans.
3. **Forgo the cleaner short-term win** of leading with the `here.now`-alternative positioning. (Or accept the messiness of running both narratives in parallel.)
4. **Operate the OSS distribution credibly at the wiki bar** — docker-compose, OIDC, backups, migrations. The bar is higher for wikis than for file viewers because customers expect more.
5. **Do the marketing work for a category position** — README, docs, comparison matrices, listings, launch posts, conference talks. Even more important at the wiki scale than at the publish-primitive scale.
6. **Accept the bigger-is-also-riskier trade.** The wiki TAM is larger, the engineering investment is larger, and the incumbent threat is more real.

The framing is the **wrong** call if:

- The operator's available engineering bandwidth is < 6 months. (Pick the `here.now`-alternative framing instead.)
- The operator's actual user demand is for the publish-and-share primitive specifically — i.e., users are asking for "give me a URL" rather than "give me a knowledge base." (Listen to the demand.)
- The operator's identity for the project is "the rendering pipeline that beats `here.now`'s," not "the knowledge base that beats Notion's." Renderer-first and wiki-first are compatible but not identical centers of gravity.

## Recommended sequencing

The pragmatic path that keeps the wiki option open without overcommitting:

1. **Ship the `here.now`-alternative v0** first (1–3 months). Publish primitive, `agent.json` + OpenAPI, bounded public-share, read/write token split, parallel agent-runtime skill. These ship regardless of which positioning is chosen — they are load-bearing for both.
2. **During that launch window, watch which buyer shows up.** If the inbound is publish-and-share-shaped, lean into the `here.now`-alternative positioning. If the inbound is "can your agents write into my team's shared knowledge?" — the wiki demand is real and the framing should pivot.
3. **In parallel, ship the cheapest wiki primitives** that don't require committing to the full claim: stable page identity (item 1), first-class backlinks API (item 2), edit-history surface (item 5), agent-metadata schema (item 11). These are useful in either framing and progressively unlock the wiki story.
4. **Make the framing call at the 3–6 month mark**, with a quarter of inbound data and a third of the wiki feature set already shipped.
5. **If the wiki framing is chosen**, plan the v0 → v1 → v2 sequencing as in the roadmap section. If the publish framing wins, the wiki primitives are still net-positive features that no one regrets.
6. **In either case, ship the bounded public-share, the page-permission model, and the agent-metadata schema** — they help both stories.

This sequencing has the property that the next 3 months of work *do not depend* on which positioning ultimately wins. That is the right shape for a decision being made with imperfect information.

## Open questions deliberately not resolved here

These need facts this analysis does not have:

- **Is there a specific agent-fleet operator (other than the author of this repo) who would adopt an agent-native wiki today?** A single design-partner customer would resolve much of the ambiguity around whether the agent-native angle is a real buying criterion.
- **What is the actual feature priority for that customer?** "I want an OSS Notion my agents can write to" is a different request from "I want a Logseq-shaped graph that agents can navigate." The product implications diverge.
- **Are Notion / Outline / Confluence / Wiki.js working on agent-native features?** Notion's AI is well-known; the others' public roadmaps are quieter on this. A few hours of competitive intel would sharpen the defensibility analysis.
- **Is the renderer-and-editor pipeline strategic enough that "Lookie-Link is the OSS wiki with the best rendering and editing" is its own positioning, separable from "agent-native"?** The differentiator may matter more than the category name.
- **Where does the wiki framing leave the existing Lookie-Link users?** Anyone currently using Lookie-Link as a file viewer must continue to be supported; the wiki framing has to be additive, not a forced migration.
- **Does pairing with a specific agent platform** (Paperclip, Claude Code Skills, Cursor, Codex) **make sense as a tighter integration story** — "the official wiki for Paperclip-managed agent fleets," etc. — before going fully ecosystem-neutral?

## Sources

- Companion: [`lookie-link-public-saas-options-2026-05-16.md`](./lookie-link-public-saas-options-2026-05-16.md) — four-path SaaS options.
- Companion: [`self-hosted-here-now-alternative-2026-05-16.md`](./self-hosted-here-now-alternative-2026-05-16.md) — open-source `here.now` alternative positioning.
- Companion: [`../competitors/here-now-vs-lookie-link-2026-05-16.md`](../competitors/here-now-vs-lookie-link-2026-05-16.md) — feature-level `here.now` comparison.
- Comparables studied for the wiki / knowledge-base landscape: Notion, Outline, BookStack, Wiki.js, HedgeDoc, MediaWiki, DokuWiki, ikiwiki, Confluence, Logseq, Trilium, Obsidian, Anytype, Silverbullet, TiddlyWiki, Dendron, Quartz, AppFlowy, Capacities, Notion AI, Mem.ai, Reflect, Khoj. Each makes a different bet on storage model, real-time semantics, plugin posture, and AI integration; the gap in deliberate agent-native design across the field is the opening this doc explores.
