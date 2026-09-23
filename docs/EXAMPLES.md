# Examples: the API from a terminal

Copy-paste recipes for a person at a shell. Every example assumes an instance at
`http://127.0.0.1:9876`; substitute your host. Nothing here needs a token on an
open instance; on a restricted one add `-H "Authorization: Bearer $LOOKIE_TOKEN"`.
`jq` is the only requirement. Two optional viewers make output pleasant:
[`bat`](https://github.com/sharkdp/bat) (syntax colours; the binary is `batcat`
on Debian and Ubuntu) and [`glow`](https://github.com/charmbracelet/glow)
(renders markdown in the terminal).

The full route list is [CAPABILITIES.md](CAPABILITIES.md); payload details are in
[API.md](API.md).

## Search

Every whitespace-separated word must occur in the file (any order) or in its
path. Double quotes make a phrase. Matching is literal and case-insensitive.

```bash
# Two words, either order gives the same files
curl -s 'http://127.0.0.1:9876/api/search?q=appearance+overlay&limit=3' | jq '{count, totalMatches, terms, top: .results[0].path}'
curl -s 'http://127.0.0.1:9876/api/search?q=overlay+appearance&limit=3' | jq '{count, totalMatches, terms, top: .results[0].path}'

# A phrase (ordered); the reversed phrase returns zero
curl -s 'http://127.0.0.1:9876/api/search?q="rendered+body"&limit=5' | jq '{terms, totalMatches, snippet: .results[0].snippet}'
curl -s 'http://127.0.0.1:9876/api/search?q="body+rendered"' | jq '.totalMatches'

# Limit to one repo, and see which backend ran
curl -s 'http://127.0.0.1:9876/api/search?q=wallpaper&scope=<repo>&limit=5' | jq '{backend, reposSearched, totalMatches}'

# Mistakes are refused with a named error, never an empty result
curl -s 'http://127.0.0.1:9876/api/search?q=wallpaper&scope=no-such-repo' | jq .error
curl -s 'http://127.0.0.1:9876/api/search?q=wallpaper&limit=0' | jq .error
curl -s 'http://127.0.0.1:9876/api/search?q=wallpaper&repos=x' | jq .error

# Path suggestions for autocomplete
curl -s 'http://127.0.0.1:9876/api/search/suggest?q=roadm' | jq '.suggestions[:5]'
```

Every result carries `viewUrl` (the browser page) and `rawUrl` (the bytes).

## Show a document in the terminal

```bash
# Print the top hit of a search
curl -s "http://127.0.0.1:9876$(curl -s 'http://127.0.0.1:9876/api/search?q=wallpaper+blur+opacity&limit=1' | jq -r '.results[0].rawUrl')" | head -40

# Pick the first YAML file among the hits
curl -s "http://127.0.0.1:9876$(curl -s 'http://127.0.0.1:9876/api/search?q=panel_opacity&limit=5' | jq -r '[.results[] | select(.path | endswith(".yaml"))][0].rawUrl')" | head -40

# A file you already know
curl -s 'http://127.0.0.1:9876/asset/<repo>/<path/to/file.md>'
```

If no hit has the extension you filtered on, the inner `jq` prints `null` and
the outer request is a 404; raise the limit or pick a term that lives in that
file type.

## Make it readable

```bash
# YAML or JSON with syntax colours and line numbers (q to leave the pager)
curl -s 'http://127.0.0.1:9876/asset/<repo>/config.yaml' | batcat -l yaml
curl -s 'http://127.0.0.1:9876/api/search?q=overlay+appearance&limit=2' | jq . | batcat -l json

# Markdown rendered as a page
curl -s 'http://127.0.0.1:9876/asset/<repo>/README.md' | glow -p -

# No extra tools: scroll and search with less
curl -s 'http://127.0.0.1:9876/asset/<repo>/README.md' | less
```

## Publish a page

Publishing creates immutable revisions under a slug and serves them at
`/view/published/<slug>/<path>` and `/asset/published/<slug>/<path>`; it does
not need a managed repository. Files may be markdown, HTML, images or any
text; relative links and images inside a bundle resolve to the bundle.

```bash
# Create (revision 1)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"slug":"my-page","entryPath":"index.md","files":[{"path":"index.md","content":"# Hello\n\nPublished through the API.\n"}]}' \
  http://127.0.0.1:9876/api/publish | jq '{ok, slug, revision, viewUrl: .publication.viewUrl}'

# Read it back (raw), and open /view/published/my-page/index.md in a browser
curl -s http://127.0.0.1:9876/asset/published/my-page/index.md

# Next revision: expectedRevision must match, or the answer is 409 revision_conflict
curl -s -X POST -H 'content-type: application/json' \
  -d '{"expectedRevision":1,"entryPath":"index.md","files":[{"path":"index.md","content":"# Hello again\n"}]}' \
  http://127.0.0.1:9876/api/publish/my-page | jq '{ok, revision, error}'

# Earlier revisions stay readable
curl -s 'http://127.0.0.1:9876/asset/published/my-page/index.md?version=1'

# What is published, and one record with its history (poll the list with If-None-Match)
curl -s 'http://127.0.0.1:9876/api/publish?state=active' | jq '{count, revision, slugs: [.publications[].slug]}'
curl -s http://127.0.0.1:9876/api/publish/my-page | jq '{state: .publication.state, currentRevision: .publication.currentRevision, revisions: [.publication.revisions[].revision]}'

# Revoke: /view and /asset answer 410 afterwards; the record stays readable
curl -s -X POST -H 'content-type: application/json' -d '{"reason":"done"}' \
  http://127.0.0.1:9876/api/publish/my-page/revoke | jq .
```

An HTML bundle works the same way with `"entryPath":"index.html"`; a linked
`style.css` or image in the bundle resolves relative to the bundle. Always
keep `error` in your jq filter: a filter like `{ok, revision}` turns a 409
into a bare `ok: false` with no reason.

The CLI: `lookie publish <file> --slug my-page`, `lookie publish --manifest FILE`,
`lookie publish list [--state active|revoked]`, `lookie publish show <slug> [--version N]`,
`lookie publish revoke <slug> --reason TEXT`.

## Browse and poll

```bash
# What can this caller do, and where are the routes
curl -s http://127.0.0.1:9876/.well-known/agent.json | jq '{capabilities, openapi: .discovery.openapiUrl}'

# Repos, a folder, and what changed in the last hour
curl -s http://127.0.0.1:9876/api/repos | jq '.repos[].id'
curl -s 'http://127.0.0.1:9876/api/repos/<repo>/tree?path=docs' | jq '.entries[] | .path'
curl -s "http://127.0.0.1:9876/api/repos/<repo>/changes?since=$(date -u -d '1 hour ago' +%FT%TZ)" | jq '.entries[] | .path'

# Appearance: poll cheaply with the ETag
curl -s -D - -o /dev/null http://127.0.0.1:9876/api/appearance | grep -i etag
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "<etag>"' http://127.0.0.1:9876/api/appearance   # 304 when unchanged
```

## The same from the bundled CLI

```bash
lookie search "overlay appearance" --limit 3
lookie search '"rendered body"' --scope <repo>
lookie search suggest roadm
lookie read <repo>/<path/to/file.md>
lookie tree <repo> --path docs
lookie changes <repo> --since "$(date -u -d '1 hour ago' +%FT%TZ)"
```

## Check a running instance

```bash
npm run search:battery -- http://127.0.0.1:9876
```

Runs the queries a person types without reading the docs and exits non-zero
when the instance answers one badly.
