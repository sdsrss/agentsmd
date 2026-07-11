'use strict';
// perf-baseline.js — measure the wall-clock latency each native hook adds, so the
// per-turn cost is a MEASURED number, not a hand-waved estimate. For each hook it
// times, over N runs, the median of two modes:
//   OFF — DISABLE_AGENTSMD_HOOKS=1: the hook exits at its kill-switch line, so this
//         is the bash-spawn + startup floor (what the switch buys back);
//   ON  — normal env: the hook does its real work.
//   delta = ON - OFF = the hook's own logic cost above the spawn floor.
// Grouped by Codex event so you can read "latency added per Bash call"
// (PreToolUse:Bash) or "per Stop". Hooks run against a synthetic snake_case event
// (incl. a small transcript so Stop hooks do representative work) with an ISOLATED
// CODEX_HOME sandbox, so measuring writes NO telemetry/state to the live ~/.codex
// (§8.V3) and leaves nothing behind (§8.V4). Numbers are a LOWER bound: they
// exclude Codex's own harness IPC round-trip, and use a non-triggering `echo` Bash
// event (the common per-call case, not the block path). Ported in spirit from
// claudemd/scripts/perf-baseline.sh (bash→Node, for CLI + argv.js consistency).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const REG = require('./lib/hook-registry');
const { ArgvError, printHelpAndExit, parseStrict, parsePositiveInt } = require('./lib/argv');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const EVENTS = ['SessionStart', 'PreToolUse', 'UserPromptSubmit', 'Stop'];
const round1 = (x) => Math.round(x * 10) / 10;
const median = (nums) => { const s = [...nums].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// One spawn of a hook with the event on stdin; returns elapsed ms (hrtime).
function timeOne(hookPath, eventJson, env) {
  const start = process.hrtime.bigint();
  cp.spawnSync('bash', [hookPath], { input: eventJson, env, stdio: ['pipe', 'ignore', 'ignore'] });
  return Number(process.hrtime.bigint() - start) / 1e6;
}
function medianMs(hookPath, eventJson, env, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) times.push(timeOne(hookPath, eventJson, env));
  return median(times);
}
function groupTotals(results) {
  const g = {};
  for (const r of results) g[r.event] = round1((g[r.event] || 0) + r.on_ms);
  return g;
}

function perfBaseline({ runs = 10, event = null, sandbox } = {}) {
  // Synthetic transcript so Stop hooks reading transcript_path do representative
  // work instead of fail-opening on a missing path.
  const transcript = path.join(sandbox, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'user_message', payload: { input_text: 'do the thing' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'custom_tool_call', payload: { name: 'apply_patch' } }),
  ].join('\n') + '\n');
  const eventJson = JSON.stringify({
    session_id: 'perf-baseline', cwd: process.cwd(), transcript_path: transcript,
    tool_name: 'Bash', tool_input: { command: 'echo hi' }, prompt: 'do the thing',
  });
  const onEnv = { ...process.env, CODEX_HOME: sandbox };            // hooks write into the sandbox, never live ~/.codex
  const offEnv = { ...onEnv, DISABLE_AGENTSMD_HOOKS: '1' };         // kill-switch floor

  const hooks = REG.HOOK_REGISTRY.filter((h) => !event || h.hookEvent === event);
  const results = hooks.map((h) => {
    const hookPath = path.join(HOOKS_DIR, h.basename);
    const off = medianMs(hookPath, eventJson, offEnv, runs);
    const on = medianMs(hookPath, eventJson, onEnv, runs);
    return { hook: h.displayName, event: h.hookEvent, off_ms: round1(off), on_ms: round1(on), delta_ms: round1(Math.max(0, on - off)) };
  });
  return { runs, results, byEvent: groupTotals(results) };
}

function formatReport(r) {
  const L = [];
  L.push(`perf-baseline — median of ${r.runs} run(s) per hook (ms). OFF = kill-switch floor; ON = full; delta = hook logic cost.`);
  L.push('');
  L.push(`${'hook'.padEnd(28)}${'event'.padEnd(18)}${'off'.padStart(8)}${'on'.padStart(8)}${'delta'.padStart(8)}`);
  for (const x of r.results) {
    L.push(`${x.hook.padEnd(28)}${x.event.padEnd(18)}${String(x.off_ms).padStart(8)}${String(x.on_ms).padStart(8)}${String(x.delta_ms).padStart(8)}`);
  }
  L.push('');
  L.push('latency added per event firing (sum of ON medians):');
  for (const [ev, ms] of Object.entries(r.byEvent)) L.push(`  ${ev.padEnd(18)} ${ms} ms`);
  L.push('');
  L.push('Note: direct `bash hook` spawns, not the Codex harness round-trip -> a LOWER bound.');
  L.push('Measured against a non-triggering `echo` Bash event (the common per-call case).');
  return L.join('\n');
}

if (require.main === module) {
  const usage = 'Usage: agentsmd-perf-baseline [--runs=N] [--event=SessionStart|PreToolUse|UserPromptSubmit|Stop] [--json]';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try { opts = parseStrict(argv, { bools: ['json'], values: ['runs', 'event'] }); }
  catch (e) {
    if (e instanceof ArgvError) { console.error(`agentsmd perf-baseline: ${e.message}\n${usage}`); process.exit(2); }
    throw e;
  }
  let runs = 10;
  if (opts.values.runs !== undefined) {
    runs = parsePositiveInt(opts.values.runs);
    if (runs === null) { console.error(`agentsmd perf-baseline: invalid --runs value: ${opts.values.runs}\n${usage}`); process.exit(2); }
  }
  const event = opts.values.event || null;
  if (event && !EVENTS.includes(event)) { console.error(`agentsmd perf-baseline: unknown --event: ${event} (expected ${EVENTS.join('|')})\n${usage}`); process.exit(2); }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-perf-'));
  try {
    const r = perfBaseline({ runs, event, sandbox });
    console.log(opts.bools.has('json') ? JSON.stringify(r, null, 2) : formatReport(r));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true }); // §8.V4 sandbox disposal
  }
}
module.exports = { perfBaseline, formatReport, EVENTS, median };
