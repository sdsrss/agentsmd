---
name: codexmd-status
description: Show codexmd install state — how many codexmd hooks are registered, how many OTHER-tenant (e.g. oh-my-codex) hooks are preserved, whether the spec block + codex_hooks flag are present, and telemetry row count. Use when the user asks if codexmd is installed, what it registered, or whether it coexists cleanly with oh-my-codex / other plugins.
---

# codexmd-status

Report codexmd's install footprint and confirm clean coexistence with any other tenant.

```bash
node "${CODEX_HOME:-$HOME/.codex}/codexmd/scripts/status.js"
```

Key fields: `codexmdHooksRegistered` (should be 7), `otherTenantHooksPreserved` (OMX / other plugins codexmd left untouched — proves independence), `codexHooksFlag`, `specBlockInAgentsMd`, `telemetryRows`. If `installed` is false, run `node scripts/install.js` (a §5-hard action — confirm with the user first).
