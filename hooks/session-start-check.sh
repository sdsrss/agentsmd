#!/usr/bin/env bash
# session-start-check.sh — SessionStart. Injects a one-line agentsmd banner via
# hookSpecificOutput.additionalContext so each session confirms the spec is live
# and which enforcement layer is active. Phase-1 scope: static confirmation +
# spec-version read from the installed spec. Bootstrap-on-mismatch and upstream
# banners are Phase-3 (install/status tooling).

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

extract_spec_version() {
  local file="$1" token prerelease identifier
  token="$(grep -m1 -oE 'CODEX-CODING-SPEC v[^[:space:]]+' "$file" 2>/dev/null | sed -E 's/^CODEX-CODING-SPEC //')"
  [[ "$token" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || return 1
  prerelease="${BASH_REMATCH[5]:-}"
  if [[ -n "$prerelease" ]]; then
    while IFS= read -r identifier; do
      [[ "$identifier" =~ ^[0-9]+$ && ${#identifier} -gt 1 && "$identifier" == 0* ]] && return 1
    done < <(printf '%s\n' "$prerelease" | tr '.' '\n')
  fi
  printf '%s' "$token"
}

# Numeric MAJOR.MINOR.PATCH comparison, true when $1 is strictly newer than $2.
# Any prerelease/build suffix or non-numeric field returns false: a release
# candidate must never nag a user running the stable release it was cut from.
# 10# forces base-10 so a zero-padded field cannot be read as octal.
semver_gt() {
  local a1 a2 a3 b1 b2 b3
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  a1="${BASH_REMATCH[1]}"; a2="${BASH_REMATCH[2]}"; a3="${BASH_REMATCH[3]}"
  [[ "$2" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  b1="${BASH_REMATCH[1]}"; b2="${BASH_REMATCH[2]}"; b3="${BASH_REMATCH[3]}"
  (( 10#$a1 != 10#$b1 )) && { (( 10#$a1 > 10#$b1 )); return; }
  (( 10#$a2 != 10#$b2 )) && { (( 10#$a2 > 10#$b2 )); return; }
  (( 10#$a3 > 10#$b3 ))
}

HOOK="session-start"
hook_kill_switch "SESSION_START" || exit 0
# R1-03 degraded-mode persistent warning: without jq every enforcement hook
# fails open, so this is said EVERY session start, not once at install time.
# jq itself is unavailable on this path — the payload is a static literal, so
# hand-rolled JSON is safe (mirrors the rule-hits jq-less telemetry fallback).
hook_require_jq || {
  JQ_INSTALL="$(hook_tool_install_command jq)"
  hook_record_failopen "$HOOK" "jq-missing"
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[agentsmd] enforcement:false — jq is missing on PATH, so every agentsmd enforcement hook FAILS OPEN (no §8 blocks). Manual install command: %s. Restart Codex after installation, then run the agentsmd-doctor skill."}}\n' "$JQ_INSTALL"
  exit 0
}

write_plugin_activation_receipt() {
  local plugin_data="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"
  local plugin_version="$1" session_id="$2" profile="$3" profile_reason="$4" extended_path="$5"
  local runtime_dir tmp_file observed_at
  [[ -n "$plugin_data" && -n "$plugin_version" && -n "$session_id" && -n "$profile" \
    && -n "$profile_reason" && -n "$extended_path" ]] || return 0
  runtime_dir="$plugin_data/runtime"
  mkdir -p "$runtime_dir" 2>/dev/null || return 0
  chmod 700 "$runtime_dir" 2>/dev/null || true
  tmp_file="$(mktemp "$runtime_dir/.activation.XXXXXX" 2>/dev/null)" || return 0
  observed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || {
    rm -f -- "$tmp_file" 2>/dev/null || true
    return 0
  }
  if ! jq -cn \
      --arg pluginVersion "$plugin_version" \
      --arg sessionId "$session_id" \
      --arg observedAt "$observed_at" \
      --arg profile "$profile" \
      --arg profileReason "$profile_reason" \
      --arg extendedPath "$extended_path" \
      '{
        schemaVersion: 1,
        pluginVersion: $pluginVersion,
        sessionId: $sessionId,
        observedAt: $observedAt,
        profile: $profile,
        profileReason: $profileReason,
        extendedPath: $extendedPath
      }' > "$tmp_file" 2>/dev/null; then
    rm -f -- "$tmp_file" 2>/dev/null || true
    return 0
  fi
  chmod 600 "$tmp_file" 2>/dev/null || {
    rm -f -- "$tmp_file" 2>/dev/null || true
    return 0
  }
  mv -f -- "$tmp_file" "$runtime_dir/activation.json" 2>/dev/null || {
    rm -f -- "$tmp_file" 2>/dev/null || true
    return 0
  }
}

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"
EVENT_CWD="$(hook_json_field "$EVENT" '.cwd')"
TOOL_CONTEXT="$(hook_missing_tool_context "$EVENT_CWD")"

# Plugin-only skips the dual-surface fast-path above. SessionStart still computes
# one structural arbitration record so the banner names the candidate and reason.
# The inspector ALSO (re)writes the arbitration cache the cheap per-hook check
# consumes, so this is the once-per-session cache producer. Bound it with a
# wall-clock ceiling well under SessionStart's 5s budget: a slow codex probe must
# never kill this hook. On timeout/failure the banner degrades and any existing
# cache is left untouched (its freshness key protects it from going stale).
run_surface_inspector() {
  local inspector="$1"
  command -v node >/dev/null 2>&1 && [[ -r "$inspector" ]] || return 1
  if declare -F platform_timeout >/dev/null 2>&1; then
    platform_timeout 3 node "$inspector" --hook-json 2>/dev/null
  else
    node "$inspector" --hook-json 2>/dev/null
  fi
}
if [[ -n "${PLUGIN_ROOT:-}" && -z "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  SURFACE_ARBITRATION_JSON="$(run_surface_inspector "$PLUGIN_ROOT/scripts/lib/surface-arbitration.js")" || SURFACE_ARBITRATION_JSON=""
fi
if [[ -z "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  SURFACE_ARBITRATION_JSON="$(run_surface_inspector "$LIB_DIR/../../scripts/lib/surface-arbitration.js")" || SURFACE_ARBITRATION_JSON=""
fi

# Refresh the per-session reference timestamp that sandbox-disposal-check.sh
# uses to detect THIS session's undisposed scratch dirs (§8.V4). Without this
# refresh the reference would freeze at the first-ever Stop and grow stale.
STATE_DIR="$(hook_runtime_state_dir)"
LEGACY_STATE_DIR="$(hook_shared_state_dir)"
STATE_READ_DIRS=("$STATE_DIR")
[[ "$LEGACY_STATE_DIR" == "$STATE_DIR" ]] || STATE_READ_DIRS+=("$LEGACY_STATE_DIR")
SKEY="$(hook_session_key "$SID")"
mkdir -p "$STATE_DIR" 2>/dev/null && : > "$STATE_DIR/session-start-$SKEY.ref" 2>/dev/null || true
# SessionStart also is not proof that another key ended: sessions can remain
# resumable, and Stop is only a turn checkpoint. Do not blanket-GC other-session
# state. The cross-session views below consume only non-self flag/summary files
# older than seven days; fresh and self state remains untouched.
# Drop advisories and remote-download provenance only on a truly fresh startup.
# `resume`, `clear`, and `compact` all continue the same session: clearing state
# there would lose queued notices and let a previously downloaded unknown script
# escape the cross-tool §8 correlation gate. A missing source keeps the legacy
# fresh-start behavior used by older/synthetic harnesses.
SS_SOURCE="$(hook_json_field "$EVENT" '.source')"
if [[ -z "$SS_SOURCE" || "$SS_SOURCE" == "startup" ]]; then
  for cleanup_dir in "${STATE_READ_DIRS[@]}"; do
    [[ -n "$cleanup_dir" ]] || continue
    if [[ "$cleanup_dir" == "$STATE_DIR" ]]; then
      cleanup_file="$(hook_advisory_file "$SID")"
      cleanup_queue="$(hook_advisory_dir "$SID")"
    else
      cleanup_file="$(hook_legacy_advisory_file "$SID")"
      cleanup_queue="$(hook_legacy_advisory_dir "$SID")"
    fi
    rm -f "$cleanup_dir/pending-advisories" 2>/dev/null || true
    rm -f "$cleanup_file" 2>/dev/null || true
    rm -rf "$cleanup_dir/pending-advisories.d" 2>/dev/null || true
    rm -rf "$cleanup_queue" 2>/dev/null || true
    rm -f "$cleanup_dir/remote-downloads-$SKEY.paths" 2>/dev/null || true
  done
fi
for gc_dir in "${STATE_READ_DIRS[@]}"; do
  find "$gc_dir" -maxdepth 1 -type f -name 'remote-downloads-*.paths' -mtime +7 -delete 2>/dev/null || true
done

# Resolve the active spec. Standalone installs already place the core in Codex's
# discovery chain. Plugin-only installs do not, so a trusted plugin hook injects
# the packaged core and announces the packaged extended-spec path explicitly.
# The fallback remains version-neutral so release bumps cannot drift silently.
VER="unknown"
SPEC_FOUND=false
SPEC_ACTIVE=false
SPEC_CONTEXT=""
OVERRIDE_SPEC="${CODEX_HOME:-$HOME/.codex}/AGENTS.override.md"
GLOBAL_SPEC="${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
if [[ -e "$OVERRIDE_SPEC" || -L "$OVERRIDE_SPEC" ]]; then
  ACTIVE_GLOBAL_SPEC="$OVERRIDE_SPEC"
else
  ACTIVE_GLOBAL_SPEC="$GLOBAL_SPEC"
fi
if [[ -r "$ACTIVE_GLOBAL_SPEC" ]]; then
  v="$(extract_spec_version "$ACTIVE_GLOBAL_SPEC")"
  [[ -n "$v" ]] && { VER="$v"; SPEC_FOUND=true; SPEC_ACTIVE=true; }
fi

SELECTED_SURFACE=""
SELECTION_REASON=""
SELECTION_EXCLUSIVE=""
# True when arbitration ran but NO surface passed health checks. In that state a
# packaged plugin core may still be injected below, but it must be announced as a
# degraded fallback, not as a "selected" surface (the surface line says selected=none).
DEGRADED_NO_SURFACE=false
if [[ -n "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  SELECTED_SURFACE="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.selection.selected // empty' 2>/dev/null)"
  [[ -n "$SELECTED_SURFACE" ]] || DEGRADED_NO_SURFACE=true
  SELECTION_REASON="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.selection.reasonCode // empty' 2>/dev/null)"
  SELECTION_EXCLUSIVE="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.selection.exclusive // false' 2>/dev/null)"
  if [[ "$SELECTED_SURFACE" == "plugin" ]]; then
    SELECTED_VERSION="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.plugin.version // empty' 2>/dev/null)"
  elif [[ "$SELECTED_SURFACE" == "standalone" ]]; then
    SELECTED_VERSION="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.standalone.version // empty' 2>/dev/null)"
  else
    SELECTED_VERSION=""
  fi
  [[ -n "$SELECTED_VERSION" ]] && VER="v${SELECTED_VERSION}"
  [[ -n "$SELECTED_SURFACE" ]] || SPEC_ACTIVE=false
elif [[ -n "${PLUGIN_ROOT:-}" ]]; then
  # Fail open toward the currently executing plugin when the inspector is not
  # available: never let an unproved standalone silently hide its packaged spec.
  SELECTED_SURFACE="plugin"
  SELECTION_REASON="arbitration-unavailable"
  SELECTION_EXCLUSIVE="false"
fi
FORCE_PLUGIN_SPEC=false
[[ "$SELECTED_SURFACE" == "plugin" ]] && FORCE_PLUGIN_SPEC=true
[[ "$FORCE_PLUGIN_SPEC" == "true" ]] && SPEC_ACTIVE=false
if [[ ( "$SPEC_ACTIVE" != "true" || "$FORCE_PLUGIN_SPEC" == "true" ) && -n "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_BASE="$(cd "$PLUGIN_ROOT" 2>/dev/null && pwd -P)"
  PLUGIN_CORE="$PLUGIN_BASE/spec/AGENTS.md"
  PLUGIN_EXTENDED="$PLUGIN_BASE/spec/AGENTS-extended.md"
  SPEC_PROFILE="full"
  PROFILE_REASON="single-full-profile"
  if [[ -n "$PLUGIN_BASE" && -r "$PLUGIN_CORE" && -r "$PLUGIN_EXTENDED" ]]; then
    v="$(extract_spec_version "$PLUGIN_CORE")"
    if [[ -n "$v" ]]; then
      VER="$v"
      SPEC_ACTIVE=true
      SPEC_CONTEXT=$'\n'"[agentsmd plugin] profile=${SPEC_PROFILE}; reason=${PROFILE_REASON}. The packaged core spec follows. Extended spec: ${PLUGIN_EXTENDED} — read it on the core triggers."$'\n'"$(cat "$PLUGIN_CORE" 2>/dev/null)"
    fi
  fi
fi

if [[ -n "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  PLUGIN_VERSION="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.plugin.version // "unknown"' 2>/dev/null)"
  PLUGIN_HEALTH="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.plugin.healthy // false' 2>/dev/null)"
  STANDALONE_VERSION="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.standalone.version // "none"' 2>/dev/null)"
  STANDALONE_HEALTH="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.candidates.standalone.healthy // false' 2>/dev/null)"
  SURFACE_CONTEXT=$'\n'"[agentsmd surface] plugin=${PLUGIN_VERSION}/healthy:${PLUGIN_HEALTH}; standalone=${STANDALONE_VERSION}/healthy:${STANDALONE_HEALTH}; selected=${SELECTED_SURFACE:-none}; reason=${SELECTION_REASON:-unknown}; exclusive=${SELECTION_EXCLUSIVE:-false}."
elif [[ -n "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_VERSION="$(jq -r '.version // "unknown"' "$PLUGIN_ROOT/.codex-plugin/plugin.json" 2>/dev/null || printf 'unknown')"
  SURFACE_CONTEXT=$'\n'"[agentsmd surface] plugin=${PLUGIN_VERSION}/healthy:unknown; standalone=unknown/healthy:unknown; selected=plugin; reason=arbitration-unavailable; exclusive=false."
else
  SPEC_ACTIVE=false
  SELECTED_SURFACE="none"
  SURFACE_CONTEXT=$'\n'"[agentsmd surface] plugin=context-unavailable; standalone=${VER}/healthy:unknown; selected=none; reason=arbitration-unavailable; exclusive=unknown."
fi
if [[ "$SELECTED_SURFACE" == "plugin" && "$SPEC_ACTIVE" == "true" ]]; then
  write_plugin_activation_receipt \
    "$PLUGIN_VERSION" "$SID" "$SPEC_PROFILE" "$PROFILE_REASON" "$PLUGIN_EXTENDED"
fi

# Cross-session §7 safety net: surface only EXPIRED (>7-day) non-self checkpoint
# flags. A fresh OTHER flag may belong to a still-resumable session, so consuming
# it would guess that Stop meant SessionEnd. Delete only the expired files actually
# consumed here. Merged into the single banner below: a second hook_context call
# would emit a second JSON object on stdout, which Codex cannot parse.
CHECKPOINT=""
SELF_FLAG="unvalidated-$SKEY.flag"
CP_FOUND=0; CP_CWD=""
for checkpoint_dir in "${STATE_READ_DIRS[@]}"; do
  [[ -n "$checkpoint_dir" ]] || continue
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ "$(basename "$f")" == "$SELF_FLAG" ]] && continue
    CP_FOUND=$((CP_FOUND+1))
    c="$(grep -m1 '^cwd=' "$f" 2>/dev/null | cut -d= -f2-)"; [[ -n "$c" ]] && CP_CWD="$c"
    rm -f "$f" 2>/dev/null || true
  done < <(find "$checkpoint_dir" -maxdepth 1 -type f -name 'unvalidated-*.flag' -mtime +7 2>/dev/null)
done
if [[ "$CP_FOUND" -gt 0 ]]; then
  CHECKPOINT=$'\n'"[agentsmd §7] Expired session state records edits left unvalidated${CP_CWD:+ in $CP_CWD} (no test/lint/typecheck/build ran after the last mutation). If that work was reported done, re-verify — \"ran\" ≠ \"verified\" (§7 session-exit)."
fi

# Stale-deploy check — OFFLINE by construction (two local file reads, no network,
# no version lookup upstream). It catches the one drift nothing else catches
# without the user running doctor: the package was upgraded (npm / git pull) but
# `agentsmd update` never ran, so $CODEX_HOME keeps enforcing the OLD spec while
# every other signal says the new version is installed. Silent when the install
# predates the manifest's sourceRoot field, when the path is gone, or when the
# versions match — an unreadable source is not evidence of staleness. Skipped
# under a plugin selection: that surface runs from its own bundle, so a stale
# standalone deploy is not the spec it is executing.
STALE_DEPLOY=""
STALE_FLAG=false
if [[ "$SELECTED_SURFACE" != "plugin" ]]; then
  STATE_MANIFEST="$LEGACY_STATE_DIR/manifest.json"
  if [[ -r "$STATE_MANIFEST" ]]; then
    DEPLOYED_V="$(jq -r '.version // empty' "$STATE_MANIFEST" 2>/dev/null)"
    SRC_ROOT="$(jq -r '.sourceRoot // empty' "$STATE_MANIFEST" 2>/dev/null)"
    if [[ -n "$DEPLOYED_V" && "$SRC_ROOT" == /* && -r "$SRC_ROOT/package.json" ]]; then
      SOURCE_V="$(jq -r '.version // empty' "$SRC_ROOT/package.json" 2>/dev/null)"
      if semver_gt "$SOURCE_V" "$DEPLOYED_V"; then
        STALE_FLAG=true
        STALE_DEPLOY=$'\n'"[agentsmd] Stale deploy: ${CODEX_HOME:-$HOME/.codex} is enforcing v${DEPLOYED_V}, but the package it was installed from (${SRC_ROOT}) is now v${SOURCE_V}. Upgrading the package does NOT redeploy the spec or hooks. Run: agentsmd update — then agentsmd doctor."
      fi
    fi
  fi
fi

hook_record "$HOOK" "context" "{\"phase\":\"session-start\",\"deployStale\":${STALE_FLAG}}" '' "$SID"
if [[ "$SPEC_ACTIVE" == "true" && "$DEGRADED_NO_SURFACE" == "true" ]]; then
  # Packaged core injected, but arbitration selected no healthy surface. Say so —
  # the appended surface line reads selected=none, and the two must agree (N-03).
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} packaged core injected in a DEGRADED no-healthy-surface state — SPINE gates, Iron Laws, and §8 SAFETY policy apply, but no delivery surface passed health checks so enforcement-hook coverage is unverified. Run agentsmd doctor. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_AGENTSMD_HOOKS=1."
elif [[ "$SPEC_ACTIVE" == "true" ]]; then
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} selected — SPINE gates, Iron Laws, and §8 SAFETY apply. Native hooks cover selected detectable patterns, fail open on missing prerequisites, and are not a security boundary. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_AGENTSMD_HOOKS=1."
elif [[ "$SPEC_FOUND" == "true" ]]; then
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} was found, but surface health could not be verified; do not treat the policy or hooks as fully active. Run agentsmd status and agentsmd doctor."
else
  BANNER="[agentsmd] Native hooks are active, but no CODEX-CODING-SPEC core was found; SPINE/Iron-Law policy is not loaded. Reinstall the plugin or run the standalone installer."
fi
hook_context "${BANNER}${SURFACE_CONTEXT}${STALE_DEPLOY}${SPEC_CONTEXT}${CHECKPOINT}${TOOL_CONTEXT}" "SessionStart"
