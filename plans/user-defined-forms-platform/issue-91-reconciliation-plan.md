# Issue #91 reconciliation proposal

> **Revision 2 changelog (2026-07-19):** adds an early fix-forward baseline-sanitization PR; dispositions the patch-equivalent FON-11792 remote branch; makes all five stash and seven branch-tip archives explicit and GC-safe; rewrites deployed reconciliation as commit-before-switch with per-mutation rollback; hardens the annotation authorization gate; and pins the final test count to an immutable execution-time candidate.

Date: 2026-07-19  
Status: proposal only—none of these mutations has been executed

## Recommended outcome

Reconcile from current GitHub main (`97bfd60` in this evidence snapshot), preserving the deployed state separately before touching it. First land a dedicated fix-forward sanitization PR for private values already committed on main; every later branch starts from that sanitized baseline. Port the deployed work as small, tested commits; do not merge the 44-path working tree as one patch and do not replace `server.js` or `lib/renderer.js` wholesale. Keep `/raw` byte-preserving and move runtime decoration to an explicitly distinct embedded-runtime surface. Close the two stale annotation PRs after recording their diffs, close the patch-equivalent FON-11792 branch as already landed via #76, and re-scope issues #53/#87 using their actual bodies before changing issue state.

Forms work remains blocked until all final checks below pass from a clean clone.

## Non-negotiable safeguards

1. No `reset --hard`, checkout-overwrite, clean, stash apply/pop, or rsync-overwrite of the deployed checkout.
2. No force push. Every public branch starts from the reconciled main and lands through review.
3. No public preservation branch containing the exact dirty tree: it currently includes a private hostname, personal paths/repo names, and local Claude authority configuration.
4. Never commit `.claude/settings.local.json` to a public-bound branch. The sole exception is Step 13's private-only archival snapshot commit, required to preserve the exact dirty tree; that branch and its keep refs must never be pushed.
5. Treat public main as already exposed, not clean: `<private-tailscale-hostname>` is committed at `bin/lookie-read.js:20,53`, `bin/lookie-annotations.js:12,48`, `docs/AGENT-SHIM.md:14`, and `docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md:57`. Remove it by normal fix-forward commits. Git history will still contain the string; record the operator's history-handling decision, but do not rewrite history in this plan.
6. Redact `lib/cli-auth.js:9`, `docs/API.md:73,197`, `docs/ANNOTATIONS-SPEC.md:33`, and `docs/FEATURES.md:189`; also clean the pre-existing private references in dirty `README.md:136`, `docs/FEATURES.md:89-90`, and `docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md:57` while those files are under review. Remove the internal `FON-3671` reference from dirty `README.md:136` (public-main `README.md:99`) and inventory the release-candidate worktree for other internal ticket IDs under the standing publication policy.
7. Remove the runtime filesystem disclosure in `server.js:707-746`: the browser must not receive `os.homedir()`, source-root absolute paths, or the absolute roots of other repositories.
8. Keep credentials in environment/private config. Tests and docs may use obvious placeholders only.

## Ordered reconciliation

### Step 1 — Freeze and preserve the exact before state privately

Before any checkout mutation, create a read-only preservation set outside the public worktree and record SHA-256 checksums for it. Preservation must not depend on `refs/stash` reflog retention or on `git bundle create --all`, because `--all` does not name `stash@{1..4}`.

First create private, never-pushed `refs/keep/issue-91/...` refs in the deployed repository, using `git update-ref <new-ref> <expected-sha> 0000000000000000000000000000000000000000` so a collision stops rather than overwrites. Pin every row below immediately and retain the refs until #91 is closed and both archives are verified:

| Keep ref suffix | Exact commit |
|---|---|
| `stashes/0` | `74abfc98233b4503b1cbae28ddb2db9da31d17f2` |
| `stashes/1` | `45fb71b8dad19c771ae5ea39de694693722a8280` |
| `stashes/2` | `e8e1cd10ea3a234ee4eb0e66f7d23ed9f25125c1` |
| `stashes/3` | `fca2de0271eca19baa581d2b732145687b4f2497` |
| `stashes/4` | `2553ec5e246d4c8f0279b3eecc07b1b950b7e036` |
| `branches/feat-FON-11756-default-pretty-everywhere` | `ac5b9971aff4946153027c93c39fba2d79e73491` |
| `branches/feat-FON-11764-annotations-viewer-ux` | `b20df4af86e4856bcee01233091c956946b8642f` |
| `branches/feat-FON-11764-annotations-viewer-ux-v2` | `e678d1ee289bfa2abca6009a651aa1e7b5ea465c` |
| `branches/feat-editable-mode-staged` | `9296570440bff55e659c8154ea3e264afbb16c6d` |
| `branches/fix-csv-asset-mime-allowlist` | `b460e5e5e86e9aec44585d9ffb190f8ff41b37c7` |
| `branches/fon-11765-annotations-cli` | `4ec1dce0c7624ab23429cd6f0a70e44cc492947b` |
| `branches/main` | `ac5b9971aff4946153027c93c39fba2d79e73491` |

