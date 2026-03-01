# Feature: Floating TOC Navigation Button

## Context
Lookie-Link is a Node.js/Express file viewer that renders markdown and code files. Users often land on a specific anchor via a URL but then need to navigate to other sections without scrolling through 600+ lines. The app is mobile-first (viewed on phones over a private network).

- **Project**: This repo
- **Rendering logic**: `lib/renderer.js`
- **Styles**: `public/style.css`
- **Current features**: Dark/light mode toggle, raw/rendered toggle, copy-link buttons on headings, collapsible frontmatter panel

## Feature

Add a floating TOC (Table of Contents) button that opens a slide-out navigation panel.

### Button
- Small floating button pinned to **bottom-right** corner
- Icon: `☰` or similar (not too large, not distracting)
- Always visible on markdown files, hidden on non-markdown files
- Sits above the page content (z-index), doesn't interfere with reading
- Subtle styling — matches current toolbar aesthetic

### Panel
- Opens on button tap — slides in from the right side, or fades in as an overlay
- **Scrollable list** of all headings (`h1` through `h4`) found in the rendered document
- **Indented by level**: h1 flush left, h2 indented one level, h3 two levels, h4 three levels
- **Current section highlighted**: The heading corresponding to the user's current scroll position should be visually highlighted (bold, accent color, or background). Use `IntersectionObserver` to track which heading is currently in or near the viewport
- When the panel opens, it should **auto-scroll to show the current section** in the TOC list (so you immediately see where you are, even in long docs)
- Tap a heading → smooth scroll to that section, panel closes
- Tap outside the panel or tap the button again → panel closes
- Panel should have a semi-transparent backdrop/overlay behind it

### Styling
- Must work in both light and dark mode (use existing CSS custom properties)
- Panel background should be solid (not transparent) for readability
- Headings in the panel should be readable but compact (not full-size heading text)
- Touch-friendly tap targets (enough padding between items for mobile)
- Smooth transitions for open/close animation

### Technical Notes
- **Client-side only** — no server changes needed
- JS runs on page load: queries all heading elements from the rendered content area
- Build the TOC list dynamically from the DOM
- Use `IntersectionObserver` with appropriate `rootMargin` to detect the current section
- The heading `id` attributes are already set by the renderer (used for anchor links)
- Only show the TOC button for markdown files — check for the same condition used by the raw/rendered toggle
- If the document has fewer than 3 headings, don't show the button (not worth it)

### Edge Cases
- Very long TOC (40+ headings): panel must scroll independently
- Short documents (< 3 headings): hide the TOC button entirely
- Headings with inline code or special characters: display the text content, not HTML

## Testing
- Open a long markdown file (best-practices docs have 20+ headings)
- Verify button appears bottom-right
- Verify panel shows all headings with proper indentation
- Scroll through the document — verify current section updates in real-time
- Tap a heading — verify smooth scroll and panel close
- Test on mobile viewport (narrow screen)
- Verify light and dark mode both look good
- Open a non-markdown file — verify button is hidden
- Open a short markdown file with < 3 headings — verify button is hidden
