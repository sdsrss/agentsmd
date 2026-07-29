# Weekly governance review

Purpose: produce one read-only operator view of governance signals while keeping
measurement gaps and provenance visible.

## Run

Run locally where the relevant telemetry and Codex transcripts exist:

```bash
agentsmd scorecard --days=30 --json > scorecard.json
agentsmd scorecard --days=30
```

The scorecard composes the existing `rules`, `sampling-audit`,
`lesson-bypass-audit`, and `sparkline` readings with prompt size, the committed
performance baseline/trend, compatibility fallback usage, install health,
conformance freshness, and worktree residue.

Review these outputs separately:

- due rules and no-opportunity/insufficient-opportunity denominators;
- bypass review, including self/test/qa/external provenance;
- went-silent emitters;
- runtime/version split joined through one session-dimension row;
- sampling proxies and memory lesson engagement;
- prompt-budget headroom, performance freshness, fallback and fail-open usage;
- recommended operator actions and every measurement limit.

No-opportunity is not success. Citation is not adherence. A sampling proxy is not
semantic proof. Raw hits do not rank rule value, and this recipe never promotes
or demotes a rule.

This is a read-only report, so it can run in the local checkout. If an operator
accepts an action that writes governance records, perform that coherent outcome
in a dedicated worktree. Clean only task-owned, inactive, unpinned residue;
pinned/active/permanent worktrees remain for explicit operator disposition.
