verified: 2026-07-11 | source: user correction after v3.2.1 release

# Release closure and ship authorization

When the user explicitly requests commit plus release/publish, that request is
the operation-scoped authorization for the current repository's standard ship
flow. Do not interrupt it with a second confirmation for commit, merge, push,
tag, or the declared package publication.

The release is not closed merely because a tag or package exists. Ensure the
released commit is integrated into and pushed on the default branch, verify the
tag/artifact, delete the merged task/release branch locally and remotely, and
finish on a clean default branch. Live configuration, production deployment,
or a different repository/package/registry/environment remains outside scope
unless the user names it.
