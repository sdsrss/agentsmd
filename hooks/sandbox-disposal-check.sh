#!/usr/bin/env bash
# sandbox-disposal-check.sh — Stop. Advises when mkdtemp-style scratch dirs the
# session likely created are still present in $TMPDIR (spec §8.V4: a task deletes
# its own sandbox artifacts on exit; residue voids the next task's baseline).
# Non-blocking: telemetry + a queued advisory surfaced next UserPromptSubmit. Scoped to agentsmd's
# own smoke/scratch prefixes + generic agent scratch, depth-1, newer than the
# session-start reference — never a deep traversal.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="sandbox-disposal"
hook_kill_switch "SANDBOX_DISPOSAL" || exit 0

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
# Per-session reference (matches session-start-check.sh's key) so parallel sessions
# never reset each other's baseline — a shared file let session B's SessionStart
# void session A's residue reference.
REF="$STATE_DIR/session-start-$(hook_session_key "$SID").ref"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
# No session reference yet → create one and skip (nothing to compare against).
[[ -r "$REF" ]] || { : > "$REF" 2>/dev/null; exit 0; }

TMPROOT="${TMPDIR:-/tmp}"
# Count depth-1 scratch dirs newer than the session reference, matching common
# mkdtemp/agent scratch prefixes only (avoid flagging unrelated /tmp content).
RESIDUE=0
SCAN="$(find "$TMPROOT" -maxdepth 1 -mindepth 1 -type d -newer "$REF" 2>/dev/null)" \
  || { hook_observe "$HOOK" '§8.V4' "$SID" true false '{"reason":"scan-failed"}'; exit 0; }
while IFS= read -r d; do
  [[ -z "$d" ]] && continue
  case "${d##*/}" in
    # Codex owns this bwrap mount staging directory. A task did not create it,
    # and parallel Codex sessions may still be using it.
    codex-bwrap-synthetic-mount-targets-*) ;;
    agentsmd-*|tmp.*|*.XXXXXX|agent-*|codex-*|claude-*) RESIDUE=$((RESIDUE+1)) ;;
  esac
done <<< "$SCAN"
hook_observe "$HOOK" '§8.V4' "$SID" true true \
  "$(jq -cn --argjson r "$RESIDUE" '{residue:$r,stage:"scan-complete"}' 2>/dev/null || echo null)"

if (( RESIDUE > 0 )); then
  hook_record "$HOOK" "advisory" "$(jq -cn --argjson r "$RESIDUE" '{residue:$r}' 2>/dev/null || echo null)" '§8.V4' "$SID"
  hook_queue_advisory \
    "[agentsmd §8.V4] ${RESIDUE} scratch dir(s) under ${TMPROOT} are newer than this session and look undisposed. Verify task ownership before deleting; never remove Codex/runtime-owned paths. Task-owned artifacts should be deleted on exit (exempt: .keep-marked or paused-task-referenced)." \
    "$SID"
fi
exit 0
