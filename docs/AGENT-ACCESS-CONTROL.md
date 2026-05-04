# Agent Access Control

## Decision

Use token-scoped access in Lookie-Link, but keep the authority for cross-company
sharing outside Lookie-Link.

Lookie-Link should enforce access at request time and render only the repos,
paths, assets, edit pages, and save endpoints the presented credential allows.
It should not become the company graph, approval system, or long-term ACL
database. Cross-company sharing should be modeled as explicit grants created by
Paperclip or an operations-owned grant file, then materialized as short-lived
Lookie-Link tokens.

This keeps the current single-instance viewer and predictable URLs while closing
the leak where any agent on the tailnet can browse every configured repository.

Recommended implementation sequence:

1. Ship static config tokens for repo/path scopes.
2. Add document-level grants backed by a local SQLite database or YAML grant file.
3. Let Paperclip create and expire grants through an agent-facing API or managed
   config writer.
4. Run a buy/build comparison against existing documentation and knowledge-base
   systems before committing to the full managed grant store.
5. Define the agent API/CLI access path for explicit Lookie-Link access without
   replacing normal lazy-load filesystem reads.
6. Add audit logs before enabling cross-company access by default.

## Access Model

There are three actors:

- **Human browser users** on the private network. They keep today's default
  experience unless `server.requireAuthForHumans` is enabled.
- **Company agents** acting under a Paperclip company identity. They must present
  a token for all `/view`, `/asset`, `/edit`, and `/api/*` routes.
- **Grant issuers** such as Paperclip, CEO-approved workflows, or a trusted ops
  agent. They create, rotate, and revoke time-bound tokens.

An access grant should include:

```yaml
id: grant_fontastic_to_moneymaking_2026_05_04
subject:
  company: moneymaking
  agents: all
resource:
  repo: operations-fontastic
  paths:
    - clients/rfc-media/briefs/example.md
permissions:
  view: true
  edit: false
expiresAt: "2026-05-11T00:00:00-04:00"
reason: "Cross-company review requested in Paperclip issue FON-xxxx"
issuedBy: fontastic
```

Tokens derived from grants should be opaque bearer secrets. The server should
store only a hash of each secret when it owns the grant store. Grant matching
must be deny-by-default: if a token is present but no grant matches the requested
repo/path/action, return `403`.

## Company Boundary

The base filesystem boundary still matters. Lookie-Link can only enforce
permissions for paths configured under its repository roots; it cannot make a
process with broad filesystem privileges safe by itself.

Paperclip should continue to scope each company's agents to their own workspace
and operations folders at the process/tooling layer. Lookie-Link is a sharing
surface layered on top of that boundary, not a replacement for it.

Practical rule:

- **Default:** company agents can only read their own configured repos.
- **Exception:** another company grants a specific repo path for a specific
  purpose and expiry.
- **Never:** an agent receives ambient access to another company's whole
  operations tree just because it can reach the Lookie-Link service.

## Paperclip Filesystem Boundary Audit

Audit date: 2026-05-04 for [FON-3673](/FON/issues/FON-3673).

Classification: the current Paperclip local-runtime boundary is not strong
enough to treat Lookie-Link cross-company grants as routine. Lookie-Link can
deny requests outside a token's repo/path scope, and `safeResolve()` prevents
configured repository path traversal, but Paperclip agent execution still relies
on host-level convention for what a company agent can read.

Evidence from the current Paperclip installation:

- Paperclip creates per-company runtime folders at
  `~/.paperclip/instances/default/companies/<companyId>/`, including
  `codex-home/`, `agents/`, and `claude-prompt-cache/`.
- The local Codex adapter resolves `CODEX_HOME` to the company-managed
  `codex-home`, but seeds it from the shared host Codex home and symlinks
  `auth.json` back to `~/.codex/auth.json`.
- Local Codex/Claude agent configs can set arbitrary absolute `cwd` and
  `instructionsRootPath` values outside the company folder, commonly under
  `~/clawd/agents/...` or `~/operations`.
