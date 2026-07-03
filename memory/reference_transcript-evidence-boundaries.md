verified: 2026-07-03 | source: `hooks/memory-read-check.sh`, `hooks/tests/smoke.sh`

# Transcript Evidence Boundaries

Hook gates must not treat user prompt text as proof that the agent performed an action.

Observed failure: `memory-read-check.sh` used to grep the full transcript for `MEMORY.md`. A user message such as "push without reading MEMORY.md" satisfied the ship gate even though no file read occurred.

Current policy:

- User transcript entries do not count as consultation evidence.
- For `memory-read-check.sh`, only non-user transcript entries containing `MEMORY.md` satisfy the gate.
- Keep hook block text free of the literal `MEMORY.md` where self-satisfaction could occur on retry.
