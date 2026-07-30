#!/usr/bin/env bash
# session-handoff-finalize.sh — SessionEnd. Mark this session's most recent Stop
# capsule finalized. SessionEnd has a three-second maximum, so this performs one
# bounded local JSON update and never reads the transcript or invokes a model.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="session-handoff-finalize"
hook_kill_switch "SESSION_HANDOFF_FINALIZE" || exit 0
[[ "${DISABLE_SESSION_HANDOFF_HOOK:-0}" == "1" ]] && exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }
[[ -r "$LIB_DIR/session-handoff.js" ]] || { hook_record_failopen "$HOOK" "helper-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
STATE_DIR="$(hook_runtime_state_dir)"
printf '%s' "$EVENT" | node "$LIB_DIR/session-handoff.js" finalize "$STATE_DIR" >/dev/null 2>&1 || true
exit 0
