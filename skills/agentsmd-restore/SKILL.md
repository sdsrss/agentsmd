---
name: agentsmd-restore
description: Restore hooks.json, config.toml, and AGENTS.md from an agentsmd pre-install snapshot. Use after a bad install/update merge. Not for ordinary uninstall; dry-run unless confirmed.
---

# agentsmd-restore

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/restore.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

`install`/`update` mutate three files shared with oh-my-codex and other tenants. The write is atomic (crash-safe), and now also **reversible**: install snapshots all three into `.agentsmd-state/backups/<id>/` before touching them (rotated — the newest 5 kept). If a merge came out logically wrong, restore the prior bytes:

```bash
node "$AGENTSMD_ROOT/scripts/restore.js" --list          # snapshots + purpose
node "$AGENTSMD_ROOT/scripts/restore.js"                 # DRY-RUN — newest compatible snapshot
node "$AGENTSMD_ROOT/scripts/restore.js" --confirm       # apply compatible snapshot
node "$AGENTSMD_ROOT/scripts/restore.js" --id=<id> --confirm
```

- **Dry-run by default** — a bare `restore` prints what it *would* overwrite and writes nothing; `--confirm` performs the write.
- Backups are labeled `pre-install` or `pre-uninstall`. A bare restore selects the newest compatible `pre-install` snapshot. Both default and explicit `--id` restores reject a snapshot whose agentsmd hooks/spec footprint does not match the current install manifest, because restoring only the shared files would create a partial install. Legacy snapshots without these labels are classified from their actual hooks/spec contents and accepted only when that derived state matches.
- Restore **overwrites the live files with the snapshot**, discarding any change made since that backup — by every tenant, not just agentsmd. That is the point (full rollback of a bad merge), but it is why it is dry-run-first.
- Only files that **existed at backup time** are restored; a file that was absent then is left alone (never deleted).
- To remove **just agentsmd's own entries** and preserve everyone else, use `agentsmd uninstall` instead — it is marker-scoped and multi-tenant-safe. Restore is the cruder "give me the exact prior bytes" tool for when a merge misbehaved.

The install manifest (`.agentsmd-state/manifest.json`) records the `backup` id from the last install. From the repo instead of an install: `node scripts/restore.js`.
