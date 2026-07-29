---
name: agentsmd-doctor
description: "Diagnose an agentsmd installation (安装故障诊断): prerequisites, hook registration/executability, config flags, and spec drift. Use after install/update or when hooks fail. Not for telemetry analysis; read-only."
---

# agentsmd-doctor

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/doctor.js" ]; then
  AGENTSMD_ROOT="$CANDIDATE_ROOT"
  if [ -f "$CANDIDATE_ROOT/.codex-plugin/plugin.json" ]; then export AGENTSMD_PLUGIN_ROOT="$CANDIDATE_ROOT"; else unset AGENTSMD_PLUGIN_ROOT; fi
else
  AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"
  unset AGENTSMD_PLUGIN_ROOT
fi
```

Run agentsmd's health checks and report which pass/fail.

```bash
node "$AGENTSMD_ROOT/scripts/doctor.js"
```

Plugin checks cover `jq` + Node.js 18 or newer, the explicit `./hooks.json` selection, all 17 hook registrations and scripts, and both spec files. A missing runtime prerequisite includes the current platform's manual install command. ShellCheck is a project/contributor lint dependency rather than plugin runtime health, so its conditional guidance comes from SessionStart when the active project declares ShellCheck. Runtime `PLUGIN_ROOT` is preferred, `CLAUDE_PLUGIN_ROOT` remains compatible, and the skill exports `AGENTSMD_PLUGIN_ROOT` from its selected bundle; conflicting roots fail health closed and cache presence never counts as activation. `pluginActivation.state=observed` proves only that the selected plugin SessionStart handler prepared the recorded profile for its response; it does not prove Codex accepted that response. `unverified` is informational and does not change the existing doctor exit semantics. Neither state proves trust or execution of every hook. Plugin-only is structurally healthy without a standalone ownership manifest or global hook entries. Read `selectedSurface`/`surfaceArbitration` for the winner; the legacy `surface` field remains the diagnostic invocation context. Health precedes SemVer, and the stable reason code explains the decision. Every manifest-backed `dualSurface: true` remains an operational failure; plugin selection over legacy standalone requires update/uninstall because neither old global core context nor already-registered commands can be removed by the new plugin. Standalone invocation retains the existing config, deployed-file, spec-freshness, and discovery-budget checks.
