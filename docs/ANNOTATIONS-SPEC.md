# Annotations and Agent-Feedback Loop — Spec

**Status**: Phase 1 implementation reference. Later-phase sections remain planning guidance.

**Related**:

- [FEATURES.md](FEATURES.md) — current feature surface (anchors, rendering, asset rewrites)
- [EDITING.md](EDITING.md) — opt-in write-back model (`enableEditing`, `safeResolve`, mtime guard, temp+rename)
- [API.md](API.md) — current HTTP surface
- [AGENT-ACCESS-CONTROL.md](AGENT-ACCESS-CONTROL.md) — token-scoped repo/path access
- `research/competitors/` — competitor landscape, including the Lavish artifact-feedback model that motivates this spec

## What this is

A spec for adding a structured, agent-readable annotation layer to Lookie-Link, so a human reviewing a rendered file can leave precise feedback that the agent picks up on its next pass.

This doc covers six decision areas. Each ends with a verdict (**adopt**, **adopt-modified**, **defer**, **reject**) and a concrete sketch. The summary table is at the bottom.

## Constraints this spec respects

- **Many repos, many agents, intermittent presence.** The agent that wrote a file may not be running when the human annotates it. Feedback must survive across processes.
- **Network is the perimeter.** Trusted-network + token-scoped access. Annotation reads require `view`; every sidecar mutation requires the write-class `write` capability (`edit` remains a legacy alias).
- **Multi-format.** Lookie-Link renders markdown, code, YAML, PDF, audio, and sanitized HTML. The annotation primitive must work for at least the text-shaped formats (markdown, YAML, code). HTML can get a richer treatment in a later phase.
- **Write-back exists but is opt-in.** Editable mode is off by default for safety ([EDITING.md](EDITING.md)). Any storage choice that requires mutating the source file must therefore be gated on the same flag.
- **Clean git diffs matter.** Many served repos are git-backed. Annotation noise in the source file pollutes blame and review unless explicitly chosen.

## 1. Where annotations are stored

### Decision: sidecar by default, rendered inline. Inline-in-source available as opt-in.

This is the most consequential choice in the spec, so the reasoning is explicit.

**Sidecar default** — every annotation lives in a JSON file under `.lookie-link/annotations/<repo>/<relative-path>.json`. The viewer reads the sidecar at render time and renders the annotations inline next to the matching anchors. From the human's perspective the annotations *appear to live in the document*; on disk they do not.

**Why default sidecar, not inline source mutation:**

- Most served files live in git repos. Inline mutation creates churn in `git diff` and `git blame` that is unrelated to the file's actual content.
- The sidecar carries metadata (author, created time, anchor, state, agent claim, replies) that has no clean inline representation in YAML, JSON, code, or PDF.
- "Remove all annotations from this repo" is `rm -rf .lookie-link/annotations/<repo>` instead of a sed pass across many files.
- The sidecar route works for binary and read-only files (PDF, audio, sanitized HTML, config files) where inline mutation is not an option.
- Sidecar storage does not require `enableEditing` to be true — annotations remain available even on the default safe configuration.

**Why offer inline-in-source as an opt-in mode:**

- Some workflows genuinely want annotations to travel with the file — for example, a markdown design doc that gets reviewed in a PR, where the annotations are part of the artifact and should appear in the diff.
- Inline mode means the markdown still renders cleanly outside Lookie-Link (annotations degrade to HTML comments or footnotes).

**Inline format when opt-in is enabled:**

For markdown, annotations are written as paired HTML comment markers that Lookie-Link recognizes at render time and renders as a styled inline note:

```markdown
<!-- lookie-link:annotation id=2026-06-09-001 anchor=#design-decisions state=open author=chris -->
The third option here conflicts with the constraint listed in §2.
<!-- /lookie-link:annotation -->
```

