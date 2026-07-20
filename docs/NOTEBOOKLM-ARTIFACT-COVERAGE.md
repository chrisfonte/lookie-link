# NotebookLM Artifact Coverage

This audit maps a representative NotebookLM export bundle to implemented Lookie-Link viewers. The authoritative route and MIME behavior is [CAPABILITIES.md](CAPABILITIES.md); the companion [artifact manifest](NOTEBOOKLM-ARTIFACT-MANIFEST.md) describes preferred export formats.

## Coverage

| Artifact | Extension | Rendered review behavior | Asset MIME |
|---|---|---|---|
| Briefing, study guide, quiz, or report | `.md` | Sanitized Markdown, anchors, TOC, portable links | `text/markdown; charset=utf-8` |
| Audio overview | `.m4a` | Dedicated and inline audio player | `audio/mp4` |
| Video overview | `.mp4` | Dedicated and inline video player | `video/mp4` |
| Slide deck | `.pdf` | Dedicated embedded PDF viewer | `application/pdf` |
| Infographic | `.png` | Dedicated image page and inline images | `image/png` |
| Extracted table | `.csv` | Structured table with raw toggle and dimensions | `text/csv; charset=utf-8` |
| Flashcards or structured export | `.json` | Structured expandable JSON with raw toggle | `application/json; charset=utf-8` |
| Interactive trusted export | `.html` / `.htm` | Sanitized view by default; optional transformed and verbatim trusted runtimes | `text/plain; charset=utf-8` on asset route |

The asset route intentionally serves HTML as plain text. Executable HTML is available only through the opt-in raw/transformed routes and requires trusted authored content.

## Verification approach

For each fixture under a configured test repo:

1. Request its rendered review URL and verify `200` plus the expected viewer marker.
2. Request its asset URL and verify `200` plus the MIME above.
3. Verify an out-of-scope caller cannot resolve the file or its referenced local assets.
4. For HTML, request `?validate=1` and verify the response contains repo-relative references without absolute host paths.

The automated test suite covers CSV/JSON/text MIME behavior, image/audio/video/PDF rendering, HTML validation, path scoping, and host-path redaction. No live workstation repository is required for this audit.

## Export guidance

- Prefer Markdown for text reports and study material.
- Prefer CSV for tabular interchange, with a Markdown companion explaining the columns.
- Prefer PDF for browser review of slides and PNG for infographics.
- Keep machine-readable JSON, but provide a Markdown index for navigation.
- Use browser-playable audio/video formats.
- Treat interactive HTML as trusted code; leave raw HTML disabled when provenance is uncertain.
