#!/usr/bin/env bash
set -u

REPO=$(cd -- "$(dirname -- "$0")/.." && pwd)
CLI="$REPO/bin/agentsmd.js"
PACKAGE_VERSION=$(cd "$REPO" && node -p 'require("./package.json").version')
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/agentsmd-user-journey.XXXXXX")
PASSED=0
FAILED=0

cleanup() {
  case "$ROOT" in
    "${TMPDIR:-/tmp}"/agentsmd-user-journey.*)
      find "$ROOT" -depth -delete
      ;;
    *)
      printf 'refusing to clean unexpected fixture path: %s\n' "$ROOT" >&2
      ;;
  esac
}
trap cleanup EXIT INT TERM

pass() {
  PASSED=$((PASSED + 1))
  printf '  ok   %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf '  FAIL %s\n' "$1" >&2
}

expect_status() {
  expected=$1
  name=$2
  shift 2
  "$@" >"$ROOT/stdout" 2>"$ROOT/stderr"
  actual=$?
  if [ "$actual" -eq "$expected" ]; then
    pass "$name"
  else
    fail "$name (expected exit $expected, got $actual)"
    sed -n '1,12p' "$ROOT/stderr" >&2
  fi
}

expect_file() {
  name=$1
  path=$2
  if [ -f "$path" ]; then pass "$name"; else fail "$name (missing $path)"; fi
}

expect_absent() {
  name=$1
  path=$2
  if [ ! -e "$path" ]; then pass "$name"; else fail "$name (unexpected $path)"; fi
}

expect_contains() {
  name=$1
  path=$2
  pattern=$3
  if grep -Eq -- "$pattern" "$path"; then
    pass "$name"
  else
    fail "$name (pattern not found: $pattern)"
  fi
}

expect_exact() {
  name=$1
  path=$2
  expected=$3
  if [ "$(sed -n '1p' "$path")" = "$expected" ]; then
    pass "$name"
  else
    fail "$name (expected: $expected)"
  fi
}

printf '== beginner persona: discovery and typo recovery ==\n'
expect_status 0 'bare CLI prints help' env CODEX_HOME="$ROOT/bare-home" node "$CLI"
expect_absent 'bare CLI does not install' "$ROOT/bare-home/agentsmd"
expect_status 0 '--help exits 0' node "$CLI" --help
expect_status 0 '--version exits 0' node "$CLI" --version
expect_exact '--version prints package version' "$ROOT/stdout" "$PACKAGE_VERSION"
expect_status 2 'unknown command exits 2' node "$CLI" 'instlal-手滑-😵'
expect_contains 'unknown command is actionable' "$ROOT/stderr" 'unknown command'

COMMANDS='init analyze design install update uninstall restore status doctor audit rules sampling-audit lesson-bypass-audit sparkline safety-coverage-audit version-cascade perf-baseline lint-argv'
for command in $COMMANDS; do
  expect_status 0 "$command --help" node "$CLI" "$command" --help
done

printf '== beginner persona: isolated install lifecycle ==\n'
CODEX_HOME="$ROOT/Codex Home 林小雨 😊"
export CODEX_HOME
expect_status 0 'status before install' node "$CLI" status
expect_contains 'status before install says false' "$ROOT/stdout" '"installed": false'
expect_status 0 'install --json' node "$CLI" install --json
expect_contains 'install emits JSON manifest' "$ROOT/stdout" '"name": "agentsmd"'
expect_status 0 'status after install' node "$CLI" status
expect_contains 'status after install says true' "$ROOT/stdout" '"installed": true'
expect_status 0 'status JSON survives a pipe consumer' sh -c 'node "$1" status | jq -e ".installed == true" >/dev/null' sh "$CLI"
expect_status 0 'doctor healthy after install' node "$CLI" doctor
expect_status 0 'same-version update is accepted' node "$CLI" update
expect_status 0 'restore list is read-only' node "$CLI" restore --list
expect_status 2 'restore rejects unknown flag' node "$CLI" restore --definitely-wrong
expect_status 0 'uninstall removes owned footprint' node "$CLI" uninstall
expect_status 0 'status after uninstall' node "$CLI" status
expect_contains 'status after uninstall says false' "$ROOT/stdout" '"installed": false'
expect_status 2 'uninstall rejects extra positional' node "$CLI" uninstall '算了'

printf '== expert persona: standalone installer action safety ==\n'
export CODEX_HOME="$ROOT/standalone-home"
expect_status 0 'standalone installer accepts local source' sh "$REPO/install.sh" --source "$REPO"
expect_status 2 'standalone installer rejects status plus uninstall' sh "$REPO/install.sh" --source "$REPO" --status --uninstall
expect_contains 'standalone conflict error names both actions' "$ROOT/stderr" 'multiple action options: --status and --uninstall'
expect_status 2 'standalone installer rejects inverse action order' sh "$REPO/install.sh" --source "$REPO" --uninstall --status
expect_status 2 'standalone installer rejects repeated action' sh "$REPO/install.sh" --source "$REPO" --status --status
expect_status 0 'standalone conflict leaves install intact' sh -c 'node "$1" status | jq -e ".installed == true" >/dev/null' sh "$CLI"
expect_status 0 'standalone uninstall still works alone' sh "$REPO/install.sh" --source "$REPO" --uninstall

printf '== beginner persona: project init/analyze/design ==\n'
PROJECT="$ROOT/你好 mixed project 🚀"
mkdir -p "$PROJECT/src"
printf '%s\n' '{"name":"@demo/你好-app","scripts":{"dev":"vite","test":"node --test"},"dependencies":{"react":"19.0.0","vite":"7.0.0"}}' >"$PROJECT/package.json"
printf '%s\n' 'export const greeting = (name) => `Hi, ${name} 👋`;' >"$PROJECT/src/app.js"
printf '%s\n' ':root { --color-brand: #3366ff; --space-card: 1.25rem; }' >"$PROJECT/src/theme.css"

