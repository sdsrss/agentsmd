verified: 2026-07-10 | source: scripts/lib/backup.js + scripts/tests/backup.test.js + scripts/tests/distribution.test.js

# Restore snapshot compatibility

Shared-file restore must never recreate agentsmd hooks/spec without the owned
runtime and manifest. A snapshot records both its lifecycle purpose
(`pre-install` / `pre-uninstall`) and the agentsmd shared footprint derived from
its actual `hooks.json` and `AGENTS.md` bytes (`present` / `absent` / `partial`).

- Default restore chooses the newest pre-install or legacy snapshot whose
  derived footprint matches the current manifest state.
- Explicit `--id` restore applies the same state-match guard; explicit selection
  is not permission to create a partial install.
- Legacy snapshots without new metadata are classified from their contents.
- Restore preloads all snapshots and live-file baselines, then rolls back prior
  writes with compare-and-swap checks if a later shared-file write fails.
- Backup creation failures remove the new partial snapshot directory, and
  filesystem errors other than a genuinely missing backup directory propagate.

The regression path is `install → update → uninstall → restore`: final status
must remain uninstalled with zero agentsmd hooks/spec while preserving tenants.
