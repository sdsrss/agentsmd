#!/usr/bin/env bash
# convention-cite-scan.sh — Stop. Adoption-telemetry counterpart to
# transcript-structure-scan.sh: scans the last assistant message for citations
# of `@conv-<dim>` anchors that `analyze.js --write` stamped into this
# project's AGENTS.md conventions block. The citation convention is a single
# trailing `<!-- adopted-conventions: … -->` HTML comment (so the signal never
# intrudes on the user's prose); the grep below is position-independent and
# finds the `@conv-<slug>` tokens wherever in the message they sit. (Taxonomy:
# scripts/lib/conventions-taxonomy.js
# is the taxonomy source — this hook never imports it: L1 must not import L2,
# so it reads whichever `@conv-<slug>` tokens are LITERALLY present in
# $CWD/AGENTS.md instead; the file on disk is the ground truth, not the
# taxonomy list). "Cite = adopted": each cited KNOWN anchor records one `cite`
# event, feeding `analyze --adoption`'s per-dimension report. Independent of
# the global §* enforcement/demote loop — rule-hits.sh's spec_section column
# is shared storage only; rules.js never reads `@conv-*` rows, and `@conv-*`
# is deliberately NOT added to spec/hard-rules.json's live_sections (it has no
# section_anchor in spec/AGENTS*.md to resolve against, so drift.test.js gates
# #1/#2 would reject it).
# Unknown/absent anchors are never recorded (an agent inventing an anchor that
# isn't in this project's AGENTS.md must not count as adoption — avoids
# hallucination noise). fail-open; honors DISABLE_CONVENTION_CITE_HOOK /
# DISABLE_AGENTSMD_HOOKS.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="convention-cite"
hook_kill_switch "CONVENTION_CITE" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

AGENTS_MD="$CWD/AGENTS.md"
# No project AGENTS.md → nothing to scan for. Silent no-op (exit 0), NOT a
# fail-open: a Stop hook fires every turn in every project, and "this project
# has no distilled conventions" is not a masked-enforcement error — matches
# memory-read-check.sh's absent-MEMORY handling. fail-open is reserved for
# genuine tool failures (jq/node/transcript) that would hide a cite that
# SHOULD have been recorded, not for "feature not in use here".
[[ -r "$AGENTS_MD" ]] || exit 0

# Known anchors = whatever `@conv-<slug>` tokens are literally present in this
# project's AGENTS.md right now — deduplicated. See header: never derived from
# the static taxonomy list.
KNOWN="$(grep -oE '@conv-[a-z-]+' "$AGENTS_MD" 2>/dev/null | sort -u)"
[[ -n "$KNOWN" ]] || exit 0   # AGENTS.md has no stamped conventions yet — nothing to scan for

TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || { hook_record_failopen "$HOOK" "no-transcript"; exit 0; }

# Extract the last assistant message's plain text (same extraction logic as
# transcript-structure-scan.sh; kept as an independent copy rather than a
# shared lib function — hooks in this repo are single self-contained files).
LAST="$(node -e '
const fs=require("fs");
const path=process.argv[1];
const CAP=1<<19; // last 512 KiB only — the last assistant message is at the tail;
                 // bounds this per-Stop hook to O(1), not O(transcript).
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
' "$TRANSCRIPT" 2>/dev/null)"
[[ -n "$LAST" ]] || exit 0

# Exact @conv-<slug> tokens actually cited in the last message (token-level, not
# substring — so @conv-error-handling-async does NOT count as citing
# @conv-error-handling). Record only KNOWN anchors that were cited as whole tokens.
CITED="$(printf '%s' "$LAST" | grep -oE '@conv-[a-z-]+' | sort -u)"
[[ -n "$CITED" ]] || exit 0
while IFS= read -r anchor; do
  [[ -z "$anchor" ]] && continue
  if printf '%s\n' "$CITED" | grep -qxF -- "$anchor"; then
    hook_record "$HOOK" "cite" "$(jq -cn --arg a "$anchor" '{anchor:$a}' 2>/dev/null || echo null)" "$anchor" "$SID"
  fi
done <<< "$KNOWN"

exit 0
