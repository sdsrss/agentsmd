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

Distill conventions from what you actually read: only include one with **≥2 independent source occurrences**, mark single-occurrence ones `(low-confidence)` or omit them, and **never invent "best practices"** — every line must trace to something in this repo. Output **bulleted** conventions, not prose, grouped under exactly these eight headings (`scripts/lib/conventions-taxonomy.js` is the source of truth): **Declaration style**, **Naming**, **Import order**, **Error handling**, **Request/API encapsulation**, **State management**, **Comment style**, **Git conventions**. Omit a heading entirely rather than force-fitting an empty or low-confidence one — don't invent bullets just to fill a heading.

Write the distilled markdown to a temp file, then inject it:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --write --from <tmp-file>
```

Merges into the `# >>> agentsmd:conventions >>>` block of `./AGENTS.md`, preserving everything outside it, and refuses — never truncates — once the conventions block exceeds 6 KiB or the whole file would exceed ~32 KiB; if it refuses, distill fewer, higher-signal conventions rather than fighting the cap. Conventions the user hand-tuned themselves live outside the managed block — never move or absorb them into it.

`--write` stamps each of the eight headings above (matched case- and emphasis-insensitively against each heading's alias list — see the taxonomy file) with a stable `@conv-<dim>` anchor, e.g. `### Naming (@conv-naming)`. The anchor is derived from the heading, never from the bullet text underneath it, so it stays identical across re-runs even though the AI's wording changes every time — that stability is what lets citations of it accumulate. A heading worded too differently to match any alias is left unanchored, so prefer the exact names above.

**Citation discipline:** the written block also carries a citation instruction at its top. When you (in this session or a later one) apply one of these conventions in your own output, name its `@conv-<dim>` anchor — that citation is this project's only adoption signal, recorded automatically by the `convention-cite-scan` Stop hook. A dimension nobody ever cites decays toward a prune candidate. Check the current standing:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --adoption [--days=N] [--project=SUBSTR]
```

Reports each known anchor's cite count over the window and flags 0-cite dimensions as prune candidates. Advisory and read-only — it never edits `AGENTS.md` itself; a human decides whether to actually drop a dimension.
