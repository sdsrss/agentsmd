---
name: agentsmd-version-cascade
description: Free-text version-drift gate — scans the prose READMEs for a same-major version token drifted off the current minor (e.g. a "current version vX.Y" claim left stale after a bump), complementing the structured drift test that only checks named JSON/header fields. Use before a release, when bumping the version, or when the user asks whether a version string in the docs went stale. Intentional historical/example refs (the rename version, an example --ref tag) are allowlisted by exact token. Read-only; exit 1 on a stale token. NOT the structured 5-place version check (that is drift.test.js gate #5, over package.json / plugin.json / hard-rules.json / the two spec headers).
---

# agentsmd-version-cascade

`drift.test.js` gate #5 asserts the version matches across the 5 **structured** places (named JSON fields + the two `CODEX-CODING-SPEC vX.Y.Z` headers). It cannot see a version token embedded in **narrative** text. This scans the prose READMEs for a current-major token whose minor has drifted:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/version-cascade-check.js"
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/version-cascade-check.js" --json
```

- Compares each `vMAJOR.MINOR(.patch)` token against `hard-rules.json` `spec_version` at **minor** granularity (patch-insensitive). The major-token regex is derived per run, so it keeps working after a major bump instead of going silently blind.
- **Intentional historical/example refs are allowlisted** (`INTENTIONAL_TOKENS` in the script — the rename version, an example `--ref` tag). A genuinely new deliberate historical ref means a conscious addition there.
- `ok` + exit 0 = no stale prose token; a stale/missing token → exit 1 with `file:line — found … (expected …)`.

Read-only. From the repo instead of an install: `node scripts/version-cascade-check.js`. For the structured cross-file version check, run `npm test` (drift gate #5).
