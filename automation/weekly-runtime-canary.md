# Weekly runtime canary

Purpose: observe pinned and latest Codex compatibility without changing the
supported-runtime policy from a single canary result.

## Isolation and authority

- Run from a clean source checkout with a dedicated, least-privilege automation
  identity.
- Use an isolated CODEX_HOME for install, status, doctor, hooks, telemetry, and
  every real-model turn. Never point the runner at an operator's live home.
- The positive fixture may mutate only its throwaway `canary.txt`; the
  near-negative fixture must leave its committed worktree unchanged.
- Do not push, open an issue, edit the spec, publish, release, or deploy.
- This recipe is read-only with respect to the source checkout, so it does not
  require a worktree. If a follow-up task will write tracked files, create one
  dedicated worktree for that task and re-enter AUTH classification.

## Matrix

Run both lanes with the same source commit:

```bash
node qa/runtime-canary.js --channel=pinned --codex=/path/to/codex-0.145.0 --out=artifacts/pinned
node qa/runtime-canary.js --channel=latest --codex=/path/to/latest-codex --out=artifacts/latest
```

Each lane executes:

1. isolated install, `status`, and `doctor`;
2. the current structural hook contract;
3. one positive mutation-plus-fresh-validation turn;
4. one near-negative validation-with-zero-mutation turn;
5. a five-run informational performance trend against `qa/perf/baseline.json`;
6. a bounded, versioned JSON capture.

Pinned failure is release-blocking evidence. Latest failure is
`compatibility-report-only`: retain the capture and investigate it, but do not
rewrite pinned support or thresholds from that observation alone.

## Cleanup and residue

The runner validates the real path and task-owned prefix before deleting its
temporary sandbox. It never cleans a source worktree. For any later writable
automation, clean only task-owned, inactive, unpinned residue. Pinned, active, or
permanent worktrees are never automatic cleanup targets; expose them in the
scorecard for operator review.
