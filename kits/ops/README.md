<!-- File: kits/ops/README.md -->

---
Title: Ops HTML Kit
Owner: Operations Team
Created: 2026-06-28
Last Updated: 2026-09-19
Version: 1.26
Status: Active
Tags: #html #css #design-system #templates #lookie-link
Document URL: ~/operations/templates/html-kit/README.md
Summary: Reusable design tokens + component classes for agent-built HTML deliverables, with a coastal and neutral theme. Lookie-safe.
Read-when: Building any rich HTML deliverable (trip plan, report, dashboard, comparison, research summary, review packet).
Audience: agents
---

# Ops HTML Kit

A small, reusable CSS kit so agent-built HTML deliverables share one consistent, professional look instead of each reinventing styling. Tokens drive everything, so re-skinning = swapping a token block (themes), and components are plain semantic markup.

## Files

| File | Role |
|---|---|
| `kit.css` | Design tokens (`:root` / `[data-theme="…"]`) + component classes |
| `EXAMPLES.html` | Rendered showcase of every component, in both themes |
| `research-packet-template.html` | Findings-first, source-adjacent scaffold for durable research HTML |
| `email-table-template.html` | Plain email-safe HTML pattern for actual email bodies with structured tables |
| `theme-follow-demo.html` | Focused Lookie-Link demo: fixed coastal/neutral panels beside a `data-lookie-follow-theme` panel |
| `CHANGELOG.md` | Version history and notable changes |
| `README.md` | This file — usage, scenario map, Lookie notes, versioning |

## Use it

1. **Pull the styles** into your page — two ways:
   - **Inline** the contents of `kit.css` into a `<style>` block. **Most reliable for standalone report/deliverable pages** (Lookie, a plain browser, PDF). ⚠ **NOT for actual email bodies** — `kit.css` relies on CSS custom properties (`var(--…)`), which Gmail and most email clients strip, so a kit-styled page pasted into an email loses all its color. For email bodies see **Plain HTML email bodies** below.
   - **Link** it: `<link rel="stylesheet" href="kit.css">` when the page sits next to `kit.css` and is served via Lookie-Link (works since the 2026-06 asset-MIME fix) or opened locally.
2. **Pick a theme** on `<body>` (or any wrapper): default is `coastal`; add `data-theme="neutral"` for a business/neutral look; add `data-theme="auto"` when a non-Lookie page should follow the browser/OS dark preference.
   - To opt into the active Lookie-Link viewer theme, add `data-lookie-follow-theme` to `<html>`, `<body>`, or a wrapper. Use this for reports, dashboards, status pages, and review packets that should blend with the viewer. Omit it for branded/identity pages that should keep their own look.
   - **Theme-follow and a fixed theme belong on the same element or are mutually exclusive.** Do not put `data-lookie-follow-theme` on `<html>` and `data-theme="neutral"` (or another fixed theme) on `<body>`: the descendant's fixed tokens override the inherited viewer tokens, so Lookie can stamp dark mode while the artifact stays light. For a theme-following page, omit the descendant `data-theme`; the root token block supplies the plain-browser fallback.
   - Every research HTML primary also adds `data-lookie-render="viewport"` to the root `<html>`. This is mandatory, has no research-package opt-out, and gives the page a real internal scroll container in Lookie so the authored sticky `topnav` remains pinned. The research rule is owned by Research Documentation Standards Rule 19; non-research flowing pages may retain Lookie's default content-height mode.
3. **Compose components** (see `EXAMPLES.html`): `hero` / `topnav` / `card` / `callout` (+ `.info` `.good` `.warn`) / `pill` / `table.budget` / `table-wrap` (horizontal-scroll container for wide reference tables — REQUIRED around any table that can outgrow a phone column) / `pre` code blocks (styled surface, self-scrolling) / `gallery` + `gallery-dense` + `photo-lightbox` / `choose` (nav cards) / `tile` (stat) / **data diagrams** (`dg` card + `dg-ladder` `dg-flow` `dg-branch` `dg-week` `dg-gauge` `dg-compare` `dg-meters` `dg-bridge` `dg-timeline` — see "Data diagrams" below) / `herostats` (findings-before-scroll stat band under the hero) / `confidence` (inline qualification) / `evidence-figure` (source image + caption) / `signal-grid` + `signal` / `scorebar` / `evidence-list` + `evidence` / `risk-matrix` + `risk` / `grid-2` `grid-3` / `timeline` / `links`+`chip` / `ul.tick` `ul.todo` / `note-intro` / `backlink` (hub/corpus return link — this, not a topnav entry, is how a page points back to its parent README) / `details.place` (tap-to-expand accordion) / **slides** (`body.deck` + `slide` layouts + `slide-canvas` — see the Presentation row in the scenario map). For multi-section artifacts, include a sticky `topnav` linking to the major sections in document order; this is the default for research packets and review packets. **topnav v2 rules (2026-07-31):** place it BELOW the hero (the title leads); one non-wrapping row that scrolls with a self-cancelling trailing fade — never let it wrap into a slab; no brand link (it duplicates the H1 — every link names a real section); labels muted, accent on hover. And decorative rules (hero underlines etc.) must derive from `--accent`, never `--pop`, which can vanish against same-hued gradients. For values a source YAML does not yet record, use the `.pending` chip ("awaiting receipt") — never invent data.
   **This list is names only — the markup is in `EXAMPLES.html` (and `research-packet-template.html` for the research components). Open it before composing.** Most components need specific child elements and classes; a plausible guess renders without error and looks wrong. The two whose failure is invisible in code and obvious on screen:

   ```html
   <!-- Tested: rendered in Lookie light/dark, desktop and phone. -->
   <!-- herostats: inside <header class="hero">, after the badges. Each stat is .hs with THREE children. -->
   <div class="herostats">
     <div class="hs"><div class="hsv">34</div><div class="hsk">Backgrounds</div><div class="hsd">What the number means, with its unit or population.</div></div>
     <div class="hs"><div class="hsv"><em>3</em></div><div class="hsk">Over budget</div><div class="hsd">Wrap a bad-semantic value in &lt;em&gt;.</div></div>
   </div>

   <!-- tile: the value goes in .stat, its unit in <small> INSIDE .stat. -->
   <div class="tile"><h3>Unit cost</h3><div class="stat">~$280<small> / unit</small></div><p class="lead">One supporting line.</p></div>
   ```

   A bare `<b>34</b><span>Backgrounds</span>` inside `.hs` runs the value and label together with no spacing.
