verified: 2026-07-03 | source: manual CODEX_HOME fixture + scripts/status.js + scripts/audit.js

# Telemetry Row Counting

`scripts/audit.js` is the parser owner for `logs/agentsmd.jsonl`: malformed JSONL lines are skipped instead of counted as telemetry.

User-facing summaries such as `scripts/status.js` must reuse `readRows()` rather than counting non-empty lines. Otherwise a damaged log can make `agentsmd-status` report more telemetry rows than `agentsmd-audit` can parse.

Regression coverage lives in `scripts/tests/install.test.js`: `status telemetryRows counts parseable telemetry, not malformed lines`.
