# Lookie-Link Skill Spec

**Status**: Draft spec — basis for the phase 2 skill packages (Claude Code, Cursor, Codex). The actual skill files (`SKILL.md`, `.cursorrules`, etc.) will be generated from this spec when phase 2 ships.

**Source issue**: [FON-10180](/FON/issues/FON-10180)

**Related**:
- The strategic evaluation at `research/commercialization/lookie-link-publish-api-cli-public-link-evaluation-2026-06-01.md`, particularly Phase 2 (Addendum c) and the CLI section
- The integration YAML at `~/operations-system/knowledge/integrations/lookie-link.yaml` — operator-side conventions this skill follows

## What this is

A single source-of-truth spec for what the Lookie-Link skill packages should contain when they ship. Skill packages target three runtimes:

| Runtime | Package format | Where it lives |
|---|---|---|
| Claude Code | `SKILL.md` + frontmatter | `~/.claude/skills/lookie-link/` (user install) or marketplace |
| Cursor | `.cursorrules` + extension manifest | Cursor's extension surface |
| Codex / OpenAI Code Interpreter | Tool function spec + system prompt fragment | Codex's tool registration |

All three derive from the same agent-facing instructions in this spec. The runtime-specific wrappers handle each platform's idiomatic format.

## Frontmatter (for Claude Code SKILL.md)

```yaml
---
name: lookie-link
description: >
  Read, write, search, publish, and share content through a Lookie-Link canonical
  content store. Use when the user asks to read or write content via the Lookie-Link
  API, when content needs to be canonical across machines, when an artifact needs a
  shareable URL, or when searching the team's shared knowledge base. Do NOT use for
  source code (use git directly) or for multi-GB binary blobs (use object storage).
---
```

## Setup

```bash
# 1. Install the CLI
npm install -g lookie-link-cli

# 2. Authenticate against your canonical Lookie-Link instance
lookie auth login --instance https://lookie.example.com

# (alternative: set env vars directly)
export LOOKIE_LINK_INSTANCE=https://lookie.example.com
export LOOKIE_LINK_TOKEN=lk_xxxxxxxxxxxxxxxxxxxxx
```

The CLI stores credentials in `~/.config/lookie-link/auth.yaml` (encrypted at rest with the OS keychain when available; falls back to file-based with strict permissions).

## Authentication

Agents use API keys. Always. The CLI handles the bearer token in the `Authorization` header automatically once `lookie auth login` has been run or `LOOKIE_LINK_TOKEN` is set.

**Never paste an API key into a shell history or a chat log.** Use `lookie auth login` (interactive prompt; key never echoes) or pre-export the env var from the agent's secrets manager.

**Key scope discipline**: every key has explicit permissions (`view`, `edit`, `write`, `publish`, `share`). Use the lowest-permission key the task needs. If the task needs to write to one managed repo, the key should be scoped to that repo only.

## Quick reference

### Read

```bash
# Read a file via the API (cache validates with If-Modified-Since)
lookie read agent-research/notes/topic.md

# Force refresh past the cache
lookie read --no-cache agent-research/notes/topic.md

# Read a specific historical version
lookie read agent-research/notes/topic.md --version 2026-06-01T20:42:33Z

# List files in a managed repo (with filters)
lookie list agent-research --modified-after 2026-06-01

# Recursive directory tree
lookie tree agent-research --max-depth 3

# What changed in a repo since a timestamp
lookie changes agent-research --since 2026-06-02T08:00:00Z
```

Reads are cached locally by default. Cache hit: ~5 ms (validation round-trip). Cache miss: 10–200 ms depending on tailnet vs. public-internet transport.

### Write

```bash
# Write to a managed repo (create or update; honors expectedMtimeMs for concurrency)
lookie write agent-research/notes/new-topic.md --content "# New topic..."

# Or read content from stdin / file
cat my-doc.md | lookie write agent-research/notes/new-topic.md --content-from-stdin

# Update an existing file with concurrency check
lookie write agent-research/notes/topic.md --content "..." --expected-mtime 1234567890

# Move / rename
lookie move agent-research/old-path.md agent-research/new-path.md

# Delete (soft by default — goes to .trash/)
lookie delete agent-research/notes/stale.md

# Hard delete (operator permission required)
lookie delete --hard agent-research/notes/stale.md
```

### Search

Search is load-bearing. Use it before writing to avoid creating duplicate content.

