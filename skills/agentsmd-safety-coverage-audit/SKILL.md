---
name: agentsmd-safety-coverage-audit
description: Check hook claims, bypass tokens, emitters, and hard-rules wiring for static drift. Use when reviewing safety hook metadata. Not for semantic security proof or runtime correctness.
---

# agentsmd-safety-coverage-audit

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Header comments and deny/advisory strings are **documentation, not proof**. This audit cross-references the hook layer against its own claims and the manifest, four ways:

```bash
agentsmd_skill_run      # human report
agentsmd_skill_run --json
agentsmd_skill_run --hook=pre-bash-safety-check.sh
```

- **Arrow-claim sweep** — every `→` claim (header block or deny/advisory string) is split on `→`/`;` and each clause keyword-grepped against the hook's code body (header stripped). A clause with zero hits = a **partial-impl candidate**: the header promises a link the code never implements (the failure this audit exists to catch).
- **Manifest cross-ref** — every `enforcement: hook|both` rule whose `rule_hits_section` is **live** must be emitted by some hook. A live section with no emitter is an **unimplemented gap**; a hook-enforced rule whose section is NOT live reads as **hook-planned** (its hook isn't built yet — expected, not a gap).
- **Bypass-token coverage** — a documented `[allow-*]` escape hatch must appear on a code line (a real guard), not just in a comment.
- **Orphan emission** — a `§`-section literal a hook emits that no manifest rule declares (telemetry the governance layer can't see).

`TOTAL GAPS: 0` + exit 0 = clean; exit 3 = at least one gap (the summary lists each). Wired into `npm test` as a coherence gate, so a hook that documents more than it implements fails CI. From the repo instead of an install: `node scripts/safety-coverage-audit.js`.