Create the bundle by naming all twelve keep refs explicitly (seven branch refs and five stash refs), not with `--all`:

```sh
issue91_bundle=/private/path/outside-worktree/issue-91-preservation.bundle
git bundle create "$issue91_bundle" \
  refs/keep/issue-91/stashes/0 \
  refs/keep/issue-91/stashes/1 \
  refs/keep/issue-91/stashes/2 \
  refs/keep/issue-91/stashes/3 \
  refs/keep/issue-91/stashes/4 \
  refs/keep/issue-91/branches/feat-FON-11756-default-pretty-everywhere \
  refs/keep/issue-91/branches/feat-FON-11764-annotations-viewer-ux \
  refs/keep/issue-91/branches/feat-FON-11764-annotations-viewer-ux-v2 \
  refs/keep/issue-91/branches/feat-editable-mode-staged \
  refs/keep/issue-91/branches/fix-csv-asset-mime-allowlist \
  refs/keep/issue-91/branches/fon-11765-annotations-cli \
  refs/keep/issue-91/branches/main
git bundle verify "$issue91_bundle"
```

Import the bundle into a private bare archive with the keep-ref names preserved, verify each imported ref against the table, and make the second checksum-verified copy from that archive. These real refs pin every reachable commit/tree/blob against GC in both the live repository and private archive; do not substitute lightweight patch files for the object archive.

For each of the five stash rows separately, verify all of the following and record the output beside its full SHA:

1. the deployed keep ref and archive keep ref both resolve exactly to the listed SHA;
2. `git cat-file -e <sha>^{commit}` succeeds in both repositories;
3. `git rev-list --count <sha>` and the SHA-256 of sorted `git rev-list --objects <sha>` output match between source and archive, which traverses all stash parents including any untracked-file parent;
4. `git stash show --include-untracked --stat -p stash@{n}` has a separately checksummed patch export; and
5. `git fsck --full` succeeds in the private bare archive.

Run these archive-object checks independently, one command per stash, after setting `issue91_archive` to the validated private bare archive path; any nonzero result blocks reconciliation:

```sh
issue91_archive=/private/path/to/issue-91.git
test "$(git -C "$issue91_archive" rev-parse refs/keep/issue-91/stashes/0)" = 74abfc98233b4503b1cbae28ddb2db9da31d17f2 && git -C "$issue91_archive" cat-file -e '74abfc98233b4503b1cbae28ddb2db9da31d17f2^{commit}' && git -C "$issue91_archive" rev-list --objects 74abfc98233b4503b1cbae28ddb2db9da31d17f2 >/dev/null
test "$(git -C "$issue91_archive" rev-parse refs/keep/issue-91/stashes/1)" = 45fb71b8dad19c771ae5ea39de694693722a8280 && git -C "$issue91_archive" cat-file -e '45fb71b8dad19c771ae5ea39de694693722a8280^{commit}' && git -C "$issue91_archive" rev-list --objects 45fb71b8dad19c771ae5ea39de694693722a8280 >/dev/null
test "$(git -C "$issue91_archive" rev-parse refs/keep/issue-91/stashes/2)" = e8e1cd10ea3a234ee4eb0e66f7d23ed9f25125c1 && git -C "$issue91_archive" cat-file -e 'e8e1cd10ea3a234ee4eb0e66f7d23ed9f25125c1^{commit}' && git -C "$issue91_archive" rev-list --objects e8e1cd10ea3a234ee4eb0e66f7d23ed9f25125c1 >/dev/null
test "$(git -C "$issue91_archive" rev-parse refs/keep/issue-91/stashes/3)" = fca2de0271eca19baa581d2b732145687b4f2497 && git -C "$issue91_archive" cat-file -e 'fca2de0271eca19baa581d2b732145687b4f2497^{commit}' && git -C "$issue91_archive" rev-list --objects fca2de0271eca19baa581d2b732145687b4f2497 >/dev/null
test "$(git -C "$issue91_archive" rev-parse refs/keep/issue-91/stashes/4)" = 2553ec5e246d4c8f0279b3eecc07b1b950b7e036 && git -C "$issue91_archive" cat-file -e '2553ec5e246d4c8f0279b3eecc07b1b950b7e036^{commit}' && git -C "$issue91_archive" rev-list --objects 2553ec5e246d4c8f0279b3eecc07b1b950b7e036 >/dev/null
```

