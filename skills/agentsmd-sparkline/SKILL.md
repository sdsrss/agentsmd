---
name: agentsmd-sparkline
description: Show multi-window trends in agentsmd rule activity and detect sections that went silent. Use for regressions or CHANGELOG trend tables. Not for single-window governance; read-only.
---

# agentsmd-sparkline

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/sparkline.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

`agentsmd audit` reports one window's hit counts; it cannot see a rule that WAS firing and silently STOPPED — a regressed or unwired hook keeps its healthy lifetime total, so the point-count still looks fine. This buckets each `spec_section`'s enforcement hits (block / deny / advisory / bypass — the same hit definition `audit` uses) across N equal windows and shows the shape: ↗ rising, ↘ falling, ≈ flat, plus a **went-silent** flag = fired earlier in the window, zero in the most recent bucket.

Run:

```bash
node "$AGENTSMD_ROOT/scripts/sparkline.js" --windows=6 --bucket-days=7
```

- **went silent** (sorted to the top of the report, ⚠ in the markdown table) is the actionable signal — a section that stopped emitting. Check the emitting hook is still registered in `hooks.json` and building; a regressed hook keeps its lifetime total, so only the trend catches it.
- `--markdown` emits a CHANGELOG-ready table (section · trend · sparkline · recent/older · total).
- `--include-test` folds back rows tagged `AGENTSMD_TELEMETRY_TAG=test` (excluded by default so verify/smoke runs don't fabricate a trend).

Advisory only — sparse windows are noisy; the trend needs a few sessions of data to mean anything. From the repo instead of an install: `node scripts/sparkline.js`. For a single window's point counts plus fail-open / project-class splits, use `agentsmd audit`.
