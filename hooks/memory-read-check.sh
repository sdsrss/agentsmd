#!/usr/bin/env bash
# memory-read-check.sh — PreToolUse:Bash. Enforces spec §7 "MEMORY.md
# read-the-file (HARD at ship/destructive/L3)": before a ship-family command
# (git push/merge, publish, deploy), if the project (or global) MEMORY.md exists
# it MUST have been consulted this session. Detection is transcript-format
# agnostic: if MEMORY.md exists but the literal string "MEMORY.md" appears 0
# times in the session transcript, it was definitely never opened → block.
# Bypass: [allow-unread-memory]. Fail-open when no MEMORY.md / no transcript.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="memory-read"
hook_kill_switch "MEMORY_READ" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Only ship-family commands (spec §5/§E3 ship intent).
printf '%s' "$CMD" | grep -qiE '(^|[;&|]|[[:space:]])git[[:space:]]+(push|merge)\b|(npm|pnpm|yarn)[[:space:]]+publish\b|(^|[[:space:]])(gh[[:space:]]+release|cargo[[:space:]]+publish)\b' || exit 0
[[ "$CMD" == *"[allow-unread-memory]"* ]] && { hook_record "$HOOK" "bypass" '{"token":"allow-unread-memory"}' '§7-memory-read' "$SID"; exit 0; }

# Locate a MEMORY.md worth consulting (project root of cwd, or global).
MEM=""
for cand in "$CWD/MEMORY.md" "${CODEX_HOME:-$HOME/.codex}/MEMORY.md"; do
  [[ -r "$cand" ]] && { MEM="$cand"; break; }
done
[[ -n "$MEM" ]] || exit 0   # no MEMORY.md → nothing to enforce

# Was it consulted? Fail-open if we can't read the transcript to tell.
TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || { hook_record_failopen "$HOOK" "no-transcript"; exit 0; }
if grep -q "MEMORY\.md" "$TRANSCRIPT" 2>/dev/null; then
  exit 0   # referenced this session → consider it consulted
fi

hook_record "$HOOK" "block" "$(jq -cn --arg m "$MEM" '{memory:$m}')" '§7-memory-read' "$SID"
hook_block \
  "Blocked: shipping without consulting ${MEM} ( spec §7, HARD at ship )." \
  "§7 (HARD): a MEMORY.md exists at ${MEM} but was not opened this session, and you are about to ship. Read it first (its index routes to lessons that may change this push), or append [allow-unread-memory] if it is genuinely irrelevant here." \
  "PreToolUse"
