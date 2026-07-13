#!/usr/bin/env bash
# rule-hits.sh — append-only JSONL telemetry for agentsmd's closed-loop data plane.

# Rows carry project path slugs — keep the log private even when this library is
# sourced without hook-common.sh (which sets the same umask for full hooks).
umask 077

rule_hits_json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

rule_hits_file_size() {
  local size=""
  size=$(stat -c %s "$1" 2>/dev/null) || size=""
  if [[ ! "$size" =~ ^[0-9]+$ ]]; then
    size=$(stat -f %z "$1" 2>/dev/null) || size=""
  fi
  [[ "$size" =~ ^[0-9]+$ ]] || size=0
  printf '%s' "$size"
}

rule_hits_file_mtime() {
  local mtime=""
  mtime=$(stat -c %Y "$1" 2>/dev/null) || mtime=""
  if [[ ! "$mtime" =~ ^[0-9]+$ ]]; then
    mtime=$(stat -f %m "$1" 2>/dev/null) || mtime=""
  fi
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$mtime"
}

rule_hits_release_owned_lock() {
  local lock_dir="$1" attempt=0
  rm -f "$lock_dir/lease" "$lock_dir/pid" 2>/dev/null
  while ! rmdir "$lock_dir" 2>/dev/null; do
    attempt=$((attempt + 1))
    (( attempt >= 50 )) && return 0
    sleep 0.01 2>/dev/null || sleep 1 2>/dev/null || return 0
  done
}

rule_hits_lock_is_stale() {
  local lock_dir="$1" stale_seconds="$2"
  local epoch="" owner="" _="" now="" age=""
  if [[ -r "$lock_dir/lease" ]]; then
    read -r epoch owner _ 2>/dev/null < "$lock_dir/lease" || true
  else
    epoch=$(rule_hits_file_mtime "$lock_dir") || return 1
    [[ -r "$lock_dir/pid" ]] && owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  fi
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 1
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  age=$((now - epoch))
  (( age >= stale_seconds )) || return 1
  # Expiry alone is insufficient: a paused but live writer still owns the
  # rotation+append critical section. The 30s default is already > every hook
  # timeout (3-8s); the PID check adds protection against scheduler stalls.
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  return 0
}

# Reclaim one dead, expired lock. The `reap` claim lives inside the OLD lock
# object, so contenders serialize on that exact generation. After a second stale
# check, takeover is an atomic rename to a unique quarantine; no contender ever
# deletes or renames the shared path based on an earlier observation.
rule_hits_reap_stale() (
  local lock_dir="$1" stale_seconds="$2"
  local claim_dir="$lock_dir/reap"
  local quarantine="" quarantine_ts=""
  local claimed=0

  quarantine_ts=$(date +%s 2>/dev/null) || quarantine_ts=0
  quarantine="${lock_dir}.stale.${BASHPID:-$$}.${RANDOM:-0}.${quarantine_ts}"

  rule_hits_lock_is_stale "$lock_dir" "$stale_seconds" || return 1
  mkdir "$claim_dir" 2>/dev/null || return 1
  claimed=1
  rule_hits_reap_cleanup() {
    (( claimed == 1 )) && rmdir "$claim_dir" 2>/dev/null
  }
  trap rule_hits_reap_cleanup EXIT
  trap 'exit 1' HUP INT TERM

  rule_hits_lock_is_stale "$lock_dir" "$stale_seconds" || return 1
  mv "$lock_dir" "$quarantine" 2>/dev/null || return 1
  claimed=0
  rmdir "$quarantine/reap" 2>/dev/null
  rm -f "$quarantine/lease" "$quarantine/pid" 2>/dev/null
  rmdir "$quarantine" 2>/dev/null
  return 0
)

# A mkdir lock works on both Linux and macOS and covers rotation plus append as
# one critical section. Lock exhaustion is deliberately silent/fail-open: a
# telemetry problem must never block the user action that invoked a hook. This
# relies on local-filesystem atomic mkdir/rename semantics; NFS behavior is not a
# supported integrity guarantee. GNU/BSD stat probes keep Linux/macOS portable.
rule_hits_write_locked() (
  local log_file="$1"
  local row="$2"
  local lock_dir="${log_file}.lock"
  local attempts="${AGENTSMD_LOG_LOCK_ATTEMPTS:-50}"
  local stale_seconds="${AGENTSMD_LOG_LOCK_STALE_SECONDS:-30}"
  local attempt=0
  local lock_pid="${BASHPID:-$$}"
  local lease_epoch="" lease_token=""
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || attempts=50
  [[ "$stale_seconds" =~ ^[1-9][0-9]*$ ]] || stale_seconds=30

  while ! mkdir "$lock_dir" 2>/dev/null; do
    if rule_hits_reap_stale "$lock_dir" "$stale_seconds"; then
      continue
    fi
    attempt=$((attempt + 1))
    (( attempt >= attempts )) && return 0
    sleep 0.01 2>/dev/null || sleep 1 2>/dev/null || return 0
  done

  lease_epoch=$(date +%s 2>/dev/null) || lease_epoch=""
  lease_token="${lock_pid}-${RANDOM:-0}-${lease_epoch}"
  [[ "$lease_epoch" =~ ^[0-9]+$ ]] || {
    rule_hits_release_owned_lock "$lock_dir"
    return 0
  }
  printf '%s %s %s\n' "$lease_epoch" "$lock_pid" "$lease_token" 2>/dev/null > "$lock_dir/lease" || {
    rule_hits_release_owned_lock "$lock_dir"
    return 0
  }
  rule_hits_unlock() {
    rule_hits_release_owned_lock "$lock_dir"
  }
  trap rule_hits_unlock EXIT
  trap 'exit 0' HUP INT TERM

  local max_mb="${AGENTSMD_LOG_MAX_MB:-5}"
  [[ "$max_mb" =~ ^[0-9]+$ ]] || max_mb=5
  local max_bytes=$((max_mb * 1024 * 1024))
  if [[ -f "$log_file" ]]; then
    local size
    size=$(rule_hits_file_size "$log_file")
    if (( size > max_bytes )); then
      [[ -f "$log_file.1" ]] && mv -f "$log_file.1" "$log_file.2" 2>/dev/null
      mv -f "$log_file" "$log_file.1" 2>/dev/null || return 0
    fi
  fi

  printf '%s\n' "$row" >> "$log_file" 2>/dev/null || return 0
)

