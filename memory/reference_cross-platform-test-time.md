verified: 2026-07-10 | source: GitHub Actions runs 29079761694 and 29080009143

# Cross-platform test time fixtures

Do not use GNU-only `touch -d` syntax to age fixture mtimes in tests that run on
macOS. A fallback to plain `touch` hides the setup failure by making the file
newer, which reverses age-based assertions. Use Node `fs.utimesSync` with an
explicit timestamp when Node is already part of the test matrix, and let fixture
setup failures fail the test instead of silently changing semantics.
