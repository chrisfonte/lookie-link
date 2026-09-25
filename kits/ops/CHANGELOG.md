---
Title: CHANGELOG
Owner: Operations Team
Status: Active
---

# Changelog — Ops HTML Kit

All notable changes to the Ops HTML Kit.

- **2026-09-24 (bundled copy, no token change):** research-packet-template.html carries `data-kit` on its stylesheet link so publishing with `kit` replaces it (it used to dangle beside a second inlined block); header names the bundled home and v1.26.

## v1.26 (2026-09-19)

- Documentation only; `kit.css` unchanged. Three README changes from two same-day build sessions:
  - **Lookie-Link notes** now open with the "you are measuring the viewer shell, not your page" trap and a tested frame-enumeration probe. The guidance previously existed only as the tail of the smooth-scrolling bullet. Two sessions hit it on one day: one got a false clean pass (shell heading, `0/1` images), the other misread a blank full-page capture as a paint-timing problem.
  - **Step 3 (Compose components)** now says the list is names only and that markup lives in `EXAMPLES.html` and `research-packet-template.html`.
  - **Inline markup for `herostats` and `tile`**, the two components whose wrong structure renders without error but visibly wrong.

## v1.25 (2026-09-08)

- Reworded the `.dg-meters` comment in `kit.css` ("constraining the user" → "constraining the account").
  When a research page inlines `kit.css`, every CSS comment ships inside the public HTML, and
  `research-doc-guard.sh --extensions html` fired its `TASK_THREAD_THE_USER` class on that comment
  in two shipped packages (ZeroTier multicast, overlay multicast). Rule going forward: kit comments
  are public prose and must pass the guard; builders that inline the kit should also strip
  `/* … */` comments before embedding (the two package `build-html.py` scripts now do).

## v1.24 (2026-08-27)

- Promoted the remaining reusable composition patterns proven by the Grok Bot usage-limits
  packet: `dg-meters`, `dg-bridge`, canonical `dg-timeline`, inline `confidence`, and semantic
  `evidence-figure`. Older packet aliases remain supported, but all adverse states now resolve
  through `--sem-bad` rather than a page-local decorative token.
- Added `research-packet-template.html` and a findings-first assembly contract: thesis-led hero,
  three or four decision-bearing hero stats, one visual argument per diagram, adjacent evidence
  and confidence, then gaps/method/sources in the back matter.
- Codified the Playwright composition receipt used for promotion: authored DOM inventory,
  topnav/section parity, semantic-token computation, responsive/theme geometry, media/link health,
  sticky/deep-link interaction, and an explicit reusable-vs-page-specific disposition. Host-injected
  classes are excluded from the authored inventory.
- Updated the component showcase with the new meter, bridge, timeline, evidence-figure, and
  confidence patterns; corrected its stale displayed version.

## README-only — 2026-08-24

- Added the headless measurement gotcha to the Lookie-Link verify notes: `scroll-behavior: smooth` makes any scroll-then-measure probe sample mid-animation, which can report a working sticky `topnav` as broken. Scroll with `behavior:'instant'`, settle, then measure — and probe the `/embed/` URL because the `/view` artifact iframe is sandboxed cross-origin. `kit.css` unchanged.

## README-only — 2026-08-22

- Codified the research-package render contract: every research HTML primary declares `data-lookie-render="viewport"` on the root `<html>` so the kit's sticky `topnav` remains persistent inside Lookie. `kit.css` is unchanged; Research Documentation Standards Rule 19 owns the mandate.
- Documented the fixed-theme descendant shadowing trap: `data-lookie-follow-theme` on `<html>` plus `data-theme="neutral"` on `<body>` leaves the artifact light in a dark viewer because the body's fixed tokens override inherited viewer tokens. Theme-following pages now omit the descendant fixed-theme attribute.

## v1.23 (2026-08-21)

- **Semantic data tokens.** New `--sem-bad` in every theme block (coastal `#e06b4f`, neutral
  `#c4603f`, theme-follow light `#c4603f`, theme-follow dark + auto-dark `#e8846b`). Rule:
  data semantics never ride decorative tokens — theme-follow maps `--pop` to the viewer's
  accent, and on green-accent dark schemes a shipped research page rendered a "100% burned"
  gauge and its "= ?" markers success-green until pinned. Extends the v2-topnav lesson
  (decorative rules from `--accent`, never `--pop`) to data semantics.
