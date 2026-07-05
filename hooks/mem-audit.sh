#!/usr/bin/env bash
# mem-audit.sh — Stop. Observer for §7 memory hygiene: the "Index hygiene" clause
# plus the mandatory `verified: <date> | source:` header every memory/*.md must
# carry. Audits the SAME MEMORY.md that memory-prompt-hint.sh surfaces (via
# hook_find_memory_file), so a drifted index — the thing that makes A3's cite-hint
# point at nothing — becomes visible instead of silently rotting.
#
# Three drift classes:
#   index_orphan   — a MEMORY.md line links memory/<f>.md that does NOT exist  (routing breakage)
#   file_orphan    — a memory/<f>.md exists but no index line links it          (unroutable memory)
#   missing_header — a memory/<f>.md lacks the `verified:`/`source:` header      (decays silently)
#
# 用户无感 discipline: telemetry is recorded for ALL three (so decay is measurable in
# the governance loop), but a surfaced advisory is QUEUED only for the ORPHAN classes
# — active routing breakage worth one nudge. A missing header alone stays silent
# (soft hygiene is the user's call, not a nag). At most one audit per memory-dir per
# 24h; fail-open throughout; the dir read is depth-1 (§8 forbids recursive traversal
# of home/config dirs). Never writes into the user's repo — it observes + nudges.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="mem-audit"
hook_kill_switch "MEM_AUDIT" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Audit exactly what the hint hook routes off — the resolved MEMORY.md, not a guess.
MEMFILE="$(hook_find_memory_file "$CWD" 2>/dev/null || true)"
[[ -n "$MEMFILE" && -r "$MEMFILE" ]] || exit 0

# Debounce: one audit per memory-dir per 24h. The stamp's mtime IS the clock (no
# stored epoch). Keyed by a cksum of the resolved path so per-project dirs debounce
# independently; a dir untouched >7d has its stamp GC'd by session-start-check.sh.
STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
HASH="$(printf '%s' "$MEMFILE" | cksum | cut -d' ' -f1)"
STAMP="$STATE_DIR/mem-audit-$HASH.stamp"
# find prints the path only when the mtime test holds → non-empty = "scanned <24h
# ago, stay quiet". -maxdepth 0 applies the test to the named file itself.
if [[ -f "$STAMP" ]] && [[ -n "$(find "$STAMP" -maxdepth 0 -mmin -1440 2>/dev/null)" ]]; then
  exit 0
fi

# Audit the memory dir (depth-1, non-recursive — fs.readdirSync does not descend).
# node prints line 1 = "<index_orphan> <file_orphan> <missing_header>", then one
# bullet per ORPHAN (missing_header emits no bullet, so it can never reach a surfaced
# message). Empty / parse failure → treated as clean (fail-open; never nag on our bug).
RESULT="$(node -e '
const fs=require("fs"), path=require("path");
const memFile=process.argv[1];
const memDir=path.join(path.dirname(memFile),"memory");
let idxRaw;
try{ idxRaw=fs.readFileSync(memFile,"utf8"); }catch{ process.exit(0); }
// index targets = memory/<file>.md link targets on the index lines.
const indexed=new Set();
for(const ln of idxRaw.split(/\r?\n/)){
  const links=ln.match(/\((?:\.\/)?memory\/[^)]+\.md\)/g);
  if(!links) continue;
  for(const g of links){ const b=g.match(/memory\/([^)]+\.md)/); if(b) indexed.add(b[1]); }
}
// actual leaf files (depth-1). archive_index.md is a secondary index, not a leaf.
let files;
try{ files=fs.readdirSync(memDir); }catch{ files=[]; }
const leaf=files.filter(f=>f.endsWith(".md") && f!=="archive_index.md");
const leafSet=new Set(leaf);
const bullets=[]; let io=0,fo=0,mh=0;
for(const t of indexed){ if(!leafSet.has(t)){ io++; bullets.push("- index lists a missing file: memory/"+t); } }
for(const f of leaf){
  if(!indexed.has(f)){ fo++; bullets.push("- memory file not in the index: memory/"+f); }
  let head="";
  try{ head=(fs.readFileSync(path.join(memDir,f),"utf8").split(/\r?\n/).find(l=>l.trim())||""); }catch{ head=""; }
  if(!(/verified:/i.test(head) && /source:/i.test(head))) mh++;
}
process.stdout.write([io+" "+fo+" "+mh].concat(bullets).join("\n"));
' "$MEMFILE" 2>/dev/null)" || RESULT=""

FIRST="${RESULT%%$'\n'*}"
read -r IO FO MH <<<"$FIRST"
[[ "$IO" =~ ^[0-9]+$ && "$FO" =~ ^[0-9]+$ && "$MH" =~ ^[0-9]+$ ]] || { IO=0; FO=0; MH=0; }

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

TOTAL=$((IO+FO+MH))
if [[ "$TOTAL" -gt 0 ]]; then
  ORPHANS=$((IO+FO))
  SURFACED=false; [[ "$ORPHANS" -gt 0 ]] && SURFACED=true
  # Measurable: every finding, orphan or not, lands one telemetry row for the loop.
  hook_record "$HOOK" "advisory" \
    "$(jq -cn --argjson io "$IO" --argjson fo "$FO" --argjson mh "$MH" --argjson s "$SURFACED" --arg mem "$MEMFILE" \
        '{index_orphan:$io,file_orphan:$fo,missing_header:$mh,surfaced:$s,mem:$mem}' 2>/dev/null || echo null)" \
    '§7-memory-hygiene' "$SID"
  # Surfaced: only routing breakage (orphans) earns a queued nudge — soft header
  # decay is measured, not nagged.
  if [[ "$ORPHANS" -gt 0 ]]; then
    DETAIL="$(printf '%s\n' "$RESULT" | tail -n +2 | grep -E '^- (index lists|memory file not)' || true)"
    MSG="[agentsmd §7] MEMORY.md hygiene — ${MEMFILE}:"$'\n'"${DETAIL}"$'\n'"Re-link or archive stale index lines (memory/archive_index.md) — the memory hint routes off this index. (Muted 24h.)"
    hook_queue_advisory "$MSG" "$SID"
  fi
fi

# Stamp regardless of findings — a healthy dir debounces too (no point re-scanning
# every turn for 24h).
: > "$STAMP" 2>/dev/null || true
exit 0
