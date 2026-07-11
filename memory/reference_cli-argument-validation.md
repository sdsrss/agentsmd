verified: 2026-07-11 | source: `bin/agentsmd.js`, `install.sh`, CLI scripts, and distribution/argv tests

# CLI Argument Validation

CLI tools must reject invalid options instead of silently falling back to defaults.

Observed failures:

- `node scripts/audit.js --days=abc` and `node scripts/rules.js --unknown` exited 0 and printed a 30-day report, hiding user typos.
- Oversized `--days` values crashed with `RangeError: Invalid time value` before argument validation rejected them.

Current policy:

- `audit.js` and `rules.js` accept no args, `--days=N`,
  `--project=SUBSTR`, `--include-test`, `--help`, and `-h`.
- `--days` must be a positive safe integer and no greater than `MAX_DAYS` in `scripts/audit.js`.
- Repeating `--days` is invalid; CLIs must not silently let the later value overwrite the earlier one.
- `status.js` and `doctor.js` accept no args, `--help`, and `-h`.
- Every CLI argv/usage error exits 2, including the top-level dispatcher,
  standalone `install.sh`, hand-written parsers, and semantic flag-value checks.
- Exit 1 is reserved for a valid command that reports a negative result or a
  runtime/health failure, such as detected drift, an unhealthy installation, or
  a missing input file. Exit 0 means success/help.
- Invalid arguments print usage text where the command has a usage block.
