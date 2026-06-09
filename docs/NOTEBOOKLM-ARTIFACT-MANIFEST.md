<!-- File: docs/NOTEBOOKLM-ARTIFACT-MANIFEST.md -->

---
Title: NotebookLM Artifact Display Manifest
Owner: Lookie-Link Maintainers
Created: 2026-06-09
Last Updated: 2026-06-09
Version: 1.1.0
Status: Active
Tags: #notebooklm #artifacts #lookie-link #display
Document URL: docs/NOTEBOOKLM-ARTIFACT-MANIFEST.md
Related: [NOTEBOOKLM-ARTIFACT-COVERAGE.md](NOTEBOOKLM-ARTIFACT-COVERAGE.md), external issue chrisfonte/lookie-link#64
---

# NotebookLM Artifact Display Manifest

This manifest exists so the NotebookLM artifact set is easy to review in Lookie-Link, not just downloadable from the filesystem. It is the contract that the [Coverage Audit](NOTEBOOKLM-ARTIFACT-COVERAGE.md) verifies against.

## Display Rule

- Prefer browser-displayable export formats when NotebookLM offers a choice.
- Keep a markdown index or manifest alongside the artifacts so a human reviewer can understand what each file is before opening it.
- For binary or raw-structured outputs, preserve the original file but add enough markdown context that the artifact set remains navigable in Lookie-Link.

## Canonical Artifact Set

This is the reference bundle the audit runs against. Files live under `operations-research/ai-tools/notebooklm/` in the user's local repo set.

| Artifact | Format | Lookie-Link display behavior | Purpose |
|---|---|---|---|
| `notebooklm-briefing-doc.md` | Markdown | Native markdown render | First-party NotebookLM summary doc |
| `notebooklm-study-guide.md` | Markdown | Native markdown render | Study-guide style synthesis |
| `notebooklm-blog-post.md` | Markdown | Native markdown render | Blog-post style synthesis |
| `notebooklm-qa-log.md` | Markdown | Native markdown render | Query log and artifact provenance |
| `notebooklm-audio-customization-prompt.md` | Markdown | Native markdown render | Reusable source-citing audio prompt |
| `notebooklm-quiz.md` | Markdown | Native markdown render | Quiz output in readable text form |
| `notebooklm-data-table.csv` | CSV | Raw highlighted view at `/view`; `text/csv` at `/asset` | Structured extracted table |
| `notebooklm-capabilities-table.csv` | CSV | Raw highlighted view at `/view`; `text/csv` at `/asset` | Capabilities/limits table |
| `notebooklm-audio-overview.m4a` | Audio | Inline audio player in Lookie-Link | NotebookLM audio overview |
| `notebooklm-slide-deck.pdf` | PDF | Browser-viewable PDF | Slide-deck artifact in reviewable format |
| `notebooklm-infographic.png` | PNG | Inline image render | Infographic artifact |
| `notebooklm-flashcards.json` | JSON | Raw JSON view | Flashcards export preserved in original machine-readable form |
| `notebooklm-mind-map-mismatch-flashcards.json` | JSON | Raw JSON view | Original mismatch artifact preserved as returned by NotebookLM |

## Format Preference Notes

- Reports should stay in markdown when possible because markdown renders cleanly in Lookie-Link and remains diffable in git.
- Slide decks should prefer PDF export over PPTX when the goal is human review in a browser.
- Infographics should prefer PNG when available because they display inline.
- Audio should be linked as `.m4a` or similar browser-playable media so Lookie-Link can render inline controls.
- JSON artifacts may still be worth keeping in original form, but they should be accompanied by a markdown manifest or explanation file like this one.

## Operational Implication

For future agentic NotebookLM runs, artifact pull-back should optimize for:

1. A browser-displayable primary artifact when NotebookLM offers multiple download formats.
2. A markdown companion or manifest when the original export is binary or raw structured data.
3. A handoff path that works cleanly inside Lookie-Link without requiring the reviewer to inspect local paths manually.