Also preserve:

- deployed HEAD, full ref list, branch/upstream table, reflog pointers, and `git status --porcelain=v2 --untracked-files=all`;
- `git diff --binary` for tracked/index state;
- an archive of all 20 untracked files with modes and relative paths;
- `git stash list` plus `git stash show --include-untracked --stat -p` for all five stash refs;
- the explicit-ref Git bundle and private bare archive above;
- the inventory in `out/inventory-91.md`.

Store two checksum-verified copies, at least one outside the deployed machine. The preservation location must be private because the exact snapshot contains machine-specific values. If any pin, bundle, import, per-stash verification, or checksum fails, stop and leave all successfully created keep refs/archives in place for diagnosis. Do not call this step complete until a throwaway restore reproduces the 44-path status, all seven branch tips, and all five full stash SHAs above.

### Step 2 — Create a clean reconciliation base

In a new worktree/clone, start a normal branch from fetched `origin/main` (`97bfd60` for this snapshot; re-verify before execution). This automatically includes `4ec1dce`/PR #74 (`bin/lookie-annotations.js`), which the deployed filesystem currently lacks. Keep the evidence checkout untouched.

Record the base command results before porting anything. If remote main has advanced, update the inventory with the new base and review the intervening commits; do not assume the July 19 snapshot is still current.

### Step 2A — Land a dedicated baseline-sanitization PR first

Before any feature port, open a small fix-forward PR from the then-current public main and make every later reconciliation branch start from its merge commit. At the evidence SHA, the exact private hostname is already committed at:

- `bin/lookie-read.js:20,53`;
- `bin/lookie-annotations.js:12,48`;
- `docs/AGENT-SHIM.md:14`; and
- `docs/NOTEBOOKLM-ARTIFACT-COVERAGE.md:57`.

Replace both CLI defaults/help text with an explicit `LOOKIE_LINK_BASE_URL`/stored configuration requirement, or a loopback-only default such as `http://127.0.0.1:9876`; use only neutral hosts in docs and tests. In the same sanitization workstream, remove the personal `~/operations/...` link and `FON-3671` wording already on main at `README.md:99`, inventory all tracked `FON-[0-9]+` occurrences under the standing no-internal-ticket-ID policy, and redact or replace personal paths/repository names with public examples. Keep the urgent hostname fix as its own commit if the broader ticket-ID sweep needs separate review; it must not wait for later feature ports.

Gate the PR on a tracked-worktree scan at its candidate SHA for the exact hostname plus `<deployed-home>`, `~/operations`, `operations-chris-fonte`, and prohibited internal ticket IDs; also run the affected CLI tests. Record a separate history report using `git log -S`/secret-scanner history mode. The fix-forward PR does **not** remove the old strings from existing commits. The operator must record whether the historical exposure is accepted, separately remediated, or requires a coordinated history rewrite. This plan neither rewrites history nor makes a history-clean scan an acceptance condition.

### Step 3 — Preserve the only genuinely local commit branch

Handle `fix/csv-asset-mime-allowlist` before deleting any branch:

- Archive both unique commits: `5d92957` and `b460e5e`.
- Main already serves CSV, so do not merge the branch as-is.
- Transplant `test/asset-mime.test.js` and any still-useful API wording from `b460e5e` into a fresh main-based regression commit, after checking it is not redundant with current tests.
- Review `5d92957` separately; keep its annotation-spec cross-link only if the target is public and still authoritative. Otherwise retain it only in the private archive.
- Push only the sanitized, rebased regression branch and open a small PR. Never force-push the old branch name.

### Step 4 — Port annotation evolution as one focused PR

Start from main's already-shipped annotation baseline (`f03e7d0` plus the `e678d1e` blobs bundled in `b53df20`). Selectively port:

