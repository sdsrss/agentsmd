#!/usr/bin/env bash
# transcript-structure-scan.sh — Stop. Post-hoc scan of the last assistant
# message for spec §10 violations: (a) banned vocabulary (§10 Specificity), and
# (b) four-section REPORT order Done → Not done → Failed → Uncertain (§10 Order),
# only when the message is clearly a four-section report. Non-blocking: telemetry
# + a queued advisory surfaced at the next UserPromptSubmit. Parses the Codex session JSONL
# ({timestamp,type,payload}); if it can't locate an assistant message it stays
# silent (fail-open — a scan that can't parse must not misfire).

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
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

# (b) four-section order — only when clearly a four-section report (≥2 markers).
order_pos() { printf '%s' "$LAST" | grep -aboiE "(^|\n)[[:space:]>*-]*${1}\b" 2>/dev/null | head -1 | cut -d: -f1; }
P_DONE="$(order_pos 'Done')"; P_NOT="$(order_pos 'Not done')"
P_FAIL="$(order_pos 'Failed')"; P_UNC="$(order_pos 'Uncertain')"
MARKERS=0
for v in "$P_NOT" "$P_FAIL" "$P_UNC"; do [[ -n "$v" ]] && MARKERS=$((MARKERS+1)); done
if [[ -n "$P_DONE" && "$MARKERS" -ge 2 ]]; then
  prev="$P_DONE"; bad=0
  for v in "$P_NOT" "$P_FAIL" "$P_UNC"; do
    [[ -z "$v" ]] && continue
    (( v < prev )) && bad=1
    prev="$v"
  done
  (( bad == 1 )) && ISSUES="${ISSUES}four-section-order "
fi

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
hook_queue_advisory \
  "[agentsmd §10] Last report may violate: ${ISSUES}. §10 (HARD): quantify value claims (absolute number / baseline-anchored ratio, not adjectives) and order sections Done → Not done → Failed → Uncertain." \
  "$SID"
exit 0
