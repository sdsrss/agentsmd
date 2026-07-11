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

HOOK="session-start"
hook_kill_switch "SESSION_START" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

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
SPEC_ACTIVE=false
SPEC_CONTEXT=""
for spec in "${CODEX_HOME:-$HOME/.codex}/AGENTS.override.md" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"; do
  if [[ -r "$spec" ]]; then
    v="$(grep -m1 -oE 'CODEX-CODING-SPEC v[0-9]+\.[0-9]+\.[0-9]+' "$spec" 2>/dev/null | grep -oE 'v[0-9.]+')"
    [[ -n "$v" ]] && { VER="$v"; SPEC_ACTIVE=true; break; }
  fi
done
if [[ "$SPEC_ACTIVE" != "true" && -n "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_BASE="$(cd "$PLUGIN_ROOT" 2>/dev/null && pwd -P)"
  PLUGIN_CORE="$PLUGIN_BASE/spec/AGENTS.md"
  PLUGIN_EXTENDED="$PLUGIN_BASE/spec/AGENTS-extended.md"
  if [[ -n "$PLUGIN_BASE" && -r "$PLUGIN_CORE" && -r "$PLUGIN_EXTENDED" ]]; then
    v="$(grep -m1 -oE 'CODEX-CODING-SPEC v[0-9]+\.[0-9]+\.[0-9]+' "$PLUGIN_CORE" 2>/dev/null | grep -oE 'v[0-9.]+')"
    if [[ -n "$v" ]]; then
      VER="$v"
      SPEC_ACTIVE=true
      SPEC_CONTEXT=$'\n'"[agentsmd plugin] The packaged core spec follows. Extended spec: ${PLUGIN_EXTENDED} — read it on the core triggers."$'\n'"$(cat "$PLUGIN_CORE" 2>/dev/null)"
    fi
  fi
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
  BANNER="[agentsmd] CODEX-CODING-SPEC ${VER} active — SPINE gates, Iron Laws, and §8 SAFETY apply. Native hooks enforce §8 (rm -rf \$VAR / remote-exec) and §10 banned-vocab on commits. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_AGENTSMD_HOOKS=1."
else
  BANNER="[agentsmd] Native hooks are active, but no CODEX-CODING-SPEC core was found; SPINE/Iron-Law policy is not loaded. Reinstall the plugin or run the standalone installer."
fi
hook_context "${BANNER}${SPEC_CONTEXT}${CHECKPOINT}" "SessionStart"
