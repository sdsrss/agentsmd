---
name: agentsmd-safety-coverage-audit
description: Check hook claims, bypass tokens, emitters, and hard-rules wiring for static drift. Use when reviewing safety hook metadata. Not for semantic security proof or runtime correctness.
---

# agentsmd-safety-coverage-audit

Header comments and deny/advisory strings are **documentation, not proof**. This audit cross-references the hook layer against its own claims and the manifest, four ways:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/safety-coverage-audit.js"      # human report
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/safety-coverage-audit.js" --json
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/safety-coverage-audit.js" --hook=pre-bash-safety-check.sh
```

- **Arrow-claim sweep** — every `→` claim (header block or deny/advisory string) is split on `→`/`;` and each clause keyword-grepped against the hook's code body (header stripped). A clause with zero hits = a **partial-impl candidate**: the header promises a link the code never implements (the failure this audit exists to catch).
- **Manifest cross-ref** — every `enforcement: hook|both` rule whose `rule_hits_section` is **live** must be emitted by some hook. A live section with no emitter is an **unimplemented gap**; a hook-enforced rule whose section is NOT live reads as **hook-planned** (its hook isn't built yet — expected, not a gap).
- **Bypass-token coverage** — a documented `[allow-*]` escape hatch must appear on a code line (a real guard), not just in a comment.
- **Orphan emission** — a `§`-section literal a hook emits that no manifest rule declares (telemetry the governance layer can't see).

`TOTAL GAPS: 0` + exit 0 = clean; exit 3 = at least one gap (the summary lists each). Wired into `npm test` as a coherence gate, so a hook that documents more than it implements fails CI. From the repo instead of an install: `node scripts/safety-coverage-audit.js`.