- **Data-diagram family** (`.dg` card + `dg-ladder`, `dg-flow`, `dg-branch`, `dg-week`,
  `dg-gauge`, `dg-compare`) and the **`.herostats`** findings-before-scroll stat band —
  promoted from the grok-bot-usage-limits research package (v1.2.3) after Playwright
  screenshot verification in Lookie light and dark, including one live defect each caught by
  that review (dark semantic inversion; wrong weekday labels — hence the "run `date` before
  calendar labels" note in the README). Bars/segments carry data inline (width, phase color)
  scaled to the real maximum; structure and semantics live in the kit.
- README gained a "Data diagrams and the semantic-color rule" section + component-list
  entries; EXAMPLES.html gained a rendered showcase of the family in both themes.

## v1.22 (2026-08-13)

- **Sticky-nav anchoring.** Added `scroll-margin-top:64px` to `section[id]`, `h2[id]`, `h3[id]` so a deep-link or topnav click lands with the target heading clear of the sticky bar instead of hidden under it (the nav was a click-trap without it). Added a quiet `:target` accent so the landed-on section is obvious. JS-free; works everywhere the document scrolls.
- **`overflow-x:hidden` sticky-breaker guardrail.** Documented in the topnav block that any ancestor setting `overflow-x:hidden` silently kills `position:sticky` (it forces `overflow-y:auto`, making that ancestor the scroll container so `top:0` pins to it, not the viewport). Fix: use `overflow-x:clip` on `body`/wrappers — never `overflow-x:hidden` above a `.topnav`. Found while reviewing the grok-bot research page, whose body carried `overflow-x:hidden`; the macos-agentic-control page did not, confirming the drift.
- **Lookie caveat recorded.** Noted that neither sticky nor clip pins the in-document nav inside Lookie's content-height iframe (`/view`), where the outer frame scrolls and the document does not — there the persistent navigation is Lookie's own native TOC panel, not this bar.

## v1.21 (2026-07-31)

- Added light theme-follow badge tokens for the surface-backed hero introduced in v1.20: `--badge-bg` now uses a subtle accent/surface mix with a white-alpha fallback, and `--badge-line` uses the viewer hairline. A Playwright computed-style probe confirmed the prior white-alpha badge disappeared against GitHub light while the new token resolves to a visible tinted chip and border.
- Dark theme-follow and fixed-brand themes retain their existing white-alpha badge treatment.
- Finding originated in the Herdr dossier and Android agentic-control design sweep and was promoted only after verification against the shared kit surface.

## v1.20 (2026-07-31)

- **Light theme-follow heroes are surface-backed** (`--hero-bg-start/--hero-bg-end` → `--lookie-bg-elev`/`--lookie-bg` under `[data-lookie-follow-theme]`), completing the contract v1.9 established for dark mode. An accent-gradient hero cannot guarantee readable text across viewer schemes: with the v1.19 ink choice, github light measured 3.07:1 (H1 barely passes AA-large; `.sub`/`.eyebrow` fail), and rose-pine light fails with either white or ink. Hero identity now comes from the `--pop` rule and accent-colored stats in both modes.
- Added `--hero-ink-soft` (maps to `--muted` in theme-follow and auto-dark blocks) and moved deck `slide--cover/divider/end` text to `var(--hero-ink,…)` / `var(--hero-ink-soft,…)` so theme-follow decks inherit the same readable-ink contract; coastal/neutral rendering is unchanged via the fallbacks.
- Added `.table-wrap` — horizontal-scroll container for wide reference tables. Promoted from the Herdr CLI/API reference pages, whose markup already used the class while no rule existed anywhere: the 111-row command catalog scrolled the whole page sideways at 390px (document scrollWidth 515 vs 364 client).
- Added a `pre` code-block surface (`--surface-2`, hairline border, self-scrolling) — reference pages previously rendered bare monospace, and a long one-line example overflowed the page on phones.
- Added `.callout.warn` on the existing `--warn`/`--warn-bg` tokens. Undefined variants (`callout warning`) fell through to the default pop callout, making trust-boundary warnings visually identical to `.callout.info` in schemes where pop == accent (github maps both to the same blue).
- Corrected the `kit.css` header version string (stale at "v1.18" through the v1.19 release — the stale-inline grep check keys on markers like this).
- Verification doctrine: full-page Playwright screenshots of Lookie `/view` pages composite the embed iframe incorrectly and can show a healthy hero as a blank slab (this artifact contaminated the evidence that opened the Herdr theme-fix session). Hero acceptance uses viewport-only captures or in-frame computed probes; contrast is checked computationally in at least one light + one dark scheme.

## v1.19 (2026-07-31)

- Added `--hero-ink`. Theme-following pages now pair hero foreground text with the viewer's readable text token, preventing pale-on-pale heroes in light schemes whose accent surfaces are intentionally subtle; fixed-brand pages retain `--on-accent` by default.
- Documented the canonical hero/nav/main inner-container contract and strengthened Playwright acceptance: visually or computationally verify hero text contrast in at least one light and one dark Lookie scheme instead of treating successful theme injection as sufficient.

## v1.18 (2026-07-29)

- Fixed the photo-lightbox inside Lookie embeds: since the viewer's content-height iframe fix (lookie-link #246), `position:fixed` overlays cover the whole embedded document rather than the visible viewport, so the zoomed image landed off-screen. Zoom now routes through the **viewer's own markdown-style lightbox**: the Lookie embed runtime intercepts clicks on `.photo-lightbox` stage links and drives the wrapper page's `[data-lightbox]` overlay — viewport-centered, closes on click/×/Escape, exactly like markdown files, with no kit markup changes. The kit keeps an `html.lookie-embedded` in-flow stage variant (fixed pixel caps, no viewport units) as a degraded-path fallback — the class is stamped BY the runtime, so this is not a no-JS path; plain-browser/standalone rendering keeps the full-viewport `:target` overlay unchanged.
- The `lookie-embedded` styling hook is the kit's new contract for "this page is inside a Lookie raw-HTML iframe" — use it for any component that must not rely on `position:fixed` or viewport units when embedded.

## v1.17 (2026-07-29)

- Promoted the generic Lookie `scheme-follow-fix` variable sets (12 viewer schemes × light/dark) from per-page style blocks (cruise gallery, venue catalog) into `kit.css` — pages with `data-lookie-follow-theme` now follow every Lookie scheme with no private copy of the block; page-brand schemes remain page-scoped.
- README: theme-follow is now the documented DEFAULT for new deliverables (fixed-brand is the exception), and added the stale-inline hazard check (`grep 'lookie-annotate-btn'` on the built page) after a Syncthing-lagged kit.css shipped a page without the v1.16 annotation-hiding rules.

## v1.16 — 2026-07-29
- Promoted the living cruise-gallery pattern into the shared Kit: `.gallery-dense` provides a fluid venue/trip contact sheet with consistent 4:3 crops and clean single-column collapse.
- Added the script-free `.photo-zoom` → `.photo-lightbox:target` pattern for full-viewport enlargement inside sanitized Lookie HTML, including visible keyboard focus and labeled close-link markup.
- Added a defensive annotation-display contract: if a host injects `.lookie-annotate-btn`, it stays hidden until `html.lookie-annotations-active`; the Kit does not claim or create annotation targets inside raw-HTML iframes.
- Added a working two-image gallery to `EXAMPLES.html` and usage/accessibility markup to `README.md`.

## v1.15 — 2026-07-11
- Added the **stack-up component** (`.stackup`, `.stackup-claim`, `.stackup-record`, `.stackup-grade`, `.stackup-src`): a two-voice claim-vs-record comparison grid — quoted forecasts/claims against what actually happened, with plain-text grade markers. JS-free, single-column on narrow screens, token-driven. Promoted from a personal-side forecast-vs-journal comparison page; demo added to EXAMPLES.html.

## v1.14 — 2026-07-08
- README (same-day addition): verification guidance gained the **token spot-check** rule — confirm a kit CSS variable computes non-empty on the live surface, because CSS error recovery can silently drop the `:root` token block (one corrupt byte between comments killed all tokens in a script-assembled deck; screenshots looked plausibly themed while text was invisible-until-selected in some viewer themes; `?validate=1` does not parse CSS).
- **Slides layer** added to `kit.css`: `body.deck` context, `slide` sections with `slide--cover/divider/statement/end` layouts, `slide-canvas`, `deck-hint`, `aside.notes` speaker notes. Three render tiers from one file, zero JavaScript: stacked document (default; `min-height:min(100svh,640px)` — capped because auto-sized iframes explode uncapped viewport units), scroll-snap deck on landscape ≥700px (root snap, 16:9 canvas sized `min(94vw, 94svh·16/9)`, all type in `cqi` so the composition scales like an image), and 1280×720 print pages (deck pages add their own `@media print{@page{size:1280px 720px;margin:0}}` — `@page` cannot be scoped in shared CSS; export via headless Chromium `--print-to-pdf`).
- README: Presentation/slide-deck scenario row + component-list entry; EXAMPLES gained a slides section.
- Provenance: promoted from the first proof deck (10 slides, three-tier validation: Lookie render, full-screen snap, 10-page PDF at 960×540pt). Technique research: developer-tools/uiux-design/html-css-slide-decks in the public research corpus.

## v1.12 — 2026-07-05
- README: added the **Local venue / place guide** recipe row (details.place with id anchors, .rating, venue photos, transit line per venue, schematic SVG area map, anchor-linked comparison table) — extracted from the Columbia SC yoga guide.
- README: added **Photo sourcing for public-repo artifacts** — show the subject itself (not stand-in landmarks); hotlink from the subject's own site/CDN with credit (nothing copied into the repo); Wikimedia Commons as landmark fallback; og:image-is-usually-a-logo and GET-not-HEAD verification gotchas.

## v1.11 — 2026-07-05
- Added `.rating` component (`.stars` + `.count`) for review ratings in venue/vendor/product research packets — first used by the Columbia SC yoga guide. Numeric value stays plain text beside the stars for searchability.
- README: new "Design phase: pairing with the `frontend-design` skill" section — the skill contributes a signature element, deliberate (system-stack) typography, and copy discipline as page-scoped extensions over kit tokens; the kit remains the system; reusable devices get promoted into kit.css.

## v1.10 — 2026-07-01
- Added `email-table-template.html` for plain, email-safe HTML bodies with inline-styled tables.
- Documented that actual Gmail/recipient email bodies should stay simple: paragraphs, bullets, basic tables, inline CSS only.
- Added guidance to prefer purpose-built email-safe HTML over Markdown-to-HTML conversion when exact table/action-list structure matters.

## v1.9 — 2026-06-29
- Added dedicated `--hero-bg-start` and `--hero-bg-end` tokens.
- Fixed Lookie-following dark theme behavior so large hero/header surfaces stay dark instead of becoming pale accent gradients.
- Re-validated against FOSSA research packets in Lookie dark mode.

## v1.8 — 2026-06-29
- Added dedicated `--nav-bg` token.
- Fixed Lookie-following dark theme contrast for sticky topnav while preserving viewer accent colors for headings and links.

## v1.7 — 2026-06-29
- Codified sticky `topnav` as the default for multi-section HTML artifacts, especially research and review packets.
- Added the YAML `sections:` mirror contract for agent and Lookie metadata access.

## v1.6 — 2026-06-29
- Added provenance link from the company/job research packet recipe to the public Company & Position Research Document Structure methodology research.
- Aligned rich HTML packets with the same section-order expectations as the standards docs.

## v1.5 — 2026-06-29
- Added durable-deliverable guidance requiring `Documentation Standards Used` sections to contain actual clickable links.
- Required matching structured references in YAML/JSON counterparts when present.

## v1.4 — 2026-06-29
- Added research/decision packet components: `signal-grid`, `scorebar`, `evidence-list`, and `risk-matrix`.
- Added small `tile` label/note helpers for company research packets, opportunity reviews, vendor evaluations, and evidence-backed decision briefs.

## v1.3 — 2026-06-28
- Added the `details.place` tap-to-expand accordion component using native `<details>` with shared `name=` groups.
- Documented accordion usage in README and showcased it in `EXAMPLES.html`.

## v1.2 — 2026-06-28
- Added opt-in Lookie-Link theme following via `data-lookie-follow-theme`.
- Added `data-theme="auto"` dark-mode support outside Lookie.
- Added `theme-follow-demo.html` as a focused live viewer test.

## v1.1 — 2026-06-28
- Tokenized nav, pill, callout, and hover colors more completely.
- Added `color-mix()` fallbacks.
- Updated Lookie-Link inter-page-link guidance after the `/view` rewrite fix.

## v1.0 — 2026-06-28
- Initial kit: coastal and neutral themes plus reusable components extracted from the South Carolina trip mini-site.

## 2026-07-31 — topnav v2 + .pending
- `.topnav` redesigned (from the android-agentic-control page, adversarially reviewed): elevated surface + hairline instead of the accent slab (which inverted between schemes), one non-wrapping ~42px scrolling row with a self-cancelling mask fade, muted labels → accent hover, below-hero placement, no brand link. Verified 42px/1-row at 900px across Solarized light, Slate dark, Monokai dark.
- `.pending` chip added — the venue sparse/pending doctrine formalized: unrecorded values render as honest pending markers, never invented data.