- `lib/annotations.js`, `public/annotations.js`, and annotation-specific hunks of `public/style.css`, `lib/renderer.js`, and `server.js`;
- `test/annotations-client.test.js`, `test/annotations-server.test.js`, and the annotation-specific `scripts/validate-editable-mode.js` additions;
- the matching, sanitized parts of `docs/ANNOTATIONS-SPEC.md`, `docs/API.md`, `docs/CONFIGURATION.md`, and `docs/FEATURES.md`.

Commit sequence inside the PR:

1. redaction operation and audit-preserving storage tests;
2. toolbar mode/count, collapsed/resolved/stale client behavior and JSDOM tests;
3. line-range and authored-HTML target behavior;
4. raw/embedded HTML integration only after Step 7 establishes the route contract.

Resolve the authorization question explicitly: current main and dirty code allow annotation mutation with `view`. This is a hard PR gate, not an advisory: the PR must not merge until an approved annotate/write capability is enforced (or an explicitly documented operator decision preserves `view` after security review) and negative tests prove a view-only principal cannot create, patch, redact, resolve, or delete annotations. Do not silently preserve the broader permission merely to minimize diff.

### Step 5 — Port media and portable-link rendering in narrow PRs

The +1,206/-55 renderer patch and +2,110/-130 server patch are too mixed for one review. Split them by observable behavior:

1. **Video PR:** video MIME allowlist, dedicated/inline renderer, fixture media, and route tests.
2. **Portable-link PR:** repo-relative and wiki resolution plus ambiguity behavior, with no host absolute paths sent to clients.
3. **HTML bundle validation PR:** `GET /view/...html?validate=1` response contract and access-controlled asset/document reference tests.
4. **Embedded runtime PR:** Step 7's raw-vs-runtime split, iframe theme/navigation/anchor behavior, and its validators.

Each PR must carry its own tests and docs. Apply hunks to main's current `server.js`/`lib/renderer.js`; never copy either dirty file over main.

### Step 6 — Port identity and write/publish permission foundations

Create a focused auth PR from these sources: `lib/access-control.js`, `lib/api-key-store.js`, API-key/grant/config hunks in `lib/config.js`, `lib/grant-store.js`, `server.js`, `test/access-control.test.js`, and `lookie-link.yaml.example`.

Reviewable commits:

1. normalize legacy `edit` to `write` with backward-compatibility tests;
2. introduce `publish` capability without enabling a publish endpoint;
3. add API-key storage, one-time secret return, hashing, constant-time comparison, rotation/revocation, and audit tests;
4. add richer grant issuer/subject/allow-root policy only where acceptance criteria exist.

Threat-model header versus query tokens, secret-at-rest file permissions, key-ID enumeration, audit redaction, and token collision/fallback ordering. Coordinate with #53 rather than creating a forms-only identity model.

### Step 7 — Repair the raw-HTML contract

**FON-11792 branch disposition before redesign:** `origin/feat/FON-11792-raw-html` points to `ae0f792cd05a4a630f87d069c8582fef647a5817`. It is graph-unmerged (`origin/main...ae0f792` is 4 behind / 1 ahead), but it and main's `38c8d441a7bbfb4906ed55207832e75ea964bb18` share parent `6bc56e9`, have identical stable patch ID `800c5a13377e874ac8cd9cf68b87f70fb18f5a6e`, and resolve to the same tree `434cc8cb97b90999e8777a764c793b4b0fbb7965`. The feature therefore already landed as PR #76 under a different commit identity. Do not merge, cherry-pick, or re-port `ae0f792`; record it as already landed and close/delete the stale remote branch normally after verifying its live PR head. The `/embed` work below is a reviewed follow-on redesign of the `38c8d44` contract, not a competing implementation of the remote branch.

**Observed mismatch:** `scripts/validate-raw-html.js:7` and `:83-88` define `/raw` as verbatim and assert `enabledResp.body === FLASHCARDS_HTML`. The dirty route's own comment at `server.js:3325-3328` still says “verbatim,” but `server.js:3422-3432` reads UTF-8, optionally calls `decorateRawHtmlForInlineAnnotations()` (`lib/renderer.js:1331-1360`), always calls `injectRawHtmlBaseAndTheme()` (`server.js:707-1023`), and sends the transformed string. The two contracts cannot both be true. The current sandbox failed earlier at socket bind, but static control flow guarantees the equality assertion will fail in a normal environment when injection changes the body.