4. **External links need `target="_blank"`** — Lookie injects `target="_top"` on same-repo document links automatically, but does NOT touch external `https://` links. Without `target="_blank"`, clicking an external link navigates the Lookie iframe instead of opening a new tab. Add `target="_blank"` to every `<a href="https://...">` manually, then lint for malformed `href="https:///..."` / `href="http:///..."` links before handoff. Avoid blind regex/sed anchor rewrites; a brittle bulk replacement caused triple-slash external URLs in a validate-passing artifact on 2026-07-06. Prefer parser-based rewrites or Playwright/DOM inspection. Cross-repo standards links (e.g., Documentation Standards Used sections) can use `~/operations/docs/meta/...` form — Lookie resolves these cross-repo and rewrites to `/view/operations/...` with `target="_top"` (verified 2026-07-06).
5. **Include standards links** in durable deliverables: add a `Documentation Standards Used` section with actual clickable links to the standards that governed the artifact, and mirror those links in YAML/JSON sidecars when present. Use `~/operations/docs/meta/...` form for cross-repo standards links (Lookie resolves them).
6. **Mirror navigation in YAML** for research/review packets: the sticky `topnav` order should match the sidecar's `sections:` array using stable `{id, title, purpose}` entries. HTML gives humans a pleasant navigation surface; YAML gives agents and future Lookie-Link metadata features the same structure without scraping the page.

**Tap-to-expand accordion** (`details.place`) — the Lookie-safe way to get click-to-open detail panes **without JavaScript** (Lookie strips `<script>`). Use native `<details>`; give items a shared `name=` to make the group exclusive (one open at a time; click an open one to close):

```html
<details class="place" name="places"><summary>🏨 Tides Folly Beach</summary>
  <div class="pane"><p class="lead">Oceanfront hotel, 1 min from Center St.</p>
    <div class="links"><a class="chip go" href="...">Book</a></div></div>
</details>
<details class="place" name="places"><summary>🎣 Folly Beach Pier</summary>
  <div class="pane"><p class="lead">Fishing pier at the heart of the beach.</p></div>
</details>
```

### Responsive photo galleries

Use plain `.gallery` for a roomy report gallery. Add `.gallery-dense` for a venue/trip-style contact sheet: cards automatically fit the available width, collapse cleanly to one column, and keep a consistent 4:3 crop.

For Lookie-safe click-to-zoom, wrap each thumbnail in `.photo-zoom` linking to a matching `.photo-lightbox` target. This uses CSS `:target`, not JavaScript, so it survives HTML sanitization. Give the thumbnail meaningful alt text; mark the duplicate enlarged image `aria-hidden="true"`; make the overlay itself a labeled close link back to the gallery heading.

Two rendering contexts (v1.18): in a plain browser the lightbox is the CSS `:target` full-viewport fixed overlay, closed by clicking the stage or browser Back — no JS. Inside a Lookie raw-HTML embed, the Lookie runtime intercepts clicks on stage links and forwards them to the **viewer's own lightbox overlay — the exact one markdown files use** — so zoom is viewport-centered and closes on click, ×, or Escape, identically to the markdown viewer. No page markup changes are needed; the same `.photo-zoom`/`.photo-lightbox` markup serves both contexts. The kit also carries an `html.lookie-embedded` in-flow stage variant as a degraded-path fallback — it applies when the embed runtime stamped the class but its click interception didn't engage; it is NOT a no-JS path (without the runtime the class never exists and plain `:target` overlay rules apply). Never use viewport units in embedded-context overrides; they resolve against the full-height frame (fixed pixel caps only).

```html
<h2 id="photos">Photos</h2>
<div class="gallery gallery-dense">
  <figure>
    <a class="photo-zoom" href="#photo-1" aria-label="Enlarge harbor photo">
      <img src="harbor.jpg" alt="Boats in the harbor at sunset">
    </a>
    <figcaption><b>Harbor</b><br><span class="attr">July 29</span></figcaption>
  </figure>
</div>
<a id="photo-1" class="photo-lightbox" href="#photos" aria-label="Close enlarged photo">
  <img src="harbor.jpg" aria-hidden="true">
</a>
```

