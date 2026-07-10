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

# Resolve every actual Git push/merge independently. repoArgs carries only Git
# globals that affect repository selection (-C/--git-dir/--work-tree/etc.); pass
# them as argv after anchoring Git at the event cwd, never by shell evaluation.
GIT_INVOCATIONS=""
if ! GIT_INVOCATIONS="$(hook_git_invocations_json 'push|merge' "$CMD" 2>/dev/null)"; then
  hook_record_failopen "$HOOK" "git-parse-failed"
  exit 0
fi
[[ -n "$GIT_INVOCATIONS" ]] || GIT_INVOCATIONS='[]'
NON_GIT_PUBLISH=0
printf '%s' "$CMD" | grep -qiE '(npm|pnpm|yarn)[[:space:]]+publish\b|(^|[[:space:]])(gh[[:space:]]+release|cargo[[:space:]]+publish)\b' \
  && NON_GIT_PUBLISH=1
GIT_COUNT="$(printf '%s' "$GIT_INVOCATIONS" | jq -r 'length' 2>/dev/null || echo 0)"
[[ "$GIT_COUNT" =~ ^[0-9]+$ ]] || GIT_COUNT=0
[[ "$GIT_COUNT" -gt 0 || "$NON_GIT_PUBLISH" -eq 1 ]] || exit 0

memory_unevaluated() {
  local reason="$1" memory="${2:-}"
  hook_observe "$HOOK" '§7-memory-read' "$SID" true false \
    "$(jq -cn --arg m "$memory" --arg r "$reason" '{memory:$m,reason:$r}' 2>/dev/null || echo null)"
}

MEMORIES=()
add_memory() {
  local candidate="$1" existing
  [[ -n "$candidate" ]] || return 0
  for existing in "${MEMORIES[@]}"; do [[ "$existing" == "$candidate" ]] && return 0; done
  MEMORIES+=("$candidate")
}

while IFS= read -r invocation; do
  [[ -n "$invocation" ]] || continue
  repo_args=()
  while IFS= read -r arg; do repo_args+=("$arg"); done < <(printf '%s' "$invocation" | jq -r '.repoArgs[]' 2>/dev/null)
  TARGET_ROOT="$(git -C "$CWD" "${repo_args[@]}" rev-parse --show-toplevel 2>/dev/null)"
  if [[ -z "$TARGET_ROOT" || ! -d "$TARGET_ROOT" ]]; then
    # The command is a real ship invocation, but its repository cannot be bound
    # safely. It remains an eligible opportunity, unevaluated; never fall back
    # to an unrelated MEMORY.md found from the event cwd.
    memory_unevaluated "target-repo-unresolved" ""
    continue
  fi
  [[ -r "$TARGET_ROOT/MEMORY.md" ]] && add_memory "$TARGET_ROOT/MEMORY.md"
done < <(printf '%s' "$GIT_INVOCATIONS" | jq -c '.[]' 2>/dev/null)

# Non-Git publish commands have no parser-provided repository identity; retain
# the established event-cwd lookup policy for those invocations.
if [[ "$NON_GIT_PUBLISH" -eq 1 ]]; then
  EVENT_MEM="$(hook_find_memory_file "$CWD" 2>/dev/null || true)"
  [[ -n "$EVENT_MEM" ]] && add_memory "$EVENT_MEM"
fi

[[ "${#MEMORIES[@]}" -gt 0 ]] || exit 0
if [[ "$CMD" == *"[allow-unread-memory]"* ]]; then
  for MEM in "${MEMORIES[@]}"; do memory_unevaluated "bypass" "$MEM"; done
  hook_record "$HOOK" "bypass" '{"token":"allow-unread-memory"}' '§7-memory-read' "$SID"
  exit 0
fi

# Was it consulted? Fail-open if we can't read the transcript to tell. User
# prompts do not count: otherwise "push without reading MEMORY.md" satisfies the
# gate by merely naming the file. Evidence is checked per target path so reading
# repository A cannot satisfy a chained ship from repository B.
TRANSCRIPT="$(hook_json_field "$EVENT" '.transcript_path')"
if [[ -z "$TRANSCRIPT" || ! -r "$TRANSCRIPT" ]]; then
  for MEM in "${MEMORIES[@]}"; do memory_unevaluated "no-transcript" "$MEM"; done
  hook_record_failopen "$HOOK" "no-transcript"
  exit 0
