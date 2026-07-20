# NotebookLM Artifact Display Manifest

This manifest defines a portable review bundle that uses only implemented Lookie-Link behavior. See the [coverage audit](NOTEBOOKLM-ARTIFACT-COVERAGE.md) and the authoritative [capability matrix](CAPABILITIES.md).

## Display rules

- Prefer browser-displayable exports when multiple formats are available.
- Keep a Markdown index beside binary or structured artifacts.
- Preserve original machine-readable exports when useful, but explain their role in the index.
- Use relative links so Lookie-Link can rewrite them inside any configured repo.

## Reference bundle

| Example artifact | Format | Implemented display behavior |
|---|---|---|
| `briefing.md` | Markdown | Sanitized document viewer with anchors and TOC |
| `study-guide.md` | Markdown | Sanitized document viewer |
| `quiz.md` | Markdown | Sanitized document viewer |
| `data-table.csv` | CSV | Structured table and raw toggle |
| `audio-overview.m4a` | Audio | Dedicated/inline audio player |
| `video-overview.mp4` | Video | Dedicated/inline video player |
| `slide-deck.pdf` | PDF | Dedicated browser PDF viewer |
| `infographic.png` | PNG | Dedicated/inline image viewer |
| `flashcards.json` | JSON | Structured JSON and raw toggle |
| `interactive-export.html` | HTML | Sanitized by default; opt-in trusted transformed/verbatim runtime |

## Handoff contract

A bundle should contain a Markdown landing page, use repo-relative links, avoid absolute workstation paths, and identify any HTML that requires the trusted raw/transformed feature. Forms, templates, and submission handling are not part of the current display contract.
