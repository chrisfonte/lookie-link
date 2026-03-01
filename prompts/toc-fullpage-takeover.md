# Feature: TOC as Full-Page Takeover (replaces floating panel)

## Context
Lookie-Link is a Node.js/Express file viewer. The previous floating TOC panel (#26) had compatibility issues with Telegram's in-app browser — `position: fixed/absolute` didn't work reliably, scroll containment failed, and the panel covered other toolbar buttons.

**New approach**: TOC as a full-page view swap, same pattern as the existing Raw/Rendered toggle.

- **Project**: This repo
- **Rendering logic**: `lib/renderer.js`
- **Styles**: `public/style.css`
- **Existing pattern to follow**: The Raw/Rendered toggle already swaps between two `<article>` elements using `hidden` attribute. Follow the same pattern for TOC.

## Feature

Replace the floating TOC panel with a full-page TOC view that swaps in/out like the Raw view.

### How It Works
1. **☰ button in the toolbar** (already exists) toggles between document view and TOC view
2. When TOC is active:
   - The document content (`<article>` with rendered markdown) is hidden
   - A TOC `<article>` is shown with a scrollable list of all headings
   - The ☰ button text changes to "Doc" (or similar) so user can get back
   - Other toolbar buttons (Raw, ☀️/🌙) remain visible and functional
3. When user taps a heading in the TOC:
   - Switch back to document view
   - Smooth scroll to that heading
4. When user taps ☰ again (showing "Doc"):
   - Switch back to document view at current scroll position

### TOC View Layout
- Full-width, same container as the document content
- Each heading is a tappable block/button — large enough for mobile touch targets
- Indented by heading level (h1 flush, h2 indented, h3 more, h4 most)
- Current section highlighted (use the existing IntersectionObserver tracking)
- Clean, readable, matches the document styling

### What to Remove
- Delete ALL floating panel code: `.toc-panel`, `.toc-overlay`, `toc-fab` CSS classes
- Delete the `<aside>` and overlay `<div>` from the HTML template
- Delete the `openToc()`/`closeToc()` functions and overlay click handler from JS
- Keep the IntersectionObserver logic for tracking the active heading
- Keep the ☰ button in the toolbar

### What to Add
- A new `<article class="content toc-view" data-toc-view hidden>` element alongside the rendered and raw articles
- TOC items built by JS on page load (same heading collection logic that exists)
- Toggle logic: ☰ hides rendered+raw articles, shows toc-view (and vice versa)
- If user was in Raw view and taps ☰, show TOC. Tapping ☰ again returns to Raw view (remember which view was active before TOC)

### Applies To
- Markdown files (headings h1-h4)
- YAML files (top-level keys via `span.yaml-anchor-wrap[id]`)
- Hide ☰ button if fewer than 3 headings

### Styling
- Works in both light and dark mode (use existing CSS custom properties)
- TOC items should have subtle borders or backgrounds to make them tappable-looking
- Enough vertical padding between items for comfortable mobile tapping
- Heading hierarchy shown via left padding/indentation

## Technical Notes
- Follow the EXACT same show/hide pattern as the Raw/Rendered toggle (hidden attribute, no CSS display tricks)
- The `<article>` for TOC view goes inside `<main class="layout">` after the header, alongside the other articles
- Do NOT use `position: fixed` or `position: absolute` for ANY TOC elements — Telegram's in-app browser doesn't support them reliably
- Do NOT change the `linkify` setting — it must stay `linkify: false`

## Testing
- Open a long markdown file — ☰ should show in toolbar
- Tap ☰ — full page should switch to TOC list
- Current section should be highlighted
- Tap a heading — should switch back to doc and scroll there
- Tap ☰ then tap ☰ again — should return to doc at same position
- Verify Raw toggle still works independently
- Verify light/dark mode works on TOC view
- Open a short file with < 3 headings — ☰ should be hidden
- Open a YAML file — ☰ should work with top-level keys
