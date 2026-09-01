---
name: agentsmd-init
description: Generate or refresh project AGENTS.md stack facts, commands, and structure (生成项目指令). Use before convention analysis. Not for inferring coding conventions or design tokens.
---

# agentsmd-init

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Generate the project-level `AGENTS.md` for the repo in the current working directory. Deterministic and language-agnostic; run it from the project root.

```bash
agentsmd_skill_run
```

Flags: `--check` (report drift without writing; exit 1 if out of sync), `--dry-run` (print what would be written), `--local` (also scaffold a git-ignored `AGENTS.local.md` for personal preferences), `--no-frontend` (skip the `## Frontend` section even when a frontend stack is detected). Choose only one of `--check`, `--dry-run`, and `--local`; each selects a different execution mode. Re-running is safe — it updates only the `# >>> agentsmd:project >>>` block and preserves everything you wrote outside it.

For the deeper pass that reads the source to distil implicit conventions (naming, imports, error handling), run the `agentsmd-analyze` skill afterward (Phase 2).
