# Features

## Cross-Link Rendering

Lookie-Link rewrites hybrid cross-link patterns in rendered markdown:

```markdown
[[Getting Started]] (~/docs/guides/getting-started.md#installation)
[[API Reference]] (`~/project/docs/api.md`)
[[Design Doc]] (~/repo/docs/design.md#overview, Sections: intro, goals)
```

These become clickable links to `/view/docs/guides/getting-started.md#installation`, etc.

Rules:
- The visible text is the `[[wikilink]]` label
- `~/` paths are mapped to `/view/<repo>/<path>`
- Content inside `<pre>` blocks is not rewritten
- `<private-repo>` placeholders are intentionally not linkified
- Trailing metadata after a comma (e.g., `, Sections: ...`) is ignored in the path

## Anchor Linking

Every markdown heading and YAML top-level key gets an anchor ID and a copy-link button that copies the full URL (with `#fragment`) to clipboard.

- `## Core Truths` → `#core-truths`
- `learned_patterns:` (YAML) → `#learned_patterns`

Append anchors to any URL: `/view/docs/guide.md#core-truths`

## Inline Images

Markdown image paths are rewritten to serve local repo images:

```markdown
![Diagram](./images/architecture.png)
![Logo](~/docs/assets/logo.svg)
```

Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`

Click any inline image to open it in a full-screen lightbox. Close with the X button, clicking outside, or pressing Escape.

## Themes

10 built-in color themes, each with dark and light variants:

- **Slate** — cool grey editorial (default)
- **Teal** — deep teal accents
- **Nord** — Arctic blue-grey
- **Rose Pine** — warm purple/mauve
- **Monokai** — classic warm syntax palette
- **Solarized** — precision color science
- **GitHub** — GitHub's code view colors
- **Ember** — warm amber/orange
- **Noir** — high-contrast monochrome
- **Indigo** — deep navy/violet

Cycle through themes with the toolbar button. Toggle dark/light mode with the sun/moon button. Preferences persist via localStorage.

Custom themes can be defined in the YAML config file. See [CONFIGURATION.md](CONFIGURATION.md#custom-themes).

## YouTube Embeds

Write `<iframe>` tags in markdown pointing to YouTube. They render with sandboxed security:

- Only `youtube.com/embed/` URLs are allowed
- `sandbox="allow-scripts allow-same-origin"` is auto-injected
- `<script>`, `<object>`, `<embed>`, `<form>`, and event handlers are stripped by DOMPurify
