#!/usr/bin/env bash
# session-summary.sh — Stop. Aggregates THIS session's enforcement telemetry
# (denials / bypasses / most-active spec section) from the log tail and writes a
# per-session summary file. session-start-check.sh surfaces the most-recent OTHER
# session's summary ONCE at the next SessionStart as a one-line self-awareness
# banner (§7 cross-session lens) — agent-facing additionalContext, zero user action.
#
# Cost: reads only the last 512 KiB of the log (windowed → O(1) per Stop, not
# O(log)); a session's rows cluster at the tail, so the window captures them for any
# realistic session. Concurrency: per-session file keyed by session id + atomic
# tmp→rename write, so parallel sessions never clobber and a reader never tears.
# Derives from rows already in the log — it records NO new telemetry row (that would
# double-count the denials/bypasses it is summarizing). Fail-open throughout.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="session-summary"
hook_kill_switch "SESSION_SUMMARY" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
[[ -n "$SID" ]] || exit 0
SKEY="$(hook_session_key "$SID")"

STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
LOG_FILE="${CODEX_HOME:-$HOME/.codex}/logs/agentsmd.jsonl"
[[ -r "$LOG_FILE" ]] || exit 0
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Aggregate this session's enforcement rows from the 512 KiB log tail. A clean
# session (no denials / bypasses / advisories) prints nothing → nothing to surface.
SUMMARY="$(node -e '
const fs=require("fs");
const path=process.argv[1], sid=process.argv[2];
const CAP=1<<19; // 512 KiB tail window
let buf;
try{ const fd=fs.openSync(path,"r"),sz=fs.fstatSync(fd).size,st=sz>CAP?sz-CAP:0,b=Buffer.alloc(sz-st);
  fs.readSync(fd,b,0,sz-st,st); fs.closeSync(fd); buf=b.toString("utf8"); }catch{ process.exit(0); }
const DENY=new Set(["block","deny"]);
let denies=0,bypasses=0; const sec={};
for(const ln of buf.split(/\r?\n/)){ if(!ln)continue;
  let o; try{o=JSON.parse(ln);}catch{continue;}
  if(!o||o.session_id!==sid)continue;
  const ev=o.event;
  if(DENY.has(ev))denies++; else if(ev==="bypass")bypasses++;
  if(DENY.has(ev)||ev==="advisory"||ev==="bypass"){ const s=o.spec_section;
    if(s&&s!=="(none)"&&s!=="null")sec[s]=(sec[s]||0)+1; }
}
let topSec="",topN=0;
for(const k of Object.keys(sec)){ if(sec[k]>topN){topN=sec[k];topSec=k;} }
if(denies+bypasses+topN===0)process.exit(0);
process.stdout.write(JSON.stringify({sid,denies,bypasses,top_section:topSec,top_count:topN}));
' "$LOG_FILE" "$SID" 2>/dev/null)" || exit 0
[[ -n "$SUMMARY" ]] || exit 0

# Atomic per-session write (tmp + rename): concurrent sessions never clobber (each
# keyed by its own session id), and a reader never sees a half-written file.
DEST="$STATE_DIR/session-summary-$SKEY.json"
TMP="$DEST.tmp.$$"
if printf '%s' "$SUMMARY" > "$TMP" 2>/dev/null; then
  mv -f "$TMP" "$DEST" 2>/dev/null || rm -f "$TMP" 2>/dev/null
fi
exit 0
