# Lookie-Link Skill Spec

**Status**: Active source of truth for generated Claude Code, Cursor, and Codex skill packages. Refresh the packages with `npm run generate:skill-packages` and verify them with `npm run check:skill-packages`.

## What this is

This document defines the common agent instructions used by each generated package. Runtime wrappers may differ, but their command guidance must describe only behavior implemented by the unified `lookie` CLI.

The command-to-route and authorization inventory is maintained in [CAPABILITIES.md](CAPABILITIES.md#unified-cli-inventory). If this spec and that inventory disagree, correct this spec and regenerate the packages.

The generated packages target these runtime-native formats:

| Runtime | Package format |
|---|---|
| Claude Code | `SKILL.md` with YAML frontmatter |
| Cursor | `.cursorrules` Markdown instructions |
| Codex | `SKILL.md` with YAML frontmatter |

## Frontmatter

```yaml
name: lookie-link
description: >-
  Read, write, delete, search, and publish content through a Lookie-Link instance.
  Use for canonical cross-machine documents, managed-repository workflows, scoped
  search, or finished artifacts that need a published URL. Do not use for source
  code or very large binary objects.
```

## Setup

Install the package globally, then store an instance and token:

```bash
npm install -g lookie-link
secret-command | lookie auth login --instance https://lookie.example.com --token-stdin
```

The token can instead be supplied through `LOOKIE_LINK_TOKEN`. The instance resolution order is an invocation-level `--instance` or `--base-url`, stored config, `LOOKIE_LINK_BASE_URL`, then `http://localhost:9876`.

Credentials are stored in `~/.config/lookie-link/auth.yaml` with mode `0600`. The CLI sends tokens only in the `Authorization: Bearer` header. Never put a token in a URL, command argument, shell history, log, or chat message.

## Authentication

Use a credential with the smallest repository, path, and operation scope needed for the task. Run these commands before a sensitive workflow:

```bash
lookie auth status
lookie whoami
lookie capabilities
```

`lookie capabilities` reads `/.well-known/agent.json`. For an older instance where discovery is unavailable, it falls back to the capability summary returned by `/api/whoami`.

## Quick reference

### Discover

```bash
lookie capabilities
lookie whoami
lookie repos
```

### Read

```bash
lookie read knowledge/notes/topic.md
lookie --json read knowledge/notes/topic.md
lookie tree knowledge --path notes --max-depth 3
lookie changes knowledge --since 2026-01-01T00:00:00Z
```

`changes --since` accepts an ISO-8601 timestamp or Unix seconds.

The read command first uses the managed-repository file API. A 404 falls back to the compatible asset endpoint so the same command can read mounted repositories.

### Write and delete

```bash
lookie write knowledge/notes/new-topic.md --content "# New topic"
secret-content-command | lookie write knowledge/notes/new-topic.md --content-from-stdin
lookie write knowledge/notes/topic.md --content-file ./topic.md --expected-mtime 1234567890
lookie delete knowledge/notes/stale.md
lookie delete knowledge/notes/stale.md --hard
```

Delete is recoverable by default. Hard deletion depends on server-side authorization.

### Search

```bash
lookie search "authority model"
lookie search "authority model" --scope knowledge
lookie search '"exact phrase"'
lookie search suggest "auth"
```

Search before writing when duplicate canonical content would be costly. Whitespace splits a query into terms; every term must match content (in any order) or the whole path — wrap words in double quotes for a literal phrase. Matching is literal (no regular expressions) and case-insensitive. A misspelled or unknown `--scope` is a CLI usage error, not an empty result — check the repo name against `lookie repos` rather than treating an empty answer as authoritative. `lookie search suggest <query>` returns bounded path suggestions only, for autocomplete-style lookups.

### Publish

```bash
lookie publish ./report.md
lookie publish ./report.md --slug release-notes
lookie publish --manifest ./manifest.json
lookie publish ./report.md --slug release-notes --expected-revision 1
lookie publish ./report.md --slug themed-report --kit default
lookie publish revoke release-notes --reason "superseded"
lookie publish list
lookie publish list --state revoked
lookie publish show release-notes
lookie publish show release-notes --version 1
```

Creating a publication may include a slug. Updating an existing slug creates a new immutable revision and requires `--expected-revision`. A manifest uses the server API shape: `files`, optional `slug`, optional `entryPath`, optional `expectedRevision`, and optional `kit`. `--kit <name|default>` on `publish` attaches a kit to the revision; each revision is immutable, so an older revision keeps whatever kit (or lack of one) was inlined into it at publish time — republishing with a different `--kit` only changes the new revision. `lookie publish list [--state active|revoked]` lists publications the caller can view; `lookie publish show <slug> [--version N]` reads one publication's record, its revisions, and optionally one revision's files.

### Kits

```bash
lookie kits
lookie kit show ops
lookie kit file ops report-template.html
```

`lookie kits` lists hosted HTML kits (design-token stylesheets plus fillable templates and examples); `lookie kit show <name>` returns one kit's projection; `lookie kit file <name> <file>` prints a template or example as raw text so it can be filled in and published. To style a page with a kit, put the placeholder link `<link rel="stylesheet" href="kit.css" data-kit>` in the page's `<head>`; the publish step replaces it with an inlined `<style data-kit data-kit-version>` block for that kit's revision. Add `?validate=1` to a published page's `/view` URL to get an advisory JSON report — including `kit` and `pageContract` sections (stale-kit, theme-follow, sticky-nav warnings) — without changing the page's status code.

Admin-only writes (organization-scoped, need `LOOKIE_LINK_ADMIN_TOKEN`):

```bash
lookie kit create --name my-kit --label "My Kit" --version 1 --stylesheet ./kit.css --template ./report.html
lookie kit upload my-kit report-template.html
lookie kit set my-kit --revision 3 --token --radius=8px
lookie kit delete my-kit
```

`kit create` makes a new organization kit; `kit upload` writes a new immutable version of one file (bundled and shared kits are read-only — organization kits only); `kit set` patches a token overlay and requires the current `--revision` from the last list/show (a stale revision is a conflict); `kit delete` tombstones an organization kit (its versions stay recorded, but the name shows as deleted).

### Annotations

```bash
lookie annotations list knowledge/notes/topic.md --state open
lookie annotations add knowledge/notes/topic.md --anchor "#topic" --kind heading --body "Clarify this"
lookie annotations claim knowledge/notes/topic.md <id> --by my-agent
lookie annotations replies knowledge/notes/topic.md <id> --add "Done"
lookie annotations resolve knowledge/notes/topic.md <id>
```

### Trash, appearance, and API discovery

```bash
lookie trash restore knowledge <trashId>
lookie trash remove knowledge <trashId>
lookie appearance show
lookie appearance set --revision 3 --blur 6 --panel 80
lookie appearance upload sunset dark --name ember ./ember.jpg
lookie appearance delete sunset dark ember
lookie openapi
lookie docs
```

`lookie trash list <repo>` lists soft-deleted records; IDs also come from the `lookie delete` response. Appearance writes need an admin token (`LOOKIE_LINK_ADMIN_TOKEN`, falling back to `LOOKIE_LINK_TOKEN`) and the `revision` from the last `appearance show`; a stale revision exits `5`.

## When to use this skill

Use Lookie-Link for:

- Canonical documents shared across machines or agents
- Scoped reads and managed-repository mutations
- Searching an allowed knowledge collection
- Publishing a finished file or manifest as a revisioned artifact

Do not use Lookie-Link for:

- Source code changes that belong in a version-control review
- Local identity or configuration files already owned by the current process
- Tight read loops where the caller should retain the first response in memory
- Very large objects that belong in dedicated object storage

## When to use the API directly vs the CLI

Prefer the CLI for supported commands because it consistently applies stored configuration, bearer headers, output formatting, compatibility fallback, and exit codes. Use the API directly only when the runtime cannot execute the CLI or when implementing a custom integration.

For direct calls, use the configured instance as the origin, consult `docs/API.md` for the route contract, and send the credential in the `Authorization` header. Never add a credential to a query string.

## Decision matrix

| Need | Recommended source |
|---|---|
| Current process identity or local config | Local filesystem |
| Source code change | Version control and review workflow |
| Canonical document read | `lookie read` |
| Repository inventory | `lookie repos`, `lookie tree`, or `lookie changes` |
| Canonical document mutation | `lookie write` or `lookie delete` |
| Knowledge lookup | `lookie search` |
| Finished revisioned artifact | `lookie publish` |
| Available kit stylesheets/templates | `lookie kits` or `lookie kit show` |
| A fillable page template or example | `lookie kit file` |
| A styled published page | `lookie publish --kit NAME` |
| Organization kit lifecycle (create/version/overlay/delete) | `lookie kit create`/`upload`/`set`/`delete` (admin only) |

## Concurrency and conflict handling

Managed-repository writes accept `--expected-mtime`, and publication updates accept `--expected-revision`. A stale expectation returns exit code `5` for an HTTP 409 conflict.

When a conflict occurs:

1. Read the current file or publication state.
2. Reconcile it with the intended change.
3. Retry using the new mtime or revision.

Do not remove the expectation and overwrite blindly.

## Common workflows

### Write a new finding

```bash
lookie search "existing topic"
lookie write knowledge/findings/new-topic.md --content-from-stdin <<'EOF'
# New topic

Finding details.
EOF
lookie read knowledge/findings/new-topic.md
```

### Update an existing file safely

```bash
lookie --json read knowledge/notes/topic.md
lookie write knowledge/notes/topic.md --content-file ./topic.md --expected-mtime 1234567890
```

Use the actual mtime returned by the read response.

### Publish and later revise a report

```bash
lookie publish ./report.md --slug quarterly-report
lookie publish ./report.md --slug quarterly-report --expected-revision 1
```

Use the current server revision for the update expectation.

### Publish a kit-styled page

```bash
lookie kits
lookie kit file ops report-template.html > ./report.html
# fill in ./report.html, keeping <link rel="stylesheet" href="kit.css" data-kit> in <head>
lookie publish ./report.html --slug quarterly-report --kit ops
lookie read lookie-publish/quarterly-report/report.html
```

Discover an available kit, fetch its template, fill it in without disturbing the `data-kit` placeholder link, publish with `--kit`, then check the published page (optionally with `?validate=1` on its `/view` URL) for kit and page-contract warnings.

## Error handling

| Exit code | Meaning | Recovery |
|---|---|---|
| `0` | Success | Continue |
| `2` | Invalid CLI usage | Correct the command or options |
| `3` | Authentication or authorization failure | Check the credential and scope |
| `4` | Not found | Check the repository, path, or slug |
| `5` | Conflict | Re-read, reconcile, and retry |
| `6` | Transport or other HTTP failure | Check the instance and server response |

Server failures arrive as `{ "ok": false, "error": { "code": "not_found", "message": "Not found." } }` (see [API.md → Error conventions](API.md#error-conventions)); `error` is never a bare string. CLIs print `error.message`; with `--json-errors` they pass the server's whole `error` object through (as `serverError`).

Errors and URLs must not contain the configured token.

## Versioning and generation

`docs/SKILL-SPEC.md` is authoritative. The generator derives every runtime package and a manifest containing the source hash. Generation has no timestamps and sorts the manifest paths, so identical source produces byte-identical output.

After changing this spec:

```bash
npm run generate:skill-packages
npm run check:skill-packages
```

The check command fails for missing, changed, or unexpected generated files.
