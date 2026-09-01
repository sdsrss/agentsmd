---
name: agentsmd-audit
description: Aggregate agentsmd rule-hit telemetry by section (遥测命中统计). Use for enforcement activity and raw hit counts. Not for promotion/demotion decisions or transcript violation rates; read-only.
---

# agentsmd-audit

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Aggregate the agentsmd enforcement telemetry (`~/.codex/logs/agentsmd.jsonl`) over a window and report activity by spec section and hook.

Run:

```bash
agentsmd_skill_run --days=30
```

Use `--project=SUBSTR` for a case-insensitive project-slug lens. Verification
rows tagged with `AGENTSMD_TELEMETRY_TAG=test` stay excluded unless
`--include-test` is explicitly passed.

Report the `by spec_section` table, including eligible/evaluated sessions when present. Raw zero hits alone are not a demotion signal; use `agentsmd-rules` for governance. From a checkout, run `node scripts/audit.js`.
