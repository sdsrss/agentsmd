# CODEX-CODING-SPEC — Operator handbook (human-facing)

**Not loaded into agent context.** This file holds the spec-maintenance rules that govern the human operator, not the agent. It is outside the Codex discovery chain (costs zero `project_doc_max_bytes`); the agent reads it only when explicitly collaborating on a spec release or an audit-cadence question — routine task loops never pull it in.

Companion files:
- `spec/AGENTS.md` — always-loaded agent core (Tier 0, per-turn gates).
- `spec/AGENTS-extended.md` — agent-loaded on L3 / ship / Override / three-strike (Tier 1).
- `spec/AGENTS-CHANGELOG.md` — shared changelog (agent reads on demand).
- `spec/hard-rules.json` — machine-readable mirror of every HARD rule (drives the tools below).
- `OPERATOR.md` (this file) — human-only maintenance handbook.

## §O1 The point of the machine

agentsmd's hooks + telemetry + this handbook connect selected detectable rules to operator review. Hook outcomes show what a detector observed; rule-specific eligible/evaluated rows bound the denominator. Neither zero hits nor high hits proves a rule's semantic value without reviewing the opportunities and rule text:

```
spec/AGENTS*.md (HARD) → hard-rules.json → hooks/*.sh + hooks/lib/*.sh → ~/.codex/logs/agentsmd.jsonl → scripts/audit.js → scripts/rules.js → promote/demote decision
```

## §O2 Operator responsibilities

- **Self-audit cadence**: every ~50 L2+ tasks OR 4 weeks, whichever first — run `node scripts/rules.js --days=30`. Review rule-specific eligible/evaluated sessions, enforcement outcomes, and self-enforced rules.
- **Demotion**: only a hook rule with enough distinct evaluated opportunities and 0 enforcement hits can become a candidate. `no-opportunity`, low-evaluation, global session counts, and raw 0 hits are not demotion evidence. The operator decides whether to move core→extended or remove the hook and stamps `last_demote_review`.
- **Promotion**: only promote a rule into core (or advisory→enforced) after BOTH ≥3 real repros across distinct sessions AND ≥20 real L2+ tasks since the last HARD addition. Either missing → log-only, no promotion. Adding rules without invocation data is how specs bloat.
- **Evidence-rebuttal shortcut**: an existing HARD rule shown (in session evidence) to produce wrong behavior → fix/remove that rule, do not wrap a new rule around it.
- **Drift monitoring**: `node scripts/doctor.js` must stay green (jq/node present, hooks executable, `[features] hooks=true`, hard-rules anchors resolve). A red anchor means the spec text moved without updating the manifest — fix in the same commit.
- **Keep the ledger clean**: exercise hooks against a sandbox `CODEX_HOME`, or set `AGENTSMD_TELEMETRY_TAG=test`; audit/rules exclude test-tagged rows by default. Untagged fixtures can inflate both rule-specific opportunities and outcomes.

## §O3 Size budget (the discovery-chain ceiling)

- Core (`spec/AGENTS.md`) loads into the Codex discovery chain **every turn**; extended loads only on trigger. The default 32 KiB `project_doc_max_bytes` cap is shared with project `AGENTS.md` files and truncates silently.
- Core is gated at ≤15 KiB so more than half the default cap remains for project chains. Track the exact size in the spec changelog.
- **Over budget → the next version MUST net-delete** (removal bytes > addition bytes) or refuse the addition. When a project chain starves, raise `project_doc_max_bytes` to 65536 in `config.toml` and verify the assembled chain (a "summarize your current instructions" run).
- Preserve hard safety/auth/evidence anchors in core; move expanded procedures to extended. Governance data informs later demotion but never substitutes for semantic review.

## §O4 Release discipline