```bash
# Full-text search across allowed scopes
lookie search "syncthing authority model"

# Scoped to specific repos
lookie search "authority model" --scope agent-research --scope operations-research

# By file type
lookie search "decision" --type markdown

# By frontmatter field
lookie search --frontmatter "type=research-doc&status=draft"

# Autocomplete path/filename
lookie search suggest "synct"
```

Search results include `path`, `score`, `snippet`, `lastModified`, `frontmatter`, `viewUrl`, and `rawUrl`. The CLI's default output is human-readable; pass `--json` for structured output an agent can parse.

### Publish (immutable slug-addressed artifacts)

Use publish when you have a finished bundle to share, not when the content is mutable.

```bash
# Publish a single file (returns a slug + URL)
lookie publish ./my-report.md

# Publish a manifest of multiple files
lookie publish --manifest manifest.json

# Update an existing published slug (creates a new revision)
lookie publish --slug <slug> ./my-report.md

# List published slugs
lookie publish list

# Revoke (operator-scoped permission)
lookie publish revoke <slug>
```

### Share

Public-share endpoints attach to publish slugs (or to managed-repo paths, depending on permission). Three modes:

```bash
# Anonymous + password (the Planet Fitness public-doc case)
lookie share <slug> --mode anonymous --expires-in 7d --password "ChooseAStrongOne"

# Magic-link to a known email
lookie share <slug> --mode magic-link --invite client@example.com --expires-in 14d

# Credentialed (recipient must log in)
lookie share <slug> --mode credentialed --invite collaborator@example.com

# List active shares
lookie share list

# Revoke before expiry
lookie share revoke <share-token>
```

## When to use this skill

**Use Lookie-Link for**:
- Multi-agent shared workspace content (managed repos)
- Cross-machine canonical reads where consistency matters more than absolute speed
- Searching the team's shared knowledge base
- Publishing finished artifacts that need a URL
- Sharing content publicly with controlled expiry / auth

**Don't use Lookie-Link for**:
- Source code (use git directly; submit PRs)
- Hot-loop reads of the agent's own identity / config files (use local fs)
- Multi-GB binary blobs (use object storage with its own URL)
- Content that needs strict per-commit review (use git + PR review)

## When to use the API directly vs the CLI

The CLI is the recommended path for almost all agent workflows because it handles auth, caching, retries, and error formatting. Use the API directly only when:

- The agent runtime can't shell out to the CLI (some sandboxed environments)
- The agent needs streaming / long-poll behavior the CLI doesn't expose
- The agent is implementing a custom tool layer on top of Lookie-Link

If using the API directly, base URL is `${LOOKIE_LINK_INSTANCE}/api/`. Authentication is `Authorization: Bearer ${LOOKIE_LINK_TOKEN}`. Full endpoint reference in [`docs/API.md`](API.md).

Agent runtimes that consume `agent.json` can self-configure against `${LOOKIE_LINK_INSTANCE}/.well-known/agent.json` for capability discovery.

## Decision matrix (compressed from the operations-system integration YAML)

