# Lookie-Link

Lookie-Link is a lightweight private-network viewer for local directories. Map a short repository name to a directory and browse rendered documents, highlighted source, structured data, images, audio, video, and PDFs through predictable URLs.

## Implemented features

- Sanitized Markdown and authored-HTML rendering, source toggles, heading/YAML anchors, portable cross-repo links, and local asset rewriting
- Dedicated image, audio, video, PDF, CSV, and JSON viewers
- Caller-scoped static tokens, hashed managed API keys, expiring managed grants, and repo/path permissions
- Caller-safe runtime discovery through `/.well-known/agent.json`, `/api/whoami`, and `/api/repos`
- Opt-in editing of existing non-binary files with atomic saves and mtime conflicts
- Opt-in sidecar annotations with inline viewer UI and heading, YAML-key, or line-range anchors
- Mutable managed repositories with bounded trees, change lists, scoped search, atomic writes, and recoverable deletion
- Immutable published revisions with optimistic updates, historical readback, and revocation
- Opt-in verbatim and transformed HTML execution for trusted content
- Eleven built-in dark/light themes, including a Codex app-shell palette, plus custom YAML themes
- A unified `lookie` CLI for authentication, discovery, managed content, search, and publishing

The complete source-checked surface is the [capability and route matrix](docs/CAPABILITIES.md). It is the single authoritative list of routes, auth gates, configuration switches, discovery fields, CLI commands, and stores.

## Quick start

```bash
npm install
cp lookie-link.yaml.example ~/.config/lookie-link/lookie-link.yaml
npm start
```

Then open `http://localhost:9876`. The default port is `9876`; configured repository keys become `/view/<repo>/...` URL prefixes.

Minimal configuration:

```yaml
server:
  port: 9876
  hostname: localhost
  enableEditing: false
  enableAnnotations: false
  enableRawHtml: false

repositories:
  docs: ~/Documents/docs
```

Editing, annotations, and raw HTML are off by default. Raw HTML executes unsanitized same-origin scripts and should only be enabled for trusted files on a trusted network.

## Unified CLI

```bash
secret-command | lookie auth login --instance http://localhost:9876 --token-stdin
lookie capabilities
lookie whoami
lookie repos
lookie read docs/README.md
lookie tree shared --path notes
lookie search "release notes" --scope shared
```

Run `lookie --help` for the implemented command grammar. The generated agent packages follow [the skill spec](docs/SKILL-SPEC.md). The older `lookie-read` and `lookie-annotations` executables remain available as compatibility shims; they are not unified CLI subcommands.

## Network and trust model

Lookie-Link binds for private-network use and is not hardened as a public multi-tenant service. `access.humanDefault` defaults to `full`, preserving unauthenticated browser access. Set it to `restricted` or `none` before enabling a mixed-user instance, then issue least-privilege credentials.

Read requests may use a bearer header or query token so browser links can remain navigable. Mutations reject query credentials. Agent and CLI usage should always prefer `Authorization: Bearer`.

## Documentation

- [Capability and route matrix](docs/CAPABILITIES.md) — authoritative implemented surface
- [Configuration](docs/CONFIGURATION.md) — setup and security guidance
- [API](docs/API.md) — payload and workflow details
- [Features](docs/FEATURES.md) — rendering and viewer behavior
- [Agent access control](docs/AGENT-ACCESS-CONTROL.md) — current authorization model
- [Publishing](docs/PUBLISHING.md) — immutable artifact contract
- [Annotations](docs/ANNOTATIONS-SPEC.md) — implemented sidecar contract
- [Agent shims](docs/AGENT-SHIM.md) — legacy compatibility executables
- [Contributing](docs/CONTRIBUTING.md)

## License

MIT