- Let a minor version run through ≥20 real L2+ tasks before the next. Batch related patch fixes into one release rather than shipping each hotfix individually; reserve a same-day standalone patch for a live enforcement regression (a §8 hook broken on a platform), not for doc/telemetry polish.
- Core + extended carry ONE shared version and move together (since v1.4.0). On any HARD-rule add/remove, update `hard-rules.json` in the same commit; the Phase-5 CI drift test asserts every `section_anchor` still resolves — and (drift gate #5) that package.json, plugin.json, hard-rules `spec_version`, and BOTH spec headers (core + extended) match.
- **Post-publish self-install (feed the loop)**: after publish, update the operator install and require a green doctor so new hooks can emit their opportunity/outcome schema. A lagging install now reads `no-opportunity`, but still provides no evidence about the new rule.

## §O5 Tooling quick reference

| Task | Command |
|---|---|
| Aggregate rule-hit telemetry | `node scripts/audit.js --days=30` (add `--project=<substr>` to scope to one repo) |
| Promote/demote governance | `node scripts/rules.js --days=30` (`--project` = informational lens: per-rule local hits; demote stays cross-project) |
| Install state + OMX-coexistence | `node scripts/status.js` |
| Health checks | `node scripts/doctor.js` |
| Install / uninstall (§5-hard) | `node scripts/install.js` / `node scripts/uninstall.js` |
| Hook latency baseline / SLO gate | `node scripts/perf-baseline.js` (quick table) / `node scripts/perf-baseline.js --slo` (graded vs `qa/perf/slo.json`, §O9) |

## §O6 Two-tier + telemetry rationale

| Tier | File | Loaded by agent? | Content |
|---|---|---|---|
| 0 (always) | `spec/AGENTS.md` | every turn (discovery chain) | per-turn gates (SPINE / LEVEL / AUTH / VALIDATE / SAFETY) |
| 1 (triggered) | `spec/AGENTS-extended.md` | L3 / ship / Override / three-strike | conditional rules (Override modes, L3 flow, ship checklist, evidence ladder) |
| 2 (keyword) | `MEMORY.md` + `memory/*.md` | keyword/path match | recall-on-demand |
| operator | `OPERATOR.md` (this file) | **never auto-loaded** | human maintenance rules |

Codex ships no built-in three-tier loader; agentsmd's SessionStart hook + the extended-load trigger in the core header approximate it, and the telemetry loop is what keeps Tier 0 honest. Putting operator content in Tier 1 would burn agent context on directives it can't execute — hence this dedicated, never-loaded home.

## §O7 Measurement boundaries (what the loop can and can't see)

Two honesty caveats on the telemetry, so promote/demote data is not over-trusted:

- **Codex-only exposure.** Hooks cannot observe work in other agents/IDEs. Rule-specific `eligible`/`evaluated` rows prevent unrelated Codex sessions from becoming a false denominator, but they still describe Codex-mediated opportunities only. Corroborate ship-class decisions against the operator's real release path.
- **`@conv-*` measures citation, not adherence.** It has neither adherence evidence nor a per-anchor opportunity denominator. Zero and high cite counts are both review context, not standalone keep/prune decisions.

## §O8 Convention-adoption review cadence

The convention-adoption layer is advisory and structurally independent of the `§*` enforcement loop. Its report prompts manual review:

- **Convention citations lack a denominator.** `analyze --adoption` counts cites but does not yet record per-anchor evaluated opportunities. Treat zero cites as a manual review prompt, never sufficient evidence for automatic pruning.
- Do not prune from citation counts alone. Read the convention, inspect whether it affects current work, and remove it only from code/review evidence.
- **Baseline (2026-07-05).** Twenty events and zero cites established no adherence or opportunity conclusion.

## §O9 Performance SLO (hook hot path)

The N-01 incident defined the failure mode this SLO exists for: a hook whose own work approaches its registered Codex timeout does not degrade gracefully — it gets killed and **fails open**, silently, with no telemetry. The SLO therefore tracks headroom against each hook's timeout, not absolute machine speed.

**What is measured.** `node scripts/perf-baseline.js --slo` runs two surface configurations in an isolated sandbox (never the live `~/.codex`) and grades them against `qa/perf/slo.json`:

- `single` — one installed surface; the common case.
- `dual-warm` — standalone + plugin both registered, arbitration cache fresh: the losing copy must yield at jq cost. This is the long-term N-01 regression guard; a node spawn creeping back into the per-hook check fails the `dual-warm-pretooluse-overhead` criterion first.
- `dual-cold` (informational, `--surface=dual-cold`) — no cache: both copies do full work by design (fail-safe direction). Not graded; it is the documented one-session degradation window after cache invalidation.

Scope is the per-call hot path (`PreToolUse`) plus the per-turn events (`UserPromptSubmit`, `Stop`). `SessionStart` is out of scope: it fires once per session and legitimately pays the arbitration inspector.

**Criteria** (numbers live in `qa/perf/slo.json`; the file is the single source of truth):

1. `per-hook-p95-headroom` — every hook copy's ON p95 ≤ the configured fraction of its registered timeout (`scripts/lib/hook-registry.js`).
2. `dual-warm-pretooluse-overhead` — dual-warm PreToolUse p95 total (both copies) minus single total ≤ the configured cap.

**Noise discipline.** A single noisy number never fails the gate: the default run is ≥2 rounds × ≥15 runs/hook, each row keeps its best (lowest-p95) round, and if rounds disagree beyond `stability.max_round_p95_delta_fraction` the verdict is INCONCLUSIVE (exit 3) — re-run on a quiet machine instead of trusting either round. CI (`perf-baseline.test.js`) asserts shapes and grading logic only, never wall-clock values.

**Cadence.** Any change touching a hook hot path (a `hooks/*.sh` on PreToolUse, `hook-common.sh`, the arbitration cache read path, `hooks.json` timeouts) must include a `--slo` run in its validation evidence, comparing against `qa/perf/baseline.json`. Re-record the baseline on the reference machine whenever hook count, timeouts, or the yield mechanism change.

**Regression / waiver / investigation flow.**

1. `--slo` FAIL on a hot-path change → first re-run once (exit 3 discipline applies). A reproduced FAIL blocks the change unless waived.
2. Waiver = a `known-drop: <reason>` line in the commit body naming the failed criterion and the measured numbers (mirrors the spec's §7 metric-coupled evidence rule). A waiver without numbers is not a waiver.
3. Investigate with the per-hook table: `delta_ms` isolates hook logic from the spawn floor (`off_ms`); a jump confined to the `plugin` copy in dual-warm means the yield path regressed (check for new spawns in `hook_plugin_shadowed_by_standalone`); a uniform jump across hooks means the floor or the environment changed, not a hook.
4. Measured numbers are a LOWER bound (direct `bash` spawns, non-triggering `echo` event); the Codex harness round-trip and block-path recognizers add real-world cost on top. Treat headroom fractions accordingly — they are deliberately conservative.
