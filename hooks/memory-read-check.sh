#!/usr/bin/env bash
# memory-read-check.sh — PreToolUse:Bash. Enforces spec §7 "MEMORY.md
# read-the-file (HARD at ship/destructive/L3)": before a ship-family command
# (git push/merge, publish, deploy), if the project (or global) MEMORY.md exists
# it MUST have been consulted this session. Detection scans non-user transcript
# entries only: if MEMORY.md exists but no assistant/tool/system-side entry names
# it, the file was not observably opened → block.
# Bypass: [allow-unread-memory]. Fail-open when no MEMORY.md / no transcript.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0

HOOK="memory-read"
hook_kill_switch "MEMORY_READ" || exit 0
hook_require_jq || { hook_record_failopen "$HOOK" "jq-missing"; exit 0; }
command -v node >/dev/null 2>&1 || { hook_record_failopen "$HOOK" "node-missing"; exit 0; }

EVENT="$(hook_read_event)" || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ -n "$EVENT" ]] || { hook_record_failopen "$HOOK" "bad-event"; exit 0; }
[[ "$(hook_json_field "$EVENT" '.tool_name')" == "Bash" ]] || exit 0
CMD="$(hook_json_field "$EVENT" '.tool_input.command')"
[[ -n "$CMD" ]] || exit 0
SID="$(hook_json_field "$EVENT" '.session_id')"
CWD="$(hook_json_field "$EVENT" '.cwd')"; [[ -n "$CWD" ]] || CWD="$PWD"

# Only ship-family commands (spec §5/§E3 ship intent).
printf '%s' "$CMD" | grep -qiE '(^|[;&|]|[[:space:]])git[[:space:]]+(push|merge)\b|(npm|pnpm|yarn)[[:space:]]+publish\b|(^|[[:space:]])(gh[[:space:]]+release|cargo[[:space:]]+publish)\b' || exit 0
[[ "$CMD" == *"[allow-unread-memory]"* ]] && { hook_record "$HOOK" "bypass" '{"token":"allow-unread-memory"}' '§7-memory-read' "$SID"; exit 0; }

# Locate a MEMORY.md worth consulting: cwd, the enclosing git root (a ship command
# is often run from a subdir), or global.
MEM=""
MEM="$(hook_find_memory_file "$CWD" 2>/dev/null || true)"
[[ -n "$MEM" ]] || exit 0   # no MEMORY.md → nothing to enforce

# Was it consulted? Fail-open if we can't read the transcript to tell. User
# prompts do not count: otherwise "push without reading MEMORY.md" satisfies the
# gate by merely naming the file. Non-user transcript entries are the only
# evidence this hook can observe cheaply across Codex transcript variants.
TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
[[ -n "$TRANSCRIPT" && -r "$TRANSCRIPT" ]] || { hook_record_failopen "$HOOK" "no-transcript"; exit 0; }
node -e '
const fs = require("fs");
let lines;
try { lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean); } catch { process.exit(2); }
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o && o.payload != null ? o.payload : o;
  const role = p && (p.role || p.author);
  if (role === "user") continue;
  if (line.includes("MEMORY.md")) process.exit(0);
}
process.exit(1);
' "$TRANSCRIPT" 2>/dev/null
CONSULTED=$?
if [[ "$CONSULTED" -eq 0 ]]; then
  exit 0   # referenced this session → consider it consulted
fi
[[ "$CONSULTED" -eq 2 ]] && { hook_record_failopen "$HOOK" "transcript-read-failed"; exit 0; }

# The block text below refers to the file by its DIRECTORY, never the literal
# "MEMORY.md" — otherwise, if Codex echoes this hook's own reason into the
# transcript, the next retry's grep above would match it and the hook would
# satisfy itself (a self-defeating gate). The telemetry record keeps the full path.
MEMDIR="$(dirname "$MEM")"
hook_record "$HOOK" "block" "$(jq -cn --arg m "$MEM" '{memory:$m}')" '§7-memory-read' "$SID"
hook_block \
  "Blocked: shipping before consulting the project memory index under ${MEMDIR} ( spec §7, HARD at ship )." \
  "§7 (HARD): a project memory index exists under ${MEMDIR} but was not opened this session, and you are about to ship. Open the index file there first (it routes to lessons that may change this push), or append [allow-unread-memory] if it is genuinely irrelevant here." \
  "PreToolUse"
