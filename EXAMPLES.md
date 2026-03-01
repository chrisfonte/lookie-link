# Examples

Copy-pasteable patterns for common Lookie-Link usage.

## Config File

Minimal `~/.config/lookie-link/lookie-link.yaml`:

```yaml
server:
  port: 9876

repositories:
  docs: ~/Documents/docs
  notes: ~/notes
```

## URL Patterns

```
# Browse a repo root
http://localhost:9876/view/docs/

# View a specific file
http://localhost:9876/view/docs/guides/getting-started.md

# Deep-link to a heading
http://localhost:9876/view/docs/guides/getting-started.md#installation

# View a YAML file with anchor
http://localhost:9876/view/docs/config/settings.yaml#database
```

## Cross-Links in Markdown

These patterns in your markdown files become clickable links in Lookie-Link:

```markdown
<!-- Hybrid cross-link (wikilink + full path) -->
See [[Getting Started]] (~/docs/guides/getting-started.md#installation)

<!-- With backtick-wrapped path -->
Reference: [[API Docs]] (`~/project/docs/api.md`)

<!-- Plain tilde path (no wikilink wrapper) -->
Config is at ~/docs/config/settings.yaml
```

## YouTube Embeds

Write standard `<iframe>` tags in your markdown. Only `youtube.com/embed/` sources are allowed — everything else is stripped.

```markdown
## Video Reference

<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" frameborder="0" allowfullscreen></iframe>
```

The iframe renders with automatic `sandbox` attribute injection. Bare YouTube URLs remain as regular links.

## Inline Images

```markdown
<!-- Relative to current file -->
![Architecture](./images/architecture.png)

<!-- Relative without prefix -->
![Screenshot](artifacts/screenshot.jpg)

<!-- Cross-repo absolute -->
![Logo](~/docs/assets/logo.svg)
```

## Health Check

```bash
curl -s http://localhost:9876/healthz
# Returns: OK
```

## Running as a Background Service

```bash
# Simple background process
nohup node server.js > /tmp/lookie-link.log 2>&1 &

# With custom port
PORT=3000 nohup node server.js > /tmp/lookie-link.log 2>&1 &

# With custom config location
LOOKIE_LINK_CONFIG=./my-config.yaml node server.js
```
