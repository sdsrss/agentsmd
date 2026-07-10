---
name: agentsmd-sampling-audit
description: Retrospectively measure §10 vocabulary and report-order violations across assistant turns. Use for per-turn compliance rates. Not for live hook hits or spec editing; read-only.
---

# agentsmd-sampling-audit

The live Stop hook (`transcript-structure-scan.sh`) observes the current last assistant turn whenever Stop fires, but live hit telemetry has no denominator for every assistant turn. This audit walks all recent assistant turns in `~/.codex/sessions/` and re-runs the same vocabulary/order detectors to calculate a retrospective violation rate.

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/sampling-audit.js" --days=30
```

Report `turns w/ violation` and `transcripts affected`. A rising rate informs `OPERATOR.md §O2`; nothing is auto-changed. `--limit=N` caps the scan and reports dropped older transcripts. From the repo: `node scripts/sampling-audit.js`.
