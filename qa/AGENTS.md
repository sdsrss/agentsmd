# QA contributor instructions

These rules add to the repository root guidance for `qa/`.

## Evidence classes

- Keep deterministic structural validation separate from a real Codex runtime, real model call, network, registry, or marketplace evidence. Never label one class as another.
- `bash qa/conformance-eval.sh --validate` checks the committed case library without model calls. A normal conformance run costs one real model call per selected case and is never part of `npm test`.
- `qa/codex-blackbox.sh` reads the installed runtime and performs real model calls. `qa/plugin-marketplace-e2e.sh` uses the network and public artifact flow; run it only at the documented release stage.
- Deterministic assertions grade model runs. Do not use a model to grade itself.

## Fixtures and captures

- Keep committed cases harmless if hooks fail open: use throwaway repositories, reserved domains, bounded paths, and fragmented secret-shaped fixtures.
- Tag QA telemetry with `AGENTSMD_TELEMETRY_TAG=qa` so governance denominators exclude it.
- Store sanitized runtime captures under ignored `docs/qa-captures/`; record runtime, model, agentsmd version, surface, case hash, and threshold hash when the harness supports them.
- Default to cleanup. A `--keep` option may preserve an explicitly named sandbox for investigation, but the final report must name it and it must never be mistaken for release evidence.
- Changes to cases require positive and safe-counterexample coverage, structural validation, and an explicit threshold decision; do not silently relax existing assertions.
