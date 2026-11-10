# Lookie-Link

Lookie-Link is a lightweight private-network viewer for local directories. Map a short repository name to a directory and browse rendered documents, highlighted source, structured data, images, audio, video, and PDFs through predictable URLs.

## Implemented features

- Sanitized Markdown and authored-HTML rendering, source toggles, heading/YAML anchors, portable cross-repo links, and local asset rewriting
- Dedicated image, audio, video, PDF, CSV, and JSON viewers; a waveform player for every served audio file, with read-only audio roots
- Opt-in audio marker editor: template-driven points and regions saved as immutable records, with guarded YAML write-back
- Caller-scoped static tokens, hashed managed API keys, expiring managed grants, and repo/path permissions
- Caller-safe runtime discovery through `/.well-known/agent.json`, `/api/whoami`, and `/api/repos`
- OpenAPI 3.1 description at `/openapi.json` with an interactive try-it explorer at `/api/docs`
- Opt-in editing of existing non-binary files with atomic saves and mtime conflicts
- Opt-in sidecar annotations with inline viewer UI and heading, YAML-key, or line-range anchors
- Mutable managed repositories with bounded trees, change lists, scoped search, atomic writes, and recoverable deletion
- Immutable published revisions with optimistic updates, historical readback, and revocation
- Opt-in verbatim and transformed HTML execution for trusted content
- Eleven built-in dark/light themes, including a Codex app-shell palette, plus custom YAML themes
- Hosted HTML kits (bundled Ops kit plus config-folder kits), including the Ops 1.31 [standalone how-to guide](kits/ops/guide-template.html)
- A unified `lookie` CLI for authentication, discovery, managed content, trash recovery, search, annotations, appearance, kits, and publishing

The complete source-checked surface is the [capability and route matrix](docs/CAPABILITIES.md). It is the single authoritative list of routes, auth gates, configuration switches, discovery fields, CLI commands, and stores.

## Quick start

```bash
npm install
mkdir -p ~/.config/lookie-link
cp lookie-link.yaml.example ~/.config/lookie-link/lookie-link.yaml
npm start
```

Then open `http://localhost:9876`. The default port is `9876`; configured repository keys become `/view/<repo>/...` URL prefixes.

A config file is optional: startup without one uses defaults and an empty repository map. Create the file above to serve your directories; see [configuration lookup and limitations](docs/CONFIGURATION.md#file-lookup-and-precedence).

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

Run `lookie --help` for the implemented command grammar. The generated agent packages follow [the skill spec](docs/SKILL-SPEC.md). The older `lookie-read` and `lookie-annotations` executables remain available as compatibility shims; `lookie annotations` covers the same annotation operations.

## System dependencies

Node 22 and the npm packages in `package.json` are all a default install needs. Two optional external tools are invoked by configured path and are not bundled:

- `ffmpeg` and `ffprobe` generate waveform peaks for the audio viewer and are required to save marker records (positions are validated against the file's frame count). Without them the audio page still plays the file and the audio info route answers `503 peaks_unavailable`. Paths come from `markers.ffmpegPath` and `markers.ffprobePath` (default: `ffmpeg` and `ffprobe` on `PATH`).
- A guarded YAML command-line tool and any validator commands are needed only for marker projections; they are named in `markers.yamlToolPath` and `markers.validators`. Without them the projection answers `409 feature_disabled`.

Both are declared as referenced system dependencies in `fossa-deps.yml`.

## Network and trust model

Lookie-Link binds for private-network use and is not hardened as a public multi-organization service. `access.humanDefault` defaults to `full`, preserving unauthenticated browser access. Set it to `restricted` or `none` before enabling a mixed-user instance, then issue least-privilege credentials.

Read requests may use a bearer header or query token so browser links can remain navigable. Mutations reject query credentials. Agent and CLI usage should always prefer `Authorization: Bearer`.

## Documentation

- [Release source and history](docs/RELEASE.md) — `main` is the release line; recovered kit history and Ops 1.31
- [Deployment](docs/DEPLOYMENT.md) — deploy a pinned `main` revision, verify, then publish the deployment commit
- [Capability and route matrix](docs/CAPABILITIES.md) — authoritative implemented surface
- [Configuration](docs/CONFIGURATION.md) — setup and security guidance
- [API](docs/API.md) — payload and workflow details
- [Examples](docs/EXAMPLES.md) — copy-paste terminal recipes: search, show a file, render it with jq, bat or glow
- [Features](docs/FEATURES.md) — rendering and viewer behavior
- [Trackers](docs/TRACKERS.md) — the structured-forms platform
- [Agent access control](docs/AGENT-ACCESS-CONTROL.md) — current authorization model
- [Publishing](docs/PUBLISHING.md) — immutable artifact contract
- [Annotations](docs/ANNOTATIONS-SPEC.md) — implemented sidecar contract
- [Agent shims](docs/AGENT-SHIM.md) — legacy compatibility executables
- [Contributing](docs/CONTRIBUTING.md)

## License

MIT
