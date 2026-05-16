# Competitor & Adjacent-Product Research

Each doc in this folder analyzes one external product that overlaps with Lookie-Link's design space, then maps the comparison onto the Lookie-Link roadmap.

## What counts as "adjacent"

Anything that answers some version of *"how does the agent's output reach a human who needs to look at it?"* — including:

- Hosted static-site services with agent-shaped APIs (`here.now`, etc.)
- Tunnel-and-expose tools (ngrok, Cloudflare Tunnel, Tailscale Funnel)
- Git-push-style hosting (Vercel, Netlify, Cloudflare Pages) used in agent workflows
- Pastebin / file-share services repurposed for the same flow
- Self-hosted file viewers and renderers in the same niche as Lookie-Link

Pure SaaS analytics, generic blogging platforms, and "build me a website" generators are out of scope.

## Format

Each comparison doc should:

1. Open with an unambiguous statement of *what the other product is*.
2. Decompose its capabilities into the same conceptual buckets Lookie-Link uses (browse / render / share / edit / access-control / persistence / agent-API).
3. Mark each bucket as ✅ both / ⚠️ partial overlap / ❌ one but not the other / 🟦 fundamentally different category.
4. Close with **"What this means for Lookie-Link"** — concrete roadmap or scoping implications. No vague "we should consider…"; either there's a candidate feature with a name, or the section says "stay out of this lane and here's why."

## Current docs

- [`here-now-vs-lookie-link-2026-05-16.md`](here-now-vs-lookie-link-2026-05-16.md) — `here.now` public agent-facing static hosting service vs. Lookie-Link's private-network file viewer.