expect_status 0 'init dry-run with multilingual path' sh -c 'cd "$1" && node "$2" init --dry-run' sh "$PROJECT" "$CLI"
expect_absent 'init dry-run writes nothing' "$PROJECT/AGENTS.md"
expect_status 0 'init writes managed AGENTS.md' sh -c 'cd "$1" && node "$2" init' sh "$PROJECT" "$CLI"
expect_file 'init created AGENTS.md' "$PROJECT/AGENTS.md"
expect_status 0 'init --check sees no drift' sh -c 'cd "$1" && node "$2" init --check' sh "$PROJECT" "$CLI"
expect_status 0 'init --local creates personal file' sh -c 'cd "$1" && node "$2" init --local' sh "$PROJECT" "$CLI"
expect_file 'init --local created AGENTS.local.md' "$PROJECT/AGENTS.local.md"
expect_status 2 'init rejects conflicting modes' sh -c 'cd "$1" && node "$2" init --check --dry-run' sh "$PROJECT" "$CLI"

expect_status 0 'analyze gather maps real source' sh -c 'cd "$1" && node "$2" analyze --gather' sh "$PROJECT" "$CLI"
expect_contains 'analyze gather includes app.js' "$ROOT/stdout" 'src/app\.js'
printf '%s\n' '## Naming' '- Use camelCase for JavaScript functions.' >"$PROJECT/conventions-输入.md"
expect_status 0 'analyze writes supplied conventions' sh -c 'cd "$1" && node "$2" analyze --write --from "conventions-输入.md"' sh "$PROJECT" "$CLI"
expect_contains 'analyze stamped naming anchor' "$PROJECT/AGENTS.md" '@conv-naming'
expect_status 0 'analyze adoption handles empty telemetry' sh -c 'cd "$1" && node "$2" analyze --adoption --days=7 --project="你好"' sh "$PROJECT" "$CLI"
expect_status 2 'analyze rejects option-like from value' sh -c 'cd "$1" && node "$2" analyze --write --from --adoption' sh "$PROJECT" "$CLI"

expect_status 0 'design preview parses tokens' sh -c 'cd "$1" && node "$2" design' sh "$PROJECT" "$CLI"
expect_absent 'design preview writes nothing' "$PROJECT/DESIGN.md"
expect_status 0 'design --write creates facts' sh -c 'cd "$1" && node "$2" design --write' sh "$PROJECT" "$CLI"
expect_file 'design created DESIGN.md' "$PROJECT/DESIGN.md"
expect_contains 'design keeps brand token' "$PROJECT/DESIGN.md" '--color-brand.*#3366ff'
expect_status 2 'design rejects unknown flag' sh -c 'cd "$1" && node "$2" design --write=maybe' sh "$PROJECT" "$CLI"

printf '== expert persona: governance, diagnostics, pipes, and limits ==\n'
export CODEX_HOME="$ROOT/expert-home"
mkdir -p "$CODEX_HOME/logs" "$CODEX_HOME/sessions"
expect_status 0 'audit empty telemetry' node "$CLI" audit --days=30 --project='中英 mix'
expect_status 0 'audit output redirects cleanly' sh -c 'node "$1" audit --days=1 >"$2/audit.txt" && test -s "$2/audit.txt"' sh "$CLI" "$ROOT"
expect_status 2 'audit rejects negative days' node "$CLI" audit --days=-1
expect_status 2 'audit rejects duplicate days' node "$CLI" audit --days=7 --days=8
expect_status 0 'rules empty telemetry' node "$CLI" rules --days=30 --project='中英 mix'
expect_status 2 'rules rejects empty project' node "$CLI" rules --project=
expect_status 0 'sampling audit empty transcripts' node "$CLI" sampling-audit --days=7 --limit=3
expect_status 2 'sampling audit rejects decimal limit' node "$CLI" sampling-audit --limit=1.5
expect_status 0 'lesson bypass audit empty telemetry' node "$CLI" lesson-bypass-audit --days=7
expect_status 2 'lesson bypass audit rejects junk days' node "$CLI" lesson-bypass-audit --days=tomorrow
expect_status 0 'sparkline empty telemetry markdown' node "$CLI" sparkline --windows=2 --bucket-days=1 --markdown
expect_status 2 'sparkline rejects one window' node "$CLI" sparkline --windows=1
expect_status 0 'safety coverage audit real tree' node "$CLI" safety-coverage-audit --json
expect_status 2 'safety coverage rejects unknown hook filter' node "$CLI" safety-coverage-audit --hook=missing.sh
expect_status 0 'version cascade real tree' node "$CLI" version-cascade --json
expect_status 0 'argv lint real tree' node "$CLI" lint-argv --json
expect_status 0 'performance baseline one run' node "$CLI" perf-baseline --runs=1 --event=PreToolUse --json
expect_status 2 'performance baseline rejects zero runs' node "$CLI" perf-baseline --runs=0

printf '== packaging and repository-wide automated regression ==\n'
expect_status 0 'npm package dry-run includes CLI' sh -c 'cd "$1" && npm pack --dry-run --json | jq -e ".[0].files | any(.path == \"bin/agentsmd.js\")" >/dev/null' sh "$REPO"
expect_status 0 'full project check' sh -c 'cd "$1" && npm run check' sh "$REPO"

printf '\nRESULT: %s passed, %s failed\n' "$PASSED" "$FAILED"
test "$FAILED" -eq 0
