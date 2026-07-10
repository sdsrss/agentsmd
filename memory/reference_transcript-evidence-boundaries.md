verified: 2026-07-11 | source: `hooks/memory-read-check.sh`, `hooks/tests/smoke.sh`

# Transcript Evidence Boundaries

Hook gates must not treat user prompt text as proof that the agent performed an action.

Observed failure: `memory-read-check.sh` used to grep the full transcript for `MEMORY.md`. A user message such as "push without reading MEMORY.md" satisfied the ship gate even though no file read occurred.

Current policy:

- User or assistant prose does not count as consultation evidence.
- `memory-read-check.sh` requires an exact `read_file` target or an explicit
  reader command and a successful, non-empty output row with the same `call_id`.
- The tool input must read the target index and, when the index contains local
  links, at least one linked memory file. Path-only `echo`/`printf`/`test` calls,
  structured nonzero exits, and textual process-exit failures do not satisfy it.
- Keep hook block text free of the literal `MEMORY.md` where self-satisfaction could occur on retry.
