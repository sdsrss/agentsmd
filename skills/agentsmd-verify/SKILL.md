---
name: agentsmd-verify
description: Select and run change-aware validation (变更感知验证) with deterministic reasons and full-gate widening. Use for changed-file test planning or execution. Not for external canaries, release, deploy, or authorization.
---

# agentsmd-verify

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Inspect the deterministic plan before executing it:

```bash
agentsmd_skill_run --changed --explain
agentsmd_skill_run --since=HEAD~1 --explain --json
```

Run the selected local checks only after reviewing changed files, widening, and boundaries:

```bash
agentsmd_skill_run --changed
agentsmd_skill_run --since=HEAD~1 --full --json
```

- `--changed` is the default and unions unstaged, staged, and untracked files.
- `--since=<commit>` compares the current worktree to a verified commit.
- `--explain` is read-only: it lists files, risk categories, checks, deterministic reasons, uncovered risks, full-gate status, external-service expectations, and AUTH boundaries.
- `--full` adds the repository full gate; it never removes targeted or release checks.
- Unknown paths require the full gate and remain explicitly uncovered until classified.
- External-service and §5-hard/AUTH operations are always report-only. The router never executes them or treats a skipped external check as fresh evidence.
- Checks are ordered targeted → widened → full. The first failed local check prevents later, wider checks from running.
- `--json` is the automation output. Do not reconstruct it from interactive prose.
