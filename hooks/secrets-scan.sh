#!/usr/bin/env bash
# secrets-scan.sh — PreToolUse:Bash enforcement of spec/AGENTS.md §8 (immutable
# SAFETY): "plaintext secrets in code/logs/commits". On a `git commit`, scans the
# effective commit diff for high-confidence secret patterns in ADDED lines and
# blocks the commit if any match. For `commit -a/--all`, a temporary index models
# Git's implicit tracked-file staging without touching the real index.
#
# Scope: `git commit` only (the effective diff is locally scannable). `git push`
# secrets need the outgoing commit range and are left to the pusher's §8 review;
# commit-time is the highest-value, lowest-false-positive gate.
# Patterns live in hooks/secrets.patterns (prefix-anchored, low-FP by design).
# Fail-open: jq/git missing, not a repo, empty staged diff, unreadable stdin →
# exit 0 (recorded via hook_record_failopen) so a broken hook never wedges commits.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
PATTERNS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secrets.patterns"

HOOK="secrets-scan"
hook_kill_switch "SECRETS_SCAN" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v git >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "git-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Parse every actual commit invocation so a clean first command cannot hide a
# later commit in the same Bash tool call.
INVOCATIONS="$(hook_git_invocations_json 'commit' "$CMD")"
[[ -n "$INVOCATIONS" && "$INVOCATIONS" != "[]" ]] || exit 0
[[ "$CMD" == *"[allow-secret]"* ]] && { hook_observe "$HOOK" '§8-secrets' "$SID" true false '{"reason":"bypass"}'; hook_record "$HOOK" "bypass" '{"token":"allow-secret"}' '§8-secrets' "$SID"; exit 0; }

TEMP_INDEX=""
cleanup_index() {
  [[ -z "$TEMP_INDEX" ]] || rm -f -- "$TEMP_INDEX" "$TEMP_INDEX.lock"
  TEMP_INDEX=""
}
secret_failopen() {
  local reason="$1"
  cleanup_index
  hook_observe "$HOOK" '§8-secrets' "$SID" true false \
    "$(jq -cn --arg r "$reason" '{reason:$r}' 2>/dev/null || echo null)"
  hook_record_failopen "$HOOK" "$reason"
}
trap cleanup_index EXIT

