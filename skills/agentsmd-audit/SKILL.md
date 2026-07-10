---
name: agentsmd-audit
description: Aggregate agentsmd rule-hit telemetry by section (遥测命中统计). Use for enforcement activity and raw hit counts. Not for promotion/demotion decisions or transcript violation rates; read-only.
---

# agentsmd-audit

Aggregate the agentsmd enforcement telemetry (`~/.codex/logs/agentsmd.jsonl`) over a window and report activity by spec section and hook.

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/audit.js" --days=30
```

Report the `by spec_section` table, including eligible/evaluated sessions when present. Raw zero hits alone are not a demotion signal; use `agentsmd-rules` for governance. From a checkout, run `node scripts/audit.js`.
