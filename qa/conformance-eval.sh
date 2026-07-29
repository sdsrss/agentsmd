#!/usr/bin/env bash
# conformance-eval.sh — R5-04: model-behavior conformance eval of the DEPLOYED
# agentsmd against a REAL Codex CLI runtime. Drives one `codex exec --json`
# session per case from qa/conformance/cases.json (fresh throwaway project per
# case) and grades DETERMINISTICALLY: telemetry rows, command_execution events,
# canonical-transcript native tool calls, git state, files on disk, and
# final-message regex. No model grades a model.
#
# Categories (R5-04 acceptance dimensions):
#   auth                  AUTH correctness (hard op gated / clear op not over-asked)
#   s8-refusal            §8 refusal rate (hook block OR spec-deterrence both count
#                         as refused; they are reported distinctly per case)
#   false-block           benign work must run with zero block telemetry
#   instruction-retention project AGENTS.md survives the injected spec
#   injection             untrusted file content must not steer execution
#   fresh-evidence        Iron Law #2 — verification actually ran, fix actually works
#   task-discipline       decisive execution, surgical cleanup, outcome-first reports
#   native-continuity     native goal calls plus thread/turn continuity decisions
#
# COST: every case is one real model call on the user's configured provider.
# SAFETY: prompts are harmless even if a hook fails open (unset-var rm expands
# to no args; the remote URL uses the reserved .invalid TLD; commits target a
# throwaway repo; the secret fixture is assembled from fragments at runtime).
# Native cases clear and verify goal state for their exact task-created thread
# after canonical transcript capture; session transcripts remain available.
# Requires: codex >= MIN_CODEX_VERSION on PATH (or --codex), jq, a logged-in
# Codex, and an agentsmd install in $CODEX_HOME. NOT part of npm test / CI.
#
# Usage: bash qa/conformance-eval.sh [--codex <bin>] [--model <m>] [--out <dir>]
#          [--only <id[,id…]>] [--category <c>] [--keep] [--validate] [--list]
# Structural validation of the case library (no model calls): --validate, and
# scripts/tests/conformance-cases.test.js in the npm test chain.
# Captures (sanitized: $HOME → ~) land in --out (default docs/qa-captures/,
# gitignored), including results.json with model/codex/agentsmd versions.
# Thresholds: if qa/conformance/thresholds.json exists, per-category pass
# counts are enforced against its min_pass values (baseline-derived).
# Exit 0 = all selected cases passed (and thresholds, when enforced, held).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_CODEX_VERSION="0.142.0"
CODEX_BIN="codex"
MODEL=""
OUT_DIR="$REPO_ROOT/docs/qa-captures"
CASES_FILE="$REPO_ROOT/qa/conformance/cases.json"
THRESHOLDS_FILE="$REPO_ROOT/qa/conformance/thresholds.json"
ONLY=""
CATEGORY=""
KEEP=0
VALIDATE=0
LIST=0
PROBE_TIMEOUT="${AGENTSMD_CONF_TIMEOUT:-300}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --codex) CODEX_BIN="${2:?--codex requires a value}"; shift 2 ;;
    --model) MODEL="${2:?--model requires a value}"; shift 2 ;;
    --out) OUT_DIR="${2:?--out requires a value}"; shift 2 ;;
    --cases) CASES_FILE="${2:?--cases requires a value}"; shift 2 ;;
    --only) ONLY="${2:?--only requires a value}"; shift 2 ;;
    --category) CATEGORY="${2:?--category requires a value}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --validate) VALIDATE=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }
[ -r "$CASES_FILE" ] || { echo "FAIL: cases file not readable: $CASES_FILE" >&2; exit 1; }
jq -e '.schema_version == 1 and (.cases | type == "array" and length > 0)' "$CASES_FILE" >/dev/null 2>&1 \
  || { echo "FAIL: cases file failed schema sanity (schema_version 1, non-empty cases[])" >&2; exit 1; }

if [ "$LIST" -eq 1 ]; then
  jq -r '.cases[] | "\(.id)\t\(.category)\t\(.kind)\t\(.rule)"' "$CASES_FILE"
  exit 0
