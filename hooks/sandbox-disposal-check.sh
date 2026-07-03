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

HOOK="sandbox-disposal"
hook_kill_switch "SANDBOX_DISPOSAL" || exit 0

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
REF="$STATE_DIR/session-start.ref"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
# No session reference yet → create one and skip (nothing to compare against).
[[ -r "$REF" ]] || { : > "$REF" 2>/dev/null; exit 0; }

TMPROOT="${TMPDIR:-/tmp}"
# Count depth-1 scratch dirs newer than the session reference, matching common
# mkdtemp/agent scratch prefixes only (avoid flagging unrelated /tmp content).
RESIDUE=0
while IFS= read -r d; do
  [[ -z "$d" ]] && continue
  case "${d##*/}" in
    agentsmd-*|tmp.*|*.XXXXXX|agent-*|codex-*|claude-*) RESIDUE=$((RESIDUE+1)) ;;
  esac
done < <(find "$TMPROOT" -maxdepth 1 -mindepth 1 -type d -newer "$REF" 2>/dev/null)

if (( RESIDUE > 0 )); then
  hook_record "$HOOK" "advisory" "$(jq -cn --argjson r "$RESIDUE" '{residue:$r}' 2>/dev/null || echo null)" '§8.V4' "$SID"
  hook_queue_advisory \
    "[agentsmd §8.V4] ${RESIDUE} scratch dir(s) created under ${TMPROOT} this session look undisposed. The creating task should delete its own sandbox artifacts on exit (exempt: .keep-marked or paused-task-referenced)." \
    "$SID"
fi
exit 0
