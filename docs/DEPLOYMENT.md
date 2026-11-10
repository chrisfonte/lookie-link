# Runtime deployment

`main` is the release source. Integrate changes through green, reviewed pull
requests first, then pin the merged SHA. A serving checkout may use an operator's
runtime deployment branch; its deployment commit records the source SHA.
See [release history](RELEASE.md) and [contributor checks](CONTRIBUTING.md#validation).

## Prepare the source and rollback point

The operator's `deploy-runtime.sh` is maintained separately from this repository.
Read the installed script and its current operator guidance before use. The
procedure below describes its existing contract; host, service, configuration,
credentials, checkpoints and approval records belong in the operator's private records.

Use a clean, branch-attached source worktree based on `origin/main`, with installed
dependencies and Playwright Chromium available. Source and serving worktrees must
share the same Git repository: the runner resolves the source branch by name from
the serving checkout. Preserve any divergent local branch and reconcile it before
using it as a release source.

Record the serving branch, full SHA, clean tracked state, process identity and
restart count. Retain a verified pre-change runtime checkpoint off the serving
host, and record the exact rollback command. Declare the observation duration and
success criteria before applying. Keep configuration and mutable stores outside
the code transaction.

## Run the installed script unchanged

Set `SOURCE`, `LIVE`, `UNIT`, `BASE`, and `DEPLOY_RUNTIME` to the operator's verified
source worktree, serving checkout, service, local verification URL, and installed
script path. Then, on the serving host:

```bash
git -C "$SOURCE" fetch origin
git -C "$SOURCE" merge --ff-only origin/main
git -C "$SOURCE" rev-parse HEAD

LOOKIE_FEATURE_DIR="$SOURCE" LOOKIE_LIVE_DIR="$LIVE" \
LOOKIE_UNIT="$UNIT" LOOKIE_BASE_URL="$BASE" \
bash "$DEPLOY_RUNTIME" --check

LOOKIE_FEATURE_DIR="$SOURCE" LOOKIE_LIVE_DIR="$LIVE" \
LOOKIE_UNIT="$UNIT" LOOKIE_BASE_URL="$BASE" \
bash "$DEPLOY_RUNTIME"
```

Both invocations run the source verification gate by default. `--check` stops
before mutation. Apply requires clean tracked source and serving trees, copies
the complete runtime diff, creates a deployment commit, stages/swaps dependencies
when the manifest or lock changes, checks server loading, restarts the named
service, waits for the listener, compares restart counts, and runs named HTTP checks.
Tests and the root changelog are outside its runtime copy set. It prints the
rollback command. Let the runner own its restart.

The script has no push or pause step: it creates the deployment commit and
restarts before the operator can push. After successful independent readback and
the settled observation window, plain-push the serving branch:

```bash
git -C "$LIVE" push origin HEAD
git -C "$LIVE" rev-parse HEAD
```

## Verify and settle

Check the installed runtime footprint against the pinned source, the new process
identity, unchanged restart count, and the runner's named HTTP checks. Record
change-window and settled-window errors separately using before/change-end/settle-end
log cursors. A listening socket alone does not establish release acceptance.

Use the instance URL visible to its callers for HTTP GET readback. For an Ops kit
release, verify the discovered version, guide/template availability and served
file hashes against the source; render an existing document and the kit directory
at desktop and phone widths. Follow the existing [kit version policy](CAPABILITIES.md)
when checking pinned CSS URLs. The route inventory remains authoritative there.

If an apply or required check fails, retain the failed-forward evidence and use
the printed rollback command for that transaction. Verify the restored process
and served bytes. Report the failure before attempting another release.