fi
CONSULTED_JSON="$(node -e '
const fs = require("fs");
const CAP = 1 << 19; // 512 KiB tail — bound the read on long sessions (mirror of the Stop hooks); an unbounded readFileSync here degraded the ship gate to a timeout no-op on the longest sessions.
let lines;
try {
  const fd = fs.openSync(process.argv[1], "r");
  let buf;
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > CAP ? size - CAP : 0;
    buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
  } finally { fs.closeSync(fd); }
  lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
} catch { process.exit(2); }
const eligible = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o && o.payload != null ? o.payload : o;
  const role = p && (p.role || p.author);
  if (role === "user") continue;
  eligible.push(line);
}
const consulted = process.argv.slice(2).filter((memory) => {
  const slash = Math.max(memory.lastIndexOf("/"), memory.lastIndexOf("\\"));
  const dir = slash >= 0 ? memory.slice(0, slash) : "";
  return eligible.some((line) => line.includes(memory)
    || (dir && line.includes(dir) && line.includes("MEMORY.md")));
});
process.stdout.write(JSON.stringify(consulted));
process.exit(consulted.length === process.argv.length - 2 ? 0 : 1);
' "$TRANSCRIPT" "${MEMORIES[@]}" 2>/dev/null)"
CONSULTED=$?
# Fail-OPEN on anything but the detector's explicit "not consulted" (exit 1).
# exit 2 is its own read-failure signal; any OTHER status is node dying
# independently of this parent (OOM/SIGKILL/SIGSEGV/SIGTERM → 137/139/143), a
# tool malfunction that must never fail-CLOSED onto a git push — the layer's
# prime invariant. Only a clean exit 1 is evidence the file was not opened.
if [[ "$CONSULTED" -ne 0 && "$CONSULTED" -ne 1 ]]; then
  for MEM in "${MEMORIES[@]}"; do memory_unevaluated "transcript-read-failed" "$MEM"; done
  hook_record_failopen "$HOOK" "transcript-read-failed"
  exit 0
fi
UNREAD=""
for MEM in "${MEMORIES[@]}"; do
  WAS_CONSULTED="$(printf '%s' "$CONSULTED_JSON" | jq -r --arg m "$MEM" 'index($m) != null' 2>/dev/null)"
  if [[ "$WAS_CONSULTED" == "true" ]]; then
    hook_observe "$HOOK" '§7-memory-read' "$SID" true true \
      "$(jq -cn --arg m "$MEM" '{memory:$m,consulted:true}' 2>/dev/null || echo null)"
    continue
  fi
  hook_observe "$HOOK" '§7-memory-read' "$SID" true true \
    "$(jq -cn --arg m "$MEM" '{memory:$m,consulted:false}' 2>/dev/null || echo null)"
  [[ -n "$UNREAD" ]] || UNREAD="$MEM"
done
[[ -n "$UNREAD" ]] || exit 0

# The block text below refers to the file by its DIRECTORY, never the literal
# "MEMORY.md" — otherwise, if Codex echoes this hook's own reason into the
# transcript, the next retry's grep above would match it and the hook would
# satisfy itself (a self-defeating gate). The telemetry record keeps the full path.
MEM="$UNREAD"
MEMDIR="$(dirname "$MEM")"
hook_record "$HOOK" "block" "$(jq -cn --arg m "$MEM" '{memory:$m}')" '§7-memory-read' "$SID"
hook_block \
  "Blocked: shipping before consulting the project memory index under ${MEMDIR} ( spec §7, HARD at ship )." \
  "§7 (HARD): a project memory index exists under ${MEMDIR} but was not opened this session, and you are about to ship. Open the index file there first (it routes to lessons that may change this push), or append [allow-unread-memory] if it is genuinely irrelevant here." \
  "PreToolUse"
