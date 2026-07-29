---
name: agentsmd-scorecard
description: Aggregate the unified agentsmd quality scorecard (统一质量记分卡) with health, compatibility, conformance, performance, and measurement limits. Use for operator review or capture comparison. Not for automatic rule changes, release gates, or telemetry editing.
---

# agentsmd-scorecard

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/scorecard.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

Generate the operator report or versioned JSON capture:

```bash
node "$AGENTSMD_ROOT/scripts/scorecard.js" --days=30
node "$AGENTSMD_ROOT/scripts/scorecard.js" --days=30 --json
node "$AGENTSMD_ROOT/scripts/scorecard.js" --days=30 --compare=scorecard-previous.json
```

- Run from the project whose AGENTS.md prompt budget and worktree inventory should be measured.
- Treat `test` and `qa` data classes as visible provenance, not field evidence.
- Treat missing dimensions, stale captures, no-opportunity, insufficient opportunity, and unmeasured false blocks as gaps.
- Treat sampling calibration as a structural proxy and memory cite-recall as engagement only; neither proves semantic adherence.
- Use `--compare` only with a prior JSON capture from this command. The reader rejects symlinks, oversized input, malformed JSON, unknown fields, and unsupported schema versions.
- Read recommended actions as operator prompts. The command is read-only and never promotes/demotes rules, cleans worktrees, changes the spec, or runs external canaries.
- Preserve the machine-readable JSON directly; do not reconstruct it from the human report.
