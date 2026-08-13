---
name: agentsmd-perf-baseline
description: Benchmark native hook wall-clock cost with OFF/ON medians in an isolated CODEX_HOME. Use for latency or disablement decisions. Not for correctness, install health, or live telemetry.
---

# agentsmd-perf-baseline

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd. Run this resolver and the selected command below in the same shell invocation so the verified root cannot be lost between shells.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
STANDALONE_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"
AGENTSMD_ROOT=""
AGENTSMD_ROOT_KIND=""
agentsmd_root_ok() {
  node -e 'const fs=require("fs"),p=require("path"),[root,script,kind,home,cliEntry]=process.argv.slice(1),semver=/^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:[.](?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/;const regular=f=>{const s=fs.lstatSync(f);return s.isFile()&&!s.isSymbolicLink()};try{const rs=fs.lstatSync(root),packageFile=p.join(root,"package.json"),runner=p.join(root,"scripts",script);if(!rs.isDirectory()||rs.isSymbolicLink()||!regular(packageFile)||!regular(runner))process.exit(1);const pkg=JSON.parse(fs.readFileSync(packageFile,"utf8"));if(pkg.name!=="@sdsrs/agentsmd"||!semver.test(pkg.version))process.exit(1);const pluginFile=p.join(root,".codex-plugin","plugin.json");if(fs.existsSync(pluginFile)){if(!regular(pluginFile))process.exit(1);const plugin=JSON.parse(fs.readFileSync(pluginFile,"utf8"));if(plugin.name!=="agentsmd"||plugin.version!==pkg.version)process.exit(1)}if(kind==="standalone"){const manifestFile=p.join(home,".agentsmd-state","manifest.json");if(!regular(manifestFile))process.exit(1);const manifest=JSON.parse(fs.readFileSync(manifestFile,"utf8")),deploy=manifest&&manifest.ownedArtifacts&&manifest.ownedArtifacts.deploy;if(manifest.name!=="agentsmd"||manifest.version!==pkg.version||!deploy||p.resolve(deploy.path)!==p.resolve(root)||!/^[a-f0-9]{64}$/.test(deploy.sha256))process.exit(1)}if(kind==="versioned-cli"){const bin=typeof pkg.bin==="string"?pkg.bin:pkg.bin&&pkg.bin.agentsmd,binPath=p.resolve(root,bin||"");if(!bin||!binPath.startsWith(p.resolve(root)+p.sep)||fs.realpathSync(binPath)!==fs.realpathSync(cliEntry))process.exit(1)}}catch{process.exit(1)}' "$1" "$2" "$3" "${CODEX_HOME:-$HOME/.codex}" "${4:-}" >/dev/null 2>&1
}
if agentsmd_root_ok "$CANDIDATE_ROOT" "perf-baseline.js" "selected-bundle"; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; AGENTSMD_ROOT_KIND="selected-bundle"
elif agentsmd_root_ok "$STANDALONE_ROOT" "perf-baseline.js" "standalone"; then AGENTSMD_ROOT="$STANDALONE_ROOT"; AGENTSMD_ROOT_KIND="standalone"
else
  AGENTSMD_CLI="$(command -v agentsmd 2>/dev/null || true)"
  if [ -n "$AGENTSMD_CLI" ]; then
    CLI_ENTRY="$(node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])) } catch {}' "$AGENTSMD_CLI" 2>/dev/null)"
    [ -n "$CLI_ENTRY" ] && CLI_ROOT="$(cd "$(dirname "$CLI_ENTRY")/.." && pwd)" || CLI_ROOT=""
    [ -n "$CLI_ROOT" ] && agentsmd_root_ok "$CLI_ROOT" "perf-baseline.js" "versioned-cli" "$CLI_ENTRY" && { AGENTSMD_ROOT="$CLI_ROOT"; AGENTSMD_ROOT_KIND="versioned-cli"; }
  fi
fi
if [ -z "$AGENTSMD_ROOT" ]; then
  printf 'agentsmd skill runner unavailable: script=perf-baseline.js skill=%.512s candidate=%.512s standalone=%.512s cli=%.512s; unblock: expose the selected plugin bundle, grant read access to the manifest-owned standalone deploy, or install the versioned agentsmd CLI\n' "$SKILL_MD" "$CANDIDATE_ROOT" "$STANDALONE_ROOT" "${AGENTSMD_CLI:-missing}" >&2
  exit 1
fi
if [ "$AGENTSMD_ROOT_KIND" = "selected-bundle" ] && [ -f "$AGENTSMD_ROOT/.codex-plugin/plugin.json" ]; then export AGENTSMD_PLUGIN_ROOT="$AGENTSMD_ROOT"; else unset AGENTSMD_PLUGIN_ROOT; fi
```

Turns "the hooks add ~200–400 ms" (a guess) into a measured per-hook table. For each hook it times, over N runs, the median of **OFF** (`DISABLE_AGENTSMD_HOOKS=1` → the hook exits at its kill-switch line: bash-spawn + startup floor) vs **ON** (the hook does its real work); `delta = ON − OFF` is the hook's own logic cost.

```bash
node "$AGENTSMD_ROOT/scripts/perf-baseline.js"                    # all 19 hooks, 10 runs
node "$AGENTSMD_ROOT/scripts/perf-baseline.js" --event=PreToolUse # all registered PreToolUse hooks
node "$AGENTSMD_ROOT/scripts/perf-baseline.js" --runs=3 --json
```

- **`latency added per event firing`** (sum of ON medians) is the number that matters: the 5 PreToolUse:Bash hooks fire on every Bash call; the 7 Stop hooks fire once per turn.
- Hooks run against a synthetic non-triggering `echo` Bash event (the common per-call case, not the block path), in an isolated sandbox `CODEX_HOME` — measuring never writes to the live `~/.codex` (§8.V3) and cleans up after itself (§8.V4).
- Numbers are a **lower bound**: direct `bash hook` spawns, not Codex's harness IPC round-trip.

Operator/dev tool, read-only on the live env. From the repo instead of an install: `node scripts/perf-baseline.js`.
