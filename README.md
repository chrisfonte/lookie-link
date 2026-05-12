# Lookie-Link

A web file viewer for browsing local directories over your network, with an opt-in editable mode for trusted environments. Point it at your documentation repos, knowledge bases, or project files and get rendered markdown, syntax-highlighted code, clickable cross-links, and in-browser save-back when editing is enabled.

## Why This Exists

If you work with AI agents that read and write files — Claude Code, OpenClaw, Codex, or anything similar — you know the problem: the agent modifies a file, and now you need to see what it did. Your options are bad. The agent dumps the entire file into Telegram or Slack (unreadable on a phone). You SSH in and `cat` it. You open your laptop and find it in your editor. None of these work well when you're reviewing from a phone or tablet.

Lookie-Link solves this by giving every file a URL. The agent modifies a document, drops a link in chat, and you tap it. You're reading the rendered file in your browser — formatted markdown, syntax-highlighted code, deep-linked to the exact section that changed. You can review, comment back, and the agent makes another pass. The whole loop works from a phone over Tailscale without ever touching a terminal.

## Features

- **File browser + renderer** — directory listings, rendered markdown/code/YAML views
- **Opt-in editable mode** — edit any non-binary file, then save back to disk
- **Managed Paperclip grants** — issue time-limited repo/path tokens with audit history
- **Grant projection writer** — optionally export active managed grants to a read-only private projection for Paperclip/runtime wiring
- **Cross-company grant guardrail** — rejects managed grants that fall outside the Paperclip adapter's allowed filesystem roots
- **Markdown rendering** — full CommonMark with syntax-highlighted code blocks
- **Cross-link rendering** — `[[name]] (~/repo/path.md#anchor)` becomes a clickable link
- **Anchor linking** — every heading and YAML key gets a copy-link button
- **Image lightbox** — click any inline image for a full-screen view
- **Audio playback** — `.m4a`, `.mp3`, `.wav`, `.ogg`, `.opus`, `.flac`, `.aac` get an inline `<audio>` player when linked in markdown (relative path, `~/repo` path, or fully-qualified `/view/...` URL), plus a dedicated player page when browsed directly. See [FEATURES.md](docs/FEATURES.md#audio-playback) for examples.
- **10 built-in themes** — Slate, Teal, Nord, Rosé Pine, Monokai, Solarized, GitHub, Ember, Noir, Indigo (dark + light)
- **Custom themes** — define your own in the YAML config
- **YouTube iframe embeds** — sandboxed security via DOMPurify
- **URL format** — `/view/<repo>/<path>#<anchor>` — predictable, shareable, deep-linkable

## Themes

10 built-in color themes, each with full dark and light variants. Switch themes from the dropdown in the toolbar; toggle dark/light mode with the sun/moon button. Both preferences persist in localStorage.

| Theme | Style |
|-------|-------|
| **Slate** | Cool grey editorial — default |
| **Teal** | Deep teal accents |
| **Nord** | Arctic blue-grey |
| **Rosé Pine** | Warm purple/mauve |
| **Monokai** | Classic warm syntax palette |
| **Solarized** | Precision color science |
| **GitHub** | GitHub's code view colors |
| **Ember** | Warm amber/orange |
| **Noir** | High-contrast monochrome |
| **Indigo** | Deep navy/violet |

### Add your own theme

Define custom themes in `~/.config/lookie-link/lookie-link.yaml`:

```yaml
themes:
  Lava:
    dark:
      bg: "#1a0a00"
      text: "#f0d0b0"
      accent: "#ff4400"
      border: "#5a2000"
    light:
      bg: "#fff8f0"
      text: "#2a1500"
      accent: "#cc3300"
      border: "#ffb090"
```

Custom themes appear in the theme dropdown alongside built-in themes. See [CONFIGURATION.md](docs/CONFIGURATION.md) for all config options.

## Quick Start

```bash
git clone https://github.com/chrisfonte/lookie-link.git
cd lookie-link
npm install
npm start
```

Open `http://localhost:9876` in your browser.

## Network Model

Lookie-Link is designed for private networks — specifically [Tailscale](https://tailscale.com) or similar mesh VPNs. It runs on a machine with access to your repos and serves files to any device on your tailnet.

This is **not** a public-facing web server. By default, human access still comes from your network, but you can now add token-scoped agent access in config so a single instance does not expose every repo to every agent on the tailnet.

## Documentation

- [Configuration](docs/CONFIGURATION.md) — YAML config, env vars, custom themes
- [Editing](docs/EDITING.md) — editable mode, safety behaviors
- [Agent Access Control](docs/AGENT-ACCESS-CONTROL.md) — token-scoped repo/path access for agents
- [Paperclip Grant Workflow](docs/PAPERCLIP-GRANT-WORKFLOW.md) — managed cross-company access contract
- [Features](docs/FEATURES.md) — cross-links, anchors, images, themes, YouTube embeds
- [API](docs/API.md) — endpoint reference
- [Contributing](docs/CONTRIBUTING.md) — renderer pipeline, validation, design history

## Inspiration

The idea for Lookie-Link came from watching Brian Castle's video ["How to Create JOBS for OpenClaw Agents"](https://www.youtube.com/watch?v=uUN1oy2PRHo) (February 2026). Castle built **Brainown**, a markdown viewer that syncs via Dropbox and lets him tap links from Telegram to jump straight to rendered documentation on his phone. Lookie-Link takes the same concept and builds it as a self-hosted web server for Tailscale networks, eliminating the Dropbox dependency.

## License

MIT
