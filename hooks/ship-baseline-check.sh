#!/usr/bin/env bash
# ship-baseline-check.sh — PreToolUse:Bash. Observes the latest GitHub run for a
# shared target branch and blocks only a conclusively known-red baseline. Full,
# local, and fresh validation remain the pusher's §E3 checklist responsibility.
# Bypass: [allow-red-ship] records acceptance of the known-red baseline.
#
# Branch resolution: prefer refspecs named in the push command, enumerate local
# heads for --all/--branches, else use the target repo's current branch.
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

github_repo_from_url() {
  local url="$1" slug=""
  url="${url%/}"; url="${url%.git}"
  case "$url" in
    https://github.com/*) slug="${url#https://github.com/}" ;;
    git@github.com:*) slug="${url#git@github.com:}" ;;
    ssh://git@github.com/*) slug="${url#ssh://git@github.com/}" ;;
  esac
  [[ "$slug" =~ ^[^/]+/[^/]+$ ]] || return 1
  printf '%s' "$slug"
}

check_push_invocation() {
  local invocation="$1" branch repo_arg remote explicit_repo remote_url github_repo
  local run_json conclusion status headsha created shortsha target_ok=false
  local push_all=false push_mirror=false
  local -a git_repo=(-C "$CWD") positionals=() branches=() shared_branches=()
  while IFS= read -r repo_arg; do
    [[ -n "$repo_arg" ]] && git_repo+=("$repo_arg")
  done < <(printf '%s' "$invocation" | jq -r '.repoArgs[]' 2>/dev/null)

  [[ "$(printf '%s' "$invocation" | jq -r '[.args[] | select(. == "--all" or . == "--branches")] | length > 0' 2>/dev/null)" == "true" ]] && push_all=true
  [[ "$(printf '%s' "$invocation" | jq -r '[.args[] | select(. == "--mirror")] | length > 0' 2>/dev/null)" == "true" ]] && push_mirror=true
  explicit_repo="$(printf '%s' "$invocation" | jq -r '
    .args as $a
    | reduce range(0; $a|length) as $i ("";
        if $a[$i] == "--repo" then ($a[$i+1] // "")
        elif ($a[$i] | startswith("--repo=")) then ($a[$i] | sub("^--repo="; ""))
        else . end)' 2>/dev/null)"
  while IFS= read -r repo_arg; do
    [[ -n "$repo_arg" ]] && positionals+=("$repo_arg")
  done < <(printf '%s' "$invocation" | jq -r '
    .args as $a
    | reduce range(0; $a|length) as $i
        ({skip:false, positional:[]};
         if .skip then .skip=false
         elif ($a[$i] == "--push-option" or $a[$i] == "-o" or $a[$i] == "--repo"
               or $a[$i] == "--receive-pack" or $a[$i] == "--exec"
               or $a[$i] == "--recurse-submodules") then .skip=true
         elif ($a[$i] | startswith("-")) then .
         else .positional += [$a[$i]] end)
    | .positional[]' 2>/dev/null)

  if [[ -n "$explicit_repo" ]]; then
    remote="$explicit_repo"
    branches=("${positionals[@]}")
  else
    remote="${positionals[0]:-}"
    (( ${#positionals[@]} > 1 )) && branches=("${positionals[@]:1}")
  fi

  # Mirror and wildcard refsets can include shared branches but cannot be mapped
  # safely to a bounded branch list here. Record the opportunity as unevaluated
  # before any gh query rather than treating it as green.
  if [[ "$push_mirror" == "true" ]]; then
    ship_unevaluated "(mirror)" "mirror-refset-unsupported"
    return 0
  fi
  # Bash 3.2 + set -u treats an empty "${array[@]}" as unbound. Guard the
  # pre-enumeration array explicitly: --all/--branches intentionally reaches
  # this point with no positional refspecs.
  if (( ${#branches[@]} > 0 )); then
    for branch in "${branches[@]}"; do
      if [[ "$branch" == *'*'* ]]; then
        ship_unevaluated "$branch" "wildcard-refspec-unsupported"
        return 0
      fi
    done
  fi

  if git "${git_repo[@]}" rev-parse --git-dir >/dev/null 2>&1; then
    target_ok=true
  fi
  if [[ "$push_all" == "true" ]]; then
    if [[ "$target_ok" != "true" ]]; then
      ship_unevaluated "(all)" "target-repo-unresolved"
      return 0
    fi
    branches=()
    while IFS= read -r branch; do
      [[ -n "$branch" ]] && branches+=("$branch")
    done < <(git "${git_repo[@]}" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
  elif (( ${#branches[@]} == 0 )); then
    if [[ "$target_ok" != "true" ]]; then
      ship_unevaluated "(current)" "target-repo-unresolved"
      return 0
    fi
    branch="$(git "${git_repo[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    [[ -n "$branch" ]] && branches+=("$branch")
  fi

  if (( ${#branches[@]} > 0 )); then
    for branch in "${branches[@]}"; do
      branch="${branch#+}"
      [[ "$branch" == *:* ]] && branch="${branch##*:}"
      [[ "$branch" == refs/heads/* ]] && branch="${branch#refs/heads/}"
      [[ -n "$branch" && "$branch" != "HEAD" ]] || continue
      case "$branch" in
        main|master|develop|dev|release|release/*|release-*|releases/*|prod|prod/*|prod-*|production) : ;;
        *) continue ;;
      esac

      shared_branches+=("$branch")
    done
  fi
  (( ${#shared_branches[@]} > 0 )) || return 0

  if [[ "$target_ok" != "true" ]]; then
    ship_unevaluated "${shared_branches[0]}" "target-repo-unresolved"
    return 0
  fi
  if [[ -z "$remote" ]]; then
    branch="$(git "${git_repo[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    [[ -n "$branch" ]] && remote="$(git "${git_repo[@]}" config --get "branch.${branch}.remote" 2>/dev/null)"
  fi
  [[ -n "$remote" ]] || { ship_unevaluated "${shared_branches[0]}" "remote-unresolved"; return 0; }
  remote_url="$(git "${git_repo[@]}" remote get-url "$remote" 2>/dev/null)"
  [[ -n "$remote_url" ]] || remote_url="$remote"
  github_repo="$(github_repo_from_url "$remote_url" 2>/dev/null)" || github_repo=""
  [[ -n "$github_repo" ]] || { ship_unevaluated "${shared_branches[0]}" "github-repo-unresolved"; return 0; }

  for branch in "${shared_branches[@]}"; do

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

    run_json="$(platform_timeout 5 gh run list --repo "$github_repo" --branch "$branch" --limit 1 --json conclusion,status,headSha,createdAt 2>/dev/null)" || run_json=""
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
