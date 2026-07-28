verified: 2026-07-28 | source: GitHub Actions release runs 30262890085, 30264165884, and 30334474903

# Release registry propagation retries

Do not run a retryable, just-published `npm pack name@version` probe directly as
a GitHub Actions shell command and rely on `set +e` or an `if` condition to
contain its transient `ETARGET`. In this repository's hosted release runs, both
forms exited the step before the retry body despite passing under local
`bash -euo pipefail`.

Put the npm subprocess and retry loop inside a tested Node helper. The helper
must treat the tarball fetch and install metadata as one readiness attempt:
`npm pack` can succeed while the next `npm install name@version` still returns
transient `ETARGET` from a lagging packument endpoint. Run the install probe in
an exact temporary prefix with lifecycle scripts disabled.

Capture both child exit statuses, remove only newly created top-level tarball
paths and the exact temporary install prefix between attempts, wait, and return
nonzero to the workflow only after the configured attempts are exhausted. This
keeps shell `errexit` outside the retryable failure boundary and does not
declare propagation complete before the workflow's install-based signature
audit can resolve the version.
