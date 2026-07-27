#!/usr/bin/env bash
# surface-advisories.sh — UserPromptSubmit. Surfaces advisories that the Stop
# hooks (residue-audit / sandbox-disposal / transcript-structure-scan) queued at
# the end of the previous turn, via additionalContext on UserPromptSubmit — the
# verified surfacing channel (Stop additionalContext is not). Reads + clears the
# pending queue so each advisory is shown once. session-start-check.sh clears the
# queue at session boundaries, keeping advisories session-scoped.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="surface-advisories"
hook_kill_switch "SURFACE_ADVISORIES" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

PENDING_DIR="$(hook_advisory_dir "$SID")"
SINGLE_FILE="$(hook_advisory_file "$SID")"
LEGACY_PENDING_DIR="$(hook_legacy_advisory_dir "$SID")"
LEGACY_SINGLE_FILE="$(hook_legacy_advisory_file "$SID")"
MSG=""

# Claim each pending advisory by renaming it into a private per-consumer dir. A
# rename an interleaving consumer already won simply fails, so a message is never
# surfaced twice, and a producer writing a new file after the claim scan keeps it
# pending for the next turn rather than losing it. Concatenate in name (arrival)
# order, matching what the single-file consumer emitted before.
consume_advisory_paths() {
  local pending_dir="$1" single_file="$2" claim="" f="" c="" legacy_msg=""
  claim="$pending_dir/.claim-$$"
  if [[ -d "$pending_dir" ]] && mkdir "$claim" 2>/dev/null; then
    for f in "$pending_dir"/[0-9]*; do
      [[ -f "$f" ]] || continue
      mv "$f" "$claim/" 2>/dev/null || continue
    done
    for c in "$claim"/[0-9]*; do
      [[ -f "$c" ]] || continue
      MSG+="$(cat "$c" 2>/dev/null)"$'\n'
    done
    rm -rf "$claim" 2>/dev/null || true
  fi

  # Migrate a ≤4.3.0 single-file queue: surface its lines once, then remove it.
  if [[ -s "$single_file" ]]; then
    legacy_msg="$(cat "$single_file" 2>/dev/null)"
    rm -f "$single_file" 2>/dev/null || true
    [[ -n "$legacy_msg" ]] && MSG+="$legacy_msg"$'\n'
  fi
}

consume_advisory_paths "$PENDING_DIR" "$SINGLE_FILE"
if [[ "$LEGACY_PENDING_DIR" != "$PENDING_DIR" || "$LEGACY_SINGLE_FILE" != "$SINGLE_FILE" ]]; then
  consume_advisory_paths "$LEGACY_PENDING_DIR" "$LEGACY_SINGLE_FILE"
fi

MSG="${MSG%$'\n'}"
[[ -n "$MSG" ]] || exit 0

hook_record "$HOOK" "surface" 'null' '' "$SID"
hook_context \
  "[agentsmd] Advisories from your previous turn (address or acknowledge):"$'\n'"${MSG}" \
  "UserPromptSubmit"
