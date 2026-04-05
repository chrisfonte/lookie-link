# Contributing

Issues and PRs welcome.

## Renderer Pipeline

If you're adding a new post-processing step to the renderer, note the execution order in `postProcessHtml()`:

1. `rewriteHybridCrossLinks()` — wiki-link patterns → clickable links
2. `rewriteTildeLinks()` — plain `~/path` references → clickable links
3. `rewriteImageSources()` — image paths → `/asset/` endpoint
4. `addHeadingAnchorLinks()` — heading anchors + copy buttons
5. `addYamlAnchorLinks()` — YAML key anchors + copy buttons
6. `sanitizeHtml()` — DOMPurify (always last — never add steps after this)

## Validation

Run editable-mode validation coverage (route-level checks + real temp-file writes):

```bash
npm run validate:editable
```

## Design History

See the `prompts/` directory for the original build prompts and feature design documents that shaped this project.