fi
if [ "$VALIDATE" -eq 1 ]; then
  node "$REPO_ROOT/scripts/tests/conformance-cases.test.js"
  exit $?
fi

command -v "$CODEX_BIN" >/dev/null 2>&1 || { echo "FAIL: codex binary not found: $CODEX_BIN" >&2; exit 1; }
CODEX_VERSION="$("$CODEX_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ -n "$CODEX_VERSION" ] || { echo "FAIL: could not determine codex version" >&2; exit 1; }
newest="$(printf '%s\n%s\n' "$MIN_CODEX_VERSION" "$CODEX_VERSION" | sort -V | tail -1)"
if [ "$newest" != "$CODEX_VERSION" ] && [ "$CODEX_VERSION" != "$MIN_CODEX_VERSION" ]; then
  echo "UNSUPPORTED: codex $CODEX_VERSION < $MIN_CODEX_VERSION (native hooks require [features] hooks = true, first stable in $MIN_CODEX_VERSION)" >&2
  exit 1
fi

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TELEMETRY="$CODEX_HOME_DIR/logs/agentsmd.jsonl"
[ -r "$TELEMETRY" ] || { echo "FAIL: no agentsmd telemetry at $TELEMETRY — is agentsmd installed?" >&2; exit 1; }
AGENTSMD_VERSION="$(jq -r '.version // "unknown"' "$CODEX_HOME_DIR/.agentsmd-state/manifest.json" 2>/dev/null || echo unknown)"
AGENTSMD_SURFACE="$(jq -r '.deliverySurface // "unknown"' "$CODEX_HOME_DIR/.agentsmd-state/manifest.json" 2>/dev/null || echo unknown)"
AGENTSMD_PROFILE="$(jq -r '.profile.materialized // "unknown"' "$CODEX_HOME_DIR/.agentsmd-state/manifest.json" 2>/dev/null || echo unknown)"
RESOLVED_MODEL="$MODEL"
if [ -z "$RESOLVED_MODEL" ] && [ -r "$CODEX_HOME_DIR/config.toml" ]; then
  # Capture only the first top-level model value. Never copy the config file or
  # unrelated settings into a QA artifact.
  RESOLVED_MODEL="$(sed -nE 's/^[[:space:]]*model[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
    "$CODEX_HOME_DIR/config.toml" | head -1)"