The Kit defensively hides `.lookie-annotate-btn` controls by default and reveals them only when a host both injects those controls and sets `html.lookie-annotations-active`. Current Lookie raw-HTML iframes may inject no section targets at all; this CSS does not create annotation capability.

## Design phase: pairing with the `frontend-design` skill

When a deliverable warrants real design investment (durable public research packets, guides, dashboards with a long shelf life), load the **`frontend-design`** skill (claude-plugins-official plugin) during the design phase — *before* composing markup. Division of labor:

- **The kit stays the system.** Tokens, components, and themes come from `kit.css` — the skill never replaces the kit or justifies hand-rolling a stylesheet. Its "avoid templated defaults" calibration is about *choices within* the system.
- **The skill contributes three things**: (1) a **signature element** — one memorable, subject-grounded device per artifact (e.g., a schematic inline-SVG map when geography organizes the content); (2) **deliberate typography** — a page-scoped display-face choice (system font stacks only — no external fonts, they break under Lookie/CSP) layered over kit tokens; (3) **copy discipline** — plain verbs, user-side naming, no filler.
- **Page-scoped extensions** go in a short marked block at the end of the inline `<style>` (`/* ---- page-scoped extensions (<slug>) — kit tokens only ---- */`), reference kit tokens (`var(--accent)` etc.) so themes keep working, and respect `prefers-reduced-motion`.
- **Skip it** for routine/internal artifacts (status reports, quick comparisons) — kit defaults are the right amount of design there.
- If a page-scoped device proves reusable across artifacts, promote it into `kit.css` as a component (as `.rating` was in v1.11) rather than copy-pasting it forward.

First artifact built this way: the Columbia SC yoga guide (operations-research/lifestyle/yoga-columbia-sc/) — serif display headings + schematic river-district SVG map as the signature element.

### Photo sourcing for public-repo artifacts

- **Show the subject itself, not stand-in landmarks** — when a guide covers venues, each venue's panel gets a photo of that venue; area/landmark photos are context only.
- **Hotlink from the subject's own website/CDN** (Wix `wsimg`, Squarespace CDN, etc. count as their hosting) — the browser fetches from their server, nothing is copied into the repo (server-test safe). Credit with a link under each image. Never copy third-party images into a public repo.
- **Wikimedia Commons** is the fallback for landmarks/context (hotlink the `1280px-` thumb, credit author + license — CC BY-SA requires it).
- Extraction gotchas: `og:image` is usually a logo — check inner pages (about/classes/gallery) for real space photos; verify URLs with **GET, not HEAD** (many CDNs reject HEAD); Squarespace serves webp for `.jpg` URLs via content negotiation (fine).
- If no usable self-hosted photo exists, say so in the artifact and link the venue's own gallery (Yelp/Instagram/Facebook) instead.

## Scenario → recipe (starting map)

