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

Plugin checks cover `jq` + `node`, the explicit `./hooks.json` selection, all 15 hook registrations and scripts, and both spec files. Plugin-only is healthy without a standalone ownership manifest or global hook entries. `dualSurface: true` is a failing duplicate-hook warning. Standalone invocation retains the existing config, deployed-file, spec-freshness, and discovery-budget checks.