**Recommended fix:** retain `/raw/:repo/*` as the byte-preserving source/runtime endpoint promised by `38c8d44` and its validator, ideally using `sendFile`/buffer semantics so encoding is not normalized. Introduce a clearly named opt-in transformed route such as `/embed/:repo/*` (or an explicit negotiated mode) for base/theme/navigation/annotation injection, and have the framed `/view` page use that route. Do not redefine an endpoint called “raw” to mean transformed HTML.

The embedded route contract must:

- declare that it transforms authored markup;
- preserve the original inline scripts needed by trusted artifacts without claiming byte identity;
- use opaque repo-relative URLs or a server-side resolution endpoint, never serialize home/root paths;
- avoid putting bearer credentials in generated HTML and minimize query-token propagation;
- keep access checks identical to view/asset scope;
- distinguish annotations enabled/disabled in tests;
- add CSP/sandbox/origin regression coverage consistent with issue #106 and forms guardrail F-7.

Update `scripts/validate-raw-html.js` so one section proves `/raw` exact bytes and a separate section proves `/embed` injections. Move the existing injection expectation from `test/access-control.test.js:414` to the embedded route. Cover full HTML, fragments, `<head>` absence, local assets, same/cross-repo links, fragments, wiki ambiguity, theme updates, annotation mounts, binary/invalid UTF-8 rejection or preservation, and private-path non-disclosure.

### Step 8 — Port managed repositories, then search

After Step 6 lands, create two PRs:

1. **Managed repo registry/CRUD:** `lib/managed-repo-store.js`, related `server.js`/config/example/docs hunks, and the CRUD/concurrency/soft-delete portion of `test/managed-repos.test.js`.
2. **Scoped search/suggest:** search route hunks plus search-specific tests and docs.

Require realpath-based allow-root checks, safe creation beneath a real parent, symlink-ancestor escape tests, atomic writes, mtime conflicts, non-leaking 404/403 behavior, bounded tree/search work, and recoverable soft deletion. This is especially important because plan finding F-14 says the existing create-path primitive is insufficient.

### Step 9 — Port publishing separately

After `publish` authorization exists, port `lib/publish-store.js`, publish-specific server/config/access hunks, `test/publish.test.js`, and sanitized `docs/PUBLISHING.md`/API/config docs.

Split storage/service from HTTP routes if necessary. Test slug/path traversal, symlink ancestors, immutable revision behavior, atomicity across multi-file revisions, partial failure recovery, stale `expectedRevision`, revocation, historical access, auth, audit, maximum sizes/counts, and private metadata. Reconcile “immutable” wording with the fact that a slug gains new revisions. Do not let published metadata imply access to its source repo.

### Step 10 — Add discovery only after capability names stabilize

Port `lib/agent-discovery.js`, discovery server routes, and `test/agent-discovery.test.js` after managed repos/search/publish/API keys have landed. Discovery must derive features from actual enabled stores/config, filter repo/path scope, and avoid revealing disabled/private capabilities or root paths. Add a matrix test comparing `/.well-known/agent.json`, `/api/whoami`, route availability, and docs.

### Step 11 — Port the unified CLI and generated skills

Create two PRs:

1. **Unified CLI:** `bin/lookie.js`, a sanitized `lib/cli-auth.js`, `test/cli-smoke.test.js`, `package.json`, regenerated `package-lock.json`, and CLI docs. Remove the private default hostname; require `--instance`, stored config, or `LOOKIE_LINK_BASE_URL`, with localhost only if a default is essential. Preserve the already-main `lookie-annotations` and `lookie-read` compatibility bins.
2. **Generated packages:** `scripts/generate-skill-packages.js`, `docs/SKILL-SPEC.md`, four generated outputs, and `test/skill-packages.test.js`. Confirm the schemas match the actual target runtimes before committing generated artifacts. Keep generation deterministic and use `--check` in CI.

The CLI PR must test token-stdin/no-echo handling, 0600 auth storage, header preference, no token in logs/errors/URLs, conflict exit codes, and capability fallback. Generated docs must not promise unimplemented `share` commands; the current spec mentions sharing while the dirty capability summary reports `share: false`.

### Step 12 — Land authoritative docs and capability matrix

Update `CLAUDE.md`, `CHANGELOG.md`, `README.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/FEATURES.md`, `docs/AGENT-ACCESS-CONTROL.md`, `docs/CONTRIBUTING.md`, publishing/annotation/skill docs, and the NotebookLM docs to describe only merged behavior. Add one generated or test-checked route/capability matrix and link all other docs to it rather than maintaining divergent lists.

