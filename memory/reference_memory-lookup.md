verified: 2026-07-03 | source: `hooks/lib/hook-common.sh`, `hooks/memory-prompt-hint.sh`, `hooks/memory-read-check.sh`, `hooks/tests/smoke.sh`

# Memory Lookup

Memory hooks share one lookup policy through `hook_find_memory_file`.

Lookup order:

1. `cwd/MEMORY.md`
2. enclosing git root `MEMORY.md`
3. parent directory walk to nearest readable `MEMORY.md`
4. global `${CODEX_HOME:-$HOME/.codex}/MEMORY.md`

Reason: users can run Codex from a subdirectory of a non-git project. Checking only `cwd` and git root misses the parent memory index, so prompt hints and ship gates fail to fire.
