verified: 2026-07-11 | source: `hooks/lib/hook-common.sh`, `hooks/memory-prompt-hint.sh`, `hooks/memory-read-check.sh`, `hooks/tests/smoke.sh`

# Memory Lookup

Prompt hints use `hook_find_memory_file` with this lookup order:

Lookup order:

1. `cwd/MEMORY.md`
2. enclosing git root `MEMORY.md`
3. parent directory walk to nearest readable `MEMORY.md`
4. global `${CODEX_HOME:-$HOME/.codex}/MEMORY.md`

Every surfaced hint includes the selected index's absolute path and tells the
agent to resolve relative links from that index directory. This keeps parent or
global fallback hints usable from nested Git repositories.

Reason: users can run Codex from a subdirectory of a non-git project. Checking
only `cwd` and git root would miss the parent memory index.

The ship gate has a stricter repository-identity policy. Each parsed Git
push/merge resolves its own target repository from the invocation's Git global
arguments and checks only that root's `MEMORY.md`; an unresolved target is
recorded as unevaluated and never falls back to event `cwd`. Non-Git publish
commands retain the event-`cwd` lookup because they have no parser-provided Git
repository identity.

Consultation evidence is target-bound too: each required index and at least one
local linked memory (when links exist) must be the exact target of `read_file` or
an explicit reader command such as `sed`/`cat`/`rg`, paired to successful output
by `call_id`. Merely printing or testing the path is not a read. A read from one
repository does not satisfy another repository in the same chained ship command.