rule_hits_emit() {
  [[ "${DISABLE_RULE_HITS_LOG:-0}" == "1" ]] && return 0

  local hook="${1:-unknown}"
  local event="${2:-unknown}"
  local extra="${3:-null}"
  local section="${4:-}"
  local session_id="${5:-}"
  local eligible="${6:-}"
  local evaluated="${7:-}"

  # Reserved test sentinel — the smoke/test suite uses session_id "smoke*"/"t";
  # keep real telemetry clean by dropping the bare `t` sentinel.
  [[ "$session_id" == "t" ]] && return 0

  local project_raw="${CODEX_PROJECT_DIR:-${PWD:-}}"
  local project=""
  [[ -n "$project_raw" ]] && project=$(printf '%s' "$project_raw" | tr -c 'a-zA-Z0-9-' '-')

  local log_dir="${CODEX_HOME:-$HOME/.codex}/logs"
  local log_file="$log_dir/agentsmd.jsonl"
  mkdir -p "$log_dir" 2>/dev/null || return 0

  local ts tag row=""
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  tag="${AGENTSMD_TELEMETRY_TAG:-}"

  if command -v jq >/dev/null 2>&1; then
    row=$(jq -cn \
      --arg ts "$ts" --arg hook "$hook" --arg event "$event" --arg project "$project" \
      --arg session_id "$session_id" --arg section "$section" --argjson extra "$extra" --arg tag "$tag" \
      --arg eligible "$eligible" --arg evaluated "$evaluated" \
      '{ts:$ts, hook:$hook, event:$event, project:$project,
        session_id:(if $session_id=="" then null else $session_id end),
        spec_section:(if $section=="" then null else $section end),
        extra:$extra}
        + (if $eligible=="" then {} else {eligible:($eligible=="true")} end)
        + (if $evaluated=="" then {} else {evaluated:($evaluated=="true")} end)
        + (if $tag=="" then {} else {tag:$tag} end)' 2>/dev/null) || return 0
  else
    local es eh ee ep esection tagfrag="" observationfrag=""
    es="$(rule_hits_json_escape "$session_id")"
    eh="$(rule_hits_json_escape "$hook")"
    ee="$(rule_hits_json_escape "$event")"
    ep="$(rule_hits_json_escape "$project")"
    esection="$(rule_hits_json_escape "$section")"
    [[ -n "$tag" ]] && tagfrag=",\"tag\":\"$(rule_hits_json_escape "$tag")\""
    if [[ -n "$eligible" ]]; then
      observationfrag=",\"eligible\":${eligible},\"evaluated\":${evaluated}"
    fi
    printf -v row '{"ts":"%s","hook":"%s","event":"%s","project":"%s","session_id":%s,"spec_section":%s,"extra":%s%s%s}' \
      "$ts" "$eh" "$ee" "$ep" \
      "$([[ -n "$es" ]] && printf '"%s"' "$es" || echo null)" \
      "$([[ -n "$esection" ]] && printf '"%s"' "$esection" || echo null)" \
      "$extra" "$observationfrag" "$tagfrag"
  fi

  [[ -n "$row" ]] || return 0
  rule_hits_write_locked "$log_file" "$row"
}

# rule_hits_append HOOK EVENT EXTRA_JSON [SPEC_SECTION] [SESSION_ID]
# Enforcement events remain separate from opportunity observations. The audit
# reader treats legacy enforcement rows as implicit eligible+evaluated checks.
rule_hits_append() {
  rule_hits_emit "${1:-unknown}" "${2:-unknown}" "${3:-null}" "${4:-}" "${5:-}"
}

# rule_hits_observe HOOK SPEC_SECTION SESSION_ID ELIGIBLE EVALUATED [EXTRA_JSON]
# Use for clean checks and fail-open checks. evaluated=true implies eligible=true.
rule_hits_observe() {
  local eligible="${4:-false}"
  local evaluated="${5:-false}"
  [[ "$eligible" == "true" ]] || eligible=false
  [[ "$evaluated" == "true" ]] || evaluated=false
  [[ "$evaluated" == "true" ]] && eligible=true
  rule_hits_emit "${1:-unknown}" "observe" "${6:-null}" "${2:-}" "${3:-}" "$eligible" "$evaluated"
}
