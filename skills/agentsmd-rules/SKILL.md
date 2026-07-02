---
name: agentsmd-rules
description: Promote/demote governance for the agentsmd coding spec — cross-references hard-rules.json against telemetry to surface always-on rules that never fire (dilution / demote candidates). Use when the user asks which spec rules to keep, demote, or promote, whether a rule earns its core residence, or to review the always-on layer. Read-only analysis; the operator decides.
---

# agentsmd-rules

Cross-reference `spec/hard-rules.json` against the rule-hit telemetry to answer: which always-on rules earn their core residence, and which are attention dilution (hook-enforced yet never firing)?

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/rules.js" --days=30
```

Surface the demote-candidates and the self-enforced count. Per `spec/OPERATOR.md §O2`: a hook-enforced rule with 0 enforcement hits across a full review window → demote core→extended (or drop the hook); promotion needs ≥3 repros across distinct sessions AND ≥20 L2+ tasks since the last HARD addition. The operator makes the call — present the data, don't auto-edit the spec.
