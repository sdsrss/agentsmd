#!/usr/bin/env bash
# pre-bash-safety-check.sh — PreToolUse:Bash enforcement of spec/AGENTS.md §8
# (immutable SAFETY). Blocks:
#   1. `rm -rf $VAR` — recursive+force delete targeting an unvalidated variable
#      expansion (spec §8: "rm -rf $VAR without validating VAR"). Bypass token:
#      [allow-rm-rf-var].
#   2. `curl|wget … | sh/bash/python/…` — unknown-origin remote script execution
#      (spec §8: "execute unknown-origin scripts"). Bypass token: [allow-remote-exec].
# Advises (non-blocking):
#   3. Unpinned `npx <pkg>` (spec §4 NPX rule). Bypass: [allow-npx-unpinned].
#
# Fail-open: any missing prerequisite (jq, unreadable stdin) exits 0 silently
# (recorded via hook_record_failopen) so a broken hook never wedges the session.
# Phase-1 scope: direct command forms. String-literal / eval / `bash -c` wrapper
# unwrapping (claudemd parity) is Phase-2 hardening — until then, an rm-rf-var
# inside a string literal may over-block, which is the fail-safe direction for a
# §8 immutable rule.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="pre-bash-safety"
hook_kill_switch "PRE_BASH_SAFETY" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }

TOOL="$(hook_json_field "$EVENT" '.tool_name')"
[[ "$TOOL" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"

# Fast-path: obviously read-only command → nothing to enforce.
hook_is_readonly_bash "$CMD" && exit 0

# ── 1. rm -rf $VAR (immutable §8) ───────────────────────────────────────────
cmd_has_rm_rf_var() {
  local c="$1"
  [[ "$c" == *"[allow-rm-rf-var]"* ]] && return 1
  # rm invoked as a command — bare `rm` or path-qualified (`/bin/rm`, `/usr/bin/rm`).
  printf '%s' "$c" | grep -qiE '(^|[;&|`(]|[[:space:]])([^[:space:];&|`()]*/)?rm([[:space:]]|$)' || return 1
  # recursive flag: short (-r / -rf / -Rf …) OR long --recursive.
  printf '%s' "$c" | grep -qiE '(^|[[:space:]])-[a-z]*r|--recursive([[:space:]=]|$)' || return 1
  # force flag: short (-f / -rf …) OR long --force.
  printf '%s' "$c" | grep -qiE '(^|[[:space:]])-[a-z]*f|--force([[:space:]=]|$)' || return 1
  # target contains a variable/parameter expansion — $VAR / ${...} / $1 / $@ / $* /
  # $(...). Positional ($1), special ($@ $*), and command-substitution ($(...))
  # targets are just as unvalidated as a named var; the prior name-only pattern
  # let `rm -rf $1`, `rm -rf "$@"`, `rm -rf $(cat f)` slip through.
  printf '%s' "$c" | grep -qE '\$(\{|\(|[A-Za-z_0-9@*])' && return 0
  return 1
}

if cmd_has_rm_rf_var "$CMD"; then
  hook_record "$HOOK" "block" '{"pattern":"rm-rf-var"}' '§8-rm-rf-var' "$SID"
  hook_block \
    "Blocked: rm -rf on an unvalidated variable ( spec/AGENTS.md §8, immutable )." \
    "§8 SAFETY (immutable): 'rm -rf \$VAR without validating VAR' is banned. Validate the variable is non-empty and points where you intend, or append [allow-rm-rf-var] to the command to confirm you have. Command: ${CMD}" \
    "PreToolUse"
fi

# ── 2. curl|wget … | shell (immutable §8: unknown-origin script) ────────────
cmd_pipes_to_shell() {
  local c="$1"
  [[ "$c" == *"[allow-remote-exec]"* ]] && return 1
  # [^;]* (not [^|]*) so a MULTI-STAGE pipeline reaches the interpreter:
  # `curl u | grep -v x | bash` / `curl u | tee f | bash`. Bounded by `;` so the
  # match stays within one command segment (a later unrelated `| sh` after `;`
  # is not attributed to the curl).
  printf '%s' "$c" | grep -qiE '(curl|wget)[[:space:]][^;]*\|[[:space:]]*(sudo[[:space:]]+)?(([^[:space:];|&]*/)?env[[:space:]]+)?([^[:space:];|&]*/)?(ba)?(sh|zsh|dash|ksh|fish)([[:space:]]|$)' && return 0
  printf '%s' "$c" | grep -qiE '(curl|wget)[[:space:]][^;]*\|[[:space:]]*(sudo[[:space:]]+)?(([^[:space:];|&]*/)?env[[:space:]]+)?([^[:space:];|&]*/)?(python[0-9.]*|node|ruby|perl)([[:space:]]|$)' && return 0
  return 1
}

if cmd_pipes_to_shell "$CMD"; then
  hook_record "$HOOK" "block" '{"pattern":"pipe-to-shell"}' '§8-unknown-script' "$SID"
  hook_block \
    "Blocked: piping a remote download straight into a shell/interpreter ( spec/AGENTS.md §8, immutable )." \
    "§8 SAFETY (immutable): 'execute unknown-origin scripts' is banned. Download to a file, inspect it, then run it — or append [allow-remote-exec] if the source is trusted and pinned. Command: ${CMD}" \
    "PreToolUse"
fi

# ── 3. unpinned npx (advisory, §4 NPX rule) ─────────────────────────────────
cmd_npx_unpinned() {
  local c="$1"
  [[ "$c" == *"[allow-npx-unpinned]"* ]] && return 1
  printf '%s' "$c" | grep -qiE '(^|[;&|`(]|[[:space:]])npx([[:space:]]+-{1,2}[a-z-]+)*[[:space:]]+[@a-z]' || return 1
  # a pinned @version anywhere in the npx invocation → treat as pinned
  printf '%s' "$c" | grep -qiE 'npx[[:space:]].*[^[:space:]]+@[0-9]' && return 1
  return 0
}

if cmd_npx_unpinned "$CMD"; then
  hook_record "$HOOK" "advisory" '{"pattern":"npx-unpinned"}' '§8-unknown-script' "$SID"
  hook_advisory \
    "[agentsmd §4] Unpinned 'npx <pkg>' — spec resolves NPX as lockfile → local → pinned whitelist. Pin a version (pkg@x.y.z), run the locally-installed binary, or append [allow-npx-unpinned] if this is intentional." \
    "PreToolUse"
fi

exit 0
