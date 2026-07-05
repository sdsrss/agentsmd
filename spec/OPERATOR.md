# CODEX-CODING-SPEC — Operator handbook (human-facing)

**Not loaded into agent context.** This file holds the spec-maintenance rules that govern the human operator, not the agent. It is outside the Codex discovery chain (costs zero `project_doc_max_bytes`); the agent reads it only when explicitly collaborating on a spec release or an audit-cadence question — routine task loops never pull it in.

Companion files:
- `spec/AGENTS.md` — always-loaded agent core (Tier 0, per-turn gates).
- `spec/AGENTS-extended.md` — agent-loaded on L3 / ship / Override / three-strike (Tier 1).
- `spec/AGENTS-CHANGELOG.md` — shared changelog (agent reads on demand).
- `spec/hard-rules.json` — machine-readable mirror of every HARD rule (drives the tools below).
- `OPERATOR.md` (this file) — human-only maintenance handbook.

## §O1 The point of the machine

agentsmd's hooks + telemetry + this handbook exist for ONE reason: **keep every rule enforceable, and let data — not taste — decide which rules stay in the always-on layer.** A rule that no one triggers and no hook enforces is pure attention dilution. The closed loop (ARCHITECTURE.md §4) makes that measurable:

```
spec/AGENTS*.md (HARD) → hard-rules.json → hooks/*.sh → ~/.codex/logs/agentsmd.jsonl → scripts/audit.js → scripts/rules.js → promote/demote decision
```

## §O2 Operator responsibilities

- **Self-audit cadence**: every ~50 L2+ tasks OR 4 weeks, whichever first — run `node scripts/rules.js --days=30`. Review demote-candidates (hook-enforced rules with 0 enforcement hits) and self-enforced rules for continued relevance.
- **Demotion**: a hook-enforced rule with 0 hits across a full review window is an always-on dilution source → move it from core to extended (Tier 0 → Tier 1) at zero behavioral cost, or drop the hook. Update `hard-rules.json` (`last_demote_review` date) in the same edit.
- **Promotion**: only promote a rule into core (or advisory→enforced) after BOTH ≥3 real repros across distinct sessions AND ≥20 real L2+ tasks since the last HARD addition. Either missing → log-only, no promotion. Adding rules without invocation data is how specs bloat.
- **Evidence-rebuttal shortcut**: an existing HARD rule shown (in session evidence) to produce wrong behavior → fix/remove that rule, do not wrap a new rule around it.
- **Drift monitoring**: `node scripts/doctor.js` must stay green (jq/node present, hooks executable, `[features] hooks=true`, hard-rules anchors resolve). A red anchor means the spec text moved without updating the manifest — fix in the same commit.
- **Keep the ledger clean**: exercise hooks against a sandbox `CODEX_HOME` (as `hooks/tests/smoke.sh` does), or export `AGENTSMD_TELEMETRY_TAG=test` so verification rows carry a `tag` and `audit`/`rules` drop them by default (`--include-test` to include). Untagged verify runs against the live `~/.codex` skew the promote/demote signal and the session-exposure count — treat a spike in `sessionCount` with no real work as sandbox leakage. The exposure gate (`rules.js` `MIN_EXPOSURE_SESSIONS`) already suppresses demotes on thin windows; tagging keeps the count itself honest. `audit --days=N` prints a `skipped:` line when it drops test-tagged or unparseable-ts rows.

## §O3 Size budget (the discovery-chain ceiling)

- Core (`spec/AGENTS.md`) loads into the Codex discovery chain **every turn**; extended loads only on trigger (zero standing budget). The chain has a `project_doc_max_bytes` cap (default 32 KiB) shared with project `AGENTS.md` files, and **truncation past the cap is silent**.
- Current core ≈ 24 KB (~74% of the default cap; ~8 KB headroom for project chains). Track the exact size in the `Sizing` line of the changelog on every release.
- **Over budget → the next version MUST net-delete** (removal bytes > addition bytes) or refuse the addition. When a project chain starves, raise `project_doc_max_bytes` to 65536 in `config.toml` and verify the assembled chain (a "summarize your current instructions" run).
- Deep static compression is the WRONG first move (it trades behavior anchors for bytes). The RIGHT move is §O2 demotion driven by `scripts/rules.js` data.

## §O4 Release discipline

- Let a minor version run through ≥20 real L2+ tasks before the next. Batch related patch fixes into one release rather than shipping each hotfix individually; reserve a same-day standalone patch for a live enforcement regression (a §8 hook broken on a platform), not for doc/telemetry polish.
- Core + extended carry ONE shared version and move together (since v1.4.0). On any HARD-rule add/remove, update `hard-rules.json` in the same commit; the Phase-5 CI drift test asserts every `section_anchor` still resolves — and (drift gate #5) that package.json, plugin.json, hard-rules `spec_version`, and BOTH spec headers (core + extended) match.
- **Post-publish self-install (feed the loop)**: after `npm publish` + tag, run `node scripts/install.js` on your own machine and confirm `node scripts/doctor.js` is green — hook count matches the release, spec headers current. The telemetry closed loop starves when the operator's own Codex install lags the published version: a lagging install emits no field data for the new hooks, so `rules.js` sees 0 hits on sections that are simply not deployed yet and mislabels them dilution. Green doctor = the loop is actually running the version you shipped.

## §O5 Tooling quick reference

| Task | Command |
|---|---|
| Aggregate rule-hit telemetry | `node scripts/audit.js --days=30` (add `--project=<substr>` to scope to one repo) |
| Promote/demote governance | `node scripts/rules.js --days=30` (`--project` = informational lens: per-rule local hits; demote stays cross-project) |
| Install state + OMX-coexistence | `node scripts/status.js` |
| Health checks | `node scripts/doctor.js` |
| Install / uninstall (§5-hard) | `node scripts/install.js` / `node scripts/uninstall.js` |

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

- **Codex-only exposure.** Every hook fires inside Codex; the loop is blind to work done in other agents/IDEs. Ship-family rules (`§E3-ship-baseline`, `§7-memory-read`) fire only on a Codex-mediated `git push`/commit — a maintainer who ships mostly from another tool sees those rules read 0 hits (→ `insufficient-exposure`, or above the exposure floor a *false* `demote-candidate`) purely because Codex never observed the ship. Read a demote verdict as "dead weight *in Codex workflows*", not "everywhere"; corroborate ship-class rules against how you actually ship before demoting one.
- **`@conv-*` measures citation, not adherence.** The adoption loop counts when your output NAMES a `@conv-<dim>` anchor — a proxy. The citation instruction can induce ceremonial naming (Goodhart), and following a convention WITHOUT citing it records nothing. So 0 cites → "nobody is visibly leaning on this dimension" (a sound prune signal — it isn't paying its context rent), but a high cite count does NOT prove the code follows it. Prune on the negative; never certify quality on the positive.
