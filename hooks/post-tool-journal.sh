#!/usr/bin/env bash
# post-tool-journal.sh — PostToolUse:Bash|apply_patch|update_plan shadow observer.
# Records only bounded tool classifications, exit state, validation type, and
# repo-relative mutation targets. Never stores command, patch, prompt, cwd,
# model, tool response, or file contents.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="post-tool-journal"
hook_kill_switch "POST_TOOL_JOURNAL" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }
[[ -r "$LIB_DIR/event-journal.js" ]] || { hook_record_failopen "$HOOK" "journal-lib-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
STATE_DIR="$(hook_runtime_state_dir)"
SURFACE="$(hook_current_surface)"
if ! AGENTSMD_EVENT_JOURNAL_STATE_DIR="$STATE_DIR" \
    AGENTSMD_EVENT_JOURNAL_SURFACE="$SURFACE" \
    node "$LIB_DIR/event-journal.js" --mode=post <<< "$EVENT" >/dev/null 2>&1; then
  hook_record_failopen "$HOOK" "journal-write-failed"
fi
exit 0