Do not land a giant docs-only claim ahead of code. Each feature PR owns its relevant docs; this final PR removes drift, redacts private values, and records the reconciled SHAs and passing checks.

### Step 13 — Reconcile the deployed checkout without overwrite

Run this only after every reviewable PR is merged, the Step 1 throwaway restore is proven, and the exact reconciled target SHA is recorded. The dirty tree must become an ordinary commit on a private-only archival branch **before the first switch to another commit/branch**. The archival commit intentionally contains all 44 dirty paths, including `.claude/settings.local.json` and private values, so neither its branch nor its keep refs may ever be pushed.

Use the following ordered mechanism. Each mutating substep has an explicit rollback; on any failed precondition, stop without advancing to the next substep.

1. **Stop the service through the operator runbook.** Record the running commit/config first. Rollback: if no repository mutation has occurred, restart that same commit/config through the runbook.
2. **Take and checksum the final private snapshot.** Compare its 44-path status, binary diff, untracked archive, refs, and stash SHAs with Step 1. This is additive; rollback is to retain the snapshot and stop. Never delete an earlier snapshot because the comparison differs.
3. **Rename the currently checked-out dirty branch to a collision-free private archival name without switching commits**, for example with `git branch -m private/archive/issue-91-<timestamp>`. Confirm the archive name does not exist and the original tip is already pinned by Step 1. `branch -m` changes the ref name/HEAD symref but does not replace working-tree or index content. Rollback before commit: rename it back to the recorded original branch name.
4. **Stage the entire snapshot on that archival branch with `git add -A`.** Compare `git diff --cached --binary`, the staged path list, and untracked-to-staged file modes against the final manifest; all 44 dirty paths, including the local Claude file, must be represented. Rollback before commit: `git restore --staged -- :/`, which leaves working-tree files untouched, then rename the branch back if abandoning the operation.
5. **Commit the staged snapshot on the private archival branch** with an archival message that references the checksum manifest, then verify `git status --porcelain=v2 --untracked-files=all` is empty and the committed tree reproduces the manifest. This commit is the required commit-before-switch point. Rollback after commit: do not amend, reset, or delete it; keep/deploy that archival commit as the known-good old state and stop. If the commit command itself fails, use the Step 4 rollback while the dirty files are still present.
6. **Pin local `main`'s pre-update SHA** at a new private `refs/keep/issue-91/pre-ff-main` ref using compare-and-swap `git update-ref`, then perform the first branch switch with plain `git switch main`. The clean-tree check from Step 5 is a hard precondition. Rollback: plain `git switch private/archive/issue-91-<timestamp>`; retain the pre-FF ref.
7. **Fast-forward local `main` only** to the recorded reconciled target using `git merge --ff-only <target-sha>`, and verify the resulting SHA exactly. Rollback: switch back to the private archival branch, then restore `refs/heads/main` to `refs/keep/issue-91/pre-ff-main` with compare-and-swap `git update-ref <main-ref> <old-sha> <new-sha>`. This changes only the inactive ref and does not overwrite the archival working tree.
8. **Create a new deployment branch at the reconciled SHA with a normal `git switch -c`**, or plain-switch an existing deployment branch only after proving it already equals that SHA. Verify a clean status. Rollback: plain-switch to the private archival branch; retain the unused deployment ref for diagnosis rather than deleting or rewriting it.
9. **Restore private deployment configuration atomically from its private source outside the public worktree.** Do not copy `.claude/settings.local.json` or any archived private value into a public-tracked path. Rollback: atomically restore the checksummed pre-change private configuration while remaining on the archival branch.
10. **Run the pinned test/validator set and smoke test, then restart through the runbook.** Compare before/after capability matrices and retain both in #91. Rollback on a failed check or restart: stop the new service, plain-switch to the private archival branch, restore the prior private config, verify the archival commit, and restart the old version through the runbook.

There is no `checkout -f`, stash command, `clean`, reset, rsync-overwrite, or force push anywhere in this sequence. Plain `git switch` is permitted only after Step 5 proves the archival commit exists and the worktree is clean.

## Stash disposition

First archive every stash patch and object in Step 1. **Apply none of them directly**: each is based on an old commit, all overlap current/main, several are incomplete, and none matches the current dirty blobs.

