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

HOOK="session-start"
hook_kill_switch "SESSION_START" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || EVENT=""
SID="$(hook_json_field "$EVENT" '.session_id')"

# Refresh the per-session reference timestamp that sandbox-disposal-check.sh
# uses to detect THIS session's undisposed scratch dirs (§8.V4). Without this
# refresh the reference would freeze at the first-ever Stop and grow stale.
STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
mkdir -p "$STATE_DIR" 2>/dev/null && : > "$STATE_DIR/session-start.ref" 2>/dev/null || true
# Drop advisories queued by a PREVIOUS session's Stop hooks — but ONLY on a fresh
# start, never on `resume` (a resumed session continues, so a queued advisory from
# its last turn must survive to be surfaced at the next UserPromptSubmit).
SS_SOURCE="$(hook_json_field "$EVENT" '.source')"
if [[ "$SS_SOURCE" != "resume" ]]; then
  rm -f "$STATE_DIR/pending-advisories" 2>/dev/null || true
  rm -f "$(hook_advisory_file "$SID")" 2>/dev/null || true
fi

# Resolve spec version from the installed core spec, if present. The fallback is a
# non-version placeholder on purpose: a hardcoded vX.Y.Z here silently goes stale
# every release (drift.test.js guards against reintroducing one). If we cannot read
# the spec, we honestly do not know its version.
VER="unknown"
for spec in "${CODEX_HOME:-$HOME/.codex}/AGENTS.override.md" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"; do
  if [[ -r "$spec" ]]; then
    v="$(grep -m1 -oE 'CODEX-CODING-SPEC v[0-9]+\.[0-9]+\.[0-9]+' "$spec" 2>/dev/null | grep -oE 'v[0-9.]+')"
    [[ -n "$v" ]] && { VER="$v"; break; }
  fi
done

hook_record "$HOOK" "context" '{"phase":"session-start"}' '' "$SID"
hook_context \
  "[agentsmd] CODEX-CODING-SPEC ${VER} active — SPINE gates, Iron Laws, and §8 SAFETY apply. Native hooks enforce §8 (rm -rf \$VAR / remote-exec) and §10 banned-vocab on commits. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_AGENTSMD_HOOKS=1." \
  "SessionStart"
