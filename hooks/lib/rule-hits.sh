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

# Dispose one quarantined (renamed-away) lock generation. Quarantine content is
# dead garbage by construction (an expired lock's lease/pid plus the reap claim),
# so concurrent disposal by several processes is a safe idempotent double-delete.
# Only known entry names are removed — never recursive — and a dir that still
# refuses rmdir is left behind (fail-open) for the next sweep to retry.
rule_hits_dispose_quarantine() {
  local quarantine="$1"
  local attempt=0
  [[ "$quarantine" == *.lock.stale.* ]] || return 1
  rmdir "$quarantine/reap" 2>/dev/null
  rm -f "$quarantine/lease" "$quarantine/pid" 2>/dev/null
  while ! rmdir "$quarantine" 2>/dev/null; do
    [[ -d "$quarantine" ]] || return 0
    attempt=$((attempt + 1))
    (( attempt >= 20 )) && return 1
    rmdir "$quarantine/reap" 2>/dev/null
    rm -f "$quarantine/lease" "$quarantine/pid" 2>/dev/null
    sleep 0.01 2>/dev/null || sleep 1 2>/dev/null || return 1
  done
  return 0
}

# Self-heal quarantine orphans next to the live lock. A reaper can die (hook
# timeout SIGKILL) or hit a transient failure between its rename and its rmdir;
# without a sweep that orphan dir would persist forever. Depth-1 targeted glob
# on the `<lock>.stale.*` prefix only — the live lock dir is never touched.
rule_hits_sweep_quarantines() {
  local lock_dir="$1"
  local q
  for q in "$lock_dir".stale.*; do
    [[ -d "$q" ]] || continue
    rule_hits_dispose_quarantine "$q"
  done
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
  rule_hits_dispose_quarantine "$quarantine"
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
  local unique_event="${3:-}"
  local unique_session_id="${4:-}"
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

  # Session dimensions are a once-per-session join row. Deduplicate while
  # holding the same lock that serializes rotation+append, across every retained
  # segment, so concurrent SessionStart sources cannot each win. Other telemetry
  # passes no uniqueness key and keeps ordinary append semantics.
  if [[ -n "$unique_event" && -n "$unique_session_id" ]]; then
    local event_needle session_needle
    event_needle="\"event\":\"$(rule_hits_json_escape "$unique_event")\""
    session_needle="\"session_id\":\"$(rule_hits_json_escape "$unique_session_id")\""
    local candidate line
    for candidate in "$log_file.2" "$log_file.1" "$log_file"; do
      [[ -r "$candidate" ]] || continue
      while IFS= read -r line; do
        if [[ "$line" == *"$event_needle"* && "$line" == *"$session_needle"* ]]; then
          return 0
        fi
      done < "$candidate"
    done
  fi

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

  printf '%s\n' "$row" >> "$log_file" 2>/dev/null
  # Heal any quarantine orphan a dead/interrupted reaper left behind — every
  # successful write is a sweep opportunity, so orphans never outlive the next
  # telemetry row (D#79: CI observed one transient disposal failure persisting).
  rule_hits_sweep_quarantines "$lock_dir"
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

  local ts tag row="" event_id="" event_stamp="" event_nonce="" event_pid="" prior_seq=""
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  tag="${AGENTSMD_TELEMETRY_TAG:-}"
  # A reviewed outcome must join one exact blocking observation. Historical
  # rows cannot safely derive this from their second-resolution timestamp, so
  # only new block/deny rows receive an opaque ID. It contains no project,
  # session, command, path, or extra payload and costs no additional process.
  case "$event" in
    block|deny)
      event_stamp="${ts//[-:]/}"
      prior_seq="${_AGENTSMD_RULE_HITS_EVENT_SEQ:-0}"
      case "$prior_seq" in
        ''|*[!0-9]*) prior_seq=0 ;;
      esac
      [[ ${#prior_seq} -gt 9 ]] && prior_seq=0
      _AGENTSMD_RULE_HITS_EVENT_SEQ=$((10#$prior_seq + 1))
      event_nonce="${EPOCHREALTIME:-${RANDOM:-0}}"
      event_nonce="${event_nonce//[.]/}"
      case "$event_nonce" in
        ''|*[!0-9]*) event_nonce="${RANDOM:-0}" ;;
      esac
      [[ ${#event_nonce} -gt 24 ]] && event_nonce="${RANDOM:-0}"
      event_pid="${BASHPID:-$$}"
      case "$event_pid" in
        ''|*[!0-9]*) event_pid="$$" ;;
      esac
      [[ ${#event_pid} -gt 12 ]] && event_pid="$$"
      event_id="evt-${event_stamp}-${event_pid}-${event_nonce}-${_AGENTSMD_RULE_HITS_EVENT_SEQ}"
      ;;
  esac

  if command -v jq >/dev/null 2>&1; then
    row=$(jq -cn \
      --arg ts "$ts" --arg hook "$hook" --arg event "$event" --arg project "$project" \
      --arg session_id "$session_id" --arg section "$section" --argjson extra "$extra" --arg tag "$tag" \
      --arg eligible "$eligible" --arg evaluated "$evaluated" --arg event_id "$event_id" \
      '{ts:$ts, hook:$hook, event:$event, project:$project,
        session_id:(if $session_id=="" then null else $session_id end),
        spec_section:(if $section=="" then null else $section end),
        extra:$extra}
        + (if $event_id=="" then {} else {event_id:$event_id} end)
        + (if $eligible=="" then {} else {eligible:($eligible=="true")} end)
        + (if $evaluated=="" then {} else {evaluated:($evaluated=="true")} end)
        + (if $tag=="" then {} else {tag:$tag} end)' 2>/dev/null) || return 0
  else
    local es eh ee ep esection tagfrag="" observationfrag="" eventidfrag=""
    es="$(rule_hits_json_escape "$session_id")"
    eh="$(rule_hits_json_escape "$hook")"
    ee="$(rule_hits_json_escape "$event")"
    ep="$(rule_hits_json_escape "$project")"
    esection="$(rule_hits_json_escape "$section")"
    [[ -n "$tag" ]] && tagfrag=",\"tag\":\"$(rule_hits_json_escape "$tag")\""
    [[ -n "$event_id" ]] && eventidfrag=",\"event_id\":\"$(rule_hits_json_escape "$event_id")\""
    if [[ -n "$eligible" ]]; then
      observationfrag=",\"eligible\":${eligible},\"evaluated\":${evaluated}"
    fi
    printf -v row '{"ts":"%s","hook":"%s","event":"%s","project":"%s","session_id":%s,"spec_section":%s,"extra":%s%s%s%s}' \
      "$ts" "$eh" "$ee" "$ep" \
      "$([[ -n "$es" ]] && printf '"%s"' "$es" || echo null)" \
      "$([[ -n "$esection" ]] && printf '"%s"' "$esection" || echo null)" \
      "$extra" "$eventidfrag" "$observationfrag" "$tagfrag"
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

rule_hits_dimension_value() {
  local value="${1:-}"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  value="${value//$'\t'/ }"
  value="${value:0:256}"
  [[ -n "$value" ]] || value="unknown"
  printf '%s' "$value"
}

# rule_hits_session_dimension SESSION_ID SPEC AGENTSMD SURFACE CODEX MODEL PLATFORM
# One bounded top-level row supplies the version/surface join dimension for all
# other hot-path telemetry. It carries no prompt, command, path, output, or
# secret. Exact once is enforced under the shared telemetry lock above.
rule_hits_session_dimension() {
  [[ "${DISABLE_RULE_HITS_LOG:-0}" == "1" ]] && return 0

  local session_id
  session_id="$(rule_hits_dimension_value "${1:-}")"
  [[ "$session_id" == "t" ]] && return 0
  if [[ ! "$session_id" =~ ^[A-Za-z0-9._:-]+$ ]]; then session_id="unknown"; fi

  local spec_version agentsmd_version surface codex_version model platform
  spec_version="$(rule_hits_dimension_value "${2:-}")"
  agentsmd_version="$(rule_hits_dimension_value "${3:-}")"
  surface="$(rule_hits_dimension_value "${4:-}")"
  codex_version="$(rule_hits_dimension_value "${5:-}")"
  model="$(rule_hits_dimension_value "${6:-}")"
  platform="$(rule_hits_dimension_value "${7:-}")"

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
      --arg ts "$ts" --arg project "$project" --arg session_id "$session_id" \
      --arg spec_version "$spec_version" --arg agentsmd_version "$agentsmd_version" \
      --arg surface "$surface" --arg codex_version "$codex_version" \
      --arg model "$model" --arg platform "$platform" --arg tag "$tag" \
      '{
        ts:$ts,
        hook:"session-start",
        event:"session-dimension",
        project:$project,
        session_id:$session_id,
        spec_version:$spec_version,
        agentsmd_version:$agentsmd_version,
        surface:$surface,
        codex_version:$codex_version,
        model:$model,
        platform:$platform
      } + (if $tag=="" then {} else {tag:$tag} end)' 2>/dev/null) || return 0
  else
    local tag_fragment=""
    [[ -n "$tag" ]] && tag_fragment=",\"tag\":\"$(rule_hits_json_escape "$tag")\""
    printf -v row \
      '{"ts":"%s","hook":"session-start","event":"session-dimension","project":"%s","session_id":"%s","spec_version":"%s","agentsmd_version":"%s","surface":"%s","codex_version":"%s","model":"%s","platform":"%s"%s}' \
      "$(rule_hits_json_escape "$ts")" "$(rule_hits_json_escape "$project")" \
      "$(rule_hits_json_escape "$session_id")" "$(rule_hits_json_escape "$spec_version")" \
      "$(rule_hits_json_escape "$agentsmd_version")" "$(rule_hits_json_escape "$surface")" \
      "$(rule_hits_json_escape "$codex_version")" "$(rule_hits_json_escape "$model")" \
      "$(rule_hits_json_escape "$platform")" "$tag_fragment"
  fi
  [[ -n "$row" ]] || return 0
  rule_hits_write_locked "$log_file" "$row" "session-dimension" "$session_id"
}
