<!-- File: docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md -->

---
Title: Lookie-Link NotebookLM Artifact Coverage Audit
Owner: Lookie-Link Maintainers
Created: 2026-06-09
Last Updated: 2026-06-09
Version: 1.1.0
Status: Active
Tags: #notebooklm #lookie-link #audit #artifacts
Document URL: docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md
External Issue: https://github.com/chrisfonte/lookie-link/issues/64
Related: FON-11756 (Paperclip), FON-11519 (asset MIME allowlist)
---

# Lookie-Link NotebookLM Artifact Coverage Audit

This audit verifies how the Lookie-Link feature surface handles every artifact type produced by an agentic NotebookLM bundle. It pairs with the [NotebookLM Artifact Display Manifest](NOTEBOOKLM-ARTIFACT-MANIFEST.md) and external issue [`chrisfonte/lookie-link#64`](https://github.com/chrisfonte/lookie-link/issues/64).

## Method

Each artifact type is probed against a running Lookie-Link instance on two routes:

- `GET /view/<repo>/<path>` — the rendered review page humans land on.
- `GET /asset/<repo>/<path>` — the raw byte path used by inline players, image tags, the PDF embed, and the `lookie-read` agent CLI.

Reference fixtures live under `operations-research/ai-tools/notebooklm/`. Each row reports the actual HTTP status, Content-Type, and review UX observed in-browser.

## Results

| Artifact | Extension | `/view` UX | `/asset` Content-Type | Markdown-link UX | Coverage verdict |
|---|---|---|---|---|---|
| Briefing doc, study guide, blog post, Q&A log, manifest, etc. | `.md` | Native markdown render with anchors, TOC, theme toggle | `text/markdown; charset=utf-8` | Standard `<a>` link → rendered view | Supported |
| Audio overview | `.m4a` | Dedicated audio player page with controls, download, file metadata | `audio/mp4` (Range requests honored) | Inline `<audio>` player auto-rendered from markdown link | Supported |
| Slide deck | `.pdf` | Dedicated viewer page with embedded PDF frame, "Open in browser", download | `application/pdf` | Markdown links to `.pdf` open the viewer page | Supported |
| Infographic | `.png` | Dedicated image page; inline images get a lightbox when referenced from markdown | `image/png` | `![alt](path.png)` renders inline; click → lightbox | Supported |
| Capabilities / data tables | `.csv` | Renders as auto-highlighted text in the document page (no table layout) | `text/csv; charset=utf-8` (added in commit `b460e5e`) | Standard `<a>` link → text view (no table) | Supported (raw); see Gap 2 for table viewer |
| Flashcards, mind-map mismatches | `.json` | JSON syntax-highlighted via highlight.js, with theme + anchor support | `application/json; charset=utf-8` | Standard `<a>` link → highlighted JSON view | Supported (documented behavior: highlighted raw view, no special viewer) |

> Historical note: during initial audit (2026-06-09) the live process predated commit `b460e5e`, so `/asset/<…>.csv` returned `415` and the text-MIME allowlist commit (`e2d3e88`, FON-11519) was not yet running. The live server has since been restarted and all six types return the table-listed Content-Type.

## Recommended Agent Export Format

When the NotebookLM source side offers a choice of export formats, agents should pull back the variant that maps cleanly onto the supported review path above:

- Reports, briefings, study guides, blog posts → markdown (`.md`).
- Slide decks → PDF (`.pdf`), not PPTX. PDF renders in-browser; PPTX is a binary download.
- Audio overviews → `.m4a`, `.mp3`, or another browser-playable codec. Avoid raw WAV when an encoded option exists.
- Infographics → PNG. SVG is also fine; both render inline. Avoid PDF for single-image infographics because the PDF path is dedicated to deck-style review.
- Tabular data → CSV is the canonical interchange format. UX caveat: CSV does not yet have a dedicated table viewer (see Gap 2); review it via the manifest companion or download.
- Raw structured exports (flashcards, mind maps) → JSON. JSON renders as highlighted raw text — keep the markdown companion (qa log / manifest) so a reviewer knows what they are looking at before opening the file.

## Live Coverage Test

The fastest way to confirm coverage is to open each artifact type in a browser against the live instance. The URLs below use the canonical NotebookLM topic hub as fixtures.

Replace `<host>` with your reachable Lookie-Link host (e.g., `localhost:9876` or `mac-mini-2.bobcat-tetra.ts.net:9876`).

| Type | `/view` (rendered review page) | `/asset` (raw byte path) |
|---|---|---|
| `.md` | `/view/operations-research/ai-tools/notebooklm/notebooklm-briefing-doc.md` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-briefing-doc.md` |
| `.m4a` | `/view/operations-research/ai-tools/notebooklm/notebooklm-audio-overview.m4a` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-audio-overview.m4a` |
| `.pdf` | `/view/operations-research/ai-tools/notebooklm/notebooklm-slide-deck.pdf` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-slide-deck.pdf` |
| `.png` | `/view/operations-research/ai-tools/notebooklm/notebooklm-infographic.png` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-infographic.png` |
| `.csv` | `/view/operations-research/ai-tools/notebooklm/notebooklm-data-table.csv` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-data-table.csv` |
| `.json` | `/view/operations-research/ai-tools/notebooklm/notebooklm-flashcards.json` | `/asset/operations-research/ai-tools/notebooklm/notebooklm-flashcards.json` |

A passing pass means every `/view` URL returns a sane review page and every `/asset` URL returns HTTP 200 with the Content-Type listed in the Results table.

The audit landing page also lives at `/view/lookie-link/docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md`, with the companion manifest at `/view/lookie-link/docs/NOTEBOOKLM-ARTIFACT-MANIFEST.md`.

## Identified Gaps

### Gap 1 — CSV asset path returned 415 (CLOSED in `b460e5e`)

`text/csv` was missing from the `/asset/` MIME allowlist, so:

- `GET /asset/<repo>/<path>.csv` returned `415 Unsupported Media Type`.
- The `lookie-read` agent CLI could not fetch CSV bytes through the normal asset path.
- Any markdown that intentionally linked via `/asset/` (rather than `/view/`) for a raw download broke for CSV.

Closed by commit `b460e5e` — `'.csv': 'text/csv; charset=utf-8'` added to `TEXT_MIME_TYPES` in `server.js`, with the existing `/asset/` MIME allowlist test in `test/access-control.test.js` extended to cover CSV.

### Gap 2 — No CSV table viewer

`.csv` review today is "auto-highlighted text in the document page". A real CSV table view (rendered `<table>`, sortable columns, basic schema preview) would substantially improve the human-review path for capabilities tables and data tables, but is not required for parity with the rest of the artifact set.

**Recommendation:** out of scope for the minimal patch. Track as a follow-up enhancement (suggested issue title: "feat: CSV table viewer for `/view/<path>.csv`").

### Gap 3 — JSON review path under-documented

JSON renders correctly as highlight.js-formatted source, but the `docs/FEATURES.md` page does not say so explicitly. A reviewer landing on a flashcards JSON expects either a fancy viewer or an explicit "this is the raw highlighted view, by design" note.

**Recommendation:** add a short "Structured Data Rendering" section to [`FEATURES.md`](FEATURES.md) covering both JSON and CSV behavior, including the recommendation to keep a markdown companion alongside structured exports.

## Closing-the-Loop Checklist

When all gaps above are closed, the artifact coverage doc and Lookie-Link docs jointly state:

- [x] Every artifact type in the NotebookLM bundle has a single defined review path.
- [x] `/asset/<repo>/<path>` works for every artifact type, including CSV.
- [x] For each type, the docs state whether the review path is inline render, dedicated viewer, or formatted raw source.
- [x] The recommended agent export format is named for every type that offers a choice.
- [x] At least one CSV and one JSON fixture is covered by automated tests so the asset path cannot regress silently (`test/access-control.test.js`).
- [ ] JSON/CSV "Structured Data Rendering" callout added to `FEATURES.md` (Gap 3 follow-up).
- [ ] CSV table viewer (Gap 2 follow-up).