- Most local Codex agents run with `dangerouslyBypassApprovalsAndSandbox: true`,
  so filesystem access is bounded by the host user account, not by Paperclip
  company identity.
- OpenClaw gateway agents use operator-level gateway scopes. Paperclip company
  identity is passed as context, but filesystem/tool isolation depends on the
  gateway/runtime honoring that context.
- The company directory permissions are normal same-user directories. They
  separate layout and credentials by convention, not by OS user, container, ACL,
  or adapter-enforced allowlist.

Conclusion: do not enable ambient cross-company Lookie-Link access yet. The
safe operating posture is:

- Allow static Lookie-Link tokens only for same-company repo/path scopes.
- Permit cross-company grants only as explicit, path-scoped, time-limited,
  issue-linked exceptions.
- Do not grant a company agent access to another company's operations tree,
  Paperclip company folder, shared `~/clawd`, or shared host credential folder.
- Treat Paperclip runtime isolation as unproven until local adapters reject
  out-of-company filesystem roots before process launch.

Smallest enforcement improvements before routine cross-company grants:

1. Add a Paperclip adapter-side allowlist check for local runtime filesystem
   roots. For each run, validate `cwd`, `instructionsFilePath`,
   `instructionsRootPath`, execution workspace paths, and any configured local
   grant projection path before launching the tool process.
2. Derive the default allowlist from the company runtime folder and explicit
   project/workspace roots attached to the issue. Cross-company paths must come
   only from active grant records or approved project workspace policy.
3. Reject or block the run when a local path resolves outside the allowlist.
   Symlinks must be resolved with `realpath`; a symlink inside a company folder
   must not silently grant access to shared host credentials or another company
   folder.
   Current Lookie-Link grant API enforcement mirrors this by requiring
   `adapterAllowRoots` on cross-company grant creation and rejecting granted
   paths that resolve outside those roots.
4. Stop treating shared Codex/Claude auth as company isolation. If credentials
   must remain shared for billing or login reasons, document them as shared
   execution credentials and keep them out of the data-access boundary.
5. Add a CI or smoke-test fixture with two company folders proving that an agent
   from company A cannot read company B's folder, shared operations roots, or a
   symlink escaping its allowed roots unless an explicit grant allows the exact
   path.

Owner split:

- Clippy owns the workflow contract and grant safety rule.
- Bob owns the implementation patch once the Paperclip adapter enforcement task
  is created.
- Clawd owns follow-up only if the OpenClaw gateway cannot enforce equivalent
  company-scoped filesystem behavior.
- Devin owns follow-up only if enforcement requires host-level OS users,
  containers, ACLs, or deployment changes.

## Storage

Start with config because it matches the current project shape:

```yaml
access:
  humanDefault: full # full | restricted | none
  tokens:
    bob_builder_read:
      secretEnv: LOOKIE_TOKEN_BOB_BUILDER_READ
      repos:
        lookie-link:
          paths: ["docs/", "README.md"]
      permissions:
        view: true
        edit: false
```

Then add a managed grant store when cross-company sharing becomes routine:

- **SQLite** is the better long-term default for expiry, audit trails, and
  revocation without restarting the server.
- **YAML** is acceptable for the first managed version if Paperclip owns writes
  and the server reloads safely.

Do not put cleartext shared secrets in committed repo files. Config should point
to environment variables or a local private config path.

## Request Flow

1. Agent receives a Lookie-Link URL plus either an `Authorization: Bearer ...`
   token or a short-lived signed URL.
2. Lookie-Link authenticates the token and resolves its subject/grants.
3. The server filters repository indexes to authorized repos and paths.
4. The server checks every route independently:
   - `/` and `/view/` list only authorized entries.
   - `/view/<repo>/<path>` requires `view`.
   - `/asset/<repo>/<path>` requires `view` for the parent document or asset path.
   - `/edit/<repo>/<path>` requires both global editing enabled and grant `edit`.
   - `/api/save/<repo>/<path>` requires `edit`.
   - `/api/preview/<repo>/<path>` requires `view`; `edit` is not required for
     previewing content already supplied in the request.
