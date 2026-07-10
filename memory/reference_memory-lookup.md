verified: 2026-07-11 | source: `hooks/lib/hook-common.sh`, `hooks/memory-prompt-hint.sh`, `hooks/memory-read-check.sh`, `hooks/tests/smoke.sh`

# Memory Lookup

Prompt hints use `hook_find_memory_file` with this lookup order:

Lookup order:

1. `cwd/MEMORY.md`
2. enclosing git root `MEMORY.md`
3. parent directory walk to nearest readable `MEMORY.md`
4. global `${CODEX_HOME:-$HOME/.codex}/MEMORY.md`

Reason: users can run Codex from a subdirectory of a non-git project. Checking
only `cwd` and git root would miss the parent memory index.

The ship gate has a stricter repository-identity policy. Each parsed Git
push/merge resolves its own target repository from the invocation's Git global
arguments and checks only that root's `MEMORY.md`; an unresolved target is
recorded as unevaluated and never falls back to event `cwd`. Non-Git publish
commands retain the event-`cwd` lookup because they have no parser-provided Git
repository identity.

Consultation evidence is target-bound too: each required index must be named by
absolute path, or by its directory plus `MEMORY.md`, in a non-user transcript
entry. A read from one repository does not satisfy another repository in the
same chained ship command.
