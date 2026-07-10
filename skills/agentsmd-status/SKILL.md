---
name: agentsmd-status
description: Show agentsmd install state (安装状态清单), registered hooks, preserved tenants, config flags, and telemetry rows. Use for a quick inventory. Not for health diagnosis or rule analysis.
---

# agentsmd-status

Report agentsmd's install footprint and confirm clean coexistence with any other tenant.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/status.js"
```

Key fields: `agentsmdHooksRegistered` (should be 15), `otherTenantHooksPreserved` (OMX / other plugins agentsmd left untouched — proves independence), `codexHooksFlag`, `specBlockInAgentsMd`, `telemetryRows`. If `installed` is false, run `node scripts/install.js` (a §5-hard action — confirm with the user first).
