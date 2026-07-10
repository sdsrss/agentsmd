verified: 2026-07-11 | source: `scripts/audit.js`, `scripts/rules.js`, `scripts/status.js`, `scripts/doctor.js`, and their tests

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
- `audit.js` and `rules.js` exit 1 on invalid arguments; `status.js` and
  `doctor.js` exit 2. All print usage text for invalid arguments.
