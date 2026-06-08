#!/usr/bin/env bash
# lookie-link-config-audit.sh
#
# Audits `~/operations-*` directories on the Lookie-Link host against
# `~/.config/lookie-link/lookie-link.yaml#repositories`, flagging real
# working repos that are not yet served. Built for FON-11521.
#
# Output is structured (machine-grep-able + human-readable). Use --json for
# strict machine-readable output. Use --apply to mutate the config in place
# (requires `yq` for safe YAML edits).
#
# See: ~/operations/docs/meta/lookie-link-for-agents/lookie-link-for-agents-best-practices.md#discovery--which-repos-does-lookie-link-serve
set -euo pipefail

CONFIG_PATH="${LOOKIE_LINK_CONFIG:-$HOME/.config/lookie-link/lookie-link.yaml}"
HOME_DIR="${HOME%/}"
APPLY=0
JSON=0
DEFAULT_OWNER_KEY="operations"   # owner UUID is copied from this key when --apply is set

usage() {
  cat <<EOF
Usage: $0 [--apply] [--json] [--config PATH]

  --apply        Add missing repos to the config (repositories, repoOwners, repoRoots).
                 The owner UUID is copied from the existing '${DEFAULT_OWNER_KEY}' entry.
  --json         Emit JSON instead of a human report.
  --config PATH  Read config from PATH instead of ${CONFIG_PATH}.

Exit codes:
  0  no missing repos (clean)
  1  one or more missing repos (delta available)
  2  invocation / config error
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --json)  JSON=1; shift ;;
    --config) CONFIG_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if ! command -v yq >/dev/null 2>&1; then
  echo "yq is required (https://github.com/mikefarah/yq). Install via brew install yq." >&2
  exit 2
fi
if [ ! -f "$CONFIG_PATH" ]; then
  echo "config not found: $CONFIG_PATH" >&2
  exit 2
fi

# --- Helpers ---------------------------------------------------------------

# Normalise ~ → $HOME, strip trailing slash.
normalise_path() {
  local p="$1"
  case "$p" in
    "~")     p="${HOME_DIR}" ;;
    "~/"*)   p="${HOME_DIR}/${p#\~/}" ;;
  esac
  printf '%s' "${p%/}"
}

# Real-content count: number of entries excluding common sync/metadata files.
content_entry_count() {
  local dir="$1"
  find "$dir" -maxdepth 1 -mindepth 1 \
    ! -name '.git' \
    ! -name '.gitignore' \
    ! -name '.stignore' \
    ! -name '.stfolder' \
    ! -name '.stversions' \
    ! -name '.DS_Store' \
    2>/dev/null | wc -l | tr -d ' '
}

# Is this dir a git worktree (i.e. `.git` is a file, not a directory)?
is_worktree() {
  [ -f "$1/.git" ]
}

# --- Read config -----------------------------------------------------------

# Build map of served absolute paths from `repositories:` (resolved through ~).
declare -A SERVED_PATHS
declare -A SERVED_KEYS
while IFS=$'\t' read -r key val; do
  [ -z "$key" ] && continue
  abs="$(normalise_path "$val")"
  SERVED_PATHS["$abs"]="$key"
  SERVED_KEYS["$key"]="$abs"
done < <(yq -r '.repositories | to_entries | .[] | [.key, .value] | @tsv' "$CONFIG_PATH")

# Fetch a default owner UUID so --apply has something to copy.
DEFAULT_OWNER_UUID="$(yq -r ".access.grants.repoOwners.\"${DEFAULT_OWNER_KEY}\" // \"\"" "$CONFIG_PATH")"

# --- Classify operations-* dirs -------------------------------------------

declare -a SERVED_LIST=()
declare -a WORKTREE_LIST=()
declare -a EMPTY_LIST=()
declare -a MISSING_LIST=()
declare -a MISSING_ABS=()

# Loop ~/operations-* directories deterministically.
shopt -s nullglob
for dir in "${HOME_DIR}"/operations-*; do
  [ -d "$dir" ] || continue
  abs="${dir%/}"
  name="${abs##*/}"

  if [ -n "${SERVED_PATHS[$abs]:-}" ]; then
    SERVED_LIST+=("$name|${SERVED_PATHS[$abs]}")
    continue
  fi

  if is_worktree "$abs"; then
    WORKTREE_LIST+=("$name")
    continue
  fi

  cnt="$(content_entry_count "$abs")"
  if [ "$cnt" -le 1 ]; then
    EMPTY_LIST+=("$name|${cnt}")
    continue
  fi

  MISSING_LIST+=("$name|${cnt}")
  MISSING_ABS+=("$abs|$name")