5. Denied requests return `403`; unknown repos and paths should avoid disclosing
   more than necessary.

## Expiry and Revocation

Every cross-company grant should expire. Reasonable defaults:

- 24 hours for ad hoc issue/comment review.
- 7 days for active project collaboration.
- 30 days maximum without explicit renewal.

Revocation must be possible without changing repository mappings. In the static
config phase this means removing or rotating the token and restarting/reloading
the service. In the managed grant-store phase it means setting `revokedAt` and
having enforcement check it immediately.

## Alternative Systems Gate

Chris raised a product strategy concern after the initial decision: Lookie-Link
is sharp and valuable as an owned product, but we should verify whether an
existing documentation or knowledge-base system already solves the harder
cross-company ACL problem before we build the whole grant-management surface.

This should be treated as a checkpoint between phase 1 and phase 2:

- Phase 1 static token scopes can proceed because they are small, useful, and
  reduce the current leak surface.
- Phase 2 managed cross-company grants should wait for a concise buy/build
  comparison.

The comparison should evaluate at least:

- **Hudu or Hudu-like knowledge-base tooling** for client/company documentation,
  permissions, API access, and existing operational fit.
- **Git-backed documentation with signed links or generated access artifacts**
  where Paperclip grants create temporary readable projections instead of giving
  agents broad repository access.
- **Wiki/documentation platforms with API and ACL support** such as Outline,
  BookStack, Wiki.js, or similar self-hosted options.
- **Object-store or static-site publishing** where selected documents are
  copied into an isolated, expiring share surface.
- **Continuing with Lookie-Link** as the owned viewer, with Paperclip-native
  grants layered on top.

Decision criteria:

- Path- or document-level permissions, not just workspace-level visibility.
- API access suitable for agents without exposing broad human admin sessions.
- Time-limited grants and revocation.
- Audit trail tied back to Paperclip issues or approvals.
- Mobile-friendly rendered document review.
- Low operational burden and no major new secret surface.
- Ability to preserve the current file-native operations workflow.

Default posture until that comparison lands: keep Lookie-Link phase 1 moving,
but do not commit to a full grant database/API until the alternative-system
research issue reports back.

## Agent API And CLI Gate

Chris raised a second architecture concern after the initial model: if
filesystem access is the leak surface, should agents read operational markdown
and YAML through Lookie-Link APIs or CLI commands instead of opening local files
directly?

Decision: do not rewrite agent lazy-load instructions to use Lookie-Link.
Lazy-loaded markdown/YAML should remain filesystem-native. The access boundary
should come from each agent being scoped to the correct company/project
filesystem, plus an explicit shared public operations folder for cross-company
reference material.

The Lookie-Link CLI/API is still useful, but its job is explicit document
sharing, review, and scoped cross-company access. It should not become the
normal path for reading every `AGENTS.md`, `TOOLS.md`, YAML integration file, or
local markdown reference.

The agent access surface should answer:

- **Read path:** how an agent reads a markdown/YAML/text file by repo key and
  relative path without receiving broader filesystem access.
- **List/search path:** whether agents can list scoped directories or search
  within granted docs, and how to prevent discovery of unauthorized paths.
- **Write path:** whether edits go through `lookie put`/`lookie edit` or remain
  filesystem-native for trusted same-company work.
- **Grant path:** how an agent requests, receives, refreshes, and verifies a
  time-limited token.
- **Credential path:** where token secrets live, such as BWS, environment
  variables, local private config, or Paperclip-projected runtime env vars.
- **Audit path:** how reads and writes tie back to Paperclip issue IDs, agent
  IDs, and grant IDs.

Likely CLI shape:

```bash
lookie whoami
lookie repos
lookie get operations-fontastic clients/rfc-media/briefs/example.md
lookie put operations-fontastic clients/rfc-media/briefs/example.md --file draft.md
lookie grant request operations-fontastic clients/rfc-media/briefs/example.md --reason FON-xxxx
```

Likely HTTP API shape:

