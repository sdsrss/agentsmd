#!/usr/bin/env bash
# plugin-marketplace-e2e.sh — zero-model consumer smoke for the public
# GitHub marketplace -> npm artifact -> Codex user plugin cache lifecycle.
#
# This test intentionally uses the real Codex CLI and network. It is excluded
# from `npm test` because an unpublished PR version cannot be installed from
# the public marketplace. The release workflow runs it after npm publication.
#
# Usage:
#   bash qa/plugin-marketplace-e2e.sh [--codex <bin>] [--source <owner/repo>] [--ref <git-ref>] [--keep]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_BIN="codex"
MARKETPLACE_SOURCE="sdsrss/agentsmd"
MARKETPLACE_REF=""
KEEP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --codex) CODEX_BIN="${2:?--codex requires a value}"; shift 2 ;;
    --source) MARKETPLACE_SOURCE="${2:?--source requires a value}"; shift 2 ;;
    --ref) MARKETPLACE_REF="${2:?--ref requires a value}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v "$CODEX_BIN" >/dev/null 2>&1 || {
  printf 'FAIL: codex binary not found: %s\n' "$CODEX_BIN" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'FAIL: jq is required\n' >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  printf 'FAIL: node is required\n' >&2
  exit 1
}

EXPECTED_VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
EXPECTED_SOURCE_VERSION="$(node -p 'require(process.argv[1]).plugins.find((entry) => entry.name === "agentsmd").source.version' "$ROOT/.agents/plugins/marketplace.json")"
EXPECTED_SKILL_COUNT="$(find "$ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agentsmd-plugin-marketplace.XXXXXX")"
PLUGIN_DATA_DIR="$SANDBOX/plugin-data/agentsmd"
STANDALONE_HOME="$SANDBOX/standalone-home"
STANDALONE_PLUGIN_DATA="$STANDALONE_HOME/plugin-data/agentsmd"

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    printf 'kept sandbox: %s\n' "$SANDBOX"
    return
  fi
  case "$SANDBOX" in
    "${TMPDIR:-/tmp}"/agentsmd-plugin-marketplace.*)
      find "$SANDBOX" -depth -delete
      ;;
    *)
      printf 'refusing to clean unexpected sandbox path: %s\n' "$SANDBOX" >&2
      ;;
  esac
}
trap cleanup EXIT INT TERM

run_codex() {
  CODEX_HOME="$SANDBOX" "$CODEX_BIN" "$@"
}

marketplace_add=(plugin marketplace add "$MARKETPLACE_SOURCE")
if [ -n "$MARKETPLACE_REF" ]; then
  marketplace_add+=(--ref "$MARKETPLACE_REF")
fi
marketplace_add+=(--json)

printf '== GitHub marketplace registration ==\n'
run_codex "${marketplace_add[@]}" >"$SANDBOX/marketplace-add.json"
jq -e '.marketplaceName == "agentsmd" and .alreadyAdded == false' \
  "$SANDBOX/marketplace-add.json" >/dev/null

run_codex "${marketplace_add[@]}" >"$SANDBOX/marketplace-add-repeat.json"
jq -e '.marketplaceName == "agentsmd" and .alreadyAdded == true' \
  "$SANDBOX/marketplace-add-repeat.json" >/dev/null

printf '== plugin install and idempotent reinstall ==\n'
run_codex plugin add agentsmd --marketplace agentsmd --json >"$SANDBOX/plugin-add.json"
run_codex plugin add agentsmd --marketplace agentsmd --json >"$SANDBOX/plugin-add-repeat.json"
run_codex plugin marketplace upgrade agentsmd --json >"$SANDBOX/marketplace-upgrade.json"
run_codex plugin add agentsmd@agentsmd --json >"$SANDBOX/plugin-add-shorthand.json"

for result in plugin-add.json plugin-add-repeat.json plugin-add-shorthand.json; do
  jq -e --arg version "$EXPECTED_VERSION" '
    .pluginId == "agentsmd@agentsmd"
    and .name == "agentsmd"
    and .marketplaceName == "agentsmd"
    and .version == $version
  ' "$SANDBOX/$result" >/dev/null
done

jq -e '.selectedMarketplaces == ["agentsmd"] and (.errors | length) == 0' \
  "$SANDBOX/marketplace-upgrade.json" >/dev/null

