#!/usr/bin/env bash
# transcript-structure-scan.sh — Stop. Post-hoc scan of the last assistant
# message for spec §10 violations: (a) banned vocabulary (§10 Specificity), and
# (b) four-section REPORT order Done → Not done → Failed → Uncertain (§10 Order),
# whenever a literal `Done:` label identifies a structured report. Non-blocking: telemetry
# + a queued advisory surfaced at the next UserPromptSubmit. Parses the Codex session JSONL
# ({timestamp,type,payload}); if it can't locate an assistant message it stays
# silent (fail-open — a scan that can't parse must not misfire).

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0
PATTERNS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/banned-vocab.patterns"

HOOK="transcript-structure"
hook_kill_switch "TRANSCRIPT_STRUCTURE" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || exit 0

# Extract the last assistant message's plain text from the Codex session JSONL.
LAST="$(node -e '
const fs=require("fs");
const path=process.argv[1];
const CAP=1<<19; // read only the last 512 KiB — the last assistant message (all we
                 // need) lives at the tail; caps per-Stop cost to O(1), not O(transcript).
let lines;
try{ const fd=fs.openSync(path,"r"),sz=fs.fstatSync(fd).size,st=sz>CAP?sz-CAP:0,b=Buffer.alloc(sz-st);
  fs.readSync(fd,b,0,sz-st,st); fs.closeSync(fd);
  lines=b.toString("utf8").split(/\r?\n/).filter(Boolean); }catch{ process.exit(0); }
const texts=[];
const pull=(v,out)=>{ if(v==null)return; if(typeof v==="string"){out.push(v);return;}
  if(Array.isArray(v)){for(const x of v)pull(x,out);return;}
  if(typeof v==="object"){ if(typeof v.text==="string")out.push(v.text);
    else if(Array.isArray(v.content))pull(v.content,out); } };
for(const ln of lines){
  let o; try{o=JSON.parse(ln);}catch{continue;}
  const p=o&&o.payload!=null?o.payload:o;
  const role=p&&(p.role||p.author);
  const isMsg=(o.type==="message"||o.type==="response_item"||p&&p.type==="message");
  if(role==="assistant"&&isMsg){ const out=[]; pull(p.content!=null?p.content:p.text,out);
    const t=out.join("\n").trim(); if(t)texts.push(t); }
}
if(!texts.length)process.exit(0);
process.stdout.write(texts[texts.length-1]);
' "$TRANSCRIPT" 2>/dev/null)" || exit 0
[[ -n "$LAST" ]] || exit 0

ISSUES=""
SCAN_TEXT="$(printf '%s' "$LAST" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { s += c; });
process.stdin.on("end", () => {
  process.stdout.write(s.replace(/```[\s\S]*?```/g, ""));
});
' 2>/dev/null || printf '%s' "$LAST")"

# (a) banned vocabulary
if [[ -r "$PATTERNS_FILE" ]]; then
  while IFS= read -r pat; do
    [[ -z "$pat" || "$pat" == \#* ]] && continue
    if printf '%s' "$SCAN_TEXT" | grep -qiE "$pat"; then
      ISSUES="${ISSUES}banned-vocab:/${pat}/ "; break
    fi
  done < "$PATTERNS_FILE"
fi

# (b) four-section completeness/order. A literal Done label makes the message a
# structured report, even when later labels are absent; requiring two trailing
# labels created a blind spot for precisely the incomplete reports this checks.
# The colon is mandatory so ordinary prose such as "Done is a status" is outside
# scope. Compact L0/L1 prose therefore remains unaffected.
order_pos() { printf '%s' "$LAST" | grep -aboiE "^[[:space:]>*-]*(\*\*)?${1}(\*\*)?[[:space:]]*:" 2>/dev/null | head -1 | cut -d: -f1; }
P_DONE="$(order_pos 'Done')"; P_NOT="$(order_pos 'Not done')"
P_FAIL="$(order_pos 'Failed')"; P_UNC="$(order_pos 'Uncertain')"
ORDER_ELIGIBLE=false
if [[ -n "$P_DONE" ]]; then
  ORDER_ELIGIBLE=true
  prev="$P_DONE"; bad=0
  if [[ -z "$P_NOT" || -z "$P_FAIL" || -z "$P_UNC" ]]; then
    bad=1
  else
    for v in "$P_NOT" "$P_FAIL" "$P_UNC"; do
      (( v < prev )) && bad=1
      prev="$v"
    done
  fi
  (( bad == 1 )) && ISSUES="${ISSUES}four-section-order "
fi

# (c) iron-law-2 evidence anchor (§6 bugfix-anchor / Iron Law #2): a completed-fix
# claim ("fixed"/"resolved"/修复/解决了) with NO evidence fingerprint anywhere in the
# message — no failing-state token, test count, file:line, exit code, commit hash, or
# inline `code`. Complements banned-vocab (which fires on the PRESENCE of a bad
# phrasing); this fires on the ABSENCE of any anchor behind a fix claim. Deliberately
# conservative — a single concrete token clears it, so a genuinely evidenced report
# never trips, and it stays silent on non-fix "Done:" lines (those are §10's job).
FIXCLAIM_RE='\b(fixed|resolved)\b|修复|解决了|已解决'
EVID_RE='[0-9]+ ?/ ?[0-9]+|[0-9]+ (passed|failed|tests?|ok|assertions?)|\b(passed|failed)\b|exit [0-9]+|exit code|[0-9]+%|[0-9]+ ?(→|->|=>) ?[0-9]+|\.[a-z0-9_]+:[0-9]+|\b(was|were|used to|previously|regression|crash|crashed|threw|throws|traceback)\b|TypeError|Exception|Error:|\b[0-9a-f]{7,40}\b|`[^`]+`'
FIX_ELIGIBLE=false
if printf '%s' "$SCAN_TEXT" | grep -qiE "$FIXCLAIM_RE"; then
  FIX_ELIGIBLE=true
fi
if [[ "$FIX_ELIGIBLE" == "true" ]] \
   && ! printf '%s' "$SCAN_TEXT" | grep -qiE "$EVID_RE"; then
  ISSUES="${ISSUES}iron-law-2 "
fi

# (d) uncertain-hedge (§10 Honesty): the Uncertain section hedges (may/could/might/
# 可能/或许) instead of stating "uncertain because <X>". Scoped to the Uncertain
# section tail (byte offset P_UNC into $LAST) so legitimate hedges elsewhere don't
# trip it; cleared by a because/因为/由于 justification in the same section.
HONESTY_ELIGIBLE=false
if [[ -n "$P_UNC" ]]; then
  HONESTY_ELIGIBLE=true
  UNC_TAIL="$(printf '%s' "$LAST" | tail -c "+$((P_UNC+1))" 2>/dev/null)"
  if printf '%s' "$UNC_TAIL" | grep -qiE '\b(may|might|could|possibly|perhaps)\b|可能|或许|也许|大概' \
     && ! printf '%s' "$UNC_TAIL" | grep -qiE '\bbecause\b|因为|由于'; then
    ISSUES="${ISSUES}uncertain-hedge "
  fi
fi

# A vocabulary scan applies to every extracted assistant message. The other
# rules enter the denominator only when their triggering report shape exists.
hook_observe "$HOOK" '§10-V' "$SID" true true '{"stage":"last-message-scanned"}'
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
  vtok="${ISSUES#*banned-vocab:}"; vtok="banned-vocab:${vtok%%[[:space:]]*}"
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
