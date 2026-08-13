---
name: agentsmd-analyze
description: Distill coding conventions from source into AGENTS.md (提炼代码约定). Use for naming/import/error-handling analysis after agentsmd-init. Not for stack detection or design tokens.
---

# agentsmd-analyze

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
if agentsmd_root_ok "$CANDIDATE_ROOT" "analyze.js" "selected-bundle"; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; AGENTSMD_ROOT_KIND="selected-bundle"
elif agentsmd_root_ok "$STANDALONE_ROOT" "analyze.js" "standalone"; then AGENTSMD_ROOT="$STANDALONE_ROOT"; AGENTSMD_ROOT_KIND="standalone"
else
  AGENTSMD_CLI="$(command -v agentsmd 2>/dev/null || true)"
  if [ -n "$AGENTSMD_CLI" ]; then
    CLI_ENTRY="$(node -e 'try { process.stdout.write(require("fs").realpathSync(process.argv[1])) } catch {}' "$AGENTSMD_CLI" 2>/dev/null)"
    [ -n "$CLI_ENTRY" ] && CLI_ROOT="$(cd "$(dirname "$CLI_ENTRY")/.." && pwd)" || CLI_ROOT=""
    [ -n "$CLI_ROOT" ] && agentsmd_root_ok "$CLI_ROOT" "analyze.js" "versioned-cli" "$CLI_ENTRY" && { AGENTSMD_ROOT="$CLI_ROOT"; AGENTSMD_ROOT_KIND="versioned-cli"; }
  fi
fi
if [ -z "$AGENTSMD_ROOT" ]; then
  printf 'agentsmd skill runner unavailable: script=analyze.js skill=%.512s candidate=%.512s standalone=%.512s cli=%.512s; unblock: expose the selected plugin bundle, grant read access to the manifest-owned standalone deploy, or install the versioned agentsmd CLI\n' "$SKILL_MD" "$CANDIDATE_ROOT" "$STANDALONE_ROOT" "${AGENTSMD_CLI:-missing}" >&2
  exit 1
fi
if [ "$AGENTSMD_ROOT_KIND" = "selected-bundle" ] && [ -f "$AGENTSMD_ROOT/.codex-plugin/plugin.json" ]; then export AGENTSMD_PLUGIN_ROOT="$AGENTSMD_ROOT"; else unset AGENTSMD_PLUGIN_ROOT; fi
```

Read a sample of the project's own source and distill the *implicit* conventions agentsmd-init can't detect, because they aren't stack facts. Gathering and writing are deterministic; the distillation is the one AI step. Run it from the project root, after `agentsmd-init`.

```bash
node "$AGENTSMD_ROOT/scripts/analyze.js" --gather
```

Prints the detected stack plus a capped, ignore-aware source map (≤40 files, ≤200 KiB total; skips `node_modules`/`.git`/`dist`/`build`/`target`/`.next`/`.nuxt`/`coverage`/`__pycache__`/`vendor`/`.code-graph` plus any bare directory named in `.gitignore`) — operates on `process.cwd()`, not `$CODEX_HOME`. Read a representative sample of the listed files, not necessarily all of them.

Distill conventions from what you actually read: only include one with **≥2 independent source occurrences**, mark single-occurrence ones `(low-confidence)` or omit them, and **never invent "best practices"** — every line must trace to something in this repo. Output **bulleted** conventions, not prose, grouped under exactly these eight headings (`scripts/lib/conventions-taxonomy.js` is the source of truth): **Declaration style**, **Naming**, **Import order**, **Error handling**, **Request/API encapsulation**, **State management**, **Comment style**, **Git conventions**. Omit a heading entirely rather than force-fitting an empty or low-confidence one — don't invent bullets just to fill a heading.

Write the distilled markdown to a temp file, then inject it:

```bash
node "$AGENTSMD_ROOT/scripts/analyze.js" --write --from <tmp-file>
```

Merges into the `# >>> agentsmd:conventions >>>` block of `./AGENTS.md`, preserving everything outside it, and refuses — never truncates — once the conventions block exceeds 6 KiB or the whole file would exceed ~32 KiB; if it refuses, distill fewer, higher-signal conventions rather than fighting the cap. Conventions the user hand-tuned themselves live outside the managed block — never move or absorb them into it.

`--write` stamps each of the eight headings above (matched case- and emphasis-insensitively against each heading's alias list — see the taxonomy file) with a stable `@conv-<dim>` anchor, e.g. `### Naming (@conv-naming)`. The anchor is derived from the heading, never from the bullet text underneath it, so it stays identical across re-runs even though the AI's wording changes every time — that stability is what lets citations of it accumulate. A heading worded too differently to match any alias is left unanchored, so prefer the exact names above.

**Citation discipline:** the written block also carries a citation instruction at its top. When you (in this session or a later one) apply one of these conventions, record its `@conv-<dim>` anchor in a single trailing HTML comment — `<!-- adopted-conventions: @conv-naming @conv-error-handling -->` (real slugs, on the last line of your message), never inline in the prose the user reads (the signal must not intrude on your answer). That comment is this project's only adoption signal, recorded automatically by the `convention-cite-scan` Stop hook. A dimension nobody ever cites decays toward a prune candidate. Check the current standing:

```bash
node "$AGENTSMD_ROOT/scripts/analyze.js" --adoption [--days=N] [--project=SUBSTR]
```

Reports each known anchor's cite count over the window and flags 0-cite dimensions as prune candidates. Advisory and read-only — it never edits `AGENTS.md` itself; a human decides whether to actually drop a dimension.
