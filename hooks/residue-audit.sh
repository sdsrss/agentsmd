#!/usr/bin/env bash
# residue-audit.sh — Stop. Advises when ~/.codex/tmp/ has grown since the last
# session baseline (spec §9 end-of-task sweep / §7 user-global-state: code that
# writes to user-global paths must not leave orphans). Non-blocking: records
# telemetry (the guaranteed signal) and QUEUES an advisory (hook_queue_advisory)
# for surface-advisories.sh to surface at the next UserPromptSubmit — Stop-event
# additionalContext is not a verified surfacing channel. First run establishes
# the baseline silently.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="residue-audit"
hook_kill_switch "RESIDUE_AUDIT" || exit 0

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

TMP_DIR="${CODEX_HOME:-$HOME/.codex}/tmp"
STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
# Per-session baseline so concurrent sessions don't clobber each other's tmp count
# (a shared file made parallel runs report false residue growth against each other).
BASELINE="$STATE_DIR/tmp-baseline-$(hook_session_key "$SID").txt"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Count immediate children of ~/.codex/tmp (depth 1; spec §8 forbids deep
# traversal of config dirs).
NOW_COUNT=0
[[ -d "$TMP_DIR" ]] && NOW_COUNT="$(find "$TMP_DIR" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"

PREV_COUNT=""
[[ -r "$BASELINE" ]] && PREV_COUNT="$(cat "$BASELINE" 2>/dev/null)"
printf '%s' "$NOW_COUNT" > "$BASELINE" 2>/dev/null || true

# First run (no baseline) → establish silently.
[[ -n "$PREV_COUNT" && "$PREV_COUNT" =~ ^[0-9]+$ ]] || exit 0
hook_observe "$HOOK" '§7-user-global-state' "$SID" true true \
  "$(jq -cn --argjson prev "$PREV_COUNT" --argjson now "$NOW_COUNT" '{previous:$prev,current:$now,stage:"comparison-complete"}' 2>/dev/null || echo null)"

if (( NOW_COUNT > PREV_COUNT )); then
  GREW=$(( NOW_COUNT - PREV_COUNT ))
  hook_record "$HOOK" "advisory" "$(jq -cn --argjson g "$GREW" --argjson n "$NOW_COUNT" '{grew:$g,now:$n}' 2>/dev/null || echo null)" '§7-user-global-state' "$SID"
  hook_queue_advisory \
    "[agentsmd §9] ~/.codex/tmp/ grew by ${GREW} entr$([[ $GREW -eq 1 ]] && echo y || echo ies) this session (now ${NOW_COUNT}). If any are your task's scratch artifacts, sweep them (spec §8.V4 disposal); .keep-marked or paused-task fixtures are exempt." \
    "$SID"
fi
exit 0
