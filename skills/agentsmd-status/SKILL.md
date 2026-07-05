---
name: agentsmd-status
description: Show agentsmd install state — how many agentsmd hooks are registered, how many OTHER-tenant (e.g. oh-my-codex) hooks are preserved, whether the spec block + [features] hooks flag are present, and telemetry row count. Use when the user asks if agentsmd is installed, what it registered, or whether it coexists cleanly with oh-my-codex / other plugins.
---

# agentsmd-status

Report agentsmd's install footprint and confirm clean coexistence with any other tenant.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/status.js"
```

Key fields: `agentsmdHooksRegistered` (should be 11), `otherTenantHooksPreserved` (OMX / other plugins agentsmd left untouched — proves independence), `codexHooksFlag`, `specBlockInAgentsMd`, `telemetryRows`. If `installed` is false, run `node scripts/install.js` (a §5-hard action — confirm with the user first).
