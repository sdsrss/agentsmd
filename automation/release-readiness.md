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
9. Before publication, generate the candidate conformance attestation from the
   exact clean candidate commit and retain it outside the package bytes. After
   publication, create the binding from that exact candidate file, the GitHub
   release tarball, the independently downloaded npm tarball, and decoded npm
   SLSA provenance. Candidate-only evidence is readiness evidence, not proof of
   publication. The offline binding checks consistency, not Sigstore
   authenticity; retain the separate successful npm signature audit and source
   acquisition evidence in the release packet.

Report full command, exit code, observed result, capture identity, freshness, and
what each check proves. Missing, stale, incomplete, or inconclusive evidence
stays explicit.

The result is readiness report-only. Even a green packet does not execute a ship
operation. Ship actions remain behind the current task's AUTH boundary.

## Authorized merge handoff

Once an authorized release task raises the stable `package.json` version and its
pull request is merged into `main`, `.github/workflows/release-tag.yml` performs
the repository handoff without executing pull-request code:

1. Read `package.json` from the reviewed base commit and exact integrated commit
   through the GitHub API.
2. Require a monotonic stable SemVer increase. An unchanged version is a no-op;
   a decrease, prerelease, build suffix, malformed file, or invalid merge SHA
   fails before creating a tag.
3. Create a Git tag object followed by `refs/tags/v<version>`, producing an
   annotated tag at the integrated commit. An existing ref is accepted only
   when its annotation and peeled commit match exactly; it is never rewritten.
4. Dispatch `.github/workflows/release.yml` with the tag as `ref`. A matching
   existing Release run makes a retry a no-op.

The handoff has only `contents:write` and `actions:write`. The Release workflow
retains direct annotated-tag push compatibility and keeps the full CI, package,
provenance, signature, registry-byte, and marketplace gates. Revert the workflow
PR to return to manual tag creation.

Remove only task-owned package output and unpinned inactive worktree residue.
Never automatically remove pinned, active, or permanent worktrees.
