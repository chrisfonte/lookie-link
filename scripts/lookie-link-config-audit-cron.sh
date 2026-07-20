#!/usr/bin/env bash
# Wrapper around lookie-link-config-audit.sh for scheduled execution.
#
# Runs the audit; on a non-empty delta it posts a Paperclip comment to the
# configured tracking issue. Designed to be driven by
# launchd / cron on the Lookie-Link host.
#
# Environment variables:
#   LOOKIE_LINK_AUDIT_ISSUE   Paperclip issue ID to comment on
#   LOOKIE_LINK_AUDIT_LOG     Log file path (default: ~/Library/Logs/lookie-link-config-audit.log)
#   LOOKIE_LINK_CONFIG        Override config path (passed through to the audit)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="${SCRIPT_DIR}/lookie-link-config-audit.sh"
ISSUE_ID="${LOOKIE_LINK_AUDIT_ISSUE:-ACME-1234}"
LOG_PATH="${LOOKIE_LINK_AUDIT_LOG:-$HOME/Library/Logs/lookie-link-config-audit.log}"

mkdir -p "$(dirname "$LOG_PATH")"

TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
TMP="$(mktemp -t ll-audit.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

set +e
"$AUDIT" >"$TMP" 2>&1
status=$?
set -e

{
  echo "=== $TS  exit=$status ==="
  cat "$TMP"
  echo
} >>"$LOG_PATH"

# exit 0 means clean — nothing to report.
if [ "$status" -eq 0 ]; then
  exit 0
fi

# exit 2 is an invocation/config error — surface it loudly but still try to post.
# exit 1 means delta — post the report as a comment.
if ! command -v paperclipai >/dev/null 2>&1; then
  echo "paperclipai not on PATH; cannot post audit comment. See $LOG_PATH." >&2
  exit "$status"
fi

BODY="$(cat <<EOF
Lookie-Link config audit (weekly) found a delta on the host.

\`\`\`
$(cat "$TMP")
\`\`\`

Apply with: \`bash ~/projects/lookie-link/scripts/lookie-link-config-audit.sh --apply\`
EOF
)"

paperclipai issue comment "$ISSUE_ID" --body "$BODY" >/dev/null
echo "Posted audit delta to $ISSUE_ID" >>"$LOG_PATH"
exit "$status"