For YAML, annotations are written as a sibling key under a magic `_lookie_link_annotations:` block at the bottom of the file (never inside the user's keyspace).

For other text formats (code, plain text), inline mode is **not supported** in phase 1 — the sidecar is the only option, because there is no comment syntax that is portable across all of them without breaking parsers.

**Switching modes:** A `lookie-link annotations migrate --to inline <repo>/<path>` and `--to sidecar` CLI lets users move existing annotations between modes without losing history.

### Sidecar schema (phase 1)

```json
{
  "schema": 1,
  "file": "ops-research/text-tools/some-doc.md",
  "annotations": [
    {
      "id": "2026-06-09-001",
      "anchor": "#design-decisions",
      "anchorKind": "heading",
      "body": "The third option here conflicts with the constraint listed in §2.",
      "author": "chris",
      "createdAt": "2026-06-09T20:46:00Z",
      "state": "open",
      "claimedBy": null,
      "claimedAt": null,
      "resolvedAt": null,
      "replies": []
    }
  ]
}
```

Phase 1 accepts `heading`, `yamlKey`, or `lineRange`. Deliberate authored-HTML targets use `heading` with a stable `data-lookie-annotation-anchor`; `elementSelector` and `textRange` remain reserved for a later HTML phase.

## 2. Agent talkback: live polling vs. flat-file pickup

### Decision: flat-file pickup is the contract. No live polling endpoint in phase 1.

Lookie-Link serves many repos and many intermittent agents. A polling endpoint per file or per session would create state and lifetime questions Lookie-Link does not currently have, and would not match the common case where the agent that wrote the file is no longer running by the time the human annotates it.

**The contract:**

- The human creates an annotation in the viewer.
- The annotation is written to the sidecar (or inline, if opt-in) on the lookie-link host.
- The agent retrieves pending annotations on its next heartbeat or on demand via:
  - `GET /api/annotations/<repo>/<path>?state=open` (HTTP)
  - `lookie annotations list <repo>/<path> --state open` (CLI)
- The agent marks an annotation `claimed` while it works, then `resolved` when it lands its fix.
- If content must be removed after posting, `redact` replaces the annotation and reply bodies with placeholders, resolves the item, and preserves authorship, timestamps, and `redactedBy` metadata instead of erasing the audit trail.

**How the agent learns there is new feedback** (without polling):

- The agent that produced the file emits a Lookie-Link URL when it finishes work; on its next heartbeat (or when the human pings it in Mattermost or Telegram), it calls `GET /api/annotations/<repo>/<path>` once to drain pending feedback.
- For ambient watch, the existing config-audit cron pattern can be extended: a `lookie-link-annotations-audit` job notifies on Paperclip/Mattermost when annotations sit in `state=open` past a threshold.
- A future `state=open` count is exposed on `GET /api/repos` so a fleet-level dashboard can surface backlog without polling per file.

**Live polling is deferred, not rejected.** If a workflow emerges where it matters that an agent reacts to feedback within seconds — typically a single-artifact, single-session loop — phase 3 adds a per-path long-poll endpoint scoped to one open session at a time. That endpoint is opt-in on the agent side: the default contract remains pickup on next pass.

## 3. Element / text-range selection UX

### Decision: section-anchor click in phase 1; element + text-range in phase 2 (HTML-first).

Lookie-Link already auto-anchors every markdown heading and top-level YAML key ([FEATURES.md#anchor-linking](FEATURES.md#anchor-linking)). That existing anchor primitive is enough to ship the first version of annotations without any new selector logic.

**Phase 1 gesture:**

- The toolbar exposes annotation mode. Existing feedback remains visible, while add-comment affordances appear next to anchored headings and YAML keys only while that mode is active.
- Clicking it opens an inline editor near that section; submitting writes to the sidecar with `anchorKind: "heading"` (or `yamlKey`) and the existing anchor ID.
- For files without anchors (plain code, plain text), the viewer exposes a line-range picker; the annotation records `anchorKind: "lineRange"` with an anchor such as `#L4-L9`.

**Nested YAML key anchors are a prerequisite.** The Lookie-Link analysis already calls out that nested YAML keys are not currently anchored. Annotations on YAML files are second-class until they are, so extending the anchor generator to nested paths (`a.b.c`) is part of phase 1.

**Phase 2 (HTML-first):**

- Selecting text in a rendered HTML or markdown document opens the annotation editor with `anchorKind: "textRange"` and a quote-plus-offset payload.
- Clicking an element in rendered HTML attaches `anchorKind: "elementSelector"` with a robust CSS selector (or DOM path) and a fallback text quote.

Phase 2 is where Lookie-Link absorbs Lavish's strongest differentiator — precise per-element correction — but only after phase 1 proves the transport.

## 4. Artifact-preserving rendering

### Decision: adopt-modified. The annotation layer is injected by the viewer; the source file is not mutated unless inline mode is explicitly enabled.

The current pipeline (anchors, link rewriting, DOMPurify) already injects post-processing around the source. The annotation layer extends that pipeline:

- Sidecar annotations are merged into the rendered output at render time as styled inline blocks anchored to the matching heading, key, line range, element, or text range.
- Sanitized authored HTML can declare a deliberate phase-1 target with `data-lookie-annotation-anchor="anchor-id"`. Annotation cards are collapsed by default so active feedback remains visible without overwhelming rich layouts.
- Source bytes on disk are unchanged in the default (sidecar) mode.
- In inline mode, source bytes are modified only for markdown and YAML, only when `enableEditing: true` and a new `enableAnnotations: inline` config flag are both set, and writes go through the same `safeResolve` + mtime guard + temp+rename path that editable mode already uses.
- The `Raw` toolbar button continues to show the source as it exists on disk. In sidecar mode the raw view is unchanged; in inline mode the raw view shows the comment markers, which is the honest representation.

## 5. Ambient agent guidance (hooks / skills)

### Decision: defer until the protocol settles, then ship a small snippet through the existing skill spec.

[SKILL-SPEC.md](SKILL-SPEC.md) already plans skill packages for Claude Code, Cursor, and Codex. Annotation guidance should be a small addition to that spec once the API contract is stable, not a separate channel.

The eventual snippet should tell agents:

- After producing or editing a file that lives in a Lookie-Link-managed repo, emit the `/view/...` URL in the completion message.
- Before editing a file the agent did not just create, call `GET /api/annotations/<repo>/<path>?state=open`; if there are open items, address them and mark them `resolved` as part of the same change.
- Never overwrite an open annotation's anchor target without first claiming it.

Shipping this guidance too early — before the API is stable — creates churn in installed skills. The flag is to write the guidance section of `SKILL-SPEC.md` in the same PR that ships the API.

## 6. Other features worth lifting

### AXI-style compact CLI output — adopt-modified.

The existing `bin/lookie-read.js` CLI shim already does the heavy lifting for reads. Annotations get a sibling shim — `bin/lookie-annotations.js` (exposed as `lookie annotations`) — with subcommands `list`, `get`, `claim`, `resolve`, `add`, `replies`. Output is JSON by default with a `--pretty` flag for human use. This keeps the agent-ergonomic shape Lavish's `lavish-axi` is praised for, without the rest of Lavish's product model.

### Session-keyed-by-path identity — already covered.

Lookie-Link's URL grammar (`/view/<repo>/<path>#anchor`) already gives session identity by canonical path. Annotations key the same way. No new identity layer needed.

### Hook-based proactive use — defer.

A `?annotate=1` URL hint or a CLAUDE.md fragment that tells the agent to drop a Lookie-Link link for any long doc is worth doing, but only after the annotation API and viewer UX exist. Premature hooks create dead surface area. Land this in the same release as the SKILL-SPEC snippet (phase 1 close).

## Out of scope (preserved from the source request)

- Write/edit capability on the source file itself beyond what `enableEditing` already provides.
- Authentication changes — network remains the perimeter, token scoping continues to gate annotation routes.
- Full-text search — separate known gap.
- `here.now`-style public sharing.

## Recommended sequence

### Phase 1 — Sidecar + section-anchor annotations + read API

- Sidecar storage under `.lookie-link/annotations/<repo>/<relative-path>.json` with the schema above.
- Nested YAML key anchors in the existing anchor generator (prerequisite).
- Viewer renders annotations inline next to anchored sections.
- Annotation-mode affordances for headings and YAML keys, plus a line-range picker for code and plain text.
- `GET /api/annotations/<repo>/<path>` with `?state=` filter.
- `POST /api/annotations/<repo>/<path>` to create (requires `write`).
- `PATCH /api/annotations/<repo>/<path>` to claim, resolve, reopen, reply, or redact (requires `write`).
- `bin/lookie-annotations.js` CLI shim.
- `enableAnnotations: true` config flag, default off, parallel to `enableEditing`.

Phase 1 closes the loop: human leaves a note, agent fetches it on next pass.

### Phase 2 — HTML element + text-range precision

- Element-level annotations for rendered HTML (`anchorKind: "elementSelector"`).
- Text-range annotations with quote-plus-offset anchors.
- Selection-to-annotation gesture in the viewer.
- Annotation-aware re-render survives minor source edits via the text-quote fallback.

### Phase 3 — Live presence and loop ergonomics

- `enableAnnotations: inline` opt-in for markdown and YAML inline mode.
- Optional per-path long-poll endpoint for agents that want sub-heartbeat reactivity, gated to one open session per path.
- Annotation backlog counts on `GET /api/repos` and a fleet-level backlog view.
- Skill-spec addendum so agents learn the annotation contract automatically.

## Verdict table

| Area | Verdict | Reason |
|---|---|---|
| Sidecar as default storage | Adopt | Survives across processes, keeps git diffs clean, carries metadata, works on binary/read-only files, no `enableEditing` required. |
| Inline-in-source as opt-in | Adopt-modified | Real use case (annotations traveling with the file in a PR review), but limited to markdown and YAML, behind two flags, using the existing safe-write path. |
| Section / YAML-key click-to-annotate | Adopt | Reuses existing anchors. Lowest-cost gesture that proves the transport. |
| Line-range annotation for un-anchored files | Adopt | Required to cover code and plain text in phase 1. |
| Nested YAML key anchors | Adopt | Prerequisite — YAML annotations are second-class without it. |
| Flat-file pickup as default agent contract | Adopt | Matches Lookie-Link's many-repo, many-agent, intermittent-presence reality. |
| Live polling endpoint | Defer | Adds session and lifetime complexity; only valuable for sub-heartbeat reactivity. Add in phase 3, scoped per path. |
| Deliberate authored-HTML targets | Adopted | `data-lookie-annotation-anchor="anchor-id"` enables stable element targets; arbitrary selection and generated selectors remain deferred. |
| Text-range annotations | Defer | Strong differentiator, more brittle anchoring. Ship in phase 2 with quote-plus-offset fallback. |
| Artifact-preserving render-time injection | Adopt-modified | Extend the existing post-processing pipeline; do not mutate source bytes in default mode. |
| `bin/lookie-annotations.js` CLI shim | Adopt | Mirrors the existing `bin/lookie-read.js` pattern, gives agent-ergonomic JSON output. |
| Session keyed by canonical path | Already adopted | Existing URL grammar covers this; annotations key the same way. |
| Ambient skill guidance | Defer | Land in `SKILL-SPEC.md` once the API is stable. Premature guidance creates churn. |
| `?annotate=1` URL hint / proactive hooks | Defer | Land in the same release as the skill guidance. |
| HTML-only product collapse | Reject | Lookie-Link's value is multi-format review; HTML gets a richer phase 2 treatment but does not become the whole product. |
| Local-only product model | Reject | Conflicts with the trusted-network advantage. |

## Implementation issues to file when approved

Each becomes its own issue against this repo.

1. **Nested YAML key anchors** — extend the anchor generator and `Annotate` affordance to nested YAML paths so YAML files are first-class.
2. **Annotation sidecar storage and read API** — `.lookie-link/annotations/...` layout, schema, `GET/POST/PATCH /api/annotations/...`, `enableAnnotations` config flag, access-control parity with `/view` and `/edit`.
3. **Viewer-side annotation UX (phase 1)** — annotation-mode affordances, collapsed inline cards, stale-anchor preservation, and a line-range picker for unanchored files.
4. **`bin/lookie-annotations.js` CLI shim** — list/get/claim/resolve/add/replies subcommands, JSON-first output, env-token auth parity with `lookie-read.js`.
5. **HTML element + text-range annotations (phase 2)** — element selector, quote-plus-offset, selection gesture, anchor-survival on minor re-render.
6. **Inline-in-source opt-in mode (phase 3)** — `enableAnnotations: inline` flag, markdown HTML-comment markers, YAML `_lookie_link_annotations` block, `lookie annotations migrate` CLI, integration with `safeResolve` + mtime + temp+rename write path.
7. **Skill-spec addendum** — annotation contract section added to `SKILL-SPEC.md` so the eventual skill packages teach agents the workflow.
8. **Annotation backlog visibility** — counts on `GET /api/repos`, optional audit cron that notifies on stale-open annotations.
