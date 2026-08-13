# Features

This document explains implemented viewer behavior. The authoritative inventory of routes, authorization gates, configuration switches, stores, discovery fields, and CLI commands is [CAPABILITIES.md](CAPABILITIES.md).

## Markdown Link Rendering

Three forms of markdown link all render as clickable `<a>` tags:

1. **Explicit link** — `[ITFlow homepage](https://itflow.org)`
2. **Autolink** — `<https://itflow.org>`
3. **Bare URL** — `https://itflow.org` (auto-detected by markdown-it's `linkify`)

The third form means a `## Sources` bullet list of plain URLs renders fully clickable without any special syntax:

```markdown
## Sources
- https://itflow.org
- https://github.com/itflow-org/itflow
```

Notes:

- URLs inside fenced code blocks and inline `` `code` `` are left literal — not linkified.
- URLs inside HTML attribute values (e.g. `<iframe src="...">`) are not touched, so embedded YouTube iframes continue to work.
- Email addresses and `www.`-prefixed hosts are also auto-linkified.

For new research documentation, the preferred bibliography form is still `[label](url)` because it gives you control over the link text and is portable across every CommonMark renderer (not all of which enable bare-URL linkify). See the standards doc cross-linking section for full guidance.

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

Every markdown heading and YAML key path gets an anchor ID and a copy-link button that copies the full URL (with `#fragment`) to clipboard.

- `## Core Truths` → `#core-truths`
- `learned_patterns:` (YAML) → `#learned_patterns`
- `database.connection.host:` (YAML) → `#database-connection-host`

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
[NotebookLM overview](~/my-repo/notebooks/2026-05-12-cruz-meeting.m4a)
[NotebookLM overview](http://<your-lookie-host>/view/my-repo/notebooks/2026-05-12-cruz-meeting.m4a)
```

Browsing an audio file directly at `/view/<repo>/<path>.<audio-ext>` renders a dedicated player page with the same controls plus a **Download** link and file metadata (size, mtime).

Under the hood, audio is streamed from `/asset/<repo>/<path>.<audio-ext>` with the correct `Content-Type` and `Range` request support, so `<audio>` can seek without re-downloading.

Notes:

- Audio files are classified as binary, so they are **not** editable in editable mode.
- Audio links inside fenced ` ``` ` code blocks are left as code, not rewritten to a player.
- The image lightbox does not apply to `<audio>` (it's a separate, non-binary widget).

## Video Playback

Browsing `.mp4`, `.webm`, `.mov`, or `.m4v` files renders a dedicated video player backed by the scoped asset route. Markdown links and authored video sources that resolve to authorized local files are rewritten to playable asset URLs. Video is binary and is not editable.

## PDF Rendering

Browsing a PDF directly at `/view/<repo>/<path>.pdf` renders a dedicated viewer page with:

- An embedded browser PDF frame backed by `/asset/<repo>/<path>.pdf`
- An **Open in browser** link for native PDF controls
- A **Download** link and the usual file metadata

Notes:

- PDFs are treated as binary assets, so they are **not** editable in editable mode.
- Standard markdown links that resolve to `/view/...pdf` now open the same dedicated viewer page.

## HTML Rendering

Standalone `.html` and `.htm` files render as sanitized document content instead of raw source when raw HTML is disabled.

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
- Agents can inspect a local HTML bundle without launching a browser by requesting `/view/<repo>/<path>.html?validate=1`. The JSON response checks stylesheet, script, image/source, and local HTML navigation references, reports missing/unsupported counts, and contains repo-relative URLs only. Reference checks enforce the caller's view scope; unreadable and absent targets use the same not-found result.
- When raw HTML is enabled, the viewer uses the transformed `/embed` runtime for the rendered pane and exposes separate transformed and byte-preserving `/raw` actions. Both preserve authored scripts and therefore share the trusted-content requirement. `/embed` rewrites local navigation/assets, injects theme synchronization, redacts sensitive host values, and can inject the annotation client; `/raw` returns authored bytes unchanged.

### Table of contents

An HTML primary gets the same `☰` table-of-contents panel as markdown, pinned in the viewer's outer chrome. Because the embed iframe is sandboxed (opaque origin), the injected embed runtime enumerates the document's own headings and posts them to the viewer, which builds the panel and drives navigation. Enumeration covers heading ids (`h1`–`h4[id]`) **and** `section[id]` wrappers, so a document that anchors on `<section id="...">` rather than on the heading itself is still indexed; the injected annotate button is stripped from the labels.

### Render modes

An HTML primary declares how it wants to be hosted, and the default is unchanged:

- **Default (no declaration):** the document is hosted in a content-height frame and the viewer page scrolls as one — the seamless reader, best for flowing documents. Viewport-relative CSS (`position: sticky`/`fixed`, `:target`, `100vh`) does not apply inside this frame; overlays use the viewer's own lightbox and the TOC above is the persistent navigation.
- **Viewport (`<html data-lookie-render="viewport">`, or `<meta name="lookie-render" content="viewport">`):** the document is hosted in a viewport-height, internally-scrolling frame where native `position: sticky`/`fixed`, `:target` fragment scrolling, and viewport-centered lightboxes work — so a document's own sticky navigation bar pins with its authored styling. The trade-off is a scroll region inside the frame, which is why it is opt-in rather than the default.

Detection reads the real root element (a fast reject then a parse), so a document that merely quotes the attribute in prose or a code sample is not switched into viewport mode. The value must be exactly `viewport`.

## Annotations

When `server.enableAnnotations: true`, the document viewer adds an inline annotation layer to every rendered file.

- The toolbar exposes a `💬 Annotate` mode. Existing annotations stay visible; add-comment icons appear next to anchored markdown/HTML headings and YAML key paths only while annotation mode is active.
- Authored HTML can declare a deliberate target with `data-lookie-annotation-anchor="anchor-id"`; Lookie-Link assigns that ID, adds an annotation affordance, and mounts its annotation cards after the target.
- Stored annotations render as collapsed cards by default. The summary shows state (`open` / `claimed` / `resolved`), author/time, a body preview, and reply count; expanding it reveals the full thread and actions.
- State controls include **Claim**, **Resolve**, **Reopen**, **Reply**, and **Redact**. Redaction scrubs annotation and reply bodies, resolves the item, and preserves minimal audit metadata.
- The `💬 N` toolbar chip reports the total count and toggles resolved annotations, which are hidden by default.
- Plain-text and code views expose a `#L<start>-L<end>` line-range picker.
- Annotations whose anchors no longer exist remain available in a `Stale anchors` section instead of being dropped.
- Annotation data lives at `<repoRoot>/.lookie-link/annotations/<repo>/<relative-path>.json` (sidecar). Source files are never mutated.
- The flag is independent of `enableEditing` — annotations are available on the default safe configuration.
- Reads require `view` access. Creating, claiming, resolving, reopening, replying, and redacting require `write` access.

See `docs/ANNOTATIONS-SPEC.md` for the full sidecar schema, phase split, and the agent-feedback loop the API enables. The HTTP transport and viewer UX are both available.

## Managed Repositories

Operators can register mutable repository roots beneath existing configured
allow-roots. Managed callers can read and atomically write files, inspect a
bounded tree or mtime-based change list, and use optimistic `expectedMtimeMs`
conflict detection. File mutations require `write` capability.

Deletes are recoverable by default: the response returns a `trashId` that can
be restored or permanently deleted. Realpath checks cover both existing paths
and the nearest existing ancestor of a new path, preventing symlink-ancestor
escapes. Missing and unauthorized managed paths have the same not-found
response, and registry responses omit host filesystem roots.

`GET /api/search` performs bounded path and full-text matching over supported
text formats; `GET /api/search/suggest` performs bounded path suggestions.
Both prune traversal using the caller's repository and path scopes, silently
exclude requested scopes the caller cannot see, cap work and result counts, and
report when a response was truncated.

## Immutable Publishing and Discovery

An optional publish store creates slug-addressed, immutable numbered bundles without modifying mounted source repositories. Updating requires the current revision, historical revisions remain readable, public metadata cannot contain absolute host paths, and revocation disables current and historical readback. Publish lifecycle authorization is a separate repo-level `publish` permission.

Caller discovery reports only capabilities and endpoint templates available under the current flags, registered routes, enabled stores, and repo/path permissions. Repo discovery returns opaque URL prefixes rather than host roots. See [CAPABILITIES.md](CAPABILITIES.md#discovery-field-inventory) and [PUBLISHING.md](PUBLISHING.md).

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
