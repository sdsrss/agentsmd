---
name: agentsmd-sampling-audit
description: Measure how often the SELF-enforced §10 rules (banned vocabulary, four-section report order) were actually violated across recent Codex sessions. Use when the user asks how well the honesty/specificity rules are being followed, wants the real violation rate of rules the live hook can't measure, or is weighing whether a self-enforced rule earns its keep. Read-only retrospective scan — never edits the spec or transcripts.
---

# agentsmd-sampling-audit

The live Stop hook (`transcript-structure-scan.sh`) records a `§10-V` / `§10-four-section-order` row only for the LAST turn of each session, so the true violation RATE of these self-enforced rules is otherwise invisible — `agentsmd rules` marks them `self-enforced` = "not mechanically measured". This walks every assistant turn in recent Codex transcripts (`~/.codex/sessions/`) and re-runs the hook's exact detection (same `banned-vocab.patterns`, same four-section-order logic; a test pins the two to identical verdicts).

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/sampling-audit.js" --days=30
```

Report the per-rule `turns w/ violation` + `transcripts affected` table. A rising rate is input to the §13.2 demote-review decision (use `agentsmd-rules` for the promote/demote call) — nothing is auto-changed. `--limit=N` caps the scan to the N most-recent transcripts and surfaces how many older ones were dropped. From the repo instead of an install: `node scripts/sampling-audit.js`.
