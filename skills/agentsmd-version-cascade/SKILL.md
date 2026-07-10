---
name: agentsmd-version-cascade
description: Scan README prose for stale same-major version tokens. Use before release or after a version bump. Not for structured package/plugin/spec version equality; read-only.
---

# agentsmd-version-cascade

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/version-cascade-check.js" ]; then AGENTSMD_ROOT="$CANDIDATE_ROOT"; else AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"; fi
```

`drift.test.js` gate #5 asserts the version matches across the 5 **structured** places (named JSON fields + the two `CODEX-CODING-SPEC vX.Y.Z` headers). It cannot see a version token embedded in **narrative** text. This scans the prose READMEs for a current-major token whose minor has drifted:

```bash
node "$AGENTSMD_ROOT/scripts/version-cascade-check.js"
node "$AGENTSMD_ROOT/scripts/version-cascade-check.js" --json
```

- Compares each `vMAJOR.MINOR(.patch)` token against `hard-rules.json` `spec_version` at **minor** granularity (patch-insensitive). The major-token regex is derived per run, so it keeps working after a major bump instead of going silently blind.
- **Intentional historical/example refs are allowlisted** (`INTENTIONAL_TOKENS` in the script — the rename version, an example `--ref` tag). A genuinely new deliberate historical ref means a conscious addition there.
- `ok` + exit 0 = no stale prose token; a stale/missing token → exit 1 with `file:line — found … (expected …)`.

Read-only. From the repo instead of an install: `node scripts/version-cascade-check.js`. For the structured cross-file version check, run `npm test` (drift gate #5).