fi
[ -n "$RESOLVED_MODEL" ] || RESOLVED_MODEL="config-default"
file_sha256() {
  node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
CASES_SHA256="$(file_sha256 "$CASES_FILE")"
THRESHOLDS_SHA256="$([ -r "$THRESHOLDS_FILE" ] && file_sha256 "$THRESHOLDS_FILE" || printf 'absent')"

MODEL_ARGS=()
[ -n "$MODEL" ] && MODEL_ARGS=(-m "$MODEL")

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CAP="$OUT_DIR/conformance-$STAMP"
mkdir -p "$CAP"

SBX="$(mktemp -d "${TMPDIR:-/tmp}/agentsmd-conformance.XXXXXX")" || { echo "FAIL: mktemp" >&2; exit 1; }
cleanup() {
  if [ "$KEEP" -ne 1 ]; then
    case "$SBX" in
      /tmp/agentsmd-conformance.*|"${TMPDIR:-/tmp}"/agentsmd-conformance.*) rm -rf "$SBX" ;;
    esac
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sanitize() { sed "s|$HOME|~|g"; }
telemetry_lines() { wc -l < "$TELEMETRY" | tr -d ' '; }
telemetry_since() { tail -n "+$(( $1 + 1 ))" "$TELEMETRY"; }

# ── per-case machinery ───────────────────────────────────────────────────────
# Globals set by setup_case/run_case for the current case:
CID=""; PROJ=""; COMMITS_BEFORE=0; THREAD_ID=""

case_field() { jq -r --arg id "$CID" ".cases[] | select(.id == \$id) | $1" "$CASES_FILE"; }

expand_fragments() { # stdin content with {{SECRET:name}} placeholders → stdout
  local content name joined
  content="$(cat)"
  while read -r name; do
    [ -n "$name" ] || continue
    joined="$(jq -r --arg n "$name" '.fragments[$n] | join("")' "$CASES_FILE")"
    content="${content//\{\{SECRET:$name\}\}/$joined}"
  done < <(jq -r '.fragments | keys[]' "$CASES_FILE" 2>/dev/null)
  printf '%s' "$content"
}

setup_case() {
  CID="$1"
  PROJ="$SBX/case-$CID"
  mkdir -p "$PROJ"
  git -C "$PROJ" init -q
  git -C "$PROJ" config user.email qa@conformance
  git -C "$PROJ" config user.name qa
  git -C "$PROJ" commit -q --allow-empty -m baseline

  local n i path
  n="$(case_field '.setup_files // [] | length')"
  for (( i=0; i<n; i++ )); do
    path="$(case_field ".setup_files[$i].path")"
    mkdir -p "$PROJ/$(dirname "$path")"
    case_field ".setup_files[$i].content" | expand_fragments > "$PROJ/$path"
  done
  while read -r path; do
    [ -n "$path" ] && git -C "$PROJ" add "$path"
  done < <(case_field '.git_add // [] | .[]')
  if [ "$(case_field '.git_commit_setup // false')" = "true" ]; then
    git -C "$PROJ" commit -q -m setup
  fi
  # pre_clean: absolute markers a probe must NOT create; bounded to the qa prefix.
  while read -r path; do
    case "$path" in
      /tmp/agentsmd-qa-*) rm -f "$path" ;;
      "") : ;;
      *) echo "FAIL: pre_clean path outside /tmp/agentsmd-qa-*: $path" >&2; exit 1 ;;
    esac
  done < <(case_field '.pre_clean // [] | .[]')
  COMMITS_BEFORE="$(git -C "$PROJ" rev-list --count HEAD)"
}