scan_commit_invocation() {
  local invocation="$1" mode pathspec_from_file pathspec_file_nul unsupported
  local index_tree head_tree diff added hit pat repo_arg tracked_path
  local -a git_repo=(-C "$CWD")
  local -a pathspecs=() pathspec_file_args=() tracked_paths=()
  while IFS= read -r repo_arg; do
    [[ -n "$repo_arg" ]] && git_repo+=("$repo_arg")
  done < <(printf '%s' "$invocation" | jq -r '.repoArgs[]' 2>/dev/null)

  mode="$(printf '%s' "$invocation" | jq -r '.commitContent.mode // "unsupported"' 2>/dev/null)"
  unsupported="$(printf '%s' "$invocation" | jq -r '.commitContent.unsupported | join(",")' 2>/dev/null)"
  if [[ "$mode" == "unsupported" || -n "$unsupported" ]]; then
    secret_failopen "commit-content-unsupported${unsupported:+:$unsupported}"
    return 0
  fi
  while IFS= read -r repo_arg; do
    pathspecs+=("$repo_arg")
  done < <(printf '%s' "$invocation" | jq -r '.commitContent.pathspecs[]' 2>/dev/null)
  pathspec_from_file="$(printf '%s' "$invocation" | jq -r '.commitContent.pathspecFromFile // empty' 2>/dev/null)"
  pathspec_file_nul="$(printf '%s' "$invocation" | jq -r '.commitContent.pathspecFileNul // false' 2>/dev/null)"
  if [[ -n "$pathspec_from_file" ]]; then
    pathspec_file_args=("--pathspec-from-file=$pathspec_from_file")
    [[ "$pathspec_file_nul" == "true" ]] && pathspec_file_args+=(--pathspec-file-nul)
  fi

  TEMP_INDEX=""
  if [[ "$mode" != "staged" ]]; then
    TEMP_INDEX="$(mktemp "${TMPDIR:-/tmp}/agentsmd-secret-index.XXXXXX")" \
      || { secret_failopen "temp-index-failed"; return 0; }
    rm -f -- "$TEMP_INDEX"

    if [[ "$mode" == "all" || "$mode" == "include" ]]; then
      index_tree="$(git "${git_repo[@]}" write-tree 2>/dev/null)" \
        || { secret_failopen "index-tree-failed"; return 0; }
      GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" read-tree "$index_tree" 2>/dev/null \
        || { secret_failopen "index-copy-failed"; return 0; }
    else
      if head_tree="$(git "${git_repo[@]}" rev-parse --verify 'HEAD^{tree}' 2>/dev/null)"; then
        GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" read-tree "$head_tree" 2>/dev/null \
          || { secret_failopen "head-index-init-failed"; return 0; }
      else
        GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" read-tree --empty 2>/dev/null \
          || { secret_failopen "empty-index-init-failed"; return 0; }
      fi
    fi

    if [[ "$mode" == "all" ]]; then
      GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" add -u -- 2>/dev/null \
        || { secret_failopen "index-update-all-failed"; return 0; }
    elif [[ -n "$pathspec_from_file" ]]; then
      # Let Git parse magic and NUL/LF pathspec-file formats. A staged addition
      # cannot be recreated from a HEAD-based index with `add -u`; refuse that
      # rare ambiguous combination rather than scan an incomplete commit set.
      if [[ "$mode" == "only" ]] \
        && ! git "${git_repo[@]}" diff --cached --quiet --diff-filter=A -- 2>/dev/null; then
        secret_failopen "only-pathspec-file-with-staged-addition"
        return 0
      fi
      GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" add -u "${pathspec_file_args[@]}" 2>/dev/null \
        || { secret_failopen "index-update-pathspec-file-failed"; return 0; }
    else
      GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" add -u -- "${pathspecs[@]}" 2>/dev/null \
        || { secret_failopen "index-update-pathspec-failed"; return 0; }
      if [[ "$mode" == "only" ]]; then
        # `commit --only <path>` can include a newly-added path already known to
        # the real index. Enumerate matches through Git (including pathspec
        # magic), then refresh those exact names in the HEAD-based temp index.
        while IFS= read -r -d '' tracked_path; do
          tracked_paths+=("$tracked_path")
        done < <(git "${git_repo[@]}" ls-files -z -- "${pathspecs[@]}" 2>/dev/null)
        for tracked_path in "${tracked_paths[@]}"; do
          GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" add -A -- "$tracked_path" 2>/dev/null \
            || { secret_failopen "index-update-selected-file-failed"; return 0; }
        done
      fi
    fi
    diff="$(GIT_INDEX_FILE="$TEMP_INDEX" git "${git_repo[@]}" diff --cached 2>/dev/null)" \
      || { secret_failopen "git-diff-failed"; return 0; }
  else
    diff="$(git "${git_repo[@]}" diff --cached 2>/dev/null)" \
      || { secret_failopen "git-diff-failed"; return 0; }
  fi
  cleanup_index
  hook_observe "$HOOK" '§8-secrets' "$SID" true true '{"stage":"diff-complete"}'
  [[ -n "$diff" ]] || return 0

  # Scan only ADDED lines (leading '+', excluding the '+++' file header) — a
  # secret already in the base tree is not something this commit introduces.
  added="$(printf '%s' "$diff" | grep -E '^\+' | grep -vE '^\+\+\+')"
  [[ -n "$added" ]] || return 0

  hit=""
  if [[ -r "$PATTERNS_FILE" ]]; then
    while IFS= read -r pat; do
      [[ -z "$pat" || "$pat" == \#* ]] && continue
      if printf '%s' "$added" | grep -qE -- "$pat"; then hit="$pat"; break; fi
    done < "$PATTERNS_FILE"
  fi
  [[ -n "$hit" ]] || return 0

  hook_record "$HOOK" "block" "$(jq -cn --arg p "$hit" '{pattern:$p}' 2>/dev/null || echo null)" '§8-secrets' "$SID"
  hook_block \
    "Blocked: commit changes appear to contain a secret ( spec/AGENTS.md §8, immutable )." \
    "§8 SAFETY (immutable): 'plaintext secrets in code/logs/commits' is banned. An ADDED line in the effective commit diff matches a known secret shape (/${hit}/). Remove it (use env vars or a secret manager), unstage it, and ROTATE it if it was ever pushed. Append [allow-secret] only for a genuine false positive (documented example / test fixture)." \
    "PreToolUse"
}

while IFS= read -r INVOCATION; do
  scan_commit_invocation "$INVOCATION"
done < <(printf '%s' "$INVOCATIONS" | jq -c '.[]' 2>/dev/null)
