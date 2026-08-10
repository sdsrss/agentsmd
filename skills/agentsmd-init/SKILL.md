---
name: agentsmd-init
description: Generate or refresh project AGENTS.md stack facts, commands, and structure (生成项目指令). Use before convention analysis. Not for inferring coding conventions or design tokens.
---

# agentsmd-init

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
if agentsmd_root_ok "$CANDIDATE_ROOT" "init.js" "selected-bundle"; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; AGENTSMD_ROOT_KIND="selected-bundle"
elif agentsmd_root_ok "$STANDALONE_ROOT" "init.js" "standalone"; then AGENTSMD_ROOT="$STANDALONE_ROOT"; AGENTSMD_ROOT_KIND="standalone"
else
  AGENTSMD_CLI="$(command -v agentsmd 2>/dev/null || true)"
  if [ -n "$AGENTSMD_CLI" ]; then
    CLI_ENTRY="$(node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])) } catch {}' "$AGENTSMD_CLI" 2>/dev/null)"
    [ -n "$CLI_ENTRY" ] && CLI_ROOT="$(cd "$(dirname "$CLI_ENTRY")/.." && pwd)" || CLI_ROOT=""
    [ -n "$CLI_ROOT" ] && agentsmd_root_ok "$CLI_ROOT" "init.js" "versioned-cli" "$CLI_ENTRY" && { AGENTSMD_ROOT="$CLI_ROOT"; AGENTSMD_ROOT_KIND="versioned-cli"; }
  fi
fi
if [ -z "$AGENTSMD_ROOT" ]; then
  printf 'agentsmd skill runner unavailable: script=init.js skill=%.512s candidate=%.512s standalone=%.512s cli=%.512s; unblock: expose the selected plugin bundle, grant read access to the manifest-owned standalone deploy, or install the versioned agentsmd CLI\n' "$SKILL_MD" "$CANDIDATE_ROOT" "$STANDALONE_ROOT" "${AGENTSMD_CLI:-missing}" >&2
  exit 1
fi
if [ "$AGENTSMD_ROOT_KIND" = "selected-bundle" ] && [ -f "$AGENTSMD_ROOT/.codex-plugin/plugin.json" ]; then export AGENTSMD_PLUGIN_ROOT="$AGENTSMD_ROOT"; else unset AGENTSMD_PLUGIN_ROOT; fi
```

Generate the project-level `AGENTS.md` for the repo in the current working directory. Deterministic and language-agnostic; run it from the project root.

```bash
node "$AGENTSMD_ROOT/scripts/init.js"
```

Flags: `--check` (report drift without writing; exit 1 if out of sync), `--dry-run` (print what would be written), `--local` (also scaffold a git-ignored `AGENTS.local.md` for personal preferences), `--no-frontend` (skip the `## Frontend` section even when a frontend stack is detected). Choose only one of `--check`, `--dry-run`, and `--local`; each selects a different execution mode. Re-running is safe — it updates only the `# >>> agentsmd:project >>>` block and preserves everything you wrote outside it.

For the deeper pass that reads the source to distil implicit conventions (naming, imports, error handling), run the `agentsmd-analyze` skill afterward (Phase 2).
