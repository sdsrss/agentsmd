---
name: agentsmd-rules
description: Review agentsmd rule promotion/demotion signals (规则升降级治理) using manifest and eligible telemetry. Use to govern the always-on spec. Not for raw hit listings or automatic spec edits; read-only.
---

# agentsmd-rules

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/rules.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

Cross-reference `spec/hard-rules.json` with rule-specific eligible/evaluated telemetry. A rule without enough evaluated opportunities is not a demotion candidate.

Run:

```bash
node "$AGENTSMD_ROOT/scripts/rules.js" --days=30
```

Use `--project=SUBSTR` for the informational local-hits lens; governance verdicts
remain cross-project. `--include-test` explicitly folds test-tagged telemetry
into both global and scoped calculations.

Surface opportunity/evaluation counts, demote candidates, and self-enforced rules. Per `OPERATOR.md §O2`, demotion needs sufficient rule-specific evaluated sessions with zero enforcement; promotion needs repeated real repros. The operator decides; never edit the spec automatically.
