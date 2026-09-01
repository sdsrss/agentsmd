---
name: agentsmd-sampling-audit
description: Retrospectively measure §10 vocabulary and report-order violations across assistant turns. Use for per-turn compliance rates. Not for live hook hits or spec editing; read-only.
---

# agentsmd-sampling-audit

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

The live Stop hook (`transcript-structure-scan.sh`) observes the current last assistant turn whenever Stop fires, but live hit telemetry has no denominator for every assistant turn. This audit walks all recent assistant turns in `~/.codex/sessions/` and re-runs the same vocabulary/order detectors to calculate a retrospective violation rate.

Run:

```bash
agentsmd_skill_run --days=30
```

Report `turns w/ violation` and `transcripts affected`. A rising rate informs `OPERATOR.md §O2`; nothing is auto-changed. `--limit=N` caps the scan and reports dropped older transcripts. From the repo: `node scripts/sampling-audit.js`.
