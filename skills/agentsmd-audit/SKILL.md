---
name: agentsmd-audit
description: Aggregate agentsmd rule-hit telemetry by section (遥测命中统计). Use for enforcement activity and raw hit counts. Not for promotion/demotion decisions or transcript violation rates; read-only.
---

# agentsmd-audit

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/audit.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

Aggregate the agentsmd enforcement telemetry (`~/.codex/logs/agentsmd.jsonl`) over a window and report activity by spec section and hook.

Run:

```bash
node "$AGENTSMD_ROOT/scripts/audit.js" --days=30
```

Use `--project=SUBSTR` for a case-insensitive project-slug lens. Verification
rows tagged with `AGENTSMD_TELEMETRY_TAG=test` stay excluded unless
`--include-test` is explicitly passed.

Report the `by spec_section` table, including eligible/evaluated sessions when present. Raw zero hits alone are not a demotion signal; use `agentsmd-rules` for governance. From a checkout, run `node scripts/audit.js`.
