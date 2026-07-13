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

HOOK="session-start"
hook_kill_switch "SESSION_START" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

# Plugin-only skips the dual-surface fast-path above. SessionStart still computes
# one structural arbitration record so the banner names the candidate and reason.
if [[ -n "${PLUGIN_ROOT:-}" && -z "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  INSPECTOR="$PLUGIN_ROOT/scripts/lib/surface-arbitration.js"
  if command -v node >/dev/null 2>&1 && [[ -r "$INSPECTOR" ]]; then
    SURFACE_ARBITRATION_JSON="$(node "$INSPECTOR" --hook-json 2>/dev/null)" || SURFACE_ARBITRATION_JSON=""
  fi
fi
if [[ -z "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  INSPECTOR="$LIB_DIR/../../scripts/lib/surface-arbitration.js"
  if command -v node >/dev/null 2>&1 && [[ -r "$INSPECTOR" ]]; then
    SURFACE_ARBITRATION_JSON="$(node "$INSPECTOR" --hook-json 2>/dev/null)" || SURFACE_ARBITRATION_JSON=""
  fi
fi

# Refresh the per-session reference timestamp that sandbox-disposal-check.sh
# uses to detect THIS session's undisposed scratch dirs (§8.V4). Without this
# refresh the reference would freeze at the first-ever Stop and grow stale.
STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
SKEY="$(hook_session_key "$SID")"
mkdir -p "$STATE_DIR" 2>/dev/null && : > "$STATE_DIR/session-start-$SKEY.ref" 2>/dev/null || true
# SessionStart also is not proof that another key ended: sessions can remain
# resumable, and Stop is only a turn checkpoint. Do not blanket-GC other-session
# state. The cross-session views below consume only non-self flag/summary files
# older than seven days; fresh and self state remains untouched.
# Drop advisories queued by a PREVIOUS session's Stop hooks — but ONLY on a fresh
# start, never on `resume` (a resumed session continues, so a queued advisory from
# its last turn must survive to be surfaced at the next UserPromptSubmit).
SS_SOURCE="$(hook_json_field "$EVENT" '.source')"
if [[ "$SS_SOURCE" != "resume" ]]; then
  rm -f "$STATE_DIR/pending-advisories" 2>/dev/null || true
  rm -f "$(hook_advisory_file "$SID")" 2>/dev/null || true
  rm -f "$STATE_DIR/remote-downloads-$SKEY.paths" 2>/dev/null || true
fi
find "$STATE_DIR" -maxdepth 1 -type f -name 'remote-downloads-*.paths' -mtime +7 -delete 2>/dev/null || true

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
if [[ -n "${SURFACE_ARBITRATION_JSON:-}" ]]; then
  SELECTED_SURFACE="$(printf '%s' "$SURFACE_ARBITRATION_JSON" | jq -r '.selection.selected // empty' 2>/dev/null)"
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
  if [[ -n "$PLUGIN_BASE" && -r "$PLUGIN_CORE" && -r "$PLUGIN_EXTENDED" ]]; then
    v="$(extract_spec_version "$PLUGIN_CORE")"
    if [[ -n "$v" ]]; then
      VER="$v"
      SPEC_ACTIVE=true
      SPEC_CONTEXT=$'\n'"[agentsmd plugin] The packaged core spec follows. Extended spec: ${PLUGIN_EXTENDED} — read it on the core triggers."$'\n'"$(cat "$PLUGIN_CORE" 2>/dev/null)"
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

# Cross-session §7 safety net: surface only EXPIRED (>7-day) non-self checkpoint
# flags. A fresh OTHER flag may belong to a still-resumable session, so consuming
# it would guess that Stop meant SessionEnd. Delete only the expired files actually
# consumed here. Merged into the single banner below: a second hook_context call
# would emit a second JSON object on stdout, which Codex cannot parse.
CHECKPOINT=""
SELF_FLAG="unvalidated-$SKEY.flag"
CP_FOUND=0; CP_CWD=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$(basename "$f")" == "$SELF_FLAG" ]] && continue
  CP_FOUND=$((CP_FOUND+1))
  c="$(grep -m1 '^cwd=' "$f" 2>/dev/null | cut -d= -f2-)"; [[ -n "$c" ]] && CP_CWD="$c"
  rm -f "$f" 2>/dev/null || true
done < <(find "$STATE_DIR" -maxdepth 1 -type f -name 'unvalidated-*.flag' -mtime +7 2>/dev/null)
if [[ "$CP_FOUND" -gt 0 ]]; then
  CHECKPOINT=$'\n'"[agentsmd §7] Expired session state records edits left unvalidated${CP_CWD:+ in $CP_CWD} (no test/lint/typecheck/build ran after the last mutation). If that work was reported done, re-verify — \"ran\" ≠ \"verified\" (§7 session-exit)."
fi

hook_record "$HOOK" "context" '{"phase":"session-start"}' '' "$SID"
if [[ "$SPEC_ACTIVE" == "true" ]]; then
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} selected — SPINE gates, Iron Laws, and §8 SAFETY apply. Native hooks cover selected detectable patterns, fail open on missing prerequisites, and are not a security boundary. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_AGENTSMD_HOOKS=1."
elif [[ "$SPEC_FOUND" == "true" ]]; then
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} was found, but surface health could not be verified; do not treat the policy or hooks as fully active. Run agentsmd status and agentsmd doctor."
else
  BANNER="[agentsmd] Native hooks are active, but no CODEX-CODING-SPEC core was found; SPINE/Iron-Law policy is not loaded. Reinstall the plugin or run the standalone installer."
fi
hook_context "${BANNER}${SURFACE_CONTEXT}${SPEC_CONTEXT}${CHECKPOINT}" "SessionStart"
