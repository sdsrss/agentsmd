#!/usr/bin/env bash
# secrets-scan.sh — PreToolUse:Bash enforcement of spec/AGENTS.md §8 (immutable
# SAFETY): "plaintext secrets in code/logs/commits". On a `git commit`, scans the
# STAGED diff (git diff --cached) for high-confidence secret patterns in ADDED
# lines and blocks the commit if any match. Bypass token: [allow-secret] (for a
# documented false positive — a test fixture or example key).
#
# Scope: `git commit` only (the staged diff is cleanly scannable). `git push`
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

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Only git commit — the staged diff is what we can scan pre-write.
printf '%s' "$CMD" | grep -qiE '(^|[;&|]|[[:space:]])git[[:space:]]+commit\b' || exit 0
[[ "$CMD" == *"[allow-secret]"* ]] && { hook_record "$HOOK" "bypass" '{"token":"allow-secret"}' '§8-secrets' "$SID"; exit 0; }

DIFF="$(git -C "$CWD" diff --cached 2>/dev/null)" || { hook_record_failopen "$HOOK" "git-diff-failed"; exit 0; }
[[ -n "$DIFF" ]] || exit 0   # nothing staged → nothing to scan (e.g. `git commit --amend` with no staged Δ)

# Scan only ADDED lines (leading '+', excluding the '+++' file header) — a secret
# already in the base tree is not something THIS commit is introducing.
ADDED="$(printf '%s' "$DIFF" | grep -E '^\+' | grep -vE '^\+\+\+')"
[[ -n "$ADDED" ]] || exit 0

HIT=""
if [[ -r "$PATTERNS_FILE" ]]; then
  while IFS= read -r pat; do
    [[ -z "$pat" || "$pat" == \#* ]] && continue
    if printf '%s' "$ADDED" | grep -qE -- "$pat"; then HIT="$pat"; break; fi
  done < "$PATTERNS_FILE"
fi
[[ -n "$HIT" ]] || exit 0

hook_record "$HOOK" "block" "$(jq -cn --arg p "$HIT" '{pattern:$p}' 2>/dev/null || echo null)" '§8-secrets' "$SID"
hook_block \
  "Blocked: staged changes appear to contain a secret ( spec/AGENTS.md §8, immutable )." \
  "§8 SAFETY (immutable): 'plaintext secrets in code/logs/commits' is banned. A staged ADDED line matches a known secret shape (/${HIT}/). Remove it (use env vars or a secret manager), unstage it, and ROTATE it if it was ever pushed. Append [allow-secret] only for a genuine false positive (documented example / test fixture)." \
  "PreToolUse"
