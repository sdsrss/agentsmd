---
name: agentsmd-lesson-bypass-audit
description: Measure whether surfaced memory hints were later cited in Codex transcripts. Use for memory hint follow-through and bypass rates. Not for rule-hit governance or memory editing; read-only.
---

# agentsmd-lesson-bypass-audit

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

`memory-prompt-hint.sh` records a `suggest` event with the memory files it surfaced. That the hint *fired* says nothing about whether the agent *read* the file — §7 "read the suggested memory" is HARD but leaves no direct telemetry. This joins each `suggest` row to its session transcript and asks: after the hint, did a non-user row name a suggested file?

- **applied** — a suggested file is named by a non-user transcript row after the hint.
- **bypassed** — transcript found, no such reference.
- **unmeasurable** — no transcript for that session (surfaced separately so the % isn't overclaimed).

Run:

```bash
agentsmd_skill_run --days=30
```

Report `cite-recall = applied / (applied + bypassed)` plus the unmeasurable slice. A low recall means the hint is firing but being bypassed — uncited memory decays, so this is the signal that the memory layer needs tuning (better index keywords, fewer/stronger hints). Advisory only. From the repo instead of an install: `node scripts/lesson-bypass-audit.js`.
