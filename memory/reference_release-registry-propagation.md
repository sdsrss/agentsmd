verified: 2026-07-27 | source: GitHub Actions release runs 30262890085 and 30264165884

# Release registry propagation retries

Do not run a retryable, just-published `npm pack name@version` probe directly as
a GitHub Actions shell command and rely on `set +e` or an `if` condition to
contain its transient `ETARGET`. In this repository's hosted release runs, both
forms exited the step before the retry body despite passing under local
`bash -euo pipefail`.

Put the npm subprocess and retry loop inside a tested Node helper. The helper
captures child exit statuses, removes only newly created top-level tarball
paths from its bounded destination between attempts, waits, and returns nonzero
to the workflow only after the configured attempts are exhausted. This keeps
shell `errexit` outside the retryable failure boundary.
