verified: 2026-07-11 | source: scripts/audit.js boundary fixture + scripts/tests/audit.test.js

# Audit Time Window

`scripts/audit.js` backs both `agentsmd-audit` and `agentsmd-rules`.

For parseable telemetry timestamps, the review window is inclusive of the exact cutoff and inclusive of `now`: `[now - days * 86400000, now]`.

Rows dated after `now` must be excluded from the current window, because `audit --days=N` is a past-window report. Counting future timestamps can skew `rules.js` promote/demote signals.

Rows with unparseable timestamps are counted separately and excluded from the
window. Retaining them in aggregation would make a garbage timestamp permanent
and could distort exposure and governance signals.