| Stash | Proposal | Justification |
|---|---|---|
| `stash@{0}` (`74abfc9`) | Archive, do not apply; drop only after restore verification and all relevant annotation/CSV tests land. | Misnamed “harness churn”; mixes an older untracked annotation module with incomplete CSV scaffolding. Both capabilities have newer implementations. |
| `stash@{1}` (`45fb71b`) | Archive, do not apply; drop after annotation transport provenance is recorded. | Annotation routes/config are already on main via `f03e7d0`; standalone stash lacks its required annotation module. |
| `stash@{2}` (`e8e1cd1`) | Archive, do not apply; drop after CSV regression disposition. | Old CSV WIP; main has the capability, and the stash is not a complete modern patch. |
| `stash@{3}` (`fca2de0`) | Archive, do not apply; drop after annotation config is verified. | Single superseded annotations-flag change already represented on main. |
| `stash@{4}` (`2553ec5`) | Archive, do not apply; drop last, only after exact restore and annotation/nested-YAML verification. | Large mixed rescue snapshot. Four blobs are already exactly on main and the rest have evolved; applying it would reintroduce old mixed state. |

“Drop” here means a normal stash deletion after two verified archives and merged replacement commits—not before. Record the old stash commit SHA beside each replacement PR.

## Local and relevant remote branch disposition