```text
GET  /api/whoami
GET  /api/repos
GET  /api/files/:repo/*path
PUT  /api/files/:repo/*path
POST /api/grants/request
```

The CLI should prefer `Authorization: Bearer` headers over query-string tokens
so credentials do not leak through pasted URLs, shell history, browser logs, or
chat transcripts. Short signed URLs may still be useful for human browser
review, but they should be treated as a separate sharing mode.

Credential storage guidance:

- For managed agents, Paperclip should project the active Lookie-Link token into
  the run environment or a short-lived private file, not require the agent to
  know a long-lived secret.
- BWS is a good candidate for long-lived service credentials and token issuer
  material, but individual short-lived grant tokens should be generated and
  expired by the grant workflow.
- Committed config may reference `secretEnv`; it must not contain cleartext
  shared secrets.

Lazy-load rule:

- Same-company trusted agents should read company/project files directly from
  their scoped filesystem.
- Agents across all companies may read the explicitly public operations folder
  once that folder is defined and enforced as shared reference material.
- Cross-company private reads should go through Lookie-Link grants or another
  evaluated documentation system.
- Do not mechanically convert `AGENTS.md`, `TOOLS.md`, or lazy-load file
  references to Lookie-Link URLs.

## Problem

Lookie-Link currently serves all configured repositories to anyone who can reach it. Access control relies entirely on network-level restrictions (Tailscale ACLs, LAN isolation).

This works for human users browsing from a phone or laptop, but creates a problem for agents. Different agents are scoped to different folders — an ops agent shouldn't be able to read research docs, and a research agent shouldn't be able to browse client operations files. Lookie-Link as-is circumvents those boundaries by exposing everything through a single URL.

## Requirements

- Agents can only view/edit repos they're authorized for
- Human browser access continues to work without auth (backward-compatible)
- Single instance — no port sprawl or running N copies
- Editing permissions should be independently controllable per agent
- Config-driven, not code-driven
- Cross-company grants are explicit, path-scoped, time-limited, and auditable
- Lookie-Link does not become the source of truth for company membership or
  Paperclip policy
- Lazy-load instructions stay filesystem-native; Lookie-Link CLI/API is for
  explicit scoped sharing, not ordinary local context loading

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
- Later versions should support path scopes, expirations, and hashed secrets

**Pros:** Clean, backward-compatible, one instance, familiar auth pattern for agents.
**Cons:** Static secrets in config are operationally weak unless moved to env vars
or a private grant store.

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

### Option D: Paperclip-Native Grants

Paperclip owns the cross-company grant workflow and Lookie-Link exposes a narrow
verification/enforcement interface.

**How it works:**
- Source company creates a grant from an issue, approval, or agent action.
- Paperclip records subject, resource, permission, reason, expiry, and issuer.
- Paperclip either writes the grant to Lookie-Link's private store or signs a
  short-lived token Lookie-Link can verify.
- Lookie-Link enforces the grant but does not decide whether the grant should
  exist.

**Pros:** Aligns access with the company/task graph, approval history, and agent
identity.
**Cons:** Requires Paperclip integration and a clearer company identity contract.

## Implementation Notes

- Token middleware would sit in `server.js` before route handlers
- `config.js` already resolves repo mappings — token scoping would filter that list per-request
- The repo index page and all `/view/`, `/edit/`, `/asset/`, `/api/` routes need filtering
- Tokens should be constant-time compared to prevent timing attacks
- Consider a `GET /whoami` endpoint that returns the token's allowed repos (useful for agent self-discovery)
- Add tests for directory listing filters, direct file access denial, asset denial,
  edit denial, save denial, expired grants, and unknown tokens

## Open Product Questions

- Should unauthenticated human access remain full-access forever, or should there
  be a `humanDefault: restricted` mode for mixed-company hosts?
- Should signed URLs be accepted for human-friendly sharing, or should all agent
  access require headers to avoid token leakage in logs and chat transcripts?
- Should grants attach to Paperclip issues by default so revocation can follow
  issue closure?
- What is the canonical company identity string for non-Paperclip callers?
