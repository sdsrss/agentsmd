---
name: agentsmd-scorecard
description: Aggregate the unified agentsmd quality scorecard (统一质量记分卡) with health, compatibility, conformance, performance, and measurement limits. Use for operator review or capture comparison. Not for automatic rule changes, release gates, or telemetry editing.
---

# agentsmd-scorecard

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Generate the operator report or versioned JSON capture:

```bash
agentsmd_skill_run --days=30
agentsmd_skill_run --days=30 --json
agentsmd_skill_run --days=30 --compare=scorecard-previous.json
agentsmd_skill_run --days=30 --outcomes=/absolute/agentsmd-outcomes.json
agentsmd_skill_run --days=30 --conformance-candidate=/absolute/candidate.json
agentsmd_skill_run --days=30 --conformance-candidate=/absolute/candidate.json --conformance-binding=/absolute/binding.json
```

- Run from the project whose AGENTS.md prompt budget and worktree inventory should be measured.
- Treat `test` and `qa` data classes as visible provenance, not field evidence.
- Treat missing dimensions, stale captures, no-opportunity, insufficient opportunity, and unmeasured/partial/invalid false-block outcomes as gaps.
- Read `compatibility.dimension_join_attribution` before diagnosing missing dimensions. `pre-first-observed-only` is retained-window ordering debt, not proof of historical schema or a current emitter defect; `post-first-observed-present` warrants current SessionStart investigation, while `no-dimension-reference` cannot attribute a version or surface. Invalid/absent identities stay unjoinable and outside the missing-session count.
- Read `false_blocks.state` before interpreting its rate. The denominator contains only reviewed external `true-block` plus `false-block` outcomes; legacy, duplicate, self, test, QA, unknown, unreviewed, unmeasurable, mismatched, and future-dated evidence stays outside it.
- Use `agentsmd outcomes list/review` for explicit bounded human review. The scorecard is read-only, never fabricates labels from conformance near-negatives, and never rewrites raw telemetry or the review sidecar.
- Read `automation.fail_open_causes` as a complete category split whose total must equal `fail_open_events`; retain `audit` for exact reasons and version attribution.
- Read `conformance.provenance` before recommending a model run: packaged release evidence is historical, a source/input mismatch is not current-tree proof, and missing evidence calls for a bounded evidence source before an unconditional rerun.
- Read `conformance.provenance.evidence_phase` when present: `local-candidate` matches a candidate artifact but is not publication proof; `published-binding` also binds the exact candidate to verified release/registry bytes and npm provenance. The command never fetches either file implicitly.
- Treat a `published-binding` as offline consistency evidence, not an independent signature audit; release provenance authenticity and input acquisition remain separate release-closure checks.
- Treat sampling calibration as a structural proxy and memory cite-recall as engagement only; neither proves semantic adherence.
- Use `--compare` only with a prior JSON capture from this command. The reader rejects symlinks, oversized input, malformed JSON, unknown fields, and unsupported schema versions.
- Read recommended actions as operator prompts. The command is read-only and never promotes/demotes rules, cleans worktrees, changes the spec, or runs external canaries.
- Preserve the machine-readable JSON directly; do not reconstruct it from the human report.
