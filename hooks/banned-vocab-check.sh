#!/usr/bin/env bash
# banned-vocab-check.sh — PreToolUse:Bash. When the command is a `git commit`
# with an inline -m message, scan the message against hooks/banned-vocab.patterns
# (spec/AGENTS.md §10 Specificity/Honesty). A hit blocks the commit: the message
# makes an unquantified value claim; the spec requires an absolute number or a
# baseline-anchored ratio. Bypass token: [allow-vocab].
#
# Phase-1 scope: inline `-m` / `-F -`-less commits. File/editor-sourced messages
# (git commit without -m) are not inspectable pre-execution and pass through —
# the Stop transcript scan (Phase 2) covers assistant prose separately.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0
PATTERNS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/banned-vocab.patterns"

HOOK="banned-vocab"
hook_kill_switch "BANNED_VOCAB" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }
[[ -r "$PATTERNS_FILE" ]] || { hook_record_failopen "$HOOK" "patterns-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }

TOOL="$(hook_json_field "$EVENT" '.tool_name')"
[[ "$TOOL" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"

# Inspect every actual Git commit invocation; checking only the first lets a
# later commit in the same Bash tool call evade the message gate.
INVOCATIONS="$(hook_git_invocations_json 'commit' "$CMD")"
[[ -n "$INVOCATIONS" && "$INVOCATIONS" != "[]" ]] || exit 0

# Scan ONLY the inline message value(s), not the whole command line — otherwise a
# filename/arg token (e.g. `-- significantly.txt`) would false-block a clean
# message. The shared parser extracts -m/--message values from every invocation.
# File/editor-sourced messages remain uninspectable pre-execution.
MSG="$(printf '%s' "$INVOCATIONS" | jq -r '.[].messages[]' 2>/dev/null)"
[[ -n "$MSG" ]] || exit 0
if [[ "$CMD" == *"[allow-vocab]"* ]]; then
  hook_observe "$HOOK" '§10-V' "$SID" true false '{"reason":"bypass"}'
  hook_record "$HOOK" "bypass" '{"token":"allow-vocab"}' '§10-V' "$SID"
  exit 0
fi

# Find the first banned pattern that hits the message text.
HIT=""
while IFS= read -r pat; do
  [[ -z "$pat" || "$pat" == \#* ]] && continue
  if printf '%s' "$MSG" | grep -qiE "$pat"; then HIT="$pat"; break; fi
done < "$PATTERNS_FILE"

hook_observe "$HOOK" '§10-V' "$SID" true true '{"source":"inline-message"}'

[[ -n "$HIT" ]] || exit 0

hook_record "$HOOK" "block" "$(jq -cn --arg p "$HIT" '{pattern:$p}')" '§10-V' "$SID"
hook_block \
  "Blocked: commit message uses banned vocabulary ( spec/AGENTS.md §10 Specificity )." \
  "§10 (HARD): the commit message contains an unquantified value claim matching /${HIT}/. Replace it with an absolute number (e.g. 'p99 580ms→140ms', '12/12 tests') or a baseline-anchored ratio ('1453→1490, +2.5%'). Append [allow-vocab] to override if the word is used non-evaluatively." \
  "PreToolUse"
