# agentsmd contributor instructions

Repo facts only; nested files add directory rules.

## Source of truth

- `spec/AGENTS.md` is generated. Edit ordered fragments under `spec/source/**`, then run `npm run spec:generate` and `npm run spec:check`; never hand-edit the core.
- Keep `spec/AGENTS-extended.md`, `spec/hard-rules.json`, core anchors, and their version aligned.
- `scripts/lib/hook-registry.js` is the hook inventory; manifests are deployment wiring. Fixtures prove repository consistency, not the complete Codex contract.

## Repository map

- `bin/` dispatches the CLI; `spec/` holds source, generated core, workflow, and governance data.
- `hooks/` holds handlers/fixtures; `scripts/` holds lifecycle, tools, and tests; `skills/` routes workflows; `qa/` holds structural and opt-in runtime harnesses.
- `.codex-plugin/`, `.agents/`, `hooks.json`, and `install.sh` are distribution entry points.

## Change-to-validation map

- Spec/rule: generate + check, spec-source, drift, and `bash qa/conformance-eval.sh --validate`; behavior changes need selected real conformance evidence.
- Hooks/wiring: smoke, ShellCheck, safety coverage, registry/drift, `node scripts/perf-baseline.js --slo --json`, and a sanitized live fixture for contract changes.
- Lifecycle/ownership changes: relevant install, preflight, lock/journal, fault-injection, repair, backup, and distribution tests with an isolated home.
- Skills/CLI changes: skill-routing, argv, distribution, and command-specific tests.
- Broad shared changes and release candidates: `npm run check`.

An unavailable check or red baseline is not a pass; report it exactly.

## Live CODEX_HOME boundary

Development and tests must not modify the live `$CODEX_HOME`. Never validate lifecycle commands there. Set an isolated home for every spawn, clean it on exit, and keep `scripts/tests/live-guard.js` around `npm test`.

## Generated and local-only files

- Commit generated core only with canonical source and green drift evidence.
- `docs/` is ignored design/capture space, not shipped contracts; `tasks/` is ignored task state.
- `tmp/` is disposable: do not commit it and remove task-owned residue before handoff.
- Put durable fixtures beside tests or in tracked `qa/`.

## Code Review Rules

### Generated artifacts

- Flag when: `spec/AGENTS.md` is hand-edited or cannot be reproduced from `spec/source/**`.
- Safe path: edit fragments, generate, then pass spec-check and drift tests.
- Do not flag: a generated diff with its source change and fresh green drift evidence.

### Lifecycle ownership

- Flag when: lifecycle code overwrites/removes a path using prefix, directory name, or stale observation as ownership proof.
- Safe path: prove exact path, content hash, and manifest immediately before mutation; mismatch means zero mutation plus diagnosis.
- Do not flag: isolated-home fixtures or manifest-proven artifacts with rollback coverage.

### Hook contracts

- Flag when: event, matcher, input/output shape, timeout, or fallback changes without a current official reference plus positive, safe-counterexample, and sanitized live evidence.
- Safe path: update registry/wiring, smoke and near-negative fixtures, architecture, and canary together.
- Do not flag: internal refactors preserving the tested contract and parity fixtures.

### Hot-path performance

- Flag when: `PreToolUse`, `UserPromptSubmit`, or `Stop` work changes without before/after SLO data, or a red result is hidden by raising a limit/replacing a baseline.
- Safe path: report per-hook headroom, aggregate cost, available wall latency, and pre-existing red criteria separately.
- Do not flag: comments, fixtures, or management code that cannot execute in hot-path events.

## Release-only requirements

Release work needs explicit ship intent. Load `spec/AGENTS-extended.md`; run the full local gate, two declared-runtime/model conformance passes, formal SLO, package/version/drift checks, and marketplace E2E at its post-publish stage. Never use registry mutations as development validation or weaken thresholds.