done
shopt -u nullglob

# --- Render report ---------------------------------------------------------

if [ "$JSON" -eq 1 ]; then
  # Emit JSON via yq (which can serialise to JSON cleanly).
  {
    printf 'config: %s\n' "$CONFIG_PATH"
    printf 'served:\n'
    for s in "${SERVED_LIST[@]:-}";   do [ -z "$s" ] || printf '  - { name: %s, key: %s }\n' "${s%%|*}" "${s#*|}"; done
    printf 'worktrees:\n'
    for s in "${WORKTREE_LIST[@]:-}"; do [ -z "$s" ] || printf '  - %s\n' "$s"; done
    printf 'empty_placeholders:\n'
    for s in "${EMPTY_LIST[@]:-}";    do [ -z "$s" ] || printf '  - { name: %s, entries: %s }\n' "${s%%|*}" "${s#*|}"; done
    printf 'missing:\n'
    for s in "${MISSING_LIST[@]:-}";  do [ -z "$s" ] || printf '  - { name: %s, entries: %s }\n' "${s%%|*}" "${s#*|}"; done
  } | yq -o=json -
else
  echo "Lookie-Link config audit — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Config: $CONFIG_PATH"
  echo
  echo "Served (already in config): ${#SERVED_LIST[@]}"
  for s in "${SERVED_LIST[@]:-}"; do [ -z "$s" ] || echo "  - ${s%%|*}  (key=${s#*|})"; done
  echo
  echo "Worktrees (skipped — .git is a file): ${#WORKTREE_LIST[@]}"
  for s in "${WORKTREE_LIST[@]:-}"; do [ -z "$s" ] || echo "  - $s"; done
  echo
  echo "Empty placeholders (skipped — <=1 content entry): ${#EMPTY_LIST[@]}"
  for s in "${EMPTY_LIST[@]:-}"; do [ -z "$s" ] || echo "  - ${s%%|*}  (entries=${s#*|})"; done
  echo
  echo "MISSING (should be served): ${#MISSING_LIST[@]}"
  for s in "${MISSING_LIST[@]:-}"; do [ -z "$s" ] || echo "  - ${s%%|*}  (entries=${s#*|})"; done
fi

# --- Apply -----------------------------------------------------------------

if [ "$APPLY" -eq 1 ] && [ "${#MISSING_ABS[@]}" -gt 0 ]; then
  if [ -z "$DEFAULT_OWNER_UUID" ]; then
    echo "--apply requires access.grants.repoOwners.${DEFAULT_OWNER_KEY} to be set in the config so a default owner UUID can be copied." >&2
    exit 2
  fi

  # Back up the config before editing.
  ts="$(date -u '+%Y%m%dT%H%M%SZ')"
  cp "$CONFIG_PATH" "${CONFIG_PATH}.bak.${ts}"
  echo
  echo "Backed up config to ${CONFIG_PATH}.bak.${ts}"

  for entry in "${MISSING_ABS[@]}"; do
    abs="${entry%%|*}"
    name="${entry#*|}"
    home_form="~/${name}"
    echo "Adding $name -> $home_form (owner=$DEFAULT_OWNER_UUID)"
    NAME="$name" HOME_FORM="$home_form" ABS="$abs" OWNER="$DEFAULT_OWNER_UUID" yq -i '
      .repositories[strenv(NAME)] = strenv(HOME_FORM)
      | .access.grants.repoOwners[strenv(NAME)] = strenv(OWNER)
      | .access.grants.repoRoots[strenv(NAME)] = strenv(ABS)
    ' "$CONFIG_PATH"
  done

  echo
  echo "Done. Restart lookie-link to pick up the new config: launchctl kickstart -k user/\$UID/com.lookie-link or your equivalent."
fi

# Exit code: 1 if there's a delta, 0 if clean. Useful for cron / launchd.
if [ "${#MISSING_LIST[@]}" -gt 0 ]; then
  exit 1
fi
exit 0
