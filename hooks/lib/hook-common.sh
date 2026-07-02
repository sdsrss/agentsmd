#!/usr/bin/env bash
# hook-common.sh — fail-open library for codexmd hooks.
# Codex output protocol verified against oh-my-codex's production codex-native
# hook (v0.130): PreToolUse block = {decision:"block", reason, systemMessage,
# hookSpecificOutput:{hookEventName}}; advisory = {hookSpecificOutput:{...},
# systemMessage} (no decision); SessionStart context = {hookSpecificOutput:
# {hookEventName, additionalContext}}. This DIFFERS from Claude Code, which uses
# hookSpecificOutput.permissionDecision:"deny" — the one porting delta.

# hook_kill_switch NAME — return 0 to proceed, 1 to short-circuit.
hook_kill_switch() {
  [[ "${DISABLE_CODEXMD_HOOKS:-0}" == "1" ]] && return 1
  local var="DISABLE_${1}_HOOK"
  [[ "${!var:-0}" == "1" ]] && return 1
  return 0
}

# hook_require_jq — 0 if jq on PATH, else 1.
hook_require_jq() { command -v jq >/dev/null 2>&1; }

# hook_read_event — read stdin JSON to stdout; empty on error.
hook_read_event() {
  local input
  input=$(cat 2>/dev/null) || return 1
  [[ -n "$input" ]] || return 1
  printf '%s' "$input"
}

# hook_json_field EVENT_JSON PATH — extract a field via jq (e.g. .tool_input.command).
hook_json_field() {
  local ev="$1" path="$2"
  command -v jq >/dev/null 2>&1 || { printf ''; return 0; }
  printf '%s' "$ev" | jq -r "${path} // empty" 2>/dev/null
}

# hook_block REASON [SYSTEM_MSG] [EVENT] — emit Codex block JSON, exit 0.
#   Denies a PreToolUse tool call / forces a Stop to continue.
hook_block() {
  local reason="$1" msg="${2:-$1}" event="${3:-PreToolUse}"
  jq -cn --arg r "$reason" --arg m "$msg" --arg e "$event" '{
    decision: "block",
    reason: $r,
    systemMessage: $m,
    hookSpecificOutput: { hookEventName: $e }
  }' 2>/dev/null
  exit 0
}

# hook_advisory SYSTEM_MSG [EVENT] — emit non-blocking warning, exit 0.
hook_advisory() {
  local msg="$1" event="${2:-PreToolUse}"
  jq -cn --arg m "$msg" --arg e "$event" '{
    hookSpecificOutput: { hookEventName: $e },
    systemMessage: $m
  }' 2>/dev/null
  exit 0
}

# hook_context ADDITIONAL_CONTEXT [EVENT] — inject context (SessionStart /
# UserPromptSubmit), exit 0.
hook_context() {
  local ctx="$1" event="${2:-SessionStart}"
  jq -cn --arg c "$ctx" --arg e "$event" '{
    hookSpecificOutput: { hookEventName: $e, additionalContext: $c }
  }' 2>/dev/null
  exit 0
}

# hook_record HOOK EVENT [EXTRA_JSON] [SECTION] [SESSION_ID] — append telemetry.
hook_record() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  source "$lib_dir/rule-hits.sh" 2>/dev/null || return 0
  rule_hits_append "$@"
}

# hook_record_failopen HOOK REASON — record a fail-open event (jq-missing /
# bad-event / prereq-missing) so silently-skipped enforcement is visible to the
# audit, not indistinguishable from "rule wasn't relevant". Rate-limited 1/60s
# per (hook,reason).
hook_record_failopen() {
  [[ "${DISABLE_RULE_HITS_LOG:-0}" == "1" ]] && return 0
  local hook="${1:-unknown}" reason="${2:-unspecified}"
  local state_dir="${CODEX_HOME:-$HOME/.codex}/.codexmd-state"
  mkdir -p "$state_dir" 2>/dev/null || return 0
  local stamp; stamp=$(printf '%s-%s' "$hook" "$reason" | tr '/. ' '___')
  local marker="$state_dir/failopen-${stamp}.ts"
  local now; now=$(date +%s 2>/dev/null) || return 0
  if [[ -r "$marker" ]]; then
    local last; last=$(cat "$marker" 2>/dev/null) || last=0; [[ -z "$last" ]] && last=0
    (( now - last < 60 )) && return 0
  fi
  printf '%s' "$now" > "$marker" 2>/dev/null || return 0
  local lib_dir; lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  source "$lib_dir/rule-hits.sh" 2>/dev/null || return 0
  local escaped="${reason//\"/\\\"}"
  rule_hits_append "$hook" "fail-open" "{\"reason\":\"$escaped\"}" '§hooks-fail-open'
}

# hook_is_readonly_bash CMD — 0 if CMD is definitely read-only & side-effect
# free (caller may skip heavy logic). Conservative: false negatives are free,
# false positives could skip a real safety check → return 1 on any uncertainty.
hook_is_readonly_bash() {
  local cmd="$1"
  case "$cmd" in
    *';'*|*'|'*|*'&'*|*'>'*|*'<'*|*'`'*) return 1 ;;
    *'$('*|*'${'*) return 1 ;;
    *$'\n'*) return 1 ;;
  esac
  local trimmed="${cmd#"${cmd%%[![:space:]]*}"}"
  local first="${trimmed%%[[:space:]]*}"
  case "$first" in
    ls|cat|head|tail|wc|stat|date|pwd|echo|printf|file|which|type|basename|dirname|realpath|true|false)
      return 0 ;;
    git)
      local rest="${trimmed#git}"; rest="${rest#"${rest%%[![:space:]]*}"}"
      local sub="${rest%%[[:space:]]*}"
      case "$sub" in
        log|status|diff|show|rev-parse|rev-list|describe|blame|reflog|ls-files|ls-tree|cat-file|remote) return 0 ;;
      esac ;;
  esac
  return 1
}
