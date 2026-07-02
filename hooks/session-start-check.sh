#!/usr/bin/env bash
# session-start-check.sh — SessionStart. Injects a one-line codexmd banner via
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

# Resolve spec version from the installed core spec, if present.
VER="v1.4.0"
for spec in "${CODEX_HOME:-$HOME/.codex}/AGENTS.override.md" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"; do
  if [[ -r "$spec" ]]; then
    v="$(grep -m1 -oE 'CODEX-CODING-SPEC v[0-9]+\.[0-9]+\.[0-9]+' "$spec" 2>/dev/null | grep -oE 'v[0-9.]+')"
    [[ -n "$v" ]] && { VER="$v"; break; }
  fi
done

hook_record "$HOOK" "context" '{"phase":"session-start"}' '' "$SID"
hook_context \
  "[codexmd] CODEX-CODING-SPEC ${VER} active — SPINE gates, Iron Laws, and §8 SAFETY apply. Native hooks enforce §8 (rm -rf \$VAR / remote-exec) and §10 banned-vocab on commits. Toggle any hook with DISABLE_<NAME>_HOOK=1; disable all with DISABLE_CODEXMD_HOOKS=1." \
  "SessionStart"
