---
name: agentsmd-audit
description: Aggregate agentsmd rule-hit telemetry (which spec rules are firing / never firing). Use when the user asks to audit agentsmd, review rule-hit data, check enforcement activity, or see which coding-spec rules are actually triggering. Not for editing the spec — read-only telemetry aggregation.
---

# agentsmd-audit

Aggregate the agentsmd enforcement telemetry (`~/.codex/logs/agentsmd.jsonl`) over a window and report activity by spec section and hook.

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/audit.js" --days=30
```

Report the `by spec_section` table to the user. Sections with 0 enforcement events over a full window are demotion candidates — for the promote/demote decision itself use `agentsmd-rules`. If the repo is available instead of an install, run `node scripts/audit.js` from the repo root.