| Deliverable | Theme | Lean on |
|---|---|---|
| Trip / itinerary plan | coastal | `hero.photo`, `choose`, `gallery gallery-dense`, `photo-lightbox`, `timeline`, maps (inline SVG), `table.budget` |
| Financial / business report | neutral | dense `table`, `tile` stats, `callout.info`, `pill` |
| Options / vendor comparison | either | `table` with `.pick` row, `grid-3` `tile`, `pill` |
| Research summary | neutral | Start from `research-packet-template.html`: thesis-led `hero`, 3–4 decision-bearing `herostats`, one visual argument per `dg`, adjacent `evidence-figure`/citations/`confidence`, gaps + method + sources in back matter |
| Local venue / place guide (studios, restaurants, vendors) | coastal | `details.place` per venue (with `id=` anchors), `.rating`, venue photo via `banner-photo` (hotlinked from the venue's OWN site — see photo sourcing below), transit/access line per venue, schematic inline-SVG area map, comparison `table` with `.pick` rows and anchor-linked names |
| Company/job research packet | neutral | `signal-grid`, `scorebar`, `risk-matrix`, `evidence-list`, tables, `callout.info` — see [document structure research](https://github.com/chrisfonte/operations-research/blob/main/business/career-research-methodology/company-and-position-research-document-structure.yaml) for ideal section ordering |
| Dashboard / status | neutral | `tile` stats, `pill` badges, `grid-3` |
| Presentation / slide deck | either | `body.deck` + `slide slide--{cover,divider,statement,end}` + `slide-canvas` — one file renders as document (Lookie/phones), scroll-snap deck (full-screen browser, Space advances, no JS), and 1280×720 PDF. **The page must add its own print block** (`@media print{ @page{size:1280px 720px;margin:0} }` — `@page` can't be scoped in shared CSS). Export PDFs with headless Chromium `--print-to-pdf`, never the print dialog. Never use uncapped `100svh` in document tier (auto-sized iframes explode it — the kit caps at `min(100svh,640px)`). Speaker notes: `<aside class="notes">` (hidden on screen and in PDF) |
| Multi-page bundle (hub + pages) | any | `topnav`, `choose` on the hub — **see inter-page links below** |

## Findings-first research packet assembly (v1.24)

Start durable research HTML from `research-packet-template.html`. The reusable composition is
an evidence sequence, not a subject-specific palette:

1. State the decision-bearing thesis in the hero; a subject-grounded signature device may
   decorate it, but does not carry data.
2. Put three or four source-backed findings in `herostats` so the reader sees the answer before
   scrolling. A visually large number must remain traceable to a source and measurement context.
3. Give each `dg` card one visual argument. The title states the claim; the diagram shows only
   measured or explicitly unknown values; its note points to adjacent evidence.
4. Place evidence immediately after the claim it supports: citations, a semantic
   `figure.evidence-figure`, and short `.confidence` language. Do not make the reader reconcile a
   front-page claim with a source list several screens away.
5. Put uncertainties, sampling limits, method, sources, and documentation standards in the back
   matter. These qualify the findings; they do not replace them.

Page-specific signature elements stay page-scoped: a product mark, subject watermark, copied UI
text, and all measurements. Promote only the structural class that works for another subject.
The legacy aliases `.conf`, `.dg-tl`, `.btag.no/.yes`, and `.ck.aftert` remain supported so older
packets can adopt the current semantic tokens without a risky markup rewrite; new pages use
`.confidence`, `.dg-timeline`, `.btag.ok/.bad`, and `.ck.after`.

### Describing a successful artifact with Playwright before promotion

Treat promotion as a measured composition receipt, not a screenshot-inspired copy. In the live
rendered document (prefer the Lookie embed frame when `/view` wraps it), record:

- authored section IDs and topnav labels in order, and prove their parity;
- counts of hero stats, diagram families, evidence figures, tables, media, confidence annotations,
  and external links — ignore host-injected classes and controls;
- computed values for every semantic token the candidate component needs; an empty custom
  property is drift even when page-local CSS makes the screenshot look plausible;
- desktop and phone geometry in light and dark, including horizontal overflow, decoded/broken
  media, sticky-nav behavior, and a deep-link landing clear of the nav;
- which traits are reusable structure and which are subject/data-specific.

Run the same probes after promotion against `EXAMPLES.html` or the template. A class earns the kit
only when the structural pattern generalizes and its semantics survive all four render contexts.
Use the maintained Playwright helpers documented in
`~/operations-system/scripts/tools/playwright/README.md`; use instant scrolling for geometry probes
because smooth scrolling otherwise samples mid-animation.

## Data diagrams and the semantic-color rule (v1.24)

Promoted from the grok-bot-usage-limits research package (2026-08-21) after screenshot
verification in Lookie light and dark. These turn a finding into a visual argument without
rasters or scripts — each `.dg` card carries an eyebrow, a title that states the claim, and
one diagram.

| Class | Use it for |
|---|---|
| `dg` | The diagram card itself: `dg-eyebrow` + `dg-title` + one visual + optional `dg-note` |
| `dg-ladder` | Known-vs-unknown comparison rows — label, scaled bar + value, qualitative label; `.lq` renders the big "?" for unquantified claims; `.lrow.na` for excluded rows |
| `dg-flow` | Left-to-right process boxes with inline-SVG arrows (`.farrow`, `currentColor`); `.fbox.hot` marks the risky step |
| `dg-branch` | A decision's outcomes as tag + body rows; `.btag.ok` / `.btag.bad` state the semantics of each branch; `.bbody.hot` for the open-risk body |
| `dg-week` | A span-of-time strip: colored phase segments (start `--accent`, incident `--sem-bad`, resolution `--good`, idle `--page-2` + dashed) |
| `dg-gauge` | Labeled meters: name + number, fill bar (width = data, inline style; color = semantics), one-line note |
| `dg-compare` | Verbatim before/after evidence cards for policy or page changes; `.ccell.after` carries the changed state |
| `dg-meters` | Distinct usage-meter families; each `.mcol` is one family, `.mpool.hot` the current constraint, `.mpool.ghost` an unknown pool |
| `dg-bridge` | A short reconciliation statement between diagrams or evidence sets |
| `dg-timeline` | Compact evidence chronology; `.tdot.mid` is warning and `.tdot.end` is the adverse/limit event |
| `herostats` | Findings-before-scroll: a 4-up stat band directly under the hero (hero gets `padding-bottom:0`); surface-backed per the v1.20 hero-contrast contract; wrap bad-semantic numbers in `<em>` |

**The semantic-color rule (the reason this block exists).** Theme-follow remaps `--pop` to
the *viewer's* accent — on GitHub-dark that is green, which silently inverted a "100% burned"
gauge into success-green in a shipped research page. So: anything that **means** bad / over /
exhausted / regression uses `var(--sem-bad)` (a warm hue pinned in every theme block: coastal
`#e06b4f`, neutral `#c4603f`, theme-follow light `#c4603f`, theme-follow dark and auto-dark
`#e8846b`); anything that means good uses `var(--good)`. `--pop` stays decorative-only (hero
rules, flair) — same family as the v2 topnav rule that decorative rules derive from
`--accent`, never `--pop`. Neutral emphasis (big stat numbers) stays `--accent-deep`.

Two composition habits that shipped with the family: **bar widths and segment colors are
data** — set them inline per instance, scaled to the real maximum, never invented; and **run
`date` before authoring any weekday/calendar label** in a diagram (a shipped burn timeline
briefly labeled Aug 20 "Wed"; it was a Thursday).

## Plain HTML email bodies

Use `email-table-template.html` when the artifact is not a standalone Lookie/report page but the **actual email body** to send through Gmail. This applies to vendor cancellation lists, service inventories, approval matrices, and other emails where organization matters.

Rules for email HTML:

- **Fully inline styles — no `<style>` block, no `kit.css`.** This is the hard rule. `style="…"` on every element, **hardcoded hex colors** (no `var(--…)` — email clients strip CSS custom properties; this is the #1 way a good-looking page arrives colorless in Gmail).
- **Banned features** (unreliable across Gmail / AOL / Outlook): CSS variables, `<style>`-block reliance, **flexbox** (`display:flex`), CSS grid, `@media` queries (incl. `prefers-color-scheme` — email clients do their own dark-mode munging), and `:hover`/pseudo-classes for anything that must be visible. Fixed **light** palette is safest.
- **Layout with tables, not divs+flex.** Center with a `<table role="presentation">` wrapper (`max-width:640px`). For "card" looks use a table cell with inline `background`/`border`/`border-radius`/`padding`. For a numbered badge use `display:inline-block` with fixed `width`/`height`/`line-height`/`border-radius:50%` — never flex.
- **You can still make it look good.** Inline-styled tables support rounded cards, colored callout boxes (inline `background`), numbered badges, and pill/"source" tags — you just rebuild them without the CSS-variable system. When the rich deliverable already exists in kit form, author a **separate `-email.html`** rather than trying to retrofit the kit page.
- Prefer purpose-built HTML over Markdown-to-HTML conversion when table columns, row wording, or action clarity matter.
- **Always include a plain-text fallback** (`--body-file` alongside `--body-html-file` in `gog send` → multipart).
- **Verify before sending**: render headless to a PNG and eyeball it (catches broken color/layout that passes a tag lint), AND open the `.html` via **Lookie `/view`** for the human to review/annotate. Quick self-lint — all of these should return **zero** in an email file: `grep -c 'var(--\|display:flex\|<style\|@media' file.html`.
- Send path (this deployment): `gog send` needs the keyring password to actually send — see the private `gog-send-html-email-path` note. Reading gmail doesn't; sending does.

Grow this map from real use; don't pre-build themes/components nothing uses yet.

## Lookie-Link notes (important)

Owner of these mechanics: [[lookie-link.yaml]] (~/operations/ai-tools/knowledge/integrations/lookie-link.yaml) `supported_formats.html`. In short:

- **A probe of the `/view/…` URL measures the viewer's shell, not your page.** The viewer renders your document inside an iframe that it fills after load. Evaluate in the top document and you get the shell's own heading (your *filename*), its one chrome image (`0/1` loaded), and no horizontal overflow — which reads exactly like a clean pass. Enumerate the frames, wait for your content, and evaluate inside the frame:

  ```js
  // Tested 2026-09-19 against a live /view page at 1440 and 400 px wide.
  await page.goto(viewUrl, { waitUntil: 'networkidle' });
  for (const frame of page.frames().filter(f => f !== page.mainFrame())) {
    await frame.waitForSelector('main, h1', { timeout: 10000 }).catch(() => {});
    console.log(await frame.evaluate(() => ({
      h1: document.querySelector('h1')?.textContent.trim(),          // your title, not the filename
      imgs: [...document.images].filter(i => i.complete && i.naturalWidth).length + '/' + document.images.length,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    })));
  }
  ```

  Sanity check on any result: if the reported `h1` is your filename, or the image count is `0/1`, you measured the shell. The host also injects its own controls into your document (an annotation button inside headings, for one), so compare text with `includes`, not equality, and ignore host-injected classes when counting. The maintained screenshot helpers already do the frame handling; this matters whenever you write a probe by hand. Related traps in the bullets below: full-page captures stitch the frame as a blank slab, and smooth scrolling samples mid-animation.

- **CSS works** (inline always; external `kit.css` via `<link>` works post-2026-06 fix — Lookie injects a `<base href=…/asset/…>` and `/asset` serves `text/css`).
- **No JavaScript** — the viewer sanitizes `<script>`. Don't rely on in-page JS; use Lookie annotations for feedback. For **click-to-expand interactivity** (detail panes, FAQs, place lists), use `details.place`; for image enlargement, use the CSS-target `photo-lightbox` pattern. Both work without JS.
- **Inter-page links work as normal relative links.** In a multi-page bundle, use portable links like `<a href="other.html">`, `<a href="../overview.html#summary">`, or `<a href="./chapter/">`. Lookie-Link rewrites same-repo HTML document links to `/view/<repo>/...` with `target="_top"` while keeping `img`/`css`/media refs on `/asset`.
- **Pin the `topnav` in Lookie by declaring the viewport render mode (2026-08-13; research mandate 2026-08-22).** A page's own sticky `topnav` cannot pin inside Lookie's default content-height frame (the outer viewer scrolls, the document never does). Every research HTML primary therefore adds `data-lookie-render="viewport"` to the root `<html>` (beside `data-lookie-follow-theme`) with no opt-out. Non-research multi-section kit pages add it when they use a sticky topnav or another viewport-relative layout. Lookie then hosts the artifact in a real scrolling frame where `position:sticky`/`fixed`, `:target`, and the `photo-lightbox` all work natively and the bar pins with its kit styling. For non-research flowing documents, no hint keeps the seamless single-scroll reader; viewport mode trades that for an internal scroll region. Independently, Lookie builds the persistent `☰` TOC for the page in **both** modes (from heading ids and `section[id]` wrappers). Owner: `supported_formats.html.render_modes` / `.native_toc` in the integration yaml; research mandate: Research Documentation Standards Rule 19; composition convention: documentation-best-practices `#html-composition-checklist`.
- **Theme following is the DEFAULT for deliverables (2026-07-29 operator decision).** Put `data-lookie-follow-theme` on `<html>` of every new kit page unless the artifact is deliberately fixed-brand — a page without it ignores the viewer's theme, which reads as broken ("should use the theme"). Lookie-Link injects `data-lookie-link-theme`, `data-lookie-link-scheme`, `color-scheme`, and `--lookie-*` variables into trusted raw-HTML iframes; the kit consumes them only when that attribute is present. As of v1.17 the kit also ships the generic per-scheme `--lookie-*` variable sets (slate/teal/github/monokai/nord/noir/solarized/rose-pine/ember/fireflies/indigo/folly-beach), so pages no longer need a private `scheme-follow-fix` style block — only page-brand schemes stay page-scoped.
- **Stale-inline hazard (2026-07-29, bitten in production).** When inlining `kit.css` at build time, verify the copy you embedded actually contains the current rules — `grep -c 'lookie-annotate-btn'` on the OUTPUT file must be ≥1 (annotation-hide default) and the scheme-follow section should be present. A Syncthing-lagged kit.css produced a page missing the v1.16 annotation-hiding rules the same day they shipped.
- **Authoring a custom scheme? The structural colour goes in `link`, not `accent`.** When you add a brand scheme to the Lookie-Link config's `themes:` block, remember which way the kit reads it: the kit maps its own `--accent` (section rules, borders, leader dots, hero rule — the page's visible structure) from **`--lookie-link`**, while `--lookie-accent` drives viewer chrome (TOC highlight, toolbar). So the colour a viewer will read as "this page's colour" is whatever you put in the scheme's **`link`** key. Put the identity colour there and the secondary in `accent`. Getting this backwards produces a page themed in the wrong colour that still passes every automated check — it renders, tokens resolve, contrast is fine; only *looking at it* catches it (found 2026-07-30 authoring a venue scheme: turquoise went in `accent`, and the page came out red-structured). Check contrast on the `link` value against the scheme's `bg`, since it is now doing heavy structural duty.

- **Use the focused demo when checking theme behavior.** `theme-follow-demo.html` shows fixed-theme panels beside a Lookie-following panel, making it obvious what should and should not change when the viewer theme changes.
- **Verify on the live `/view/…` URL**, not just `file://` — a reusable screenshot helper lives in the private system hub at `scripts/tools/playwright/screenshot.mjs` (with its own README covering per-machine invocation; note that `~/operations-private/` in public docs is a sanitization alias, not a literal path — resolve it to the actual private system hub). **Full-page (`fullPage:true`) captures of `/view` pages are NOT valid hero/above-the-fold evidence**: headless Chromium composites the embed iframe incorrectly when stitching, so a healthy hero can screenshot as a giant blank slab (bitten twice, 2026-07-31 — a fix cycle chased a ghost defect this created). Confirm hero text with viewport-only captures (`fullPage:false`) or by evaluating boxes/computed colors inside the `/embed/` frame.
- **Measuring sticky or scroll behavior headlessly? Kill smooth scrolling first.** The kit sets `scroll-behavior: smooth` on `html`, so a `window.scrollTo(...)` followed immediately by `getBoundingClientRect()` or a screenshot samples the page **mid-animation**: a correctly pinned `topnav` reads as `top: -5698` and captures as though sticky were broken. Scroll with `behavior:'instant'` (or set `scroll-behavior:auto` for the probe), let it settle, then measure or capture. Bitten 2026-08-24 verifying a research primary's viewport contract — the first probe reported a sticky failure that did not exist and a second probe on the same page returned `navTop: 0`. Probe the **`/embed/` URL, not `/view`**: the `/view` artifact iframe is sandboxed cross-origin, so the wrapper page cannot script into it, and a wheel event dispatched at the wrapper does not scroll the frame either.
- **Verify tokens actually applied, not just "page renders."** A single corrupt byte in inlined CSS can silently kill the whole `:root` token block (CSS error recovery drops the next rule) — the page still renders in browser-default colors that can pass a casual screenshot check and `?validate=1` (which does not parse CSS), while being unreadable on other surfaces. Spot-check a computed style (e.g., `getComputedStyle(document.documentElement).getPropertyValue('--accent')` is non-empty, or body background is the kit gradient). Cause found 2026-07-08: a script-assembled deck embedded a literal `\n` between CSS comments, killing all kit tokens; text was invisible-until-selected in some viewer themes. If assembling HTML programmatically, prefer file reads/concatenation over string escapes.

### Retrofitting a non-kit page to theme-follow (2026-07-19)

The `data-lookie-follow-theme` attribute is **inert by itself** — it only does something when CSS consumes the injected `--lookie-*` variables. Kit pages get that for free from `kit.css`; a page with a hand-rolled stylesheet needs a small mapping block or the attribute silently changes nothing (and structural lint that checks only for the attribute will still pass it). Retrofit recipe, proven on a real package 2026-07-19:

1. Add `data-lookie-follow-theme` to `<html>`, `<body>`, or a wrapper.
2. Append a token-mapping block at the end of the page's `<style>`, mapping the page's own custom properties onto the Lookie variables with the fixed values as fallbacks, e.g. `[data-lookie-follow-theme]{--accent:var(--lookie-link,#315f8c);--page:var(--lookie-bg,#edf1f5);--surface:var(--lookie-bg-elev,#fff);--line:var(--lookie-border,#d8e0e8);--ink:var(--lookie-text,#172331);--muted:var(--lookie-text-soft,#586878);}` — plus overrides for any **hardcoded literal backgrounds** (zebra rows, callout tints) that would otherwise stay light in a dark viewer theme.
3. **Surfaces with hardcoded light text stay dark**: a hero/banner with literal `#fff` text must keep a fixed dark background under theme-follow, not the remapped accent gradient — the same failure the kit's own v1.9 `--hero-bg-*` tokens fixed (an accent-mapped gradient goes pale in dark viewer themes and washes out the white text). Deliberately-branded accents (e.g. per-item brand colors) may stay fixed; say so in a comment.
4. Verify on the live `/view/…` URL in **both** viewer themes — and on a Syncthing peer, **confirm the served copy actually contains your edit first** (fetch the raw endpoint and grep for a marker string): the serving machine lags the local edit by a sync cycle, and a too-fast screenshot verifies the *previous* version while looking perfectly normal (observed 2026-07-19).

## Versioning

Bump `Version` here and add a dated note when tokens/components change. Record full version history in `CHANGELOG.md`. Already-produced deliverables that **inlined** the CSS are frozen at their version (a kit update doesn't retroactively restyle them); linked pages pick up changes automatically.

- **v1.21 (2026-07-31):** Light theme-follow badge visibility. v1.20 made light-mode theme-follow heroes surface-backed but left `--badge-bg`/`--badge-line` as white-alpha, so hero badges rendered as invisible chips on the light hero surface (confirmed by computed-style probe against the kit surface in the github light scheme: `rgba(255,255,255,.16)` chip on a `#f6f8fa→#fff` hero). The light `[data-lookie-follow-theme]` block now sets `--badge-bg:color-mix(in srgb,var(--accent) 8%,var(--surface))` (white-alpha kept as the pre-`color-mix` fallback) and `--badge-line:var(--line)`. Dark follow mode and the fixed coastal/neutral themes keep white-alpha badges — their heroes remain dark/accent surfaces. Found retrofitting the herdr and android-agentic-control research pages to the v1.20 hero contract.

- **v1.20 (2026-07-31):** Theme-follow heroes are now **surface-backed in light mode too**: under `[data-lookie-follow-theme]`, `--hero-bg-start/--hero-bg-end` map to `--lookie-bg-elev`/`--lookie-bg` in both modes. Rationale: viewer accent endpoints can be any lightness, so an accent-gradient hero cannot guarantee contrast with either ink (github light measured 3.07:1 with `--hero-ink:ink`; rose-pine light fails with both white and ink). Identity now carries via the hero rule and accent-colored stats, matching the dark contract since v1.9. Added `--hero-ink-soft` and switched deck cover/divider/end slide text to `--hero-ink`/`--hero-ink-soft` fallbacks so theme-follow decks track the same contract (fixed themes unchanged via fallbacks). New components: `.table-wrap` (horizontal-scroll container — wide reference tables were scrolling the whole page sideways on phones), a `pre` code-block surface, and `.callout.warn` (warnings previously fell through to the default pop callout and rendered identical to `.callout.info` in schemes where pop == accent, e.g. github). Corrected the `kit.css` header version string, which had stayed at v1.18 through the v1.19 release. Acceptance: full-page Playwright captures of `/view` cannot verify the hero (see the Lookie-Link note above) — use viewport-only captures or in-frame probes, and check hero text contrast computationally in at least one light and one dark scheme, including one saturated-accent light scheme (github) on phones.

- **v1.19 (2026-07-31):** Added the `--hero-ink` contract so theme-following heroes use the viewer's readable text color when a light scheme maps both accent endpoints to pale surfaces. Canonical kit structure is `<header class="hero"><div class="wrap">…</div></header>`, followed by `<nav class="topnav"><div class="inner">…</div></nav>`, then `<main class="wrap">…</main>`; omitting those inner containers breaks width, layering, and navigation-order assumptions. Playwright theme acceptance must confirm hero text visibility—not only theme stamps, overflow, and broken images—in at least one light and one dark Lookie scheme.

- **v1.18 (2026-07-29):** Embedded-context photo-lightbox fix. The Lookie viewer now sizes raw-HTML iframes to their content (lookie-link #246), which broke `position:fixed` overlays (they cover the whole document, not the visible viewport). Photo zoom inside embeds now routes through the viewer's own markdown-style lightbox (click/×/Escape close, viewport-centered) via the Lookie embed runtime — same kit markup, no page changes. The kit keeps an `html.lookie-embedded` in-flow stage variant as a degraded-path fallback (runtime present but interception unavailable; not a no-JS path — without the runtime the class doesn't exist). `lookie-embedded` is the general styling hook for "framed by Lookie" — components must not rely on `position:fixed`/viewport units under it.
- **README-only (2026-07-22):** Hardened the **Plain HTML email bodies** rules after a real Gmail send (a recipient-facing explainer). Corrected the "Use it" claim that inlining `kit.css` "works in email" — it does **not**, because `kit.css` uses CSS custom properties (`var(--…)`) that Gmail/AOL/Outlook strip, arriving colorless. New rules spell out fully-inline styles + hardcoded hex, the banned-feature list (CSS vars, `<style>` reliance, flexbox, grid, `@media`), table-not-flex layout, authoring a separate `-email.html`, the render-to-PNG + Lookie `/view` pre-send check, and the `grep -c 'var(--\|display:flex\|<style\|@media'`-should-be-zero self-lint. `kit.css` unchanged.
- **README-only (2026-07-19):** Added the **"Retrofitting a non-kit page to theme-follow"** recipe (attribute is inert without token-consuming CSS; token-mapping block with fallbacks; hardcoded-light-text surfaces keep fixed dark backgrounds per the v1.9 hero rationale; verify both viewer themes AND that the Syncthing-served copy contains the edit before trusting a live screenshot). Proven on the gpt-5-6-family-comparison retrofit; `kit.css` unchanged.
- **v1.15 (2026-07-11):** Added the **stack-up component** (`.stackup` + claim/record/grade/src classes) — a two-voice claim-vs-record comparison grid for forecast-vs-actual, prediction-vs-outcome, or plan-vs-result pages. Demo in EXAMPLES.html.
- **v1.14 (2026-07-08):** Added the **slides layer** — `body.deck`, `slide` + `slide--cover/divider/statement/end` layouts, `slide-canvas`, `deck-hint`, `aside.notes`. One HTML file renders three ways with zero JS: stacked document (viewport units capped at `min(100svh,640px)` — uncapped `svh` explodes in auto-sized iframes like the Lookie viewer), root scroll-snap deck on landscape screens (16:9 canvas, `cqi`-scaled type), and 1280×720 print pages (the page adds its own `@page` block; export via headless Chromium). Promoted from the first proof deck after three-tier validation; technique research: [HTML/CSS Slide Decks Without JavaScript](https://github.com/chrisfonte/operations-research/blob/main/developer-tools/uiux-design/html-css-slide-decks/html-css-slide-decks.md).
- **v1.13 (2026-07-06):** Added raw-HTML iframe link guidance from Playwright/CMUX Opus validation: external `https://` anchors need authored `target="_blank"` because Lookie only rewrites same-repo document links to `target="_top"`; lint for malformed `https:///` / `http:///` anchors because `?validate=1` does not currently check external URL well-formedness; cross-repo standards links in HTML can use `~/operations/docs/meta/...`, which Lookie resolves to the served `operations` repo.
- **v1.10 (2026-07-01):** Added `email-table-template.html` and guidance for plain, email-safe HTML bodies. This is intentionally separate from rich HTML deliverables: use it for actual Gmail/recipient email bodies with simple inline-styled tables instead of Markdown-to-HTML conversion when structure matters.
- **v1.9 (2026-06-29):** Added dedicated `--hero-bg-start` / `--hero-bg-end` tokens so Lookie-following dark themes keep the hero/header surface dark instead of turning the whole banner into a light accent gradient.
- **v1.8 (2026-06-29):** Added a dedicated `--nav-bg` token so Lookie-following dark themes can keep topnav contrast high while headings still use the viewer accent color.
- **v1.7 (2026-06-29):** Codified sticky `topnav` as the default for multi-section HTML artifacts, especially research and review packets, and added the YAML `sections:` mirror contract for agent/Lookie metadata access.
- **v1.6 (2026-06-29):** Added provenance link from the company/job research packet recipe to the public [Company & Position Research Document Structure](https://github.com/chrisfonte/operations-research/blob/main/business/career-research-methodology/company-and-position-research-document-structure.yaml) methodology research so rich HTML packets inherit the same section-order expectations as the standards docs.
- **v1.5 (2026-06-29):** Added durable-deliverable guidance requiring `Documentation Standards Used` sections to contain actual clickable links, with matching structured references in YAML/JSON counterparts when present.
- **v1.4 (2026-06-29):** Added research/decision packet components: `signal-grid`, `scorebar`, `evidence-list`, and `risk-matrix`, plus small `tile` label/note helpers. These support company research packets, opportunity reviews, vendor evaluations, and evidence-backed decision briefs without custom one-off CSS.
- **v1.3 (2026-06-28):** Added the `details.place` **tap-to-expand accordion** component — native `<details>` with a shared `name=` for exclusive open/close, no JavaScript (Lookie-safe). Documented in component list + Lookie notes; showcased in `EXAMPLES.html`.
- **v1.2 (2026-06-28):** Added opt-in Lookie-Link theme following via `data-lookie-follow-theme`, plus `data-theme="auto"` dark-mode support outside Lookie. Added `theme-follow-demo.html` as a focused live viewer test.
- **v1.16 (2026-07-29):** Added the dense responsive gallery, script-free click-to-zoom lightbox, keyboard focus treatment, and default-hidden Lookie annotation controls; promoted from a living cruise gallery.
- **v1.1 (2026-06-28):** Tokenized nav/pill/callout/hover colors more completely, added `color-mix()` fallbacks, and updated Lookie-Link inter-page-link guidance after the `/view` rewrite fix.
- **v1.0 (2026-06-28):** Initial kit — coastal + neutral themes; components extracted from the SC trip mini-site.