| Branch | Proposal |
|---|---|
| `feat/FON-11756-default-pretty-everywhere` | Do not push the dirty branch publicly. Preserve exact WIP privately, port it through the PR sequence, then delete the local branch after deployed reconciliation. Its tip `ac5b997` is already on main. |
| `feat/FON-11764-annotations-viewer-ux-v2` | No new push. Close its annotation PR as already landed/superseded, then delete local and remote feature refs normally after recording `e678d1e`; its five changed blobs are exactly in `b53df20`. |
| `feat/FON-11764-annotations-viewer-ux` | No new push. Close its alternate annotation PR as superseded, retain `b20df4a` in the private bundle, then delete local and remote refs normally after review. |
| `feat/editable-mode-staged` | Delete local after archival; `9296570` is already an ancestor of main. No PR/push. |
| `fix/csv-asset-mime-allowlist` | Preserve both commits, then push a new sanitized main-based regression branch/PR for only the still-useful test/docs. Delete the old local branch after that PR and archive are verified. |
| `fon-11765-annotations-cli` | Delete local after fast-forward; `4ec1dce` is in main via #74. No PR/push. |
| `main` | Fast-forward normally after preservation. Never force-push. |
| `origin/feat/FON-11792-raw-html` (`ae0f792`) | Do not merge or port. Its patch/tree are exactly represented by `38c8d44` on main (#76), despite graph-distinct commit identity. Verify the actual PR head, record patch/tree equivalence, close it as already landed, and delete the stale remote branch normally. Step 7 is a follow-on `/raw`/`/embed` redesign from main. |

## PR #72/#75/#76 and issue #53/#87 recommendations

The exact PR-number-to-branch mapping is not present locally, so verify the PR heads/bodies before acting. The evidence supports the following disposition regardless of which number maps to which annotation branch:

- The PR whose head is `e678d1e` should be **closed as already landed/superseded**, with a comment that all five changed blobs are exactly present in `b53df20` (#71) and later dirty work supersedes them.
- The PR whose head is `b20df4a` should be **closed as superseded**, not merged. It is an alternate larger annotation client/style implementation; archive its diff and link the new focused annotation PR.
- If #72/#75 point elsewhere, stop and use their actual heads rather than relying on this inference.
- **#76 / FON-11792:** main commit `38c8d44` carries `(#76)` and is patch/tree-equivalent to remote head `ae0f792`. Verify #76's actual head/body before mutation; if confirmed, record the branch as already landed and close/delete any still-open PR/ref normally. Do not cite graph ancestry alone as proof, and do not cherry-pick `ae0f792`. Link the separate Step 7 follow-on redesign so the shipped byte-preserving `/raw` contract is not silently orphaned.

For issues:

- **#53 — agent-scoped access control:** recommend **re-scope**, not immediate closure. Main demonstrably ships phase-1 path-scoped tokens and grants, while dirty work adds API keys, normalized capabilities, issuer/subject semantics, and discovery. Rewrite #53 around the remaining shared principal/capability/ownership contract (including forms compatibility), or close it only if its actual body was limited to the already-shipped phase-1 behavior and create a successor issue for the remainder. The issue body is absent here, so that check is mandatory.
- **#87 — raw iframe anchor behavior:** recommend **re-scope to the explicit embedded-runtime contract and tests in Step 7**, then close after that PR lands. The dirty implementation has anchor/theme/navigation behavior, but it is not on main, its raw validator contract is contradictory, and current tests could not run here. If the actual #87 body is fully satisfied by a different shipped change, close it with the exact commit/test evidence instead.

## Verification checklist mapped to #91 acceptance criteria

### No deployed work is lost; before/after inventory retained

- [ ] `out/inventory-91.md`, exact tracked patch, untracked archive, refs, all five stash patches/objects, and SHA-256 manifest exist in two private locations.
- [ ] `git bundle verify`, archive `git fsck --full`, and the per-stash ref/object/count/hash checks in Step 1 pass; a throwaway restore reproduces 44 dirty paths, all seven local branch tips, and full stash SHAs `74abfc98233b4503b1cbae28ddb2db9da31d17f2`, `45fb71b8dad19c771ae5ea39de694693722a8280`, `e8e1cd10ea3a234ee4eb0e66f7d23ed9f25125c1`, `fca2de0271eca19baa581d2b732145687b4f2497`, and `2553ec5e246d4c8f0279b3eecc07b1b950b7e036`.
- [ ] Every dirty path maps to a merged PR, an explicitly rejected/private archive item, or local-only churn disposition.
- [ ] Before and after route/capability matrices are attached to #91.

### GitHub and deployed checkout share a reconciled baseline

- [ ] The Step 2A fix-forward sanitization PR is merged first, and every public reconciliation PR is based on a descendant of that sanitized merge commit.
- [ ] All accepted feature PRs are merged through normal non-force review.
- [ ] Local deployed `main`, public `origin/main`, and the deployed runtime commit resolve to the same reconciled SHA.
- [ ] `git status --short` is clean except documented private deployment config outside the public repository.
- [ ] No wholesale overwrite, force push, stash apply/pop, or destructive reset was used.

### Tests and validators pass

- [ ] At execution time, pin one immutable release-candidate commit SHA and record its discovered test manifest plus expected total **N** in the #91 evidence before the acceptance run. On that exact SHA, `npm test` executes and passes all **N** tests in an environment with dependencies and loopback sockets; every ported PR's own suite and required CI checks are green. If the candidate SHA or test manifest changes, record a new N and rerun—do not compare against the moving pre-reconciliation count of 27.
- [ ] `npm run validate:editable` passes.
- [ ] `npm run validate:raw-html` passes the byte-preserving `/raw` contract.
- [ ] The new embedded-runtime validator passes transformation, auth, path non-disclosure, theme/navigation/anchor, and annotation cases.
- [ ] Every new workstream PR adds its own positive and negative tests; CI runs tests and both validators.
- [ ] The annotation PR's authorization gate passes: view-only principals cannot perform any annotation mutation unless an explicit security-reviewed exception is recorded.

### Docs, issue states, and discovery match implementation

- [ ] `CLAUDE.md`, `CHANGELOG.md`, README, API/config/feature/access docs, publishing/annotation/skill docs, and one authoritative capability matrix agree with route inspection.
- [ ] `/.well-known/agent.json`, `/api/whoami`, `/api/repos`, enabled configuration, and the authoritative matrix agree under unrestricted, scoped, invalid, and unauthenticated callers.
- [ ] PRs #72/#75/#76, `origin/feat/FON-11792-raw-html`, and issues #53/#87 have evidence-linked final dispositions after their actual metadata is read.
- [ ] Forms issues remain blocked until #91 closes.

### Clean clone reproduces the baseline

- [ ] Fresh clone from reconciled main, followed by the documented dependency install, passes `npm test`, `validate:editable`, and `validate:raw-html` on Node 22.
- [ ] Generated skill packages pass `--check`/sync tests.
- [ ] No test relies on the deployed machine's hostname, home path, existing config stores, or private repo roots.
- [ ] A tracked-file scan of the exact release-candidate worktree/commit finds no credentials, `<private-tailscale-hostname>`, personal deployment paths/repo names, local Claude settings, prohibited internal ticket IDs, or client-visible absolute root serialization. Scan command/version, patterns, exclusions, candidate SHA, and results are attached to #91.
- [ ] A separate full-history scan/report records the known hostname-bearing commits and any other findings, and the operator's accept/remediate/rewrite decision is attached to #91. This plan does not claim that fix-forward commits make existing Git history clean and does not execute a history rewrite.

Only after every checkbox is satisfied should #91 close and forms implementation unblock.
