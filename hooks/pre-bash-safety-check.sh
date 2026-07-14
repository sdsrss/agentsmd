#!/usr/bin/env bash
# pre-bash-safety-check.sh — PreToolUse:Bash enforcement of spec/AGENTS.md §8
# (immutable SAFETY). Blocks:
#   1. `rm -rf $VAR` — recursive+force delete targeting an unvalidated variable
#      expansion (spec §8: "rm -rf $VAR without validating VAR"). No bypass: the
#      only way through is a mechanically-verified validation shape (realpath
#      canonicalization + non-empty + bounded literal prefix; see
#      markStrictlyValidatedRmTargets in lib/command-parse.js).
#   2. downloader output executed by an interpreter through a pipeline,
#      substitution, downloaded file, or a later same-session tool call —
#      unknown-origin remote script execution
#      (spec §8: "execute unknown-origin scripts"). No inline bypass; a reviewed
#      pinned source may be registered per-repo via `agentsmd exception add`
#      (.agentsmd/exceptions.json, fingerprint = exact URL + expiry). Cross-tool
#      correlation (running a previously-downloaded file) is never exemptable.
# Advises (non-blocking):
#   3. Unpinned `npx <pkg>` dependency-hygiene advice. Bypass: [allow-npx-unpinned].
#
# Fail-open: any missing prerequisite (jq, unreadable stdin) exits 0 silently
# (recorded via hook_record_failopen) so a broken hook never wedges the session.
# The shared quote-aware lexer distinguishes executable command positions from
# strings passed as data, and preserves expansion metadata for rm targets.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

HOOK="pre-bash-safety"
hook_kill_switch "PRE_BASH_SAFETY" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }

TOOL="$(hook_json_field "$EVENT" '.tool_name')"
[[ "$TOOL" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Fast-path: obviously read-only command → nothing to enforce.
hook_is_readonly_bash "$CMD" && exit 0

# Parse command positions, quotes, escapes, wrappers, expansions, and pipelines
# once. The shared lexer is also used by commit/ship hooks, avoiding whole-string
# matches that mistake data passed to echo/printf for executable shell syntax.
SAFETY="$(node "$LIB_DIR/command-parse.js" --safety "$CMD" 2>/dev/null)" || {
  hook_record_failopen "$HOOK" "command-parse-failed"
  exit 0
}
printf '%s' "$SAFETY" | jq -e 'type == "object"' >/dev/null 2>&1 || {
  hook_record_failopen "$HOOK" "command-parse-invalid"
  exit 0
}

# ── 1. rm -rf $VAR (immutable §8, no bypass) ─────────────────────────────────
if [[ "$(printf '%s' "$SAFETY" | jq -r '.rmRfCandidate // false')" == "true" ]]; then
  hook_observe "$HOOK" '§8-rm-rf-var' "$SID" true true '{"candidate":"rm-rf"}'
  if [[ "$(printf '%s' "$SAFETY" | jq -r '.rmRfVar // false')" == "true" ]]; then
    hook_record "$HOOK" "block" '{"pattern":"rm-rf-var"}' '§8-rm-rf-var' "$SID"
    hook_block \
      "Blocked: rm -rf on an unvalidated variable ( spec/AGENTS.md §8, immutable )." \
      "§8 SAFETY (immutable): 'rm -rf \$VAR without validating VAR' is banned. Validate mechanically, e.g.: SAFE=\"\$(realpath -- \"\$VAR\")\" && [[ -n \"\$SAFE\" && \"\$SAFE\" == /tmp/* ]] && rm -rf \"\$SAFE\" — the bounded prefix may be /tmp/* or a literal absolute path of two or more segments. Command: ${CMD}" \
      "PreToolUse"
  fi
fi

# ── 2. remote download executed by an interpreter (immutable §8) ────────────
REMOTE_EXEC="$(printf '%s' "$SAFETY" | jq -r '.remoteExec // false')"
REMOTE_KIND="same-tool"
SKEY="$(hook_session_key "$SID")"
REMOTE_STATE="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state/remote-downloads-$SKEY.paths"
remember_remote_path() {
  local download_path="$1" resolved
  [[ -n "$download_path" && "$SKEY" != "global" ]] || return 0
  resolved="$(node -e 'const p=require("path");process.stdout.write(p.resolve(process.argv[1],process.argv[2]));' "$CWD" "$download_path" 2>/dev/null)"
  [[ -n "$resolved" ]] || return 0
  mkdir -p "$(dirname "$REMOTE_STATE")" 2>/dev/null || return 0
  grep -Fxq -- "$resolved" "$REMOTE_STATE" 2>/dev/null || printf '%s\n' "$resolved" >> "$REMOTE_STATE" 2>/dev/null || true
}
if [[ "$SKEY" != "global" && -r "$REMOTE_STATE" ]]; then
  REMOTE_SNAPSHOT="$(cat "$REMOTE_STATE" 2>/dev/null)"
  while IFS= read -r remote_path; do
    [[ -n "$remote_path" && -f "$remote_path" ]] || continue
    if [[ "$(node "$LIB_DIR/command-parse.js" --executes-file "$CMD" "$remote_path" "$CWD" 2>/dev/null)" == "true" ]]; then
      REMOTE_EXEC=true
      REMOTE_KIND="cross-tool"
      break
    fi
    while IFS= read -r propagated_path; do
      remember_remote_path "$propagated_path"
    done < <(node "$LIB_DIR/command-parse.js" --propagates-file "$CMD" "$remote_path" "$CWD" 2>/dev/null | jq -r '.[]?' 2>/dev/null)
  done <<< "$REMOTE_SNAPSHOT"
fi

if [[ "$REMOTE_EXEC" == "true" ]]; then
  hook_observe "$HOOK" '§8-unknown-script' "$SID" true true \
    "$(jq -cn --arg c "$REMOTE_KIND" '{candidate:"remote-exec",correlation:$c}' 2>/dev/null || echo null)"
  # Structured exception (R1-01): every literal download URL in this command must
  # carry a live registered exception. Cross-tool correlation, expansion-bearing
  # URLs, and substitution shapes yield zero collectable URLs → no exemption.
  EXC_ALLOW=false EXC_IDS="" EXC_EXPIRED_ID=""
  if [[ "$REMOTE_KIND" == "same-tool" ]] && EXC_FILE="$(hook_exceptions_file "$CWD")"; then
    EXC_URL_COUNT="$(printf '%s' "$SAFETY" | jq -r '.remoteUrls | length' 2>/dev/null)"
    if [[ "$EXC_URL_COUNT" =~ ^[0-9]+$ && "$EXC_URL_COUNT" -ge 1 ]]; then
      EXC_ALLOW=true
      while IFS= read -r exc_url; do
        [[ -n "$exc_url" ]] || continue
        EXC_STATE="$(hook_exception_state "$EXC_FILE" '§8-unknown-script' \
          '.detector == "url" and (.fingerprint.url // "") == $url' --arg url "$exc_url")"
        case "$EXC_STATE" in
          live:?*) EXC_IDS="$EXC_IDS ${EXC_STATE#live:}" ;;
          expired:?*) EXC_ALLOW=false; EXC_EXPIRED_ID="${EXC_STATE#expired:}" ;;
          *) EXC_ALLOW=false ;;
        esac
      done < <(printf '%s' "$SAFETY" | jq -r '.remoteUrls[]?' 2>/dev/null)
    fi
  fi
  if [[ "$EXC_ALLOW" == "true" ]]; then
    for exc_id in $EXC_IDS; do
      hook_record "$HOOK" "exception" \
        "$(jq -cn --arg i "$exc_id" '{id:$i,detector:"url"}' 2>/dev/null || echo null)" \
        '§8-unknown-script' "$SID"
    done
  else
    if [[ -n "$EXC_EXPIRED_ID" ]]; then
      hook_record "$HOOK" "exception-expired" \
        "$(jq -cn --arg i "$EXC_EXPIRED_ID" '{id:$i,detector:"url"}' 2>/dev/null || echo null)" \
        '§8-unknown-script' "$SID"
    fi
    hook_record "$HOOK" "block" "$(jq -cn --arg c "$REMOTE_KIND" '{pattern:"remote-exec",correlation:$c}' 2>/dev/null || echo null)" '§8-unknown-script' "$SID"
    hook_block \
      "Blocked: executing an uninspected remote download ( spec/AGENTS.md §8, immutable )." \
      "§8 SAFETY (immutable): 'execute unknown-origin scripts' is banned. Download to a file, inspect it, then run it. A reviewed pinned source may be registered per-repo: agentsmd exception add --rule §8-unknown-script --url <exact-url> --reason '<why>'${EXC_EXPIRED_ID:+ (a matching exception exists but has EXPIRED — re-review and re-register)}. Command: ${CMD}" \
      "PreToolUse"
  fi
