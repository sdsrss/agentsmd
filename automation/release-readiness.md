# Release readiness

Purpose: generate a report-only release decision packet. It does not grant ship
authorization and never performs push, merge, publish, release, or deploy.

## Worktree and checkpoint

Use a dedicated worktree from the exact candidate commit because conformance and
package checks create task-owned captures or temporary artifacts. Record the
candidate SHA and rollback point before running. Keep the outcome coherent:
readiness evidence only.

## Required evidence

1. Full check: `npm run check`.
2. Full conformance twice on the declared Codex/runtime/model combination.
3. Formal performance SLO with all configured runs and rounds.
4. Package dry run and isolated install/distribution verification.
5. Version, generated-spec, drift, action-SHA, and changelog checks.
6. Secret scan over the candidate diff and package file list.
7. Reviewed rollback path for the package and shared install surface.
8. Authorization state: name whether push, merge, tag, publish, release, and
   post-publish marketplace E2E are authorized.

Report full command, exit code, observed result, capture identity, freshness, and
what each check proves. Missing, stale, incomplete, or inconclusive evidence
stays explicit.

The result is readiness report-only. Even a green packet does not execute a ship
operation. Ship actions remain behind the current task's AUTH boundary.

Remove only task-owned package output and unpinned inactive worktree residue.
Never automatically remove pinned, active, or permanent worktrees.
