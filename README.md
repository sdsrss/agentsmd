# agentsmd

**English · [中文](./README.zh-CN.md)**

> A coding-discipline spec for **OpenAI's Codex CLI**, made enforceable by native Codex hooks and kept honest by a rule-hit telemetry loop. It turns a spec the model can drift from into a system that actually holds — and it installs standalone, fully independent of oh-my-codex.

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/hooks-native%20Codex-blue) ![independent](https://img.shields.io/badge/independent%20of-oh--my--codex-orange)

> **Formerly `codexmd`.** The project was renamed to `agentsmd` in v2.0.0 to match its repository. Installing agentsmd automatically migrates a prior codexmd install — [details below](#upgrading-from-codexmd).

---

## What is agentsmd?

**agentsmd is a global coding-discipline spec for the Codex CLI that Codex's own hooks enforce.** The spec — `spec/AGENTS.md` (always-on core) plus `spec/AGENTS-extended.md` (loaded on demand) — defines a `CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT` workflow, level-based rigor, Iron Laws (no "done" without fresh evidence; no fix without a root cause), a §8 SAFETY floor, and honest four-section reporting. Native Codex hooks make the mechanical parts **non-optional**, and every rule-hit is logged so **data — not taste — decides which rules earn a place in the always-on layer.**

## Why hooks and telemetry, not just an `AGENTS.md`?

A spec file is only as strong as the model's willingness to follow it mid-session. The real cost of a long rule list is **attention dilution**: the more rules you write, the weaker each one's pull in the middle of a long task — and that cost is invisible to any token count.

agentsmd answers this the way a system does, not a document:

- **Hooks** turn the mechanical rules (block `rm -rf $VAR`, block unquantified commit-message claims, block a push onto a red-CI branch) into deterministic gates the model cannot talk its way past.
- **Telemetry** records every hit, so `agentsmd-rules` can show which always-on rules keep firing (they earn their place) and which never fire (they are pure dilution — demote them).

The point isn't saving tokens. **A rule nobody enforces and nobody triggers is pure attention dilution.** agentsmd exists to keep every rule enforceable and every always-on rule justified by data.

## What it enforces

Ten native hooks across all five Codex events. The blocking ones are hard gates; the Stop-time ones queue an advisory that surfaces at your next prompt.

| Hook | Event | Enforces |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY — blocks `rm -rf $VAR`, `curl \| bash`; warns on unpinned `npx` |
| `banned-vocab-check` | PreToolUse:Bash | §10 — blocks unquantified value claims in `git commit` messages |
| `ship-baseline-check` | PreToolUse:Bash | §E3 — blocks `git push` to a shared branch while its CI is red |
| `memory-read-check` | PreToolUse:Bash | §7 — blocks a ship when a project `MEMORY.md` was not consulted |
| `session-start-check` | SessionStart | injects the active-spec banner; resets the advisory queue |
| `surface-advisories` | UserPromptSubmit | surfaces advisories the Stop hooks queued last turn |
| `memory-prompt-hint` | UserPromptSubmit | surfaces `MEMORY.md` entries matching the prompt |
| `residue-audit` | Stop | §7/§9 — flags `~/.codex/tmp` growth |
| `sandbox-disposal-check` | Stop | §8.V4 — flags undisposed scratch dirs |
| `transcript-structure-scan` | Stop | §10 — checks four-section order + banned vocab in the last report |

Stop-hook advisories are queued and surfaced at the next `UserPromptSubmit` (the verified `additionalContext` channel), not emitted inline on Stop. Every hit is appended to `~/.codex/logs/agentsmd.jsonl`.

## Requirements

- **Codex CLI** with native hooks enabled — `config.toml` → `[features] hooks = true`. The installer sets this and migrates the pre-0.142 `codex_hooks` name automatically.
- **`jq`** and **`node` ≥ 18** on `PATH`.

Everything honors `$CODEX_HOME` (defaults to `~/.codex`).

## Install

### As a Codex plugin (recommended)

Point a Codex marketplace at this repo and add it. Codex auto-registers the `skills/` command layer and the plugin-root `hooks.json`, and manages the lifecycle for you.

### Manual (standalone, no marketplace)

```bash
node scripts/install.js     # merge into ~/.codex, set [features] hooks, inject the spec block
node scripts/status.js      # confirm: agentsmd hooks registered, other tenants preserved
node scripts/doctor.js      # health checks
```

Install is **idempotent** and preserves every other tenant's entries byte-for-byte.

## Update

Re-run the installer — it refreshes agentsmd's files, re-merges its hooks without duplication, and picks up any new spec. There is no separate update path to learn:

```bash
node scripts/install.js     # = update (idempotent); or: npm run spec:update
```

## Uninstall

```bash
node scripts/uninstall.js   # remove agentsmd; leave every other tenant byte-for-byte
```

Uninstall strips only agentsmd's own entries (hooks, skills, the `AGENTS.md` block, the install + state dirs) and, per §5, **leaves the `config.toml` hooks flag enabled** (removing it could break oh-my-codex or your own hooks).

### Upgrading from codexmd

If you previously installed **codexmd** (v1.4.0–v1.4.3), you don't need to do anything special: **running the agentsmd installer migrates you automatically.** It strips hooks under the old `CODEX_HOME/codexmd` install dir, the `# >>> codexmd >>>` `AGENTS.md` block, the `codexmd-*` skills, and `~/.codex/{codexmd, .codexmd-state}` — marker-scoped, so oh-my-codex and every other tenant are left untouched. The migration is a no-op if no codexmd install is present, and `uninstall` sweeps any codexmd remnant too.

## How is it independent of oh-my-codex?

agentsmd manages **only its own entries** in the shared `~/.codex/hooks.json`, `config.toml`, and `AGENTS.md`, identified by the active `CODEX_HOME/agentsmd` install-dir marker in hook commands and `# >>> agentsmd >>>` sentinels. It never reads, modifies, reorders, or depends on oh-my-codex (OMX) or any other tenant, and it installs cleanly whether or not OMX is present. If the shared `hooks.json` is ever unparseable, the installer **aborts rather than clobber** it — it may hold other tenants' hooks it cannot see. This is proven by `scripts/tests/install.test.js`, which asserts a byte-identical round-trip alongside a seeded OMX config.

OMX (if present) is an orchestration framework; agentsmd is the discipline/enforcement layer. They are complementary — and agentsmd does not depend on OMX.

## Governance — let data decide which rules stay

```bash
node scripts/audit.js --days=30    # aggregate rule-hit telemetry by spec section
node scripts/rules.js --days=30    # promote/demote signals vs spec/hard-rules.json
```

A hook-enforced rule with **zero hits** over a review window is always-on-layer dilution → a demote candidate. A high-hit rule justifies its place in the core. Operator cadence, size budget, and promote/demote gates live in `spec/OPERATOR.md`.

## Develop

```bash
npm test    # install/independence + closed-loop telemetry + drift + hook smoke suites
```

`scripts/tests/drift.test.js` is the CI gate that keeps `spec/`, `hard-rules.json`, both hook wirings, and the version in sync. Architecture and phase history: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Layout

```
spec/        canonical spec (core, extended, changelog, hard-rules.json, OPERATOR.md)
hooks/       L1 enforcement — the native hooks + shared lib + smoke test
scripts/     L2 management — install/uninstall/status/doctor/audit/rules (+ migrate + tests)
skills/      L3 command layer — agentsmd-audit/rules/doctor/status
.codex-plugin/plugin.json   Codex plugin manifest
hooks.json   plugin-root hook wiring (relative paths)
```

## FAQ

**Is agentsmd the same as codexmd?**
Yes. `codexmd` was the former name; the project was renamed to `agentsmd` in v2.0.0 to match its repository. Same system, same `CODEX-CODING-SPEC`; only the tool's identity changed. Existing codexmd installs are migrated automatically.

**Do I need oh-my-codex to use agentsmd?**
No. agentsmd installs and runs standalone. If OMX happens to be installed, the two coexist without touching each other's config.

**Does it work with plain OpenAI Codex CLI?**
Yes — it targets the Codex CLI's native hook system (`[features] hooks = true`, Codex 0.142+). It reads snake_case hook stdin and emits the Codex block/advisory/context JSON shapes.

**Will it modify my existing `~/.codex` config?**
Only its own marker-scoped entries, and it refuses to touch an unparseable `hooks.json`. Your model, profiles, and other plugins' entries are preserved byte-for-byte.

**How do I update or remove it?**
Update by re-running `node scripts/install.js` (idempotent). Remove with `node scripts/uninstall.js`, which leaves every other tenant untouched.

## License

MIT
