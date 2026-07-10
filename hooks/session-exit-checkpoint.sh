#!/usr/bin/env bash
# session-exit-checkpoint.sh — Stop. Observer for §7-session-exit ("un-validated
# work is not 'Completed'"). Detects a turn that MUTATED files (apply_patch or a
# known formatter/in-place writer) with NO validating command (test / lint /
# typecheck / build) run afterward,
# and (a) records telemetry so the otherwise self-enforced, invisible rule becomes
# measurable, and (b) drops a silent per-session state flag under the agentsmd
# state dir. Stop is a turn checkpoint, NOT reliable evidence that a session
# ended: Codex may emit many Stops before a later resume. session-start-check.sh
# therefore surfaces only expired flags, never every OTHER session key.
#
# Never blocks. Never writes into the user's repo (the paused-task file itself
# stays the agent's §7 responsibility; this hook only observes + nudges). The flag
# self-clears the moment a later turn validates. Fail-open throughout.
#
# Codex transcript shapes (verified on a real ~/.codex/sessions/*.jsonl):
#   file edit   → {type:"custom_tool_call", payload:{name:"apply_patch",...}}
#   shell/exec  → {type:"function_call",    payload:{name:"exec_command", arguments:"…"}}
#   user turn   → {type:"user_message"} (or a message/response_item with role user)

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="session-exit-checkpoint"
hook_kill_switch "SESSION_EXIT_CHECKPOINT" || exit 0
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
SKEY="$(hook_session_key "$SID")"
# No session id → cannot key a per-session flag without cross-contaminating
# concurrent sessions. Skip rather than write a shared, mislabelled flag.
[[ "$SKEY" == "global" ]] && exit 0
TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || exit 0
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

STATE_DIR="${CODEX_HOME:-$HOME/.codex}/.agentsmd-state"
FLAG="$STATE_DIR/unvalidated-$SKEY.flag"

# Walk the transcript tail (512 KiB — the current turn lives at the end; caps the
# per-Stop cost at O(1), not O(transcript)). Since the last user turn: count
# mutations, and detect any validating shell command. Prints "MUT VAL"
# (e.g. "3 0" = 3 edits, none validated). Empty/parse failure → stay silent.
RESULT="$(node -e '
const fs=require("fs");
const p=process.argv[1];
const CAP=1<<19;
let lines;
try{const fd=fs.openSync(p,"r"),sz=fs.fstatSync(fd).size,st=sz>CAP?sz-CAP:0,b=Buffer.alloc(sz-st);
  fs.readSync(fd,b,0,sz-st,st);fs.closeSync(fd);
  lines=b.toString("utf8").split(/\r?\n/).filter(Boolean);}catch{process.exit(0);}
// Locate the last user-turn boundary; scan only what follows it (this turn).
let start=0;
for(let i=lines.length-1;i>=0;i--){
  let o;try{o=JSON.parse(lines[i]);}catch{continue;}
  const t=o&&o.type,pl=o&&o.payload!=null?o.payload:o,role=pl&&(pl.role||pl.author);
  if(t==="user_message"||((t==="message"||t==="response_item")&&role==="user")){start=i+1;break;}
}
const VAL=/\b(npm\s+(test|run\b[^\n]*\b(test|lint|check|typecheck|build))|yarn\s+(test|lint)|pnpm\s+(test|lint)|python\s+-m\s+pytest|pytest|jest|vitest|mocha|cargo\s+(test|build|check|clippy)|go\s+test|tsc\b|eslint|biome\s+(?:check|lint)\b|ruff\s+(?:check\b|format\b[^\n]*--check\b)|clippy|make\s+(test|check)|(?:node|bash|sh)\s+[^\n;]*(?:\/tests?\/|\.test\.(?:[cm]?[jt]s|tsx?)\b|(?:smoke|test)\.sh\b))/i;
const MUT=/((?:npx\s+)?prettier\b[^\n]*(?:--write|-w\b)|eslint\b[^\n]*--fix\b|biome\b[^\n]*(?:--write|--fix)\b|gofmt\b[^\n]*-w\b|rustfmt\b|cargo\s+fmt\b|sed\b[^\n]*\s-i(?:\s|$)|perl\b[^\n]*\s-pi\b|npm\s+run\s+(?:format|fmt)\b)/i;
const RUFF_MUT=/\bruff\s+format\b/i;
const RUFF_CHECK=/\bruff\s+format\b[^\n]*--check\b/i;
let mut=0,val=0;
for(let i=start;i<lines.length;i++){
  let o;try{o=JSON.parse(lines[i]);}catch{continue;}
  const pl=o&&o.payload!=null?o.payload:o,name=(pl&&pl.name)||o.name;
  // Validation counts only after the most-recent edit. A test before a later
  // apply_patch characterizes old bytes; it cannot validate the new bytes.
  if(name==="apply_patch"){mut++;val=0;continue;}
  if(name==="exec_command"){
    let a=pl&&pl.arguments;
    if(typeof a==="string"){try{a=JSON.parse(a);}catch{a=null;}}
    // Inspect only executable command fields. workdir/justification and other
    // JSON metadata may contain words such as "test" but execute nothing.
    const raw=a&&typeof a==="object"?(a.cmd!==undefined?a.cmd:a.command):null;
    const cmd=typeof raw==="string"?raw
      :(Array.isArray(raw)&&raw.every(x=>typeof x==="string")?raw.join(" "):"");
    if(MUT.test(cmd)||(RUFF_MUT.test(cmd)&&!RUFF_CHECK.test(cmd))){mut++;val=0;}
    if(mut>0&&VAL.test(cmd))val=1;
  }
}
process.stdout.write(mut+" "+val);
' "$TRANSCRIPT" 2>/dev/null)" || exit 0

MUT="${RESULT%% *}"; VAL="${RESULT##* }"
[[ "$MUT" =~ ^[0-9]+$ ]] || exit 0
if [[ "$MUT" -gt 0 ]]; then
  hook_observe "$HOOK" '§7-session-exit' "$SID" true true \
    "$(jq -cn --argjson m "$MUT" --arg v "$VAL" '{mutations:$m,validated:($v=="1")}' 2>/dev/null || echo null)"
fi

if [[ "$MUT" -gt 0 && "$VAL" == "0" ]]; then
  # Mutated without validating. Record telemetry ONCE per streak — only on the
  # absent→present transition — so the ledger gets one row per unvalidated streak,
  # not one per turn (which would flood §7-session-exit with mid-work edits).
  if [[ ! -f "$FLAG" ]]; then
    hook_record "$HOOK" "advisory" \
      "$(jq -cn --argjson n "$MUT" --arg cwd "$CWD" '{mutations:$n,cwd:$cwd}' 2>/dev/null || echo null)" \
      '§7-session-exit' "$SID"
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
  printf 'mutations=%s\ncwd=%s\n' "$MUT" "$CWD" > "$FLAG" 2>/dev/null || true
else
  # Validated this turn (or nothing mutated) → clear any outstanding flag.
  rm -f "$FLAG" 2>/dev/null || true
fi
exit 0
