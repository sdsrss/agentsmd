verified: 2026-07-03 | source: hooks/lib/rule-hits.sh jq-less PATH fixture + hooks/tests/smoke.sh

# Telemetry Fallback JSON Escaping

`hooks/lib/rule-hits.sh` has two JSONL write paths:

- normal path: `jq -cn`
- fallback path: shell `printf` when `jq` is absent

The fallback path must escape backslash, double quote, newline, carriage return, and tab for string fields before embedding them in JSON. Escaping only `"` can produce malformed JSONL when an external hook field such as `session_id` contains `\`.

Regression coverage lives in `hooks/tests/smoke.sh`: `telemetry jq-less fallback writes valid JSON`.
