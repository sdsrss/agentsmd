#!/usr/bin/env bash
# ship-baseline-check.sh — PreToolUse:Bash. Observes the latest GitHub run for a
# shared target branch and blocks only a conclusively known-red baseline. Full,
# local, and fresh validation remain the pusher's §E3 checklist responsibility.
# Bypass: [allow-red-ship] records acceptance of the known-red baseline.
#
# Branch resolution: prefer the branch named in the push command
# (`git push <remote> <branch>`), else the current branch via git rev-parse.
# Shared = main|master|develop|dev|release[/-]*|releases/*|prod[/-]*|production
# (local/feature branches skip).
# Freshness: the run's headSha + createdAt are captured and surfaced in the block
# + telemetry so a human can judge whether a green is stale. Blocking a
# stale-GREEN (base tip ahead of the last CI run) is intentionally NOT done here:
# it needs the true remote tip, which a fast fail-open hook can't resolve reliably
# without false positives — deferred to the pusher's §E3 gate.
# Fail-open: gh missing / not a GitHub repo / no runs / timeout → exit 0.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
# shellcheck source=/dev/null
source "$LIB_DIR/platform.sh" 2>/dev/null || true

HOOK="ship-baseline"
hook_kill_switch "SHIP_BASELINE" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

INVOCATIONS="$(hook_git_invocations_json 'push' "$CMD")"
[[ -n "$INVOCATIONS" && "$INVOCATIONS" != "[]" ]] || exit 0

ship_unevaluated() {
  local branch="$1" reason="$2"
  hook_observe "$HOOK" '§E3-ship-baseline' "$SID" true false \
    "$(jq -cn --arg b "$branch" --arg r "$reason" '{branch:$b,reason:$r}' 2>/dev/null || echo null)"
}

check_push_invocation() {
  local invocation="$1" branch repo_arg run_json conclusion status headsha created shortsha
  local -a git_repo=(-C "$CWD") branches=()
  while IFS= read -r repo_arg; do
    [[ -n "$repo_arg" ]] && git_repo+=("$repo_arg")
  done < <(printf '%s' "$invocation" | jq -r '.repoArgs[]' 2>/dev/null)
  while IFS= read -r branch; do
    [[ -n "$branch" ]] && branches+=("$branch")
  done < <(printf '%s' "$invocation" | jq -r '
    .args as $a
    | reduce range(0; $a|length) as $i
        ({skip:false, positional:[]};
         if .skip then .skip=false
         elif ($a[$i] == "--push-option" or $a[$i] == "-o" or $a[$i] == "--repo"
               or $a[$i] == "--receive-pack" or $a[$i] == "--exec") then .skip=true
         elif ($a[$i] | startswith("-")) then .
         else .positional += [$a[$i]] end)
    | .positional[1:][]' 2>/dev/null)
  if (( ${#branches[@]} == 0 )); then
    branch="$(git "${git_repo[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    [[ -n "$branch" ]] && branches+=("$branch")
  fi

  for branch in "${branches[@]}"; do
    branch="${branch#+}"
    [[ "$branch" == *:* ]] && branch="${branch##*:}"
    [[ "$branch" == refs/heads/* ]] && branch="${branch#refs/heads/}"
    [[ -n "$branch" && "$branch" != "HEAD" ]] || continue
    case "$branch" in
      main|master|develop|dev|release|release/*|release-*|releases/*|prod|prod/*|prod-*|production) : ;;
      *) continue ;;
    esac

    if [[ "$CMD" == *"[allow-red-ship]"* ]]; then
      ship_unevaluated "$branch" "bypass"
      hook_record "$HOOK" "bypass" '{"token":"allow-red-ship"}' '§E3-ship-baseline' "$SID"
      continue
    fi
    if ! command -v gh >/dev/null 2>&1; then
      ship_unevaluated "$branch" "gh-missing"
      hook_record_failopen "$HOOK" "gh-missing"
      continue
    fi

    run_json="$(platform_timeout 5 gh run list --branch "$branch" --limit 1 --json conclusion,status,headSha,createdAt 2>/dev/null)" || run_json=""
    if [[ -z "$run_json" ]]; then
      ship_unevaluated "$branch" "gh-noreply"
      hook_record_failopen "$HOOK" "gh-noreply"
      continue
    fi
    if ! printf '%s' "$run_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
      ship_unevaluated "$branch" "gh-invalid-json"
      hook_record_failopen "$HOOK" "gh-invalid-json"
      continue
    fi
    conclusion="$(printf '%s' "$run_json" | jq -r '.[0].conclusion // empty' 2>/dev/null)"
    status="$(printf '%s' "$run_json" | jq -r '.[0].status // empty' 2>/dev/null)"
    headsha="$(printf '%s' "$run_json" | jq -r '.[0].headSha // empty' 2>/dev/null)"
    created="$(printf '%s' "$run_json" | jq -r '.[0].createdAt // empty' 2>/dev/null)"
    hook_observe "$HOOK" '§E3-ship-baseline' "$SID" true true \
      "$(jq -cn --arg b "$branch" --arg c "$conclusion" --arg s "$status" '{branch:$b,conclusion:$c,status:$s,stage:"run-parsed"}' 2>/dev/null || echo null)"
    [[ -n "$conclusion" || -n "$status" ]] || continue
    shortsha="${headsha:0:12}"

    case "$conclusion" in
      failure|cancelled|timed_out|startup_failure|action_required)
        hook_record "$HOOK" "block" "$(jq -cn --arg b "$branch" --arg c "$conclusion" --arg s "$headsha" --arg t "$created" '{branch:$b,conclusion:$c,head_sha:$s,created_at:$t}')" '§E3-ship-baseline' "$SID"
        hook_block \
          "Blocked: pushing to '${branch}' whose latest observable CI run concluded '${conclusion}' ( spec §E3 known-red branch observer )." \
          "§E3 known-red observer: '${branch}' latest run is ${conclusion}${shortsha:+, commit ${shortsha}}${created:+, ${created}}. Fix or re-run CI, hold the push, or append [allow-red-ship] to accept this known-red baseline. This hook does not certify local/full/fresh validation." \
          "PreToolUse" ;;
    esac
  done
}

while IFS= read -r INVOCATION; do
  check_push_invocation "$INVOCATION"
done < <(printf '%s' "$INVOCATIONS" | jq -c '.[]' 2>/dev/null)