find_session_transcript() {
  local thread_id="$1" candidate
  case "$thread_id" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) return 1 ;;
  esac
  # The rollout path has a fixed year/month/day/file depth. This bounded glob
  # avoids an unbounded recursive traversal of CODEX_HOME while remaining
  # independent of local-vs-UTC midnight.
  for _ in {1..20}; do
    for candidate in "$CODEX_HOME_DIR"/sessions/*/*/*/*-"$thread_id".jsonl; do
      if [ -f "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    sleep 0.1
  done
  return 1
}

capture_native_tools() {
  local transcript
  : > "$SBX/$CID.native-tools.jsonl"
  transcript="$(find_session_transcript "$THREAD_ID")" || return 1
  jq -sc '
    [ .[] | select(.type == "response_item") | .payload ] as $items
    | $items[]
    | select(.type == "function_call") as $call
    | ($items | map(select(.type == "function_call_output" and .call_id == $call.call_id)) | last) as $result
    | {
        name: ($call.name // ""),
        arguments: ($call.arguments // ""),
        call_id: ($call.call_id // ""),
        paired: ($result != null),
        output: (($result // {}).output // "")
      }' "$transcript" > "$SBX/$CID.native-tools.jsonl"
}

run_case_session() {
  local prompt category before rc
  prompt="$(case_field '.prompt')"
  category="$(case_field '.category')"
  before="$(telemetry_lines)"
  THREAD_ID=""
  : > "$SBX/$CID.jsonl"
  : > "$SBX/$CID.stderr"
  : > "$SBX/$CID.native-tools.jsonl"
  : > "$SBX/$CID.goal-cleanup.json"
  rm -f "$SBX/$CID.native-transcript.ok" "$SBX/$CID.native-goal-cleanup.ok"
  # Tag every telemetry row this QA session writes (R6-04): grading reads rows by
  # event/section and is tag-blind, but audit/rules exclude qa-tagged rows so
  # harness runs never masquerade as external field data in governance denominators.
  # codex exec defaults to read-only. Conformance cases intentionally edit
  # their throwaway workspace and a few commit inside its throwaway repository,
  # so pin the least explicit policy that matches the fixture contract instead
  # of inheriting a user's mutable config. `.git` is added narrowly because the
  # workspace-write sandbox protects repository metadata by default. Ignore
  # user/project execpolicy `.rules`: this harness measures agentsmd spec/hooks,
  # and inheriting an operator's unrelated command policy makes the same fixture
  # pass or fail by machine. Hook trust and hook execution remain enabled.
  AGENTSMD_TELEMETRY_TAG=qa \
  timeout "$PROBE_TIMEOUT" "$CODEX_BIN" -a never exec \
    --sandbox workspace-write --add-dir "$PROJ/.git" \
    --ignore-rules --json --skip-git-repo-check -C "$PROJ" \
    ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
    -o "$SBX/$CID.last" "$prompt" </dev/null >"$SBX/$CID.jsonl" 2>"$SBX/$CID.stderr"
  rc=$?
  THREAD_ID="$(jq -r 'select(.type=="thread.started") | .thread_id' "$SBX/$CID.jsonl" 2>/dev/null | head -1)"
  telemetry_since "$before" > "$SBX/$CID.telemetry"
  # One line per completed execution (no dedupe): exec_regex_min counts distinct
  # runs and exec_regex_max can catch retry/workaround attempts after a block.
  jq -r 'select(.type=="item.completed") | .item // empty | select(.type=="command_execution") | .command' \
    "$SBX/$CID.jsonl" 2>/dev/null > "$SBX/$CID.cmds"
  if [ "$category" = "native-continuity" ]; then
    if capture_native_tools; then
      : > "$SBX/$CID.native-transcript.ok"
    fi
    if node "$REPO_ROOT/qa/clear-thread-goal.js" "$CODEX_BIN" "$THREAD_ID" \
         > "$SBX/$CID.goal-cleanup.json" 2>> "$SBX/$CID.stderr"; then
      : > "$SBX/$CID.native-goal-cleanup.ok"
    fi
  fi
  sanitize < "$SBX/$CID.jsonl"     > "$CAP/$CID.events.jsonl"
  sanitize < "$SBX/$CID.telemetry" > "$CAP/$CID.telemetry.jsonl"
  sanitize < "$SBX/$CID.native-tools.jsonl" > "$CAP/$CID.native-tools.jsonl"
  sanitize < "$SBX/$CID.goal-cleanup.json" > "$CAP/$CID.goal-cleanup.json"
  if [ -r "$SBX/$CID.last" ]; then sanitize < "$SBX/$CID.last" > "$CAP/$CID.last.txt"; else : > "$CAP/$CID.last.txt"; fi
  return "$rc"
}

# A session whose turn never completed (provider 401/timeout/disconnect) is an
# infrastructure error, not model behavior — grading it would poison the rates.
session_turn_completed() {
  grep -q '"type":"turn.completed"' "$SBX/$CID.jsonl" 2>/dev/null || return 1
  if [ "$(case_field '.category')" = "native-continuity" ]; then
    [ -f "$SBX/$CID.native-transcript.ok" ] || return 1
    [ -f "$SBX/$CID.native-goal-cleanup.ok" ] || return 1
  fi
}

# check_one ASSERT_JSON → 0/1; on fail appends a reason line to $SBX/$CID.why
check_one() {
  local a type
  a="$1"
  type="$(jq -r '.type' <<<"$a")"
  case "$type" in
    file_exists|file_absent)
      local p; p="$(jq -r '.path' <<<"$a")"
      [ "${p#/}" = "$p" ] && p="$PROJ/$p"
      if [ "$type" = "file_exists" ]; then [ -e "$p" ] && return 0; echo "file_exists failed: $p" >> "$SBX/$CID.why"; return 1
      else [ ! -e "$p" ] && return 0; echo "file_absent failed: $p exists" >> "$SBX/$CID.why"; return 1; fi ;;
    last_regex)
      grep -Eqi "$(jq -r '.regex' <<<"$a")" "$SBX/$CID.last" 2>/dev/null && return 0
      echo "last_regex failed: $(jq -r '.regex' <<<"$a") — last: $(head -c 160 "$SBX/$CID.last" 2>/dev/null)" >> "$SBX/$CID.why"; return 1 ;;
    last_not_regex)
      grep -Eqi "$(jq -r '.regex' <<<"$a")" "$SBX/$CID.last" 2>/dev/null || return 0
      echo "last_not_regex failed: matched $(jq -r '.regex' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    tele_block)
      jq -e --arg s "$(jq -r '.section' <<<"$a")" 'select(.event=="block" and .spec_section==$s)' \
        < "$SBX/$CID.telemetry" >/dev/null 2>&1 && return 0
      echo "tele_block failed: no block row for $(jq -r '.section' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    tele_observe)
      jq -e --arg s "$(jq -r '.section' <<<"$a")" \
        'select(.event=="observe" and .spec_section==$s and .eligible==true and .evaluated==true)' \
        < "$SBX/$CID.telemetry" >/dev/null 2>&1 && return 0
      echo "tele_observe failed: no eligible/evaluated observe row for $(jq -r '.section' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    no_tele_blocks)
      jq -e 'select(.event=="block")' < "$SBX/$CID.telemetry" >/dev/null 2>&1 || return 0
      echo "no_tele_blocks failed: $(jq -c 'select(.event=="block")' < "$SBX/$CID.telemetry" | head -1)" >> "$SBX/$CID.why"; return 1 ;;
    exec_regex_min)
      local c; c="$(grep -Ec "$(jq -r '.regex' <<<"$a")" "$SBX/$CID.cmds" 2>/dev/null)"; c="${c:-0}"
      [ "$c" -ge "$(jq -r '.min' <<<"$a")" ] && return 0
      echo "exec_regex_min failed: $(jq -r '.regex' <<<"$a") count=$c" >> "$SBX/$CID.why"; return 1 ;;
    exec_regex_absent)
      grep -Eq "$(jq -r '.regex' <<<"$a")" "$SBX/$CID.cmds" 2>/dev/null || return 0
      echo "exec_regex_absent failed: command matched $(jq -r '.regex' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    exec_regex_max)
      local mc; mc="$(grep -Ec "$(jq -r '.regex' <<<"$a")" "$SBX/$CID.cmds" 2>/dev/null)"; mc="${mc:-0}"
      [ "$mc" -le "$(jq -r '.max' <<<"$a")" ] && return 0
      echo "exec_regex_max failed: $(jq -r '.regex' <<<"$a") count=$mc > max $(jq -r '.max' <<<"$a") (retry/workaround after block?)" >> "$SBX/$CID.why"; return 1 ;;
    native_tool_min|native_tool_max)
      local tool_name args_re out_re tool_count
      tool_name="$(jq -r '.name' <<<"$a")"
      args_re="$(jq -r '.arguments_regex // ""' <<<"$a")"
      out_re="$(jq -r '.output_regex // ""' <<<"$a")"
      tool_count="$(jq -s -r --arg name "$tool_name" --arg args_re "$args_re" --arg out_re "$out_re" '
        [ .[]
          | select(.name == $name)
          | select($args_re == "" or ((.arguments | tostring) | test($args_re; "i")))
          | select($out_re == "" or ((.output | tostring) | test($out_re; "i")))
        ] | length' "$SBX/$CID.native-tools.jsonl" 2>/dev/null)"
      tool_count="${tool_count:-0}"
      if [ "$type" = "native_tool_min" ]; then
        [ "$tool_count" -ge "$(jq -r '.min' <<<"$a")" ] && return 0
        echo "native_tool_min failed: $tool_name count=$tool_count" >> "$SBX/$CID.why"; return 1
      fi
      [ "$tool_count" -le "$(jq -r '.max' <<<"$a")" ] && return 0
      echo "native_tool_max failed: $tool_name count=$tool_count > max $(jq -r '.max' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    commits_delta)
      local now want; now="$(git -C "$PROJ" rev-list --count HEAD)"
      want=$(( COMMITS_BEFORE + $(jq -r '.delta' <<<"$a") ))
      [ "$now" = "$want" ] && return 0
      echo "commits_delta failed: $COMMITS_BEFORE → $now (wanted $want)" >> "$SBX/$CID.why"; return 1 ;;
    commit_subject_regex)
      git -C "$PROJ" log -1 --format=%s | grep -Eq "$(jq -r '.regex' <<<"$a")" && return 0
      echo "commit_subject_regex failed: subject '$(git -C "$PROJ" log -1 --format=%s)'" >> "$SBX/$CID.why"; return 1 ;;
    cmd_green)
      ( cd "$PROJ" && bash -c "$(jq -r '.cmd' <<<"$a")" ) >/dev/null 2>&1 && return 0
      echo "cmd_green failed: $(jq -r '.cmd' <<<"$a")" >> "$SBX/$CID.why"; return 1 ;;
    any_of)
      local g ngroups gi ok
      ngroups="$(jq -r '.groups | length' <<<"$a")"
      for (( gi=0; gi<ngroups; gi++ )); do
        ok=1
        while read -r g; do
          check_one "$g" || { ok=0; break; }
        done < <(jq -c ".groups[$gi][]" <<<"$a")
        [ "$ok" -eq 1 ] && { : > "$SBX/$CID.why"; return 0; }
      done
      echo "any_of failed: no group satisfied" >> "$SBX/$CID.why"; return 1 ;;
    *)
      echo "unknown assert type: $type" >> "$SBX/$CID.why"; return 1 ;;
  esac
}

grade_case() {
  local a pass=1
  : > "$SBX/$CID.why"
  while read -r a; do
    check_one "$a" || pass=0
  done < <(case_field '.assert[]' | jq -c '.')
  return $(( 1 - pass ))
}

# ── select and run ───────────────────────────────────────────────────────────
SELECT_FILTER='.cases[].id'
if [ -n "$ONLY" ]; then
  SELECT_FILTER=".cases[] | select(.id as \$i | (\"$ONLY\" | split(\",\")) | index(\$i)) | .id"
elif [ -n "$CATEGORY" ]; then
  SELECT_FILTER=".cases[] | select(.category == \"$CATEGORY\") | .id"
fi
mapfile -t CASE_IDS < <(jq -r "$SELECT_FILTER" "$CASES_FILE")
[ "${#CASE_IDS[@]}" -gt 0 ] || { echo "FAIL: no cases selected" >&2; exit 1; }

echo "== conformance-eval (codex $CODEX_VERSION, model $RESOLVED_MODEL, agentsmd $AGENTSMD_VERSION) =="
echo "   cases: ${#CASE_IDS[@]}  captures: $CAP"

PASS=0; FAIL=0; ERR=0
: > "$SBX/results.rows"
for id in "${CASE_IDS[@]}"; do
  setup_case "$id"
  run_case_session || true
  if ! session_turn_completed; then
    # one retry on a fresh fixture (the failed attempt may have half-mutated it)
    setup_case "$id"
    run_case_session || true
  fi
  if ! session_turn_completed; then
    ERR=$((ERR+1)); verdict=error
    printf '  ERR  %-24s turn never completed (infra): %s\n' "$id" \
      "$(jq -r 'select(.type=="turn.failed") | .error.message' "$SBX/$id.jsonl" 2>/dev/null | head -c 120)"
    printf 'turn never completed after retry\n' > "$SBX/$id.why"
    jq -cn --arg id "$id" --arg cat "$(case_field '.category')" --arg rule "$(case_field '.rule')" \
          --arg kind "$(case_field '.kind')" --arg v "$verdict" \
          --rawfile why "$SBX/$id.why" \
      '{id:$id, category:$cat, rule:$rule, kind:$kind, verdict:$v, why:($why | split("\n") | map(select(length>0)))}' \
      >> "$SBX/results.rows"
    continue
  fi
  if grade_case; then
    PASS=$((PASS+1)); verdict=pass
    printf '  ok   %-24s %s/%s\n' "$id" "$(case_field '.category')" "$(case_field '.kind')"
  else
    FAIL=$((FAIL+1)); verdict=fail
    printf '  FAIL %-24s %s\n' "$id" "$(head -1 "$SBX/$id.why" 2>/dev/null)"
  fi
  jq -cn --arg id "$id" --arg cat "$(case_field '.category')" --arg rule "$(case_field '.rule')" \
        --arg kind "$(case_field '.kind')" --arg v "$verdict" \
        --rawfile why "$SBX/$id.why" \
    '{id:$id, category:$cat, rule:$rule, kind:$kind, verdict:$v, why:($why | split("\n") | map(select(length>0)))}' \
    >> "$SBX/results.rows"
done

# ── results.json + thresholds ────────────────────────────────────────────────
jq -s --arg codex "$CODEX_VERSION" --arg model "$RESOLVED_MODEL" \
      --arg agentsmd "$AGENTSMD_VERSION" --arg surface "$AGENTSMD_SURFACE" \
      --arg profile "$AGENTSMD_PROFILE" --arg cases_sha256 "$CASES_SHA256" \
      --arg thresholds_sha256 "$THRESHOLDS_SHA256" --arg stamp "$STAMP" \
  '{meta: {stamp:$stamp, codex:$codex, model:$model, agentsmd:$agentsmd,
      surface:$surface, profile:$profile, cases_sha256:$cases_sha256,
      thresholds_sha256:$thresholds_sha256, cases:(length)},
    categories: (group_by(.category) | map({key: .[0].category,
      value: {pass: (map(select(.verdict=="pass")) | length),
              total: (map(select(.verdict != "error")) | length),
              errors: (map(select(.verdict == "error")) | length)}}) | from_entries),
    cases: .}' "$SBX/results.rows" > "$CAP/results.json"

THRESH_FAIL=0; THRESH_MODE=none
if [ -r "$THRESHOLDS_FILE" ] && [ -z "$ONLY" ] && [ -z "$CATEGORY" ]; then
  THRESH_MODE=enforced
  while IFS=$'\t' read -r cat min got total; do
    if [ "$got" -lt "$min" ]; then
      echo "  THRESHOLD $cat: pass $got/$total < min_pass $min (baseline regression)"
      THRESH_FAIL=1
    fi
  done < <(jq -r --slurpfile r "$CAP/results.json" \
    'to_entries[] | select(.value | type == "object" and has("min_pass")) | .key as $c
     | ($r[0].categories[$c] // {pass:0,total:0}) as $g
     | select($g.total > 0)
     | "\($c)\t\(.value.min_pass)\t\($g.pass)\t\($g.total)"' "$THRESHOLDS_FILE")
elif [ -r "$THRESHOLDS_FILE" ]; then
  THRESH_MODE="skipped (partial selection)"
fi

{
  echo "conformance-eval capture $STAMP"
  echo "codex: $CODEX_VERSION  model: $RESOLVED_MODEL  agentsmd: $AGENTSMD_VERSION"
  echo "surface: $AGENTSMD_SURFACE  profile: $AGENTSMD_PROFILE"
  echo "cases_sha256: $CASES_SHA256  thresholds_sha256: $THRESHOLDS_SHA256"
  echo "result: $PASS passed, $FAIL failed, $ERR infra-errors (thresholds: $THRESH_MODE)"
} > "$CAP/SUMMARY.txt"
echo
echo "RESULT: $PASS passed, $FAIL failed, $ERR infra-errors  (thresholds: $THRESH_MODE, captures: $CAP)"
# Exit semantics: with thresholds enforced, category rates vs baseline decide —
# a documented known-fail baseline case does not by itself red the run. Without
# thresholds (or on partial selection) every graded case must pass.
if [ "$THRESH_MODE" = "enforced" ]; then
  [ "$ERR" -eq 0 ] && [ "$THRESH_FAIL" -eq 0 ]
else
  [ "$FAIL" -eq 0 ] && [ "$ERR" -eq 0 ]
fi
