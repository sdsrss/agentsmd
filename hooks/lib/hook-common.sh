#!/usr/bin/env bash
# hook-common.sh — fail-open library for agentsmd hooks.
# Codex output protocol verified against oh-my-codex's production codex-native
# hook (v0.130): PreToolUse block = {decision:"block", reason, systemMessage,
# hookSpecificOutput:{hookEventName}}; advisory = {hookSpecificOutput:{...},
# systemMessage} (no decision); SessionStart context = {hookSpecificOutput:
# {hookEventName, additionalContext}}. This DIFFERS from Claude Code, which uses
# hookSpecificOutput.permissionDecision:"deny" — the one porting delta.

# Codex exposes the active plugin bundle through CLAUDE_PLUGIN_ROOT. Keep the
# shorter name internal so standalone hooks remain root-agnostic and existing
# fixture injection stays compatible.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"

# platform.sh provides the portable stat/timeout helpers the cache-gated surface
# check (and SessionStart's bounded inspector run) rely on. Fail open if it is
# somehow absent — callers degrade to "both surfaces run", never to a crash.
# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/platform.sh" 2>/dev/null || true

# Telemetry rows and state refs carry project path slugs; nothing a hook writes
# is read by another user or process, so every created dir/file is private
# (0700/0600). Existing wide-mode files are tightened by install/update and
# surfaced by doctor.
umask 077

# Cache schema this reader understands. Bump in lockstep with
# ARBITRATION_CACHE_SCHEMA in scripts/lib/surface-arbitration.js.
AGENTSMD_ARBITRATION_CACHE_SCHEMA=1

# hook_kill_switch NAME — return 0 to proceed, 1 to short-circuit.
hook_kill_switch() {
  [[ "${DISABLE_AGENTSMD_HOOKS:-0}" == "1" ]] && return 1
  local var="DISABLE_${1}_HOOK"
  [[ "${!var:-0}" == "1" ]] && return 1
  return 0
}

# hook_require_jq — 0 if jq on PATH, else 1.
hook_require_jq() { command -v jq >/dev/null 2>&1; }

