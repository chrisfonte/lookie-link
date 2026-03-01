# Feature: YAML Frontmatter as Collapsible Panel

## Context
Lookie-Link is a Node.js/Express file viewer that renders markdown files. YAML frontmatter (`---` fenced blocks at the top of markdown files) currently gets stripped before rendering (commit `4404f1a`). We want to render it instead — as a collapsible panel.

- **Project**: This repo
- **Entry point**: `server.js`, rendering logic in `lib/renderer.js`
- **Current behavior**: Frontmatter is regex-stripped at ~line 419 before markdown-it processes the file

## Feature

Replace the frontmatter stripping with a collapsible `<details><summary>` panel:

1. **Extract** the YAML frontmatter from between the opening and closing `---` fences
2. **Syntax highlight** the YAML content using highlight.js (the project already uses it — see `renderCode()` function and the hljs require)
3. **Render as collapsible panel** at the top of the document, before the markdown content:
   ```html
   <details class="frontmatter-panel">
     <summary>📋 Frontmatter</summary>
     <pre><code class="hljs language-yaml">...highlighted YAML...</code></pre>
   </details>
   ```
4. **Collapsed by default** — user clicks to expand
5. **Style the panel** to look distinct from document content:
   - Subtle border or background color difference
   - Small top margin, rounded corners
   - Summary text should be subtle/muted, not bold
   - Should look good in both light and dark mode (the project has both themes via CSS custom properties)

## Technical Notes
- The frontmatter regex is already in `renderer.js` — modify it to capture instead of strip
- Use the existing `hljs.highlight(yaml, { language: 'yaml' })` for syntax coloring
- The panel HTML goes BEFORE the markdown-rendered content in the final output
- Only applies to markdown files (`.md`, `.markdown`, `.mdown`)
- If no frontmatter exists, don't render the panel at all
- The `---` delimiters themselves should NOT appear in the rendered YAML

## Testing
- Open a markdown file with frontmatter (most best-practices docs have it)
- Verify panel is collapsed by default
- Verify YAML is syntax highlighted when expanded
- Verify files without frontmatter show no panel
- Verify it looks good in both light and dark mode
