# Agent CLI Shims

Lookie-Link ships two CLI shims for agents that prefer a shell entry point over raw HTTP:

- `lookie-read` — fetch a file from a Lookie-Link host (`bin/lookie-read.js`)
- `lookie-annotations` — list / create / claim / resolve / reply to annotations (`bin/lookie-annotations.js`)

Both share the same env-based auth, the same exit-code grammar, and JSON-first stdout.

## Common Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOOKIE_LINK_BASE_URL` | `http://localhost:9876` | Server base URL |
| `LOOKIE_LINK_TOKEN` | _(unset)_ | Bearer token forwarded as `Authorization: Bearer <token>` |
| `LOOKIE_LINK_AUTHOR` | `lookie-annotations` (annotations only) | Default author name for created annotations and replies |

`--base-url URL` overrides `LOOKIE_LINK_BASE_URL` on any invocation.

## Exit Codes

Both shims use the same grammar:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Usage error (bad flags, missing args, malformed `<repo>/<path>`) |
| `3` | Not found (file or annotation does not exist) |
| `4` | Forbidden (HTTP 401 or 403 — auth missing, wrong scope, or token rejected) |
| `5` | Transport, 5xx, or unexpected response shape |

## Path Argument

Both shims accept either form for the file argument:

```
operations/README.md
~/operations/README.md
```

The leading `~/` and any leading slashes are stripped before the first path segment is treated as the repo id.

## `lookie-annotations`

```
lookie-annotations <command> <repo>/<path> [options]
```

### Subcommands

| Command | Call |
|---------|------|
| `list <repo>/<path> [--state STATE]...` | `GET /api/annotations/:repo/*` |
| `get <repo>/<path> <id>` | `GET` + client-side filter |
| `add <repo>/<path> --anchor A --kind K --body B [--author NAME]` | `POST` |
| `claim <repo>/<path> <id> [--by AGENT]` | `PATCH` `op=claim` |
| `resolve <repo>/<path> <id>` | `PATCH` `op=resolve` |
| `replies <repo>/<path> <id>` | `GET` + client-side filter |
| `replies <repo>/<path> <id> --add BODY [--author NAME]` | `PATCH` `op=reply` |

`--state` is repeatable (e.g. `--state open --state claimed`). Valid values: `open`, `claimed`, `resolved`.

`--kind` must be one of `heading`, `yamlKey`, `lineRange`. `lineRange` anchors must be of the form `#L<start>-L<end>`.

### Body Input

`add` and `replies --add` require a body. Three input forms:

- `--body "inline text"` — pass directly on the command line
- `--body-file PATH` — read from a file (best for long markdown — no shell escaping)
- `--body -` — read from stdin (`cat body.md | lookie-annotations add ... --body -`)

### Output

Default output is parseable JSON. `--pretty` prints a human-readable block, one annotation per stanza, suitable for terminal viewing.

`--json-errors` mirrors the convention from `lookie-read.js`: errors are emitted as `{"error": "<message>", "code": <exit>}` on stdout (still followed by the matching exit code). Without `--json-errors`, errors go to stderr.

### Examples

```sh
# List every open annotation on a file
LOOKIE_LINK_TOKEN=$mytoken \
  lookie-annotations list operations/README.md --state open

# Create one from inline body
lookie-annotations add operations/README.md \
  --anchor '#design-decisions' --kind heading \
  --body 'Please split this section.' --author agent-bob

# Create one from a markdown file
lookie-annotations add operations/README.md \
  --anchor '#design-decisions' --kind heading \
  --body-file ./review.md --author agent-bob

# Claim, resolve, reply
lookie-annotations claim   operations/README.md 2026-06-09-001 --by agent-bob
lookie-annotations resolve operations/README.md 2026-06-09-001
lookie-annotations replies operations/README.md 2026-06-09-001 --add 'thanks!'
```

## `lookie-read`

See `bin/lookie-read.js --help`. Fetches a single file via local-filesystem fast path or `/asset/<repo>/<path>` over HTTP, with `--range` and `--list-repos` support. Same env vars and exit-code grammar.
