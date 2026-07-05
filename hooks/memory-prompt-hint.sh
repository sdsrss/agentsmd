#!/usr/bin/env bash
# memory-prompt-hint.sh — UserPromptSubmit. Proactive recall aid for spec §7:
# when the user's prompt shares a keyword with a MEMORY.md index line, inject a
# non-blocking hint (additionalContext) pointing at the relevant memory so the
# agent reads it before acting. Advisory only. English index keywords (matching
# the spec's English-only project_/reference_ index convention); ≥5-letter words
# minus stopwords, substring match against the lowercased prompt.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="memory-prompt-hint"
hook_kill_switch "MEMORY_PROMPT_HINT" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
PROMPT="$(hook_json_field "$EVENT" '.prompt')"
[[ -n "$PROMPT" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

MEM=""
MEM="$(hook_find_memory_file "$CWD" 2>/dev/null || true)"
[[ -n "$MEM" ]] || exit 0

PROMPT_LC="$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')"
STOP=" the and for with this that from memory file when use using before after into your you code spec rule rules note lesson project reference feedback which what will each per via ally "

MATCHES=""
COUNT=0
while IFS= read -r line; do
  [[ "$line" == "- ["* || "$line" == "* ["* ]] || continue
  hit=0
  for kw in $(printf '%s' "$line" | grep -oE '[A-Za-z][A-Za-z-]{4,}' | tr '[:upper:]' '[:lower:]' | sort -u); do
    [[ "$STOP" == *" $kw "* ]] && continue
    if [[ "$PROMPT_LC" == *"$kw"* ]]; then hit=1; break; fi
  done
  # CJK trigger words: index bodies keep 中文 trigger words (spec §1) and prompts are
  # 中文 by default. Extract non-ASCII byte runs ≥6 bytes (≈2+ CJK chars; excludes lone
  # punctuation like —) under a FORCED C byte-locale: a UTF-8 character class such as
  # [一-龥] silently matches nothing in the hook's non-interactive shell, which does
  # not reliably inherit an interactive UTF-8 locale. `-a` stops grep -o from treating
  # the high bytes as binary. UTF-8 is self-synchronizing, so a byte-substring match
  # on ASCII-delimited runs is a character-substring match — no false boundary hits.
  if (( ! hit )); then
    for kw in $(printf '%s' "$line" | LC_ALL=C grep -aoE '[^ -~]{6,}' 2>/dev/null | sort -u); do
      if [[ "$PROMPT" == *"$kw"* ]]; then hit=1; break; fi
    done
  fi
  if (( hit )); then
    # keep the index line's title + link, trim trailing desc for brevity
    MATCHES="${MATCHES}  ${line}"$'\n'
    COUNT=$((COUNT+1))
    (( COUNT >= 3 )) && break
  fi
done < "$MEM"

[[ "$COUNT" -gt 0 ]] || exit 0

# Emit the surfaced memory filenames (not just a count) as a `suggest` event, so
# lesson-bypass-audit.js can later join this row against the session transcript and
# measure cite-recall — was the hint acted on, or bypassed? extra.suggested = the
# memory/*.md link targets pulled from the matched MEMORY.md index lines.
SUGGESTED_JSON="$(printf '%s' "$MATCHES" | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(//; s/\)$//' | jq -R . | jq -cs . 2>/dev/null)"
[[ -z "$SUGGESTED_JSON" ]] && SUGGESTED_JSON="[]"
hook_record "$HOOK" "suggest" "$(jq -cn --argjson c "$COUNT" --argjson s "$SUGGESTED_JSON" '{count:$c, suggested:$s}' 2>/dev/null || echo null)" '§7-memory-read' "$SID"
hook_context \
  "[agentsmd §7] Prior memory may be relevant to this task — read before acting:"$'\n'"${MATCHES%$'\n'}" \
  "UserPromptSubmit"
