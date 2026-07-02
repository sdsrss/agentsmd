# codexmd

A global **coding-discipline spec for Codex**, enforced by native Codex hooks and kept honest by a rule-hit telemetry loop. It turns a spec the model can drift from into a system that actually holds.

> The point isn't saving tokens. A rule nobody enforces and nobody triggers is pure attention dilution. codexmd's hooks + telemetry + governance exist to keep every rule enforceable, and to let **data** — not taste — decide which rules stay in the always-on layer.

## What it enforces

`spec/AGENTS.md` (the always-on core) + `spec/AGENTS-extended.md` (loaded on L3/ship/override) define the discipline: a `CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT` spine, level classification, Iron Laws (no "done" without fresh evidence; no fix without root cause), §8 SAFETY, honest four-section reports. Native hooks make the mechanical parts non-optional:

| Hook | Event | Enforces |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY — blocks `rm -rf $VAR`, `curl \| bash`; warns on unpinned `npx` |
| `banned-vocab-check` | PreToolUse:Bash | §10 — blocks unquantified value claims in `git commit` messages |
| `ship-baseline-check` | PreToolUse:Bash | §E3 — blocks `git push` to a shared branch when its CI is red |
| `session-start-check` | SessionStart | injects the active-spec banner |
| `residue-audit` | Stop | §7/§9 — flags `~/.codex/tmp` growth |
| `sandbox-disposal-check` | Stop | §8.V4 — flags undisposed scratch dirs |
| `transcript-structure-scan` | Stop | §10 — checks four-section order + banned vocab in the last report |

Every hit is logged to `~/.codex/logs/codexmd.jsonl`; `codexmd-rules` reads it to surface which always-on rules earn their place and which are demote candidates (the closed loop — see `ARCHITECTURE.md §4`).

## Requirements

Codex CLI with native hooks (`config.toml → [features] codex_hooks = true`; the installer sets it) + `jq` + `node`.

## Install

**As a Codex plugin** (recommended): publish/point a marketplace at this repo, then add it — Codex auto-registers `skills/` and the plugin `hooks.json`, and manages its lifecycle.

**Manual** (works standalone, no marketplace):

```bash
node scripts/install.js     # merge into ~/.codex, set codex_hooks, inject the spec block
node scripts/status.js      # confirm: codexmd hooks registered, other tenants preserved
node scripts/doctor.js      # health checks
node scripts/uninstall.js   # clean removal — leaves every other tenant byte-for-byte
```

Honors `$CODEX_HOME` (defaults to `~/.codex`).

## Independent of oh-my-codex

codexmd manages **only its own entries** in the shared `~/.codex/hooks.json`, `config.toml`, and `AGENTS.md` (identified by a `/codexmd/` path marker and `# >>> codexmd >>>` sentinels). It never reads, modifies, reorders, or depends on oh-my-codex or any other tenant, and installs cleanly whether or not OMX is present. Proven by `scripts/tests/install.test.js` (byte-identical round-trip alongside a seeded OMX config).

## Governance

```bash
node scripts/audit.js --days=30    # aggregate rule-hit telemetry by spec section
node scripts/rules.js --days=30    # promote/demote signals vs spec/hard-rules.json
```

Operator cadence, size budget, and promote/demote gates: `spec/OPERATOR.md`.

## Develop

```bash
npm test    # install/independence + closed-loop + drift + hook smoke suites
```

`scripts/tests/drift.test.js` is the CI gate keeping `spec/`, `hard-rules.json`, both hook wirings, and the version in sync. Architecture + phase history: `ARCHITECTURE.md`.

## Layout

```
spec/        canonical spec (core, extended, changelog, hard-rules.json, OPERATOR.md)
hooks/       L1 enforcement (7 hooks + lib + smoke test)
scripts/     L2 management (install/uninstall/status/doctor/audit/rules + tests)
skills/      L3 command layer (codexmd-audit/rules/doctor/status)
.codex-plugin/plugin.json   Codex plugin manifest
hooks.json   plugin-root hook wiring (relative paths)
```