run_codex plugin list --json >"$SANDBOX/plugin-list.json"
jq -e --arg version "$EXPECTED_VERSION" --arg source_version "$EXPECTED_SOURCE_VERSION" '
  [.installed[] | select(.pluginId == "agentsmd@agentsmd")] as $matches
  | ($matches | length) == 1
    and $matches[0].installed == true
    and $matches[0].enabled == true
    and $matches[0].version == $version
    and $matches[0].source.source == "npm"
    and $matches[0].source.package == "@sdsrs/agentsmd"
    and $matches[0].source.version == $source_version
    and $matches[0].marketplaceSource.sourceType == "git"
  ' "$SANDBOX/plugin-list.json" >/dev/null

PLUGIN_ROOT="$(jq -er '.installedPath' "$SANDBOX/plugin-add-shorthand.json")"
EXPECTED_ROOT="$SANDBOX/plugins/cache/agentsmd/agentsmd/$EXPECTED_VERSION"
test "$PLUGIN_ROOT" = "$EXPECTED_ROOT"

for required in \
  .codex-plugin/plugin.json \
  hooks.json \
  spec/AGENTS.md \
  spec/AGENTS-extended.md \
  scripts/uninstall.js \
  bin/agentsmd.js
do
  test -f "$PLUGIN_ROOT/$required"
done

SKILL_COUNT="$(find "$PLUGIN_ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
test "$SKILL_COUNT" -eq "$EXPECTED_SKILL_COUNT" || {
  printf 'FAIL: packaged skill count %s != source skill count %s\n' \
    "$SKILL_COUNT" "$EXPECTED_SKILL_COUNT" >&2
  exit 1
}
CACHE_VERSION_COUNT="$(find "$SANDBOX/plugins/cache/agentsmd/agentsmd" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
test "$CACHE_VERSION_COUNT" -eq 1

printf '== packaged plugin health ==\n'
AGENTSMD_PLUGIN_ROOT="$PLUGIN_ROOT" CODEX_HOME="$SANDBOX" \
  node "$PLUGIN_ROOT/bin/agentsmd.js" doctor

printf '== safe cleanup and Codex removal ==\n'
mkdir -p "$SANDBOX/.agentsmd-state" "$SANDBOX/logs" "$PLUGIN_DATA_DIR/runtime"
printf '%s\n' 'owned by agentsmd' >"$PLUGIN_DATA_DIR/runtime/session-start-e2e.ref"
printf '%s\n' 'ambiguous legacy state' >"$SANDBOX/.agentsmd-state/session-start-legacy.ref"
printf '%s\n' 'owned by another tenant' >"$SANDBOX/.agentsmd-state/foreign.txt"
printf '%s\n' '{"hook":"session-start"}' >"$SANDBOX/logs/agentsmd.jsonl"

CODEX_HOME="$SANDBOX" PLUGIN_DATA="$PLUGIN_DATA_DIR" \
  node "$PLUGIN_ROOT/scripts/uninstall.js" --plugin-state-only >"$SANDBOX/uninstall.out"
sed -n '/^{/,$p' "$SANDBOX/uninstall.out" >"$SANDBOX/uninstall.json"
jq -e '
  .pluginStateOnly == true
  and .sharedFilesTouched == false
  and .standaloneStatePreserved == true
  and .stateFilesRemoved == 1
  and .stateDirRemoved == true
' "$SANDBOX/uninstall.json" >/dev/null
test ! -e "$PLUGIN_DATA_DIR/runtime"
test -f "$SANDBOX/.agentsmd-state/session-start-legacy.ref"
test -f "$SANDBOX/.agentsmd-state/foreign.txt"
test -f "$SANDBOX/logs/agentsmd.jsonl"

if CODEX_HOME="$SANDBOX" node "$PLUGIN_ROOT/bin/agentsmd.js" install \
  >"$SANDBOX/standalone-refusal.out" 2>"$SANDBOX/standalone-refusal.err"
then
  printf 'FAIL: expected standalone install to refuse an active plugin\n' >&2
  exit 1
fi
grep -Fq 'plugin is enabled; remove it before standalone install' \
  "$SANDBOX/standalone-refusal.err"
test ! -e "$SANDBOX/.agentsmd-state/manifest.json"
test ! -e "$SANDBOX/agentsmd"

CODEX_HOME="$STANDALONE_HOME" node "$PLUGIN_ROOT/bin/agentsmd.js" install >/dev/null
test -f "$STANDALONE_HOME/.agentsmd-state/manifest.json"
test -d "$STANDALONE_HOME/agentsmd"
cp "$STANDALONE_HOME/hooks.json" "$STANDALONE_HOME/hooks.before-plugin-cleanup.json"
cp "$STANDALONE_HOME/.agentsmd-state/manifest.json" \
  "$STANDALONE_HOME/manifest.before-plugin-cleanup.json"