fi

# Remember statically-resolved download destinations and derived cp/mv/ln/install
# paths for this session. The next PreToolUse treats them as provenance only when
# the recorded source exists. State is bounded and session-scoped.
if [[ "$SKEY" != "global" ]]; then
  while IFS= read -r download_path; do
    remember_remote_path "$download_path"
  done < <(printf '%s' "$SAFETY" | jq -r '.downloads[]?')
  if [[ -r "$REMOTE_STATE" && "$(wc -l < "$REMOTE_STATE" 2>/dev/null || echo 0)" -gt 20 ]]; then
    tail -n 20 "$REMOTE_STATE" > "$REMOTE_STATE.tmp" 2>/dev/null && mv -f "$REMOTE_STATE.tmp" "$REMOTE_STATE" 2>/dev/null
  fi
fi

# ── 3. unpinned npx (non-safety dependency-hygiene advisory) ────────────────
cmd_npx_unpinned() {
  local c="$1"
  [[ "$c" == *"[allow-npx-unpinned]"* ]] && return 1
  printf '%s' "$c" | grep -qiE '(^|[;&|`(]|[[:space:]])npx([[:space:]]+-{1,2}[a-z-]+)*[[:space:]]+[@a-z]' || return 1
  # a pinned @version anywhere in the npx invocation → treat as pinned
  printf '%s' "$c" | grep -qiE 'npx[[:space:]].*[^[:space:]]+@[0-9]' && return 1
  return 0
}

if cmd_npx_unpinned "$CMD"; then
  hook_record "$HOOK" "advisory" '{"pattern":"npx-unpinned"}' 'advisory-npx-unpinned' "$SID"
  hook_advisory \
    "[agentsmd dependency hygiene] Unpinned 'npx <pkg>' executes a mutable package version. Prefer a lockfile/local binary, pin pkg@x.y.z, or append [allow-npx-unpinned] when intentional." \
    "PreToolUse"
fi

exit 0
