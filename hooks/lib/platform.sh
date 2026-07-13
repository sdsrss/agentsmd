#!/usr/bin/env bash
# platform.sh — cross-platform abstractions for stat/find/timeout in agentsmd hooks.
# Ported from claudemd hooks/lib/platform.sh (GNU + BSD/macOS safe).

# platform_stat_mtime FILE — echo mtime as epoch seconds.
platform_stat_mtime() {
  local f="${1:-}"  # `${1:-}` not `$1`: defensive against a no-arg call under `set -u`
  [[ -n "$f" ]] || return 1
  if stat --format=%Y "$f" >/dev/null 2>&1; then
    stat --format=%Y "$f"
  else
    stat -f %m "$f" 2>/dev/null
  fi
}

# platform_stat_size FILE — echo size in bytes.
platform_stat_size() {
  local f="${1:-}"  # `${1:-}` not `$1`: defensive against a no-arg call under `set -u`
  [[ -n "$f" ]] || return 1
  if stat --format=%s "$f" >/dev/null 2>&1; then
    stat --format=%s "$f"
  else
    stat -f %z "$f" 2>/dev/null
  fi
}

# platform_find_newer DIR REFERENCE_FILE — list immediate children (depth ≤ 1)
# newer than REFERENCE_FILE. Depth cap is mandatory: the spec this plugin ships
# forbids recursive traversal of ~/.codex/ (spec/AGENTS.md §8) — hook behavior
# must comply with its own rule.
platform_find_newer() {
  local dir="${1:-}" ref="${2:-}"  # `${N:-}` not `$N`: defensive under `set -u`
  [[ -n "$dir" && -n "$ref" ]] || return 1
  find "$dir" -maxdepth 1 -newer "$ref" 2>/dev/null | grep -v "^${dir}$" || true
}

# platform_timeout SECONDS CMD [ARGS...] — run CMD with a wall-clock ceiling.
# `timeout` is GNU coreutils; stock macOS has neither `timeout` nor `gtimeout`.
# Prefer timeout → gtimeout → a Node process-group watchdog so the ceiling and
# descendant cleanup survive without coreutils. Returns the command's exit status
# (124 on watchdog timeout, matching GNU `timeout`).
platform_timeout() {
  local secs="${1:-}"; shift || true
  [[ -n "$secs" && "$#" -gt 0 ]] || return 1
  if [[ "${AGENTSMD_NO_TIMEOUT_BIN:-0}" != "1" ]]; then
    if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
    if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  fi
  if command -v node >/dev/null 2>&1; then
    local platform_dir
    platform_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    node "$platform_dir/platform-timeout.js" "$secs" "$@"
    return $?
  fi
  # Last-resort parent-only watchdog for environments lacking both coreutils and
  # Node. agentsmd's supported hook runtime requires Node, so this is defensive.
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs" 2>/dev/null; kill -TERM "$cmd_pid" 2>/dev/null ) &
  local watch_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null; rc=$?
  [[ "$rc" -eq 143 ]] && rc=124
  kill -TERM "$watch_pid" 2>/dev/null
  wait "$watch_pid" 2>/dev/null || true
  return "$rc"
}