printf '%s\n' 'ambiguous shared state' \
  >"$STANDALONE_HOME/.agentsmd-state/session-start-dual.ref"
mkdir -p "$STANDALONE_PLUGIN_DATA/runtime"
printf '%s\n' 'plugin-private state' \
  >"$STANDALONE_PLUGIN_DATA/runtime/session-start-dual.ref"
CODEX_HOME="$STANDALONE_HOME" PLUGIN_DATA="$STANDALONE_PLUGIN_DATA" \
  node "$PLUGIN_ROOT/scripts/uninstall.js" --plugin-state-only \
  >"$STANDALONE_HOME/uninstall-dual.out"
sed -n '/^{/,$p' "$STANDALONE_HOME/uninstall-dual.out" \
  >"$STANDALONE_HOME/uninstall-dual.json"
jq -e '
  .pluginStateOnly == true
  and .sharedFilesTouched == false
  and .standaloneStatePreserved == true
  and .stateFilesRemoved == 1
  and .stateDirRemoved == true
  and (has("stateCleanupSkipped") | not)
' "$STANDALONE_HOME/uninstall-dual.json" >/dev/null
test ! -e "$STANDALONE_PLUGIN_DATA/runtime"
test -f "$STANDALONE_HOME/.agentsmd-state/session-start-dual.ref"
cmp "$STANDALONE_HOME/hooks.before-plugin-cleanup.json" "$STANDALONE_HOME/hooks.json"

printf '%s\n' '{ malformed shared hooks remain outside plugin cleanup' \
  >"$STANDALONE_HOME/hooks.json"
cp "$STANDALONE_HOME/hooks.json" "$STANDALONE_HOME/hooks.malformed.before"
printf '%s\n' '{ malformed standalone marker still preserves shared state' \
  >"$STANDALONE_HOME/.agentsmd-state/manifest.json"
printf '%s\n' 'owned by agentsmd' \
  >"$STANDALONE_HOME/.agentsmd-state/session-start-malformed.ref"
mkdir -p "$STANDALONE_PLUGIN_DATA/runtime"
printf '%s\n' 'plugin-private state' \
  >"$STANDALONE_PLUGIN_DATA/runtime/session-start-malformed.ref"
CODEX_HOME="$STANDALONE_HOME" PLUGIN_DATA="$STANDALONE_PLUGIN_DATA" \
  node "$PLUGIN_ROOT/scripts/uninstall.js" --plugin-state-only \
  >"$STANDALONE_HOME/uninstall-malformed.out"
sed -n '/^{/,$p' "$STANDALONE_HOME/uninstall-malformed.out" \
  >"$STANDALONE_HOME/uninstall-malformed.json"
jq -e '
  .pluginStateOnly == true
  and .sharedFilesTouched == false
  and .standaloneStatePreserved == true
  and .stateFilesRemoved == 1
  and .stateDirRemoved == true
' "$STANDALONE_HOME/uninstall-malformed.json" >/dev/null
test ! -e "$STANDALONE_PLUGIN_DATA/runtime"
test -f "$STANDALONE_HOME/.agentsmd-state/session-start-malformed.ref"
cmp "$STANDALONE_HOME/hooks.malformed.before" "$STANDALONE_HOME/hooks.json"
cp "$STANDALONE_HOME/hooks.before-plugin-cleanup.json" "$STANDALONE_HOME/hooks.json"
cp "$STANDALONE_HOME/manifest.before-plugin-cleanup.json" \
  "$STANDALONE_HOME/.agentsmd-state/manifest.json"
CODEX_HOME="$STANDALONE_HOME" node "$STANDALONE_HOME/agentsmd/scripts/status.js" |
  jq -e '.installed == true' >/dev/null

run_codex plugin remove agentsmd --marketplace agentsmd --json >"$SANDBOX/plugin-remove.json"
jq -e '.pluginId == "agentsmd@agentsmd"' "$SANDBOX/plugin-remove.json" >/dev/null
test ! -e "$PLUGIN_ROOT"

run_codex plugin marketplace remove agentsmd --json >"$SANDBOX/marketplace-remove.json"
jq -e '.marketplaceName == "agentsmd"' "$SANDBOX/marketplace-remove.json" >/dev/null
run_codex plugin list --json >"$SANDBOX/plugin-list-final.json"
jq -e '[.installed[] | select(.pluginId == "agentsmd@agentsmd")] | length == 0' \
  "$SANDBOX/plugin-list-final.json" >/dev/null

printf 'plugin marketplace E2E passed: agentsmd %s\n' "$EXPECTED_VERSION"
