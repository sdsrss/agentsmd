#!/usr/bin/env bash
# rule-hits.sh — append-only JSONL telemetry for agentsmd's closed-loop data plane.
# Ported from claudemd hooks/lib/rule-hits.sh. Log path retargeted to
# ~/.codex/logs/agentsmd.jsonl (Codex home, not ~/.claude). Feeds scripts/audit.js
# bySection aggregation → hit-rate promote/demote governance (ARCHITECTURE.md §4).

# rule_hits_append HOOK EVENT EXTRA_JSON [SPEC_SECTION] [SESSION_ID]
#   HOOK        — hook name (pre-bash-safety, banned-vocab, session-start, ...)
#   EVENT       — deny | block | advisory | context | fail-open | bootstrap | ...
#   EXTRA       — JSON value (object | null | string). "null" if none.
#   SECTION     — spec section id for promote/demote accounting (e.g. §8-rm-rf-var).
#                 Empty → null. Hooks not enforcing a spec rule leave it empty.
#   SESSION_ID  — Codex session id from stdin `.session_id`. Empty → null.
rule_hits_append() {
  [[ "${DISABLE_RULE_HITS_LOG:-0}" == "1" ]] && return 0

  local hook="${1:-unknown}"
  local event="${2:-unknown}"
  local extra="${3:-null}"
  local section="${4:-}"
  local session_id="${5:-}"

  # Reserved test sentinel — the smoke/test suite uses session_id "smoke*"/"t";
  # keep real telemetry clean by dropping the bare `t` sentinel (matches claudemd).
  [[ "$session_id" == "t" ]] && return 0

  # Project field: encode cwd the way a per-project telemetry consumer expects —
  # replace every non-[a-zA-Z0-9-] char with `-`. Codex may not export a project
  # dir env in hooks, so fall back to PWD.
  local project_raw="${CODEX_PROJECT_DIR:-${PWD:-}}"
  local project=""
  [[ -n "$project_raw" ]] && project=$(printf '%s' "$project_raw" | tr -c 'a-zA-Z0-9-' '-')

  local log_dir="${CODEX_HOME:-$HOME/.codex}/logs"
  local log_file="$log_dir/agentsmd.jsonl"
  mkdir -p "$log_dir" 2>/dev/null || return 0

  # Size-capped rotation (default 5 MB → .1, pushing .1 → .2, drop .2).
  local max_mb="${AGENTSMD_LOG_MAX_MB:-5}"
  [[ "$max_mb" =~ ^[0-9]+$ ]] || max_mb=5
  local max_bytes=$((max_mb * 1024 * 1024))
  if [[ -f "$log_file" ]]; then
    local size
    size=$(stat -c %s "$log_file" 2>/dev/null || stat -f %z "$log_file" 2>/dev/null || echo 0)
    if (( size > max_bytes )); then
      [[ -f "$log_file.1" ]] && mv -f "$log_file.1" "$log_file.2" 2>/dev/null
      mv -f "$log_file" "$log_file.1" 2>/dev/null
    fi
  fi

  local ts tag
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Optional provenance tag (e.g. AGENTSMD_TELEMETRY_TAG=test for verification runs
  # against a real CODEX_HOME). Written only when set; scripts/audit.js excludes
  # tagged non-production rows by default so a smoke/verify run never skews the
  # promote/demote ledger. Best practice remains sandboxing CODEX_HOME (OPERATOR §O4).
  tag="${AGENTSMD_TELEMETRY_TAG:-}"

  if command -v jq >/dev/null 2>&1; then
    jq -cn \
      --arg ts "$ts" --arg hook "$hook" --arg event "$event" --arg project "$project" \
      --arg session_id "$session_id" --arg section "$section" --argjson extra "$extra" --arg tag "$tag" \
      '{ts:$ts, hook:$hook, event:$event, project:$project,
        session_id:(if $session_id=="" then null else $session_id end),
        spec_section:(if $section=="" then null else $section end),
        extra:$extra} + (if $tag=="" then {} else {tag:$tag} end)' \
      2>/dev/null >> "$log_file" || return 0
  else
    # jq-less fallback: minimal hand-escaped row so telemetry survives without jq.
    local es eh ee ep esection
    rule_hits_json_escape() {
      local s="${1:-}"
      s="${s//\\/\\\\}"
      s="${s//\"/\\\"}"
      s="${s//$'\n'/\\n}"
      s="${s//$'\r'/\\r}"
      s="${s//$'\t'/\\t}"
      printf '%s' "$s"
    }
    es="$(rule_hits_json_escape "$session_id")"
    eh="$(rule_hits_json_escape "$hook")"
    ee="$(rule_hits_json_escape "$event")"
    ep="$(rule_hits_json_escape "$project")"
    esection="$(rule_hits_json_escape "$section")"
    local tagfrag=""
    [[ -n "$tag" ]] && tagfrag=",\"tag\":\"$(rule_hits_json_escape "$tag")\""
    printf '{"ts":"%s","hook":"%s","event":"%s","project":"%s","session_id":%s,"spec_section":%s,"extra":%s%s}\n' \
      "$ts" "$eh" "$ee" "$ep" \
      "$([[ -n "$es" ]] && printf '"%s"' "$es" || echo null)" \
      "$([[ -n "$esection" ]] && printf '"%s"' "$esection" || echo null)" \
      "$extra" "$tagfrag" >> "$log_file" 2>/dev/null || return 0
  fi
}
