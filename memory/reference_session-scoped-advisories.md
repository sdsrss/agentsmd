verified: 2026-07-03 | source: `hooks/lib/hook-common.sh`, `hooks/surface-advisories.sh`, `hooks/tests/smoke.sh`

# Session-Scoped Advisories

Stop-time advisories must be queued per Codex `session_id`, not in a single global pending file.

Reason: multiple Codex sessions can share one `CODEX_HOME`. A global `pending-advisories` file lets one session surface and clear another session's Stop advisory, so the creating session never sees its own guidance.

Current policy:

- Use `hook_advisory_file "$SID"` for queued advisory paths.
- Stop hooks pass their event `SID` to `hook_queue_advisory`.
- `surface-advisories.sh` reads only the current session queue.
- `session-start-check.sh` clears the legacy global queue plus the current session queue on fresh startup, but preserves the current queue on resume.
