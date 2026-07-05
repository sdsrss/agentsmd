---
name: agentsmd-restore
description: Roll agentsmd's 3 shared Codex files (hooks.json / config.toml / AGENTS.md) back to a pre-install snapshot. Use when an install or update produced a wrong merge (a tenant's hooks vanished, config.toml looks off, AGENTS.md is malformed) and you want the exact prior bytes back. Each install auto-snapshots these files first (rotated, keep 5). Dry-run by default; --confirm writes. To remove only agentsmd's own entries instead, use uninstall (marker-scoped).
---

# agentsmd-restore

`install`/`update` mutate three files shared with oh-my-codex and other tenants. The write is atomic (crash-safe), and now also **reversible**: install snapshots all three into `.agentsmd-state/backups/<id>/` before touching them (rotated — the newest 5 kept). If a merge came out logically wrong, restore the prior bytes:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/restore.js" --list          # what snapshots exist
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/restore.js"                 # DRY-RUN — preview newest
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/restore.js" --confirm       # apply the newest
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/restore.js" --id=<id> --confirm
```

- **Dry-run by default** — a bare `restore` prints what it *would* overwrite and writes nothing; `--confirm` performs the write.
- Restore **overwrites the live files with the snapshot**, discarding any change made since that backup — by every tenant, not just agentsmd. That is the point (full rollback of a bad merge), but it is why it is dry-run-first.
- Only files that **existed at backup time** are restored; a file that was absent then is left alone (never deleted).
- To remove **just agentsmd's own entries** and preserve everyone else, use `agentsmd uninstall` instead — it is marker-scoped and multi-tenant-safe. Restore is the cruder "give me the exact prior bytes" tool for when a merge misbehaved.

The install manifest (`.agentsmd-state/manifest.json`) records the `backup` id from the last install. From the repo instead of an install: `node scripts/restore.js`.
