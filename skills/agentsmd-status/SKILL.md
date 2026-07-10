---
name: agentsmd-status
description: Show agentsmd install state (安装状态清单), registered hooks, preserved tenants, config flags, and telemetry rows. Use for a quick inventory. Not for health diagnosis or rule analysis.
---

# agentsmd-status

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/status.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

Report agentsmd's install footprint and confirm clean coexistence with any other tenant.

```bash
node "$AGENTSMD_ROOT/scripts/status.js"
```

Key fields: `manifestValid`, `manifestError`, `agentsmdHooksRegistered` (should be 15), `otherTenantHooksPreserved` (OMX / other plugins agentsmd left untouched), `codexHooksFlag`, `specBlockInAgentsMd`, and `telemetryRows`. If `installed` is false and `manifestError` is non-null, report the malformed/unreadable ownership manifest and diagnose it before any lifecycle action; do not recommend a blind reinstall. If the manifest is simply absent and installation is requested, run `node "$AGENTSMD_ROOT/scripts/install.js"` only after the §5-hard confirmation.
