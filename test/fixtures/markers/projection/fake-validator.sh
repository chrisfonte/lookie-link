#!/bin/sh
# Test double for a record validator: fake-validator.sh <candidate> <root>
#   FAKE_VALIDATOR_EXIT    exit code (default 0)
#   FAKE_VALIDATOR_LOG     file that receives one line per call
#   FAKE_VALIDATOR_FILES=1 also require every `record_path:` named in the candidate to exist under <root>
set -eu
cand="$1"; root="$2"
[ -z "${FAKE_VALIDATOR_LOG:-}" ] || echo "validate $(basename "$cand") root=$([ -d "$root" ] && echo yes || echo no)" >> "$FAKE_VALIDATOR_LOG"
if [ "${FAKE_VALIDATOR_FILES:-0}" = 1 ]; then
  for p in $(sed -n 's/^ *\(- \)\{0,1\}record_path: *//p' "$cand" | tr -d '"'); do
    [ -f "$root/$p" ] || { echo "missing file" >&2; exit 3; }
  done
fi
exit "${FAKE_VALIDATOR_EXIT:-0}"
