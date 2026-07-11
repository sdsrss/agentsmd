#!/usr/bin/env bash
# memory-read-check.sh — PreToolUse:Bash. Enforces spec §7 "MEMORY.md
# read-the-file (HARD at ship/destructive/L3)": before a ship-family command
# (git push/merge, publish, deploy), if the project (or global) MEMORY.md exists
# it MUST have been consulted this session. Detection requires a successful
# read_file call or an explicit read command paired with successful tool output;
# assistant prose and path-only commands are not read evidence.
# Bypass: [allow-unread-memory]. Fail-open when no MEMORY.md / no transcript.

set -uo pipefail
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=/dev/null
source "$LIB_DIR/hook-common.sh" 2>/dev/null || exit 0
hook_plugin_shadowed_by_standalone && exit 0

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
  if (( ${#MEMORIES[@]} > 0 )); then
    for existing in "${MEMORIES[@]}"; do [[ "$existing" == "$candidate" ]] && return 0; done
  fi
  MEMORIES+=("$candidate")
}

while IFS= read -r invocation; do
  [[ -n "$invocation" ]] || continue
  # Keep the array non-empty for Bash 3.2 under set -u; expanding an empty
  # repoArgs array there aborts the hook before Git can resolve the event cwd.
  git_repo_args=(-C "$CWD")
  while IFS= read -r arg; do git_repo_args+=("$arg"); done < <(printf '%s' "$invocation" | jq -r '.repoArgs[]' 2>/dev/null)
  TARGET_ROOT="$(git "${git_repo_args[@]}" rev-parse --show-toplevel 2>/dev/null)"
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
const path = require("path");
const calls = new Map();
const outputs = new Map();
const parseValue = (value) => {
  if (!value || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};
const outputFailed = (value) => {
  value = parseValue(value);
  if (value && typeof value === "object") {
    for (const key of ["exit_code", "exitCode"]) {
      if (Number.isFinite(Number(value[key])) && Number(value[key]) !== 0) return true;
    }
    return Object.values(value).some(outputFailed);
  }
  return typeof value === "string" && /(?:\b(?:Process\s+)?exited\s+(?:with\s+code\s+)?[1-9][0-9]*\b|\bexit[_ ]?code\s*[:=]?\s*[1-9][0-9]*\b|No such file or directory|Script failed|tool_error)/i.test(value);
};
// Scan the complete JSONL instead of a tail window: a valid read early in a long
// session remains evidence. Memory stays bounded by retaining only path-relevant
// in-flight calls (max 1024) and successful pairs (max 256), never tool outputs.
const pending = new Map();
const MAX_PENDING = 1024;
const MAX_SUCCESSFUL = 256;
const MAX_LINE_BYTES = 1 << 20;
const transcript = process.argv[1];
let fd;
try { fd = fs.openSync(transcript, "r"); } catch { process.exit(2); }
let carry = "", droppingOversize = false;
const processLine = (line) => {
  if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  const p = o && o.payload != null ? o.payload : o;
  if (!p || typeof p !== "object") return;
  const type = p.type || o.type;
  const callId = p.call_id || p.id;
  if ((type === "function_call" || type === "custom_tool_call") && callId) {
    const name = p.name || "";
    if (["exec_command", "exec", "read_file"].includes(name)) {
      const args = parseValue(p.arguments != null ? p.arguments : p.input);
      const source = JSON.stringify(args == null ? "" : args);
      if (/MEMORY\.md|[\\/]memory[\\/]/.test(source)) {
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        pending.set(callId, { name, arguments: args });
      }
    }
    return;
  }
  if ((type === "function_call_output" || type === "custom_tool_call_output") && callId) {
    const call = pending.get(callId);
    pending.delete(callId);
    if (!call || calls.size >= MAX_SUCCESSFUL) return;
    const out = p.output != null ? p.output : p.content;
    if (out != null && JSON.stringify(out).length > 2 && !outputFailed(out)) {
      calls.set(callId, call);
      outputs.set(callId, true);
    }
  }
};
try {
  const chunk = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (!n) break;
    carry += chunk.subarray(0, n).toString("utf8");
    let nl;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl).replace(/\r$/, "");
      carry = carry.slice(nl + 1);
      if (!droppingOversize) processLine(line);
      droppingOversize = false;
    }
    if (Buffer.byteLength(carry) > MAX_LINE_BYTES) { carry = ""; droppingOversize = true; }
  }
  if (!droppingOversize && carry) processLine(carry.replace(/\r$/, ""));
} catch { fs.closeSync(fd); process.exit(2); }
fs.closeSync(fd);
const consulted = process.argv.slice(2).filter((memory) => {
  // macOS exposes the same temp path as both /var/... and /private/var/....
  // Git canonicalizes to the latter while the transcript may retain the former.
  // TMPDIR commonly ends in '/', so mktemp-derived transcript paths can also
  // carry a harmless doubled separator that Git removes during canonicalization.
  const normalize = (value) => value
    .replace(/\/private\/var\//g, "/var/")
    .replace(/\/{2,}/g, "/");
  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathMentioned = (source, target) => new RegExp(`(^|[\\s\"\x27=])${escapeRe(normalize(target))}($|[\\s\"\x27])`).test(normalize(source));
  const commandReads = (source, target) => {
    if (typeof source !== "string") return false;
    return source.split(/\r?\n|;|&&|\|\||\|/).some((segment) => {
      const reader = /^\s*(?:(?:command|sudo)\s+)*(?:env(?:\s+(?:-[^\s]+|[A-Za-z_]\w*=[^\s]+))*\s+)?(?:[A-Za-z_]\w*=[^\s]+\s+)*(?:\/[^\s]+\/)?(?:cat|sed|head|tail|awk|rg|grep|bat|less|more|perl)\b/.test(segment);
      return reader && pathMentioned(segment, target);
    });
  };
  const exactPathField = (value, target) => {
    if (!value || typeof value !== "object") return false;
    return [value.path, value.file_path].some((v) => typeof v === "string" && normalize(v) === normalize(target));
  };
  const orchestratedCommands = (source) => {
    const found = [];
    const marker = "tools.exec_command(";
    if (typeof source !== "string") return found;
    const readString = (start) => {
      const quote = source[start];
      if (quote !== "\"" && quote !== "\x27") return null;
      let value = "";
      for (let i = start + 1; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === quote) return { value, end: i + 1 };
        if (ch !== "\\") { value += ch; continue; }
        if (++i >= source.length) return null;
        const esc = source[i];
        const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
        if (Object.prototype.hasOwnProperty.call(simple, esc)) value += simple[esc];
        else if (esc === "x" && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
          value += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16)); i += 2;
        } else if (esc === "u" && /^[0-9a-f]{4}$/i.test(source.slice(i + 1, i + 5))) {
          value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4;
        } else if (esc !== "\n" && esc !== "\r") value += esc;
      }
      return null;
    };
    const skipIgnored = (at) => {
      let i = at;
      for (;;) {
        while (/\s/.test(source[i] || "")) i += 1;
        if (source.startsWith("//", i)) { i = source.indexOf("\n", i + 2); if (i < 0) return source.length; continue; }
        if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); return end < 0 ? source.length : skipIgnored(end + 2); }
        return i;
      }
    };
    const objectFields = (start) => {
      const fields = [];
      let fieldStart = start + 1, braces = 1, brackets = 0, parens = 0, i = start + 1;
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\"" || ch === "\x27") { const s = readString(i); if (!s) return null; i = s.end; continue; }
        if (source.startsWith("//", i)) { const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end + 1; continue; }
        if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue; }
        if (ch === "{") braces += 1;
        else if (ch === "}" && --braces === 0) { fields.push(source.slice(fieldStart, i)); return { fields, end: i + 1 }; }
        else if (ch === "[") brackets += 1;
        else if (ch === "]") brackets -= 1;
        else if (ch === "(") parens += 1;
        else if (ch === ")") parens -= 1;
        else if (ch === "," && braces === 1 && brackets === 0 && parens === 0) { fields.push(source.slice(fieldStart, i)); fieldStart = i + 1; }
        i += 1;
      }
      return null;
    };
    const fieldValue = (field, wanted) => {
      let i = 0;
      while (/\s/.test(field[i] || "")) i += 1;
      let key = "";
      if (field[i] === "\"" || field[i] === "\x27") {
        const quote = field[i++];
        while (i < field.length && field[i] !== quote) key += field[i++];
        if (field[i] !== quote) return null;
        i += 1;
      } else {
        const match = field.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (!match) return null;
        key = match[0]; i += key.length;
      }
      while (/\s/.test(field[i] || "")) i += 1;
      if (field[i++] !== ":" || !wanted.has(key)) return null;
      while (/\s/.test(field[i] || "")) i += 1;
      const localSource = source;
      source = field;
      const parsed = readString(i);
      source = localSource;
      return parsed ? parsed.value : null;
    };
    for (let i = 0; i < source.length;) {
      if (source[i] === "\"" || source[i] === "\x27") { const s = readString(i); i = s ? s.end : source.length; continue; }
      if (source.startsWith("//", i) || source.startsWith("/*", i)) { i = skipIgnored(i); continue; }
      if (!source.startsWith(marker, i)) { i += 1; continue; }
      const start = skipIgnored(i + marker.length);
      if (source[start] !== "{") { i += marker.length; continue; }
      const parsed = objectFields(start);
      if (!parsed) break;
      for (const field of parsed.fields) {
        const value = fieldValue(field, new Set(["cmd", "command"]));
        if (typeof value === "string") found.push(value);
      }
      i = parsed.end;
    }
    return found;
  };
  const commandFields = (value, name) => {
    if (typeof value === "string") return name === "exec" ? orchestratedCommands(value) : [value];
    if (!value || typeof value !== "object") return [];
    return [value.cmd, value.command, value.source].filter((v) => typeof v === "string");
  };
  const wasRead = (target) => {
    for (const [callId, call] of calls) {
      if (!outputs.has(callId)) continue;
      if (call.name === "read_file" && exactPathField(call.arguments, target)) return true;
      if ((call.name === "exec_command" || call.name === "exec")
          && commandFields(call.arguments, call.name).some((source) => commandReads(source, target))) return true;
    }
    return false;
  };
  if (!wasRead(memory)) return false;
  let body;
  try { body = fs.readFileSync(memory, "utf8"); } catch { return false; }
  const MAX_MEMORY_BYTES = 64 * 1024;
  const root = path.dirname(memory);
  const memoryDir = path.join(root, "memory");
  let memoryDirStat, memoryReal;
  try {
    memoryDirStat = fs.lstatSync(memoryDir);
    if (!memoryDirStat.isDirectory() || memoryDirStat.isSymbolicLink()) return true;
    memoryReal = fs.realpathSync(memoryDir);
  } catch { return true; }
  const links = [];
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (!target || target.includes("\\") || target.includes("\0") || path.isAbsolute(target)
        || /^[A-Za-z]:[\\/]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const parts = target.split("/");
    if (parts[0] !== "memory" || parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")
        || !parts[parts.length - 1].endsWith(".md")) continue;
    let cursor = memoryDir, unsafe = false;
    for (const part of parts.slice(1)) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); } catch { unsafe = true; break; }
      if (stat.isSymbolicLink()) { unsafe = true; break; }
    }
    if (unsafe) continue;
    let stat, real;
    try { stat = fs.statSync(cursor); real = fs.realpathSync(cursor); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES || !real.startsWith(memoryReal + path.sep)) continue;
    links.push(real);
  }
  return links.length === 0 || links.some(wasRead);
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
