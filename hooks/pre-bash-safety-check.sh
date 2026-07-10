#!/usr/bin/env bash
# pre-bash-safety-check.sh — PreToolUse:Bash enforcement of spec/AGENTS.md §8
# (immutable SAFETY). Blocks:
#   1. `rm -rf $VAR` — recursive+force delete targeting an unvalidated variable
#      expansion (spec §8: "rm -rf $VAR without validating VAR"). Bypass token:
#      [allow-rm-rf-var].
#   2. `curl`/`wget` output executed by an interpreter through a pipeline,
#      substitution, or downloaded file — unknown-origin remote script execution
#      (spec §8: "execute unknown-origin scripts"). Bypass token: [allow-remote-exec].
# Advises (non-blocking):
#   3. Unpinned `npx <pkg>` dependency-hygiene advice. Bypass: [allow-npx-unpinned].
#
# Fail-open: any missing prerequisite (jq, unreadable stdin) exits 0 silently
# (recorded via hook_record_failopen) so a broken hook never wedges the session.
# The shared quote-aware lexer distinguishes executable command positions from
# strings passed as data, and preserves expansion metadata for rm targets.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="pre-bash-safety"
hook_kill_switch "PRE_BASH_SAFETY" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }

TOOL="$(hook_json_field "$EVENT" '.tool_name')"
[[ "$TOOL" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"

# Fast-path: obviously read-only command → nothing to enforce.
hook_is_readonly_bash "$CMD" && exit 0

# Parse command positions, quotes, escapes, wrappers, expansions, and pipelines
# once. The shared lexer is also used by commit/ship hooks, avoiding whole-string
# matches that mistake data passed to echo/printf for executable shell syntax.
SAFETY="$(node "$LIB_DIR/command-parse.js" --safety "$CMD" 2>/dev/null)" || {
  hook_record_failopen "$HOOK" "command-parse-failed"
  exit 0
}
printf '%s' "$SAFETY" | jq -e 'type == "object"' >/dev/null 2>&1 || {
  hook_record_failopen "$HOOK" "command-parse-invalid"
  exit 0
}

# ── 1. rm -rf $VAR (immutable §8) ───────────────────────────────────────────
if [[ "$(printf '%s' "$SAFETY" | jq -r '.rmRfCandidate // false')" == "true" ]]; then
  hook_observe "$HOOK" '§8-rm-rf-var' "$SID" true true '{"candidate":"rm-rf"}'
  if [[ "$CMD" != *"[allow-rm-rf-var]"* ]] \
    && [[ "$(printf '%s' "$SAFETY" | jq -r '.rmRfVar // false')" == "true" ]]; then
    hook_record "$HOOK" "block" '{"pattern":"rm-rf-var"}' '§8-rm-rf-var' "$SID"
    hook_block \
      "Blocked: rm -rf on an unvalidated variable ( spec/AGENTS.md §8, immutable )." \
      "§8 SAFETY (immutable): 'rm -rf \$VAR without validating VAR' is banned. Validate the variable is non-empty and points where you intend, or append [allow-rm-rf-var] to the command to confirm you have. Command: ${CMD}" \
      "PreToolUse"
  fi
fi

# ── 2. remote download executed by an interpreter (immutable §8) ────────────
if [[ "$(printf '%s' "$SAFETY" | jq -r '.remoteExec // false')" == "true" ]]; then
  hook_observe "$HOOK" '§8-unknown-script' "$SID" true true '{"candidate":"remote-exec"}'
  if [[ "$CMD" != *"[allow-remote-exec]"* ]]; then
    hook_record "$HOOK" "block" '{"pattern":"remote-exec"}' '§8-unknown-script' "$SID"
    hook_block \
      "Blocked: executing an uninspected remote download ( spec/AGENTS.md §8, immutable )." \
      "§8 SAFETY (immutable): 'execute unknown-origin scripts' is banned. Download to a file, inspect it, then run it — or append [allow-remote-exec] if the source is trusted and pinned. Command: ${CMD}" \
      "PreToolUse"
  fi
fi

# ── 3. unpinned npx (non-safety dependency-hygiene advisory) ────────────────
cmd_npx_unpinned() {
  local c="$1"
  [[ "$c" == *"[allow-npx-unpinned]"* ]] && return 1
  printf '%s' "$c" | grep -qiE '(^|[;&|`(]|[[:space:]])npx([[:space:]]+-{1,2}[a-z-]+)*[[:space:]]+[@a-z]' || return 1
  # a pinned @version anywhere in the npx invocation → treat as pinned
  printf '%s' "$c" | grep -qiE 'npx[[:space:]].*[^[:space:]]+@[0-9]' && return 1
  return 0
}

if cmd_npx_unpinned "$CMD"; then
  hook_record "$HOOK" "advisory" '{"pattern":"npx-unpinned"}' 'advisory-npx-unpinned' "$SID"
  hook_advisory \
    "[agentsmd dependency hygiene] Unpinned 'npx <pkg>' executes a mutable package version. Prefer a lockfile/local binary, pin pkg@x.y.z, or append [allow-npx-unpinned] when intentional." \
    "PreToolUse"
fi

exit 0
