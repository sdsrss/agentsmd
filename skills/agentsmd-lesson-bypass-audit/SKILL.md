---
name: agentsmd-lesson-bypass-audit
description: Measure whether surfaced memory hints were later cited in Codex transcripts. Use for memory hint follow-through and bypass rates. Not for rule-hit governance or memory editing; read-only.
---

# agentsmd-lesson-bypass-audit

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/lesson-bypass-audit.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

`memory-prompt-hint.sh` records a `suggest` event with the memory files it surfaced. That the hint *fired* says nothing about whether the agent *read* the file — §7 "read the suggested memory" is HARD but leaves no direct telemetry. This joins each `suggest` row to its session transcript and asks: after the hint, did a non-user row name a suggested file?

- **applied** — a suggested file is named by a non-user transcript row after the hint.
- **bypassed** — transcript found, no such reference.
- **unmeasurable** — no transcript for that session (surfaced separately so the % isn't overclaimed).

Run:

```bash
node "$AGENTSMD_ROOT/scripts/lesson-bypass-audit.js" --days=30
```

Report `cite-recall = applied / (applied + bypassed)` plus the unmeasurable slice. A low recall means the hint is firing but being bypassed — uncited memory decays, so this is the signal that the memory layer needs tuning (better index keywords, fewer/stronger hints). Advisory only. From the repo instead of an install: `node scripts/lesson-bypass-audit.js`.
