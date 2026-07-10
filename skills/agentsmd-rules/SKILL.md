---
name: agentsmd-rules
description: Review agentsmd rule promotion/demotion signals (规则升降级治理) using manifest and eligible telemetry. Use to govern the always-on spec. Not for raw hit listings or automatic spec edits; read-only.
---

# agentsmd-rules

Cross-reference `spec/hard-rules.json` with rule-specific eligible/evaluated telemetry. A rule without enough evaluated opportunities is not a demotion candidate.

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/rules.js" --days=30
```

Surface opportunity/evaluation counts, demote candidates, and self-enforced rules. Per `OPERATOR.md §O2`, demotion needs sufficient rule-specific evaluated sessions with zero enforcement; promotion needs repeated real repros. The operator decides; never edit the spec automatically.
