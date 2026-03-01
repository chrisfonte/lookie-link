# Feature: Raw Markdown Toggle + Dark Mode

## Context
Lookie-Link is a Node.js/Express file viewer that renders markdown files as HTML. It serves files from configured repo directories over Tailscale.

- **Project**: This repo (`~/projects/fontastic/ops-file-viewer/`)
- **Entry point**: `server.js`
- **Config**: `~/.config/lookie-link/lookie-link.yaml` (repo mappings)
- **Current version**: v2.1.0

## Features to Add

### 1. Raw/Rendered Markdown Toggle
Add a button in the top toolbar area that toggles between:
- **Rendered** (default): The current HTML-rendered markdown view
- **Raw**: The original markdown source displayed in a `<pre><code>` block with syntax highlighting if available

Requirements:
- Button should say "Raw" when viewing rendered, "Rendered" when viewing raw
- Toggle is client-side only — the server already has the raw content available
- Pass the raw markdown source to the client (embed in a `<script>` tag as a JSON-encoded string, or a hidden element)
- Preserve scroll position when toggling (or at least scroll to top)
- Raw view should use a monospace font, preserve whitespace exactly
- Only show this toggle for markdown files (`.md`)

### 2. Light/Dark Mode Toggle
Add a button that switches between light and dark themes.

Requirements:
- Default to dark mode (current theme is already dark-ish — match it)
- Store preference in `localStorage` so it persists across page loads
- Button shows a sun icon (☀️) in dark mode, moon icon (🌙) in light mode
- Light mode: white/light gray background, dark text, appropriate code block styling
- Dark mode: current dark theme
- Apply to all elements: body, code blocks, pre blocks, the toolbar, links, headings

### UI Placement
- Add a small toolbar/button bar at the top-right of the page (fixed position, doesn't scroll away)
- Both buttons should be compact, minimal, not distracting
- Style them to match whichever mode is active

## Technical Notes
- The server renders markdown via `markdown-it` with plugins, then pipes through DOMPurify
- The raw source should be the original `.md` file content, NOT the rendered HTML
- Keep changes minimal — don't refactor the rendering pipeline
- The EJS template is inline in `server.js` (look for the template string)

## Testing
- Verify toggle works on a markdown file
- Verify non-markdown files don't show the Raw/Rendered toggle
- Verify dark/light mode persists across navigation
- Verify code blocks look good in both modes
