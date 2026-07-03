#!/usr/bin/env bash
# surface-advisories.sh — UserPromptSubmit. Surfaces advisories that the Stop
# hooks (residue-audit / sandbox-disposal / transcript-structure-scan) queued at
# the end of the previous turn, via additionalContext on UserPromptSubmit — the
# verified surfacing channel (Stop additionalContext is not). Reads + clears the
# pending queue so each advisory is shown once. session-start-check.sh clears the
# queue at session boundaries, keeping advisories session-scoped.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="surface-advisories"
hook_kill_switch "SURFACE_ADVISORIES" || exit 0
hook_require_jq || exit 0

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

PENDING="$(hook_advisory_file "$SID")"
[[ -s "$PENDING" ]] || exit 0
MSG="$(cat "$PENDING" 2>/dev/null)"
rm -f "$PENDING" 2>/dev/null || true
[[ -n "$MSG" ]] || exit 0

hook_record "$HOOK" "surface" 'null' '' "$SID"
hook_context \
  "[agentsmd] Advisories from your previous turn (address or acknowledge):"$'\n'"${MSG}" \
  "UserPromptSubmit"
