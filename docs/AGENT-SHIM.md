# Compatibility Agent Shims

The package retains two standalone compatibility executables. New integrations should prefer the unified `lookie` CLI documented in [CAPABILITIES.md](CAPABILITIES.md#unified-cli-inventory).

## Common environment and exits

Both scripts accept `--base-url`, read `LOOKIE_LINK_BASE_URL` (default `http://localhost:9876`), and send `LOOKIE_LINK_TOKEN` as a bearer credential. `lookie-annotations` also uses `LOOKIE_LINK_AUTHOR` as its default author.

Both use exit `0` success, `2` usage, `3` not found, `4` authentication/authorization, and `5` transport/unexpected server failure.

## `lookie-read`

`lookie-read <repo>/<path>` discovers repos through `/api/repos`, optionally uses a local mapped-root fast path, and otherwise reads through `/asset`. It supports `--range`, `--no-local`, `--no-cache`, and `--list-repos`; its repo manifest cache has a five-minute TTL.

The local fast path is a compatibility behavior and may read from locally configured roots. Use `--no-local` when the HTTP authorization boundary must be exercised.

## `lookie-annotations`

The annotation shim supports:

- `list <repo>/<path> [--state STATE]...`
- `get <repo>/<path> <id>`
- `add <repo>/<path> --anchor A --kind K --body BODY [--author NAME]`
- `claim <repo>/<path> <id> [--by AGENT]`
- `resolve <repo>/<path> <id>`
- `replies <repo>/<path> <id> [--add BODY] [--author NAME]`

Kinds are `heading`, `yamlKey`, and `lineRange`; states are `open`, `claimed`, and `resolved`. Body input may come from `--body`, `--body-file`, or stdin via `--body -`. Output is JSON by default; `--pretty` is human-oriented and `--json-errors` moves structured errors to stdout.

There is no annotation migration command and no `lookie annotations` unified subcommand.
