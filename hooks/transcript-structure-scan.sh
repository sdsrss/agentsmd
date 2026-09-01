#!/usr/bin/env bash
# transcript-structure-scan.sh — Stop. Post-hoc scan of the last assistant
# message for spec §10 violations: (a) banned vocabulary (§10 Specificity), and
# (b) four-section REPORT order Done → Not done → Failed → Uncertain (§10 Order),
# whenever a literal `Done:` label identifies a structured report. Non-blocking: telemetry
# + a queued advisory surfaced at the next UserPromptSubmit. Reads the stable
# Stop last_assistant_message field first; older runtimes use a bounded
# transcript fallback whose use is recorded. If neither yields an assistant
# message it stays silent (fail-open — a scan that can't parse must not misfire).

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0
PATTERNS_FILE="$LIB_DIR/../banned-vocab.patterns"

HOOK="transcript-structure"
hook_kill_switch "TRANSCRIPT_STRUCTURE" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0

ISSUES=""
# One bounded analyzer process extracts the stable event fields (or the legacy
# transcript fallback) and scans the message. This avoids two jq processes plus
# repeated Node/grep/head/cut/tail scans while preserving rule eligibility.
ANALYSIS="$(node "$LIB_DIR/transcript-structure.js" "$PATTERNS_FILE" --event --tsv <<< "$EVENT" 2>/dev/null)" || {
  hook_record_failopen "$HOOK" "analysis-failed"
  exit 0
}
IFS=$'\t' read -r SID MESSAGE_SOURCE MESSAGE_FOUND \
  BANNED_PATTERN ORDER_ISSUE FIX_ISSUE HONESTY_ISSUE \
  VOCAB_ELIGIBLE ORDER_ELIGIBLE FIX_ELIGIBLE HONESTY_ELIGIBLE PATTERNS_READABLE <<< "$ANALYSIS"
[[ "$SID" == "-" ]] && SID=""
[[ "$MESSAGE_FOUND" == "true" ]] || exit 0
if [[ "$MESSAGE_SOURCE" == "transcript" ]]; then
  hook_record "$HOOK" "compat-fallback" \
    '{"from":"last_assistant_message","to":"transcript","bounded_bytes":524288}' '' "$SID"
fi
[[ "$BANNED_PATTERN" == "-" ]] && BANNED_PATTERN=""
[[ -n "$BANNED_PATTERN" ]] && ISSUES="${ISSUES}banned-vocab:/${BANNED_PATTERN}/ "
[[ "$ORDER_ISSUE" == "true" ]] && ISSUES="${ISSUES}four-section-order "
[[ "$FIX_ISSUE" == "true" ]] && ISSUES="${ISSUES}iron-law-2 "
[[ "$HONESTY_ISSUE" == "true" ]] && ISSUES="${ISSUES}uncertain-hedge "

# Every rule enters the denominator only when its triggering shape exists in the
# message. For §10-V (Specificity) that shape is an evaluable value/completion
# claim — a `Done:` label or a claim verb — NOT mere existence of a last message
# (counting every message inflated the denominator into a false demote signal,
# audit M-05). A banned-vocab hit is itself an opportunity by definition, so the
# gate can never hide a violation. No claim → an explicit eligible:false row
# (scan ran, no opportunity); claim but unreadable patterns → eligible yet
# unevaluated, so the loss is visible instead of silent.
if [[ "$VOCAB_ELIGIBLE" == "true" ]]; then
  if [[ "$PATTERNS_READABLE" == "true" ]]; then
    hook_observe "$HOOK" '§10-V' "$SID" true true '{"stage":"value-claim-scanned"}'
  else
    hook_observe "$HOOK" '§10-V' "$SID" true false '{"reason":"patterns-missing"}'
  fi
else
  hook_observe "$HOOK" '§10-V' "$SID" false false '{"stage":"no-value-claim"}'
fi
[[ "$ORDER_ELIGIBLE" == "true" ]] && hook_observe "$HOOK" '§10-four-section-order' "$SID" true true '{"stage":"report-order-scanned"}'
[[ "$FIX_ELIGIBLE" == "true" ]] && hook_observe "$HOOK" '§6-iron-law-2' "$SID" true true '{"stage":"fix-claim-scanned"}'
[[ "$HONESTY_ELIGIBLE" == "true" ]] && hook_observe "$HOOK" '§10-honesty' "$SID" true true '{"stage":"uncertain-section-scanned"}'

[[ -n "$ISSUES" ]] || exit 0
ISSUES="${ISSUES% }"
# Attribute each issue class to its OWN spec section so the promote/demote ledger
# (scripts/rules.js bySection) counts banned-vocab hits under §10-V (Specificity)
# and section-order hits under §10-four-section-order — not everything under the
# latter. A report that trips both emits one row per section, each carrying only
# its own issue in extra (distinct rows, never identical multi-emit — keeps
# bySection aggregation and any future dup detector honest).
if [[ "$ISSUES" == *banned-vocab:* ]]; then
  vtok="banned-vocab:/${BANNED_PATTERN}/"
  hook_record "$HOOK" "advisory" "$(jq -cn --arg i "$vtok" '{issues:$i}' 2>/dev/null || echo null)" '§10-V' "$SID"
fi
[[ "$ISSUES" == *four-section-order* ]] && \
  hook_record "$HOOK" "advisory" "$(jq -cn '{issues:"four-section-order"}' 2>/dev/null || echo null)" '§10-four-section-order' "$SID"
[[ "$ISSUES" == *iron-law-2* ]] && \
  hook_record "$HOOK" "advisory" "$(jq -cn '{issues:"iron-law-2"}' 2>/dev/null || echo null)" '§6-iron-law-2' "$SID"
[[ "$ISSUES" == *uncertain-hedge* ]] && \
  hook_record "$HOOK" "advisory" "$(jq -cn '{issues:"uncertain-hedge"}' 2>/dev/null || echo null)" '§10-honesty' "$SID"
# One composed advisory carrying only the clauses whose issue actually fired (each
# spec section already got its own telemetry row above).
ADV="[agentsmd spec] Last report may violate: ${ISSUES}."
[[ "$ISSUES" == *banned-vocab:* || "$ISSUES" == *four-section-order* ]] && \
  ADV="$ADV §10 (HARD): quantify value claims (absolute number / baseline-anchored ratio, not adjectives) and order sections Done → Not done → Failed → Uncertain."
[[ "$ISSUES" == *iron-law-2* ]] && \
  ADV="$ADV Iron Law #2: a fix/done claim needs a fresh-evidence anchor (failing-state token + test name / number / file:line), not a bare assertion."
[[ "$ISSUES" == *uncertain-hedge* ]] && \
  ADV="$ADV §10 Honesty: write 'uncertain because <X>', not may/could/might hedging."
hook_queue_advisory "$ADV" "$SID"
exit 0
