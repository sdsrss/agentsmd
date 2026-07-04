---
name: agentsmd-init
description: Generate or refresh a project-level AGENTS.md for the current repo — detects the stack (Node/Rust/Python/Go), package manager, build/test/dev commands, and structure, then writes a sentinel-delimited managed block that re-runs update in place while preserving your own edits. Use when the user asks to create, scaffold, generate, or refresh a project AGENTS.md, or set up project coding conventions. Complements the global agentsmd spec in ~/.codex/AGENTS.md (which carries the universal workflow discipline).
---

# agentsmd-init

Generate the project-level `AGENTS.md` for the repo in the current working directory. Deterministic and language-agnostic; run it from the project root.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js"
```

Flags: `--check` (report drift without writing; exit 1 if out of sync), `--dry-run` (print what would be written), `--local` (also scaffold a git-ignored `AGENTS.local.md` for personal preferences), `--no-frontend` (skip the `## Frontend` section even when a frontend stack is detected). Re-running is safe — it updates only the `# >>> agentsmd:project >>>` block and preserves everything you wrote outside it.

For the deeper pass that reads the source to distil implicit conventions (naming, imports, error handling), run the `agentsmd-analyze` skill afterward (Phase 2).
