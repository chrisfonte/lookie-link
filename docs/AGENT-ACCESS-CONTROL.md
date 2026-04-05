# Agent Access Control

## Problem

Lookie-Link currently serves all configured repositories to anyone who can reach it. Access control relies entirely on network-level restrictions (Tailscale ACLs, LAN isolation).

This works for human users browsing from a phone or laptop, but creates a problem for agents. Different agents are scoped to different folders — an ops agent shouldn't be able to read research docs, and a research agent shouldn't be able to browse client operations files. Lookie-Link as-is circumvents those boundaries by exposing everything through a single URL.

## Requirements

- Agents can only view/edit repos they're authorized for
- Human browser access continues to work without auth (backward-compatible)
- Single instance — no port sprawl or running N copies
- Editing permissions should be independently controllable per agent
- Config-driven, not code-driven

## Possible Solutions

### Option A: Token-Scoped Repo Access (Recommended)

Add a `tokens` section to `lookie-link.yaml`:

```yaml
tokens:
  ops-agent:
    secret: "randomly-generated-secret-1"
    repos: [operations, operations-fontastic]
    allowEditing: false
  research-agent:
    secret: "randomly-generated-secret-2"
    repos: [operations-research]
    allowEditing: false
  full-access:
    secret: "randomly-generated-secret-3"
    repos: all
    allowEditing: true
```

**How it works:**
- Agent passes token via `Authorization: Bearer <secret>` header or `?token=<secret>` query param
- Middleware resolves token to allowed repo list
- Requests for unauthorized repos return 403
- Repository index (`/view/`) only shows authorized repos
- No token = full access (preserves current browser-on-tailnet behavior)
- `allowEditing` per token controls whether `/edit` and `/api/save` routes are available

**Pros:** Clean, backward-compatible, one instance, familiar auth pattern for agents.
**Cons:** Secrets in config file (mitigated by file permissions + Tailscale already being the trust boundary).

### Option B: Path-Prefix Namespacing

Expose scoped base URLs like `/agent/<agent-name>/view/...` where the prefix determines which repos are visible:

```yaml
agents:
  ops-agent:
    repos: [operations, operations-fontastic]
  research-agent:
    repos: [operations-research]
```

**How it works:**
- Agent gets a base URL: `http://host:9876/agent/ops-agent/view/...`
- Middleware extracts agent name from path and filters repos
- No secrets — security relies on agents not guessing other agent names

**Pros:** Simple for agents (just a different base URL). No token management.
**Cons:** Security through obscurity — any agent that knows another's name can access its repos. No real auth.

### Option C: Multiple Listener Ports

Map ports to repo subsets in config:

```yaml
listeners:
  - port: 9876
    repos: all
  - port: 9877
    repos: [operations, operations-fontastic]
  - port: 9878
    repos: [operations-research]
```

**Pros:** No auth code needed — Tailscale ACLs can restrict which device reaches which port.
**Cons:** Port sprawl, harder to manage, each new agent scope needs a new port, doesn't scale.

## Implementation Notes

- Token middleware would sit in `server.js` before route handlers
- `config.js` already resolves repo mappings — token scoping would filter that list per-request
- The repo index page and all `/view/`, `/edit/`, `/asset/`, `/api/` routes need filtering
- Tokens should be constant-time compared to prevent timing attacks
- Consider a `GET /whoami` endpoint that returns the token's allowed repos (useful for agent self-discovery)