# Plugin and standalone are alternative delivery surfaces. When both current
# protocol surfaces can see the plugin root, the losing physical hook copy
# yields. Legacy standalone hooks remain non-cooperative and are reported by
# status/doctor as non-exclusive.
hook_plugin_shadowed_by_standalone() {
  [[ -n "${PLUGIN_ROOT:-}" ]] || return 1
  local home="${CODEX_HOME:-$HOME/.codex}"
  local manifest="$home/.agentsmd-state/manifest.json"
  local cache="$home/.agentsmd-state/arbitration-cache.json"
  # No standalone manifest → single-surface (plugin-only) fast path; nothing to
  # arbitrate against, so this copy never yields.
  [[ -r "$manifest" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # A dual surface without a cache is the acknowledged degraded state: BOTH
  # surfaces run (safe direction). Never spawn node here — that synchronous
  # sha256Tree + codex probe on every hook is exactly what blew the safety
  # hook's budget (N-01). The cache is produced out of band at SessionStart /
  # status / doctor by the shared inspector.
  [[ -r "$cache" ]] || return 1

  # Resolve which physical surface THIS hook copy was loaded from. CLAUDE_PLUGIN_ROOT
  # can be inherited by a globally registered standalone command, so only the copy
  # physically loaded from the plugin (or standalone) tree may act on the cache.
  local current_hooks plugin_hooks standalone_hooks current_surface="unknown"
  current_hooks="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"
  plugin_hooks="$(cd "$PLUGIN_ROOT/hooks" 2>/dev/null && pwd -P)"
  standalone_hooks="$(cd "$home/agentsmd/hooks" 2>/dev/null && pwd -P)"
  [[ -n "$current_hooks" ]] || return 1
  [[ -n "$plugin_hooks" && "$current_hooks" == "$plugin_hooks" ]] && current_surface="plugin"
  [[ -n "$standalone_hooks" && "$current_hooks" == "$standalone_hooks" ]] && current_surface="standalone"
  [[ "$current_surface" != "unknown" ]] || return 1

  # Read the cache. ANY parse failure, unknown schema, plugin-root mismatch, or
  # stale manifest freshness key → return 1 (both surfaces run; safe direction).
  local schema cached_root cached_key selected resolved_root fresh_key
  schema="$(jq -r '.schemaVersion // empty' "$cache" 2>/dev/null)" || return 1
  [[ "$schema" == "$AGENTSMD_ARBITRATION_CACHE_SCHEMA" ]] || return 1
  cached_root="$(jq -r '.pluginRoot // empty' "$cache" 2>/dev/null)"
  cached_key="$(jq -r '.manifest.key // empty' "$cache" 2>/dev/null)"
  selected="$(jq -r '.selection.selected // empty' "$cache" 2>/dev/null)"
  [[ -n "$cached_root" && -n "$cached_key" && -n "$selected" ]] || return 1

  # Cache must be for the same resolved plugin root and the same on-disk manifest.
  resolved_root="$(cd "$PLUGIN_ROOT" 2>/dev/null && pwd -P)"
  [[ -n "$resolved_root" && "$resolved_root" == "$cached_root" ]] || return 1
  fresh_key="$(platform_stat_mtime "$manifest" 2>/dev/null):$(platform_stat_size "$manifest" 2>/dev/null)"
  [[ "$fresh_key" == "$cached_key" ]] || return 1

  # Yield only when a valid, fresh cache names a DIFFERENT selected surface than
  # this physical copy — i.e. this copy is the loser and may stand down.
  [[ "$selected" != "unknown" && "$current_surface" != "$selected" ]]
}

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

# hook_state_dir — echo (and ensure) agentsmd's state dir under the Codex home.
hook_state_dir() {
  local d="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
  mkdir -p "$d" 2>/dev/null || true
  printf '%s' "$d"
}

hook_session_key() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { printf 'global'; return 0; }
  printf '%s' "$sid" | tr -c 'a-zA-Z0-9_.-' '_'
}

hook_advisory_file() {
  local key d
  d="$(hook_state_dir)"
  key="$(hook_session_key "${1:-}")"
  if [[ "$key" == "global" ]]; then
    printf '%s/pending-advisories' "$d"
  else
    printf '%s/pending-advisories-%s' "$d" "$key"
  fi
}

hook_find_memory_file() {
  local cwd="${1:-$PWD}" cand gitroot dir parent
  cand="$cwd/MEMORY.md"
  [[ -r "$cand" ]] && { printf '%s' "$cand"; return 0; }
  gitroot="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"
  if [[ -n "$gitroot" && -r "$gitroot/MEMORY.md" ]]; then
    printf '%s' "$gitroot/MEMORY.md"
    return 0
  fi
  dir="$cwd"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    cand="$dir/MEMORY.md"
    [[ -r "$cand" ]] && { printf '%s' "$cand"; return 0; }
    parent="$(dirname "$dir")"
    [[ "$parent" == "$dir" ]] && break
    dir="$parent"
  done
  cand="${CODEX_HOME:-$HOME/.codex}/MEMORY.md"
  [[ -r "$cand" ]] && { printf '%s' "$cand"; return 0; }
  return 1
}

# hook_queue_advisory MESSAGE — queue a Stop-time advisory to be surfaced at the
# NEXT UserPromptSubmit. additionalContext on the Stop event is not a verified
# surfacing channel; UserPromptSubmit/SessionStart is (matches OMX's usage), so
# Stop advisories are deferred there instead of emitted inline on Stop. The queue
# is capped and cleared at SessionStart (session-scoped).
hook_queue_advisory() {
  local msg="$1" sid="${2:-}" f
  f="$(hook_advisory_file "$sid")"
  printf '%s\n' "$msg" >> "$f" 2>/dev/null || return 0
  local n
  n=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [[ "$n" =~ ^[0-9]+$ && "$n" -gt 20 ]]; then
    tail -n 20 "$f" > "$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null
  fi
}

# hook_record HOOK EVENT [EXTRA_JSON] [SECTION] [SESSION_ID] — append telemetry.
hook_record() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  source "$lib_dir/rule-hits.sh" 2>/dev/null || return 0
  rule_hits_append "$@"
}

# hook_observe HOOK SECTION SESSION_ID ELIGIBLE EVALUATED [EXTRA_JSON]
# Record a rule-specific opportunity independently from enforcement. Callers own
# the eligibility boundary; this wrapper deliberately does not infer one from the
# hook event type.
hook_observe() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  source "$lib_dir/rule-hits.sh" 2>/dev/null || return 0
  rule_hits_observe "$@"
}

# hook_record_failopen HOOK REASON — record a fail-open event (jq-missing /
# bad-event / prereq-missing) so silently-skipped enforcement is visible to the
# audit, not indistinguishable from "rule wasn't relevant". Rate-limited 1/60s
# per (hook,reason).
hook_record_failopen() {
  [[ "${DISABLE_RULE_HITS_LOG:-0}" == "1" ]] && return 0
  local hook="${1:-unknown}" reason="${2:-unspecified}"
  local state_dir="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
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

# hook_git_invocations_json SUBCMD_ALT CMD — print a JSON array containing every
# matching Git command. The parser is quote-aware, accepts common wrappers and
# path-qualified Git, and never evaluates the command or shell expansions.
hook_git_invocations_json() {
  local sub="$1" cmd="$2" lib_dir
  command -v node >/dev/null 2>&1 || return 1
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$lib_dir/command-parse.js" "$sub" "$cmd" 2>/dev/null
}

# Backward-compatible single-invocation accessor for out-of-tree hook consumers.
hook_git_invocation_json() {
  hook_git_invocations_json "$1" "$2" | jq -c '.[0] // empty' 2>/dev/null
}

# hook_cmd_invokes_git SUBCMD_ALT CMD — 0 if CMD contains an actual matching Git
# invocation. SUBCMD_ALT is a literal alternation ('push' or 'push|merge').
hook_cmd_invokes_git() {
  local parsed
  parsed="$(hook_git_invocations_json "$1" "$2")"
  [[ -n "$parsed" && "$parsed" != "[]" ]]
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
