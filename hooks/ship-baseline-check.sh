#!/usr/bin/env bash
# ship-baseline-check.sh — PreToolUse:Bash. Enforces spec §E3 ship-checklist
# item 2: a `git push` to a shared branch requires the base-branch CI to be
# green. If the latest CI run on the target branch concluded red, block the push
# (spec/AGENTS.md §E3-ship-baseline). Bypass: [allow-red-ship] (records a
# known-red baseline; the pusher takes responsibility).
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

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Only inspect git push (consume git global options so `git -C <dir> push` is
# gated the same as the bare form).
hook_cmd_invokes_git 'push' "$CMD" || exit 0
[[ "$CMD" == *"[allow-red-ship]"* ]] && { hook_record "$HOOK" "bypass" '{"token":"allow-red-ship"}' '§E3-ship-baseline' "$SID"; exit 0; }
command -v gh >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "gh-missing"; exit 0; }

# Resolve the target branch: `git push <remote> <branch>` wins, else HEAD.
# Strip push options whose values are separate argv tokens before the lightweight
# parse, otherwise the option value is mistaken for the remote.
PARSE_CMD="$(printf '%s' "$CMD" | sed -E 's/[[:space:]]--push-option[[:space:]]+[^[:space:]]+//g; s/[[:space:]]-o[[:space:]]+[^[:space:]]+//g')"
# Consume git global options (HOOK_GIT_GLOBAL_OPTS) before `push` so a
# `git -C <dir> push origin main` still yields `main`, not the -C value.
BRANCH="$(printf '%s' "$PARSE_CMD" | grep -oiE "git${HOOK_GIT_GLOBAL_OPTS}[[:space:]]+push([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]-][^[:space:]]*" | awk '{print $NF}' | head -1)"
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
fi
# A `src:dst` refspec pushes to dst — gate on the destination branch.
[[ "$BRANCH" == *:* ]] && BRANCH="${BRANCH##*:}"
# Full refnames are common in scripted pushes (`HEAD:refs/heads/main`); normalize
# them before shared-branch matching so they cannot bypass the ship gate.
[[ "$BRANCH" == refs/heads/* ]] && BRANCH="${BRANCH#refs/heads/}"
[[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || exit 0

# Only gate shared branches. Cover the common release/prod naming shapes: bare,
# slash-scoped (release/1.2), AND dash-suffixed (release-1.2, prod-east) — the
# last was previously unmatched, so a red-CI push to `release-1.2` slipped through.
case "$BRANCH" in
  main|master|develop|dev|release|release/*|release-*|releases/*|prod|prod/*|prod-*|production) : ;;
  *) exit 0 ;;
esac

# Query the latest CI run conclusion on that branch (bounded).
RUN_JSON="$(platform_timeout 5 gh run list --branch "$BRANCH" --limit 1 --json conclusion,status,headSha,createdAt 2>/dev/null)" || RUN_JSON=""
[[ -n "$RUN_JSON" ]] || { hook_record_failopen "$HOOK" "gh-noreply"; exit 0; }
CONCLUSION="$(printf '%s' "$RUN_JSON" | jq -r '.[0].conclusion // empty' 2>/dev/null)"
STATUS="$(printf '%s' "$RUN_JSON" | jq -r '.[0].status // empty' 2>/dev/null)"
HEADSHA="$(printf '%s' "$RUN_JSON" | jq -r '.[0].headSha // empty' 2>/dev/null)"
CREATED="$(printf '%s' "$RUN_JSON" | jq -r '.[0].createdAt // empty' 2>/dev/null)"
[[ -n "$CONCLUSION" || -n "$STATUS" ]] || exit 0   # no runs → nothing to gate
SHORTSHA="${HEADSHA:0:12}"

case "$CONCLUSION" in
  failure|cancelled|timed_out|startup_failure|action_required)
    hook_record "$HOOK" "block" "$(jq -cn --arg b "$BRANCH" --arg c "$CONCLUSION" --arg s "$HEADSHA" --arg t "$CREATED" '{branch:$b,conclusion:$c,head_sha:$s,created_at:$t}')" '§E3-ship-baseline' "$SID"
    hook_block \
      "Blocked: pushing to '${BRANCH}' whose latest CI run concluded '${CONCLUSION}' ( spec §E3 ship-checklist item 2 )." \
      "§E3 (ship gate): base-branch CI on '${BRANCH}' is red (latest run: ${CONCLUSION}${SHORTSHA:+, commit ${SHORTSHA}}${CREATED:+, ${CREATED}}). Options per spec: (a) fix the failure first, (b) record a known-red baseline in the commit body and append [allow-red-ship] to proceed, or (c) hold the push. Pushing onto a red baseline hides which change broke it. If that run predates the branch's current tip, the red may be stale — re-run CI to confirm." \
      "PreToolUse" ;;
  *) exit 0 ;;   # success / neutral / skipped / in-progress → allow
esac