| What the agent needs | Recommended source |
|---|---|
| Its own identity / config file | Local filesystem (agent owns it) |
| Hot-loop reads in a tight cycle | Local filesystem |
| Best-practices / shared knowledge doc | Local first, Lookie-Link API via cache as fallback |
| Recently-written research doc (other agent might have written) | Lookie-Link API via cache (short TTL) |
| Doc that only exists on the canonical instance | Lookie-Link API via cache |
| GitHub URL the user pasted | GitHub (user's explicit choice); cache the result |
| Cross-machine canonical write target | Lookie-Link managed repo via `lookie write` |
| One-off public share | Lookie-Link publish + anonymous share |
| Audited client share | Lookie-Link publish + magic-link share |
| Long-lived collaborator share | Lookie-Link publish + credentialed share |

## Concurrency and conflict handling

Writes to managed repos use `expectedMtimeMs` for concurrency control. Pass the value from your last read; if the file moved since then, you get a 409 Conflict.

```bash
# Read returns mtime in JSON output
MTIME=$(lookie read agent-research/notes/topic.md --json | jq .lastModified)

# Modify content, then write with the mtime
lookie write agent-research/notes/topic.md --content "..." --expected-mtime $MTIME
```

If you get a 409, fetch the current state, reconcile with your intended write (resolve conflicts in the content), and retry with the new mtime. Do not blindly overwrite.

## Audit log expectations

Every state-changing operation (write, publish, share, restore, revoke, key rotation) writes an audit log entry. The entry includes:

- Timestamp
- Actor (`agent.id + key.id + key.label`)
- Operation
- Path / slug
- Optional metadata (size, hash, conflict info)

Agents do not access the audit log directly in normal workflows. Operators query it via `GET /api/audit?...`.

## Common workflows

### Workflow 1: agent writes a research finding into the shared workspace

```bash
# 1. Search first — avoid duplicates
lookie search "syncthing authority model"

# 2. If no existing doc covers the topic, write it
lookie write agent-research/findings/syncthing-authority-2026-06-02.md \
  --content-from-stdin << 'EOF'
# Syncthing authority model — findings 2026-06-02

[content...]
EOF

# 3. Confirm the write succeeded
lookie read agent-research/findings/syncthing-authority-2026-06-02.md --no-cache
```

### Workflow 2: agent publishes a finished report and shares with a client

```bash
# 1. Publish the report as an immutable slug
SLUG=$(lookie publish ./final-report.pdf --json | jq -r .slug)

# 2. Share via magic-link to the client
lookie share $SLUG \
  --mode magic-link \
  --invite client@example.com \
  --expires-in 14d
```

### Workflow 3: agent looks up prior research before answering a question

```bash
# Search the canonical store; results include snippets the agent can use as context
lookie search "client-X migration history" --json | jq '.[] | {path, snippet, lastModified}'

# Fetch the most relevant doc(s) in full
lookie read agent-research/clients/client-X/migration-history.md
```

### Workflow 4: agent needs the latest version of a doc that another agent might have just written

```bash
# Trust the cache for most reads, but force-refresh when freshness is critical
lookie read agent-research/findings/latest-incident.md --no-cache
```

## When NOT to call Lookie-Link

If you're about to:
- Edit source code → use git directly
- Read your own identity file → use local fs
- Run a tight loop of reads on the same file → cache the first read in memory, don't re-call
- Read multi-GB content → don't store it in Lookie-Link in the first place
- Modify a git-tracked repo's source → use git commit + push, not Lookie-Link write endpoints

## Error handling

The CLI exits non-zero with a stderr message on error. Common failures:

| Exit code | Meaning | Recovery |
|---|---|---|
| 1 | Generic error (check stderr) | Read the message |
| 2 | Auth failure (401 / 403) | Re-run `lookie auth login` or check `LOOKIE_LINK_TOKEN` |
| 3 | Not found (404) | Verify the path; use `lookie list` / `lookie tree` to confirm |
| 4 | Conflict (409) | Fetch current state, reconcile, retry |
| 5 | Rate limited (429) | Back off; the CLI auto-retries with jitter |
| 6 | Server error (5xx) | Auto-retried with exponential backoff; if persistent, check instance health |
| 7 | Network unreachable | Cache returned if available; otherwise stderr explains |

## Cache invalidation

The CLI cache lives in `~/.cache/lookie-link/<instance>/`. To clear:

```bash
lookie cache clear                      # entire cache
lookie cache clear --repo agent-research  # one repo
lookie cache stats                       # see what's cached and size
```

The agent does not normally need to manage the cache. It self-cleans per the configured TTL and validates on every read.

## Permissions reference (quick)

| Permission | What it lets you do |
|---|---|
| `view` | Read files via `/view/` or `/api/repos/.../files/...` GET |
| `edit` | Modify files in existing mounted local-checkout repos |
| `write` | Create / update / delete files in managed repos |
| `publish` | Create slug-addressed publish artifacts |
| `share` | Mint public-share URLs |
| `manage_users` | Operator-only |
| `manage_agent_keys` | Operator-only |
| `manage_grants` | Operator-only |
| `manage_backup` | Operator-only |
| `manage_repo_sync` | Operator-only |
| `manage_shares` | Mint / revoke shares for shares the identity created |

Agents are typically minted with some combination of `view + write + publish + share` scoped to specific repos and paths.

## Compatibility with the operations-system contract

The operations-system contract at `~/operations-system/knowledge/integrations/lookie-link.yaml` is the **operator-side** policy that determines:

- Which managed repos exist on the canonical instance
- Which `syncMode` each repo uses (bidirectional vs canonical)
- Which backup target(s) the operator has configured
- Which agents have keys with which permissions

This skill is the **agent-side** instructions that follow that policy. Agents using this skill don't need to know how the operator chose those settings — they just call the API per these instructions.

## Versioning of this spec

When this spec changes:
- Bump the version in the frontmatter
- Note the change in `CHANGELOG.md` of the lookie-link repo
- Regenerate the runtime-specific skill files from this spec
- If a managed-repo write workflow changes, also update the integration YAML in operations-system

This spec is the source of truth. Runtime-specific files (`SKILL.md`, `.cursorrules`, etc.) are generated artifacts.
