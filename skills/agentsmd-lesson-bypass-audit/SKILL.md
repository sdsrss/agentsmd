---
name: agentsmd-lesson-bypass-audit
description: Measure memory cite-recall — how often the §7 memory hint ("read the suggested memory before acting") is actually acted on vs bypassed across recent Codex sessions. Use when the user asks whether the memory system is working, if surfaced memories get read, or wants the follow-through rate behind the hints (not just that they fired). Read-only join of suggest-telemetry against transcripts.
---

# agentsmd-lesson-bypass-audit

`memory-prompt-hint.sh` records a `suggest` event with the memory files it surfaced. That the hint *fired* says nothing about whether the agent *read* the file — §7 "read the suggested memory" is HARD but leaves no direct telemetry. This joins each `suggest` row to its session transcript and asks: after the hint, did a non-user row name a suggested file?

- **applied** — a suggested file is named by a non-user transcript row after the hint.
- **bypassed** — transcript found, no such reference.
- **unmeasurable** — no transcript for that session (surfaced separately so the % isn't overclaimed).

Run:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/lesson-bypass-audit.js" --days=30
```

Report `cite-recall = applied / (applied + bypassed)` plus the unmeasurable slice. A low recall means the hint is firing but being bypassed — uncited memory decays, so this is the signal that the memory layer needs tuning (better index keywords, fewer/stronger hints). Advisory only. From the repo instead of an install: `node scripts/lesson-bypass-audit.js`.
