# Native hook contributor instructions

These rules add to root guidance for `hooks/`.

## Contracts and editing

- Start with `scripts/lib/hook-registry.js`, both manifests, the handler/helpers, and matching smoke cases.
- Current official Codex docs or a sanitized live capture define the external contract. Synthetic fixtures prove repository behavior only.
- Keep handlers bounded and fail open on missing prerequisites/internal observer failures. A deny needs a tested rule-specific reason and legal near-negative.
- Use physical-surface/state helpers from `hooks/lib/hook-common.sh`; never hardcode shared runtime paths.
- Key queued/consumed state by `session_id`; concurrent sessions must not share one advisory file.
- Telemetry may contain bounded reason/event/tool/exit data and repo-relative paths, never full prompts, commands, patches, output, secrets, or unbounded absolute paths.
- Keep Bash portable. Reuse bounded Node parsing where established.
- Update positive, deny/failure, fallback, and near-negative fixtures with a detector.
- Synchronize `hooks.json`, `hooks/hooks.json`, registry, kill switches, timeouts, and rule metadata when their shared contract changes.

## Validation

- Behavior: `bash hooks/tests/smoke.sh`; shell diagnostics: `npm run lint:shell`.
- Wiring: `node scripts/safety-coverage-audit.js`, hook-registry, and drift tests.
- Hot paths: targeted quick measurement while iterating, then `node scripts/perf-baseline.js --slo --json`; separate existing from introduced failures.
- Contract/surface/fallback changes also need the isolated real-runtime canary. Store sanitized captures under ignored `docs/qa-captures/`.
