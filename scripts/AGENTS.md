# Management script contributor instructions

These rules add to the repository root guidance for `scripts/` and `scripts/lib/`.

## Architecture

- Keep `bin/agentsmd.js` a thin subprocess dispatcher. Management behavior belongs in a focused script or shared library, with tests under `scripts/tests/`.
- Hooks must not import management modules. The documented bounded SessionStart arbitration spawn is the only current exception; drift tests enforce it.
- Reuse strict argv parsing, atomic filesystem helpers, safe walking, hook registry, and lifecycle primitives instead of adding parallel implementations.

## Lifecycle boundary

- Every install/update/uninstall/repair/restore test uses an isolated `CODEX_HOME`; never point a development command at the live home.
- Shared or tenant-owned files require compare-before-write behavior. Prove owned artifacts by exact path, content hash, and manifest; a mismatch must produce a zero-mutation refusal.
- Preserve third-party bytes, file modes, transaction journals, rollback snapshots, lock ownership, and concurrent-change checks.
- New or changed deletion, cleanup, overwrite, or recovery paths must first run against a temporary fixture and assert both the intended mutation and preserved neighbors.
- Keep `scripts/tests/live-guard.js` at the start and end of the full suite. Do not add a test-only bypass to make a live mutation pass.

## Validation routing

- CLI parsing: command-specific tests plus `scripts/tests/argv.test.js` and `scripts/tests/lint-argv.test.js`.
- Generated spec logic: spec-source and drift tests.
- Lifecycle or ownership: install, preflight, lifecycle-lock, lifecycle-journal, `scripts/tests/fault-injection.test.js`, repair, backup, and distribution tests as applicable.
- Diagnostics/governance: the command-specific test and malformed/empty/future-data near-negatives.
- After a shared library change, widen to all direct consumers found with `rg`, then run `npm run check`.
