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

## Audio Playback

Markdown links to local audio files are rendered as an inline `<audio>` player so you can tap **Play** without leaving the page. The original link text is preserved underneath as a caption that points at the dedicated player page.

Supported extensions: `.m4a`, `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.flac`, `.aac`

All three of these link forms render as a player:

```markdown
[NotebookLM overview](./notebooks/2026-05-12-cruz-meeting.m4a)
[NotebookLM overview](~/operations-chris-fonte/notebooks/2026-05-12-cruz-meeting.m4a)
[NotebookLM overview](http://<tailscale-host>:9876/view/operations-chris-fonte/notebooks/2026-05-12-cruz-meeting.m4a)
```

Browsing an audio file directly at `/view/<repo>/<path>.<audio-ext>` renders a dedicated player page with the same controls plus a **Download** link and file metadata (size, mtime).

Under the hood, audio is streamed from `/asset/<repo>/<path>.<audio-ext>` with the correct `Content-Type` and `Range` request support, so `<audio>` can seek without re-downloading.

Notes:

- Audio files are classified as binary, so they are **not** editable in editable mode.
- Audio links inside fenced ` ``` ` code blocks are left as code, not rewritten to a player.
- The image lightbox does not apply to `<audio>` (it's a separate, non-binary widget).

## PDF Rendering

Browsing a PDF directly at `/view/<repo>/<path>.pdf` renders a dedicated viewer page with:

- An embedded browser PDF frame backed by `/asset/<repo>/<path>.pdf`
- An **Open in browser** link for native PDF controls
- A **Download** link and the usual file metadata

Notes:

- PDFs are treated as binary assets, so they are **not** editable in editable mode.
- Standard markdown links that resolve to `/view/...pdf` now open the same dedicated viewer page.

## HTML Rendering

Standalone `.html` and `.htm` files render as sanitized document content instead of raw source by default.

Example:

```html
<section>
  <h1>Hello</h1>
  <p><img src="./diagram.png" alt="Diagram"></p>
  <script>alert('remove me')</script>
</section>
```

Behavior:

- The default view renders the HTML fragment/document inline inside Lookie-Link
- A **Raw** toolbar button swaps back to syntax-highlighted source
- `<script>` tags and inline event handlers are stripped by DOMPurify
- Local `<img src="./file.png">` references are rewritten through `/asset/<repo>/<path>` so images still load from the repo
- Heading anchors and TOC generation apply to rendered HTML headings the same way they do for markdown

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

Select a theme from the toolbar dropdown. Toggle dark/light mode with the sun/moon button. Preferences persist via localStorage.

Custom themes can be defined in the YAML config file. See [CONFIGURATION.md](CONFIGURATION.md#custom-themes).

## YouTube Embeds

Write `<iframe>` tags in markdown pointing to YouTube. They render with sandboxed security:

- Only `youtube.com/embed/` URLs are allowed
- `sandbox="allow-scripts allow-same-origin"` is auto-injected
- `<script>`, `<object>`, `<embed>`, `<form>`, and event handlers are stripped by DOMPurify
