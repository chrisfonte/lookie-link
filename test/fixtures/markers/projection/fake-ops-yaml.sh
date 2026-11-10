#!/bin/sh
# Test double for the guarded YAML CLI (`apply` only).
#   FAKE_LOG          file that receives one line of argv per invocation
#   FAKE_EXIT_DRY     exit code for the dry run (before any check)
#   FAKE_EXIT_LIVE    exit code for --live (before replacing, unless FAKE_LIVE_APPLY=1)
#   FAKE_LIVE_APPLY=1 replace the live file first, then exit with FAKE_EXIT_LIVE
# Without those it checks --expected-sha256 against the live file (exit 4 when stale)
# and, on --live, copies the candidate over the live file.
set -eu
[ "${1:-}" = "apply" ] || { echo "usage" >&2; exit 2; }
live="$2"; cand="$3"; shift 3
expected=""; is_live=0; allow=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expected-sha256) expected="$2"; shift 2 ;;
    --allow-change) allow="$allow $2"; shift 2 ;;
    --live) is_live=1; shift ;;
    *) shift ;;
  esac
done
[ -z "${FAKE_LOG:-}" ] || echo "apply live=$is_live expected=$expected allow=$allow" >> "$FAKE_LOG"
if [ "$is_live" = 0 ] && [ -n "${FAKE_EXIT_DRY:-}" ]; then echo "fake dry-run refusal" >&2; exit "$FAKE_EXIT_DRY"; fi
actual=$(sha256sum "$live" | cut -d' ' -f1)
if [ "$actual" != "$expected" ]; then echo "stale baseline; no replacement" >&2; exit 4; fi
if [ "$is_live" = 0 ]; then echo "dry-run: ok"; exit 0; fi
if [ -n "${FAKE_EXIT_LIVE:-}" ] && [ "${FAKE_LIVE_APPLY:-0}" != 1 ]; then echo "fake live refusal" >&2; exit "$FAKE_EXIT_LIVE"; fi
cp "$cand" "$live"
if [ -n "${FAKE_EXIT_LIVE:-}" ]; then echo "fake live failure after replace" >&2; exit "$FAKE_EXIT_LIVE"; fi
echo "applied: $live"
exit 0
