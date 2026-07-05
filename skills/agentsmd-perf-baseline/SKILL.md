---
name: agentsmd-perf-baseline
description: Measure the real wall-clock latency each native Codex hook adds to a turn — median over N runs of OFF (DISABLE_AGENTSMD_HOOKS kill-switch floor) vs ON (full run), grouped by event — so the per-turn hook cost is a measured number, not a hand-waved estimate. Use when the user asks how much latency the hooks add, whether a hook is slow, wants to benchmark hook overhead, or is weighing disabling a hook. Spawns hooks in an isolated CODEX_HOME sandbox (writes NO telemetry/state to the live ~/.codex); numbers are a lower bound (exclude Codex's harness round-trip). NOT a correctness check — use agentsmd-safety-coverage-audit / doctor for that.
---

# agentsmd-perf-baseline

Turns "the hooks add ~200–400 ms" (a guess) into a measured per-hook table. For each hook it times, over N runs, the median of **OFF** (`DISABLE_AGENTSMD_HOOKS=1` → the hook exits at its kill-switch line: bash-spawn + startup floor) vs **ON** (the hook does its real work); `delta = ON − OFF` is the hook's own logic cost.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/perf-baseline.js"                    # all 15 hooks, 10 runs
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/perf-baseline.js" --event=PreToolUse # just the per-Bash-call hooks
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/perf-baseline.js" --runs=3 --json
```

- **`latency added per event firing`** (sum of ON medians) is the number that matters: the 5 PreToolUse:Bash hooks fire on every Bash call; the 7 Stop hooks fire once per turn.
- Hooks run against a synthetic non-triggering `echo` Bash event (the common per-call case, not the block path), in an isolated sandbox `CODEX_HOME` — measuring never writes to the live `~/.codex` (§8.V3) and cleans up after itself (§8.V4).
- Numbers are a **lower bound**: direct `bash hook` spawns, not Codex's harness IPC round-trip.

Operator/dev tool, read-only on the live env. From the repo instead of an install: `node scripts/perf-baseline.js`.
