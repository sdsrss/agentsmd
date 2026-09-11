---
name: agentsmd-perf-baseline
description: Benchmark native hook wall-clock cost with OFF/ON medians in an isolated CODEX_HOME. Use for latency or disablement decisions. Not for correctness, install health, or live telemetry.
---

# agentsmd-perf-baseline

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Turns "the hooks add ~200–400 ms" (a guess) into a measured per-hook table. For each hook it times, over N runs, the median of **OFF** (`DISABLE_AGENTSMD_HOOKS=1` → the hook exits at its kill-switch line: bash-spawn + startup floor) vs **ON** (the hook does its real work); `delta = ON − OFF` is the hook's own logic cost.

```bash
agentsmd_skill_run                    # all 19 hooks, 10 runs
agentsmd_skill_run --event=PreToolUse # all registered PreToolUse hooks
agentsmd_skill_run --runs=3 --json
```

- Report **concurrent event wall time** separately from **aggregate process cost** (the sum of separately measured ON medians). The registry has 5 PreToolUse:Bash hooks and 8 Stop hooks; the event-wide benchmark also includes the PreToolUse edit-journal entry, so it is not an exact Bash-matcher measurement.
- Hooks run against a synthetic non-triggering `echo` Bash event (the common per-call case, not the block path), in an isolated sandbox `CODEX_HOME` — measuring never writes to the live `~/.codex` (§8.V3) and cleans up after itself (§8.V4).
- Synthetic measurements exclude Codex's harness IPC, model time, and real long-transcript or blocking paths. Do not turn aggregate cost or an event-wide group into measured end-to-end user latency.

Operator/dev tool, read-only on the live env. From the repo instead of an install: `node scripts/perf-baseline.js`.
