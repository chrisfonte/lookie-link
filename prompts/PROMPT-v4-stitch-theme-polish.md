# PROMPT-v4 — Stitch-Informed Theme Polish

## Goal

Apply a narrow visual polish pass to Lookie-Link using a Google Stitch File Index concept as inspiration, while preserving the existing product structure and behavior.

This is **not** a redesign and **not** a framework rewrite.

## Design intent

Move Lookie-Link toward a more editorial, trustworthy review surface for agent-written files:
- stronger heading hierarchy
- calmer slate/blue palette
- more intentional directory listing rhythm
- softer chrome and card treatment
- better perceived polish on mobile and desktop

## Constraints

- Keep the existing Express app structure
- Keep current routes and behavior unchanged
- No fake SaaS dashboard shell
- No generic product-management UI additions
- No Stitch-generated app replacement
- Implement directly in the real Lookie-Link repo

## Primary source inputs

- Stitch File Index screen concept
- Translation brief: `~/operations-incubator/specs/lookie-link-theme-translation-brief.md`

## Files to modify

- `lib/renderer.js`
- `public/style.css`
- docs as needed (`README.md`, `CHANGELOG.md`, `prompts/README.md`)

## Required implementation scope

### 1. Typography
- introduce stronger heading/display styling
- use Space Grotesk for major headings/branding if practical
- keep body text highly readable

### 2. Theme tokens
- retune dark theme from green-forward utilitarian styling toward a Stitch-inspired slate/blue editorial palette
- keep light theme coherent as well
- maintain accessible contrast

### 3. Directory listing polish
- improve file row spacing and hierarchy
- add clearer secondary metadata treatment
- preserve simple table/list behavior

### 4. Shell/chrome polish
- strengthen top header presentation
- improve card/table surface treatment
- keep the app feeling lightweight and real

## Validation

After changes:
- run `npm run validate:editable`
- run a local render smoke test against a real `/view/...` route
- verify the resulting page still loads and the directory listing renders correctly

## Deliverable standard

When done, the app should feel more polished and intentional, but still unmistakably be Lookie-Link.
