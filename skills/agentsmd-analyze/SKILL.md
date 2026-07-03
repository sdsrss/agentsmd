---
name: agentsmd-analyze
description: Distill a project's implicit coding conventions (naming, imports, error handling, comment style, git conventions, etc.) from its own source, then inject them into the project AGENTS.md's `agentsmd:conventions` block. Use when the user asks to analyze, distill, or deepen project conventions beyond what agentsmd-init detects — agentsmd-init only detects stack facts (language, package manager, commands); this skill reads and reasons over actual code. Run agentsmd-init first; this skill edits the same AGENTS.md.
---

# agentsmd-analyze

Read a sample of the project's own source and distill the *implicit* conventions agentsmd-init can't detect, because they aren't stack facts. Gathering and writing are deterministic; the distillation is the one AI step. Run it from the project root, after `agentsmd-init`.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --gather
```

Prints the detected stack plus a capped, ignore-aware source map (≤40 files, ≤200 KiB total; skips `node_modules`/`.git`/`dist`/`build`/`target`/`.next`/`.nuxt`/`coverage`/`__pycache__`/`vendor`/`.code-graph` plus any bare directory named in `.gitignore`) — operates on `process.cwd()`, not `$CODEX_HOME`. Read a representative sample of the listed files, not necessarily all of them.

Distill conventions from what you actually read: only include one with **≥2 independent source occurrences**, mark single-occurrence ones `(low-confidence)` or omit them, and **never invent "best practices"** — every line must trace to something in this repo. Output **bulleted** conventions, not prose, grouped under: declaration style, naming, import order, error handling, request/API encapsulation, state management, comment style, git conventions.

Write the distilled markdown to a temp file, then inject it:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --write --from <tmp-file>
```

Merges into the `# >>> agentsmd:conventions >>>` block of `./AGENTS.md`, preserving everything outside it, and refuses — never truncates — once the conventions block exceeds 6 KiB or the whole file would exceed ~32 KiB; if it refuses, distill fewer, higher-signal conventions rather than fighting the cap. Conventions the user hand-tuned themselves live outside the managed block — never move or absorb them into it.
