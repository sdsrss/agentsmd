---
name: codexmd-audit
description: Aggregate codexmd rule-hit telemetry (which spec rules are firing / never firing). Use when the user asks to audit codexmd, review rule-hit data, check enforcement activity, or see which coding-spec rules are actually triggering. Not for editing the spec — read-only telemetry aggregation.
---

# codexmd-audit

Aggregate the codexmd enforcement telemetry (`~/.codex/logs/codexmd.jsonl`) over a window and report activity by spec section and hook.

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/codexmd/scripts/audit.js" --days=30
```

Report the `by spec_section` table to the user. Sections with 0 enforcement events over a full window are demotion candidates — for the promote/demote decision itself use `codexmd-rules`. If the repo is available instead of an install, run `node scripts/audit.js` from the repo root.
