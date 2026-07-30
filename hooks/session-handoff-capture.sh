#!/usr/bin/env bash
# session-handoff-capture.sh — Stop. Persist a bounded, redacted completion
# capsule for the next fresh chat in the same repository. It reads only Codex's
# stable last_assistant_message field through the bounded Node helper; it never
# scans the transcript, invokes a model, or emits stored content to telemetry.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="session-handoff-capture"
hook_kill_switch "SESSION_HANDOFF_CAPTURE" || exit 0
[[ "${DISABLE_SESSION_HANDOFF_HOOK:-0}" == "1" ]] && exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }
[[ -r "$LIB_DIR/session-handoff.js" ]] || { hook_record_failopen "$HOOK" "helper-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
STATE_DIR="$(hook_runtime_state_dir)"
printf '%s' "$EVENT" | node "$LIB_DIR/session-handoff.js" capture "$STATE_DIR" >/dev/null 2>&1 || true
exit 0
