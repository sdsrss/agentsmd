verified: 2026-07-03 | source: `install.sh`, `scripts/tests/distribution.test.js`

# Installer Cleanup

`install.sh` cleanup state must be set in the parent shell, not inside command substitution.

Observed failure: `src=$(fetch_source)` ran `fetch_source` in a subshell, so `TMP_ROOT` was empty in the parent EXIT trap. An unsupported `--repo` with custom `TMPDIR` left `agentsmd-install.*` behind.

Current policy:

- `fetch_source` sets global `SRC_PATH`.
- Main flow calls `fetch_source` directly and then reads `SRC_PATH`.
- `cleanup` normalizes the temp base before matching `agentsmd-install.*`.
