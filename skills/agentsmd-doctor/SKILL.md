---
name: agentsmd-doctor
description: "Diagnose an agentsmd installation (安装故障诊断): prerequisites, hook registration/executability, config flags, and spec drift. Use after install/update or when hooks fail. Not for telemetry analysis; read-only."
---

# agentsmd-doctor

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/doctor.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

Run agentsmd's health checks and report which pass/fail.

```bash
node "$AGENTSMD_ROOT/scripts/doctor.js"
```

Checks: `jq` + `node` on PATH, `config.toml features.hooks=true` (Codex 0.142+; legacy `codex_hooks` also recognized — else native hooks are off), installed hooks executable, and every `hard-rules.json` `section_anchor` still resolves in the spec (drift guard). A red hooks flag means the hooks are registered but Codex is not running them — enable the feature. A red anchor means the spec text moved without updating `hard-rules.json`.
