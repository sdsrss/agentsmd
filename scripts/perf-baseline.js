'use strict';
// perf-baseline.js — measure the wall-clock latency each native hook adds, so the
// per-turn cost is a MEASURED number, not a hand-waved estimate. For each hook it
// times, over N runs, two modes:
//   OFF — DISABLE_AGENTSMD_HOOKS=1: the hook exits at its kill-switch line, so this
//         is the bash-spawn + startup floor (what the switch buys back);
//   ON  — normal env: the hook does its real work.
//   delta = ON(p50) - OFF(p50) = the hook's own logic cost above the spawn floor.
// Grouped by Codex event so you can read "latency added per Bash call"
// (PreToolUse:Bash) or "per Stop". Hooks run against a synthetic snake_case event
// (incl. a small transcript so Stop hooks do representative work) with an ISOLATED
// CODEX_HOME sandbox, so measuring writes NO telemetry/state to the live ~/.codex
// (§8.V3) and leaves nothing behind (§8.V4). Numbers are a LOWER bound: they
// exclude Codex's own harness IPC round-trip, and use a non-triggering `echo` Bash
// event (the common per-call case, not the block path). Ported in spirit from
// claudemd/scripts/perf-baseline.sh (bash→Node, for CLI + argv.js consistency).
//
// R6-02 (performance SLO) extends the E1 tool with:
//   --surface=single|dual-warm|dual-cold — single is the classic repo-hooks run;
//     the dual surfaces install a standalone copy into the sandbox CODEX_HOME and
//     time BOTH physical hook copies per event (what a dual-surface user pays per
//     firing). dual-warm has a fresh arbitration cache (the losing plugin copy
//     yields — N-01's steady state); dual-cold deletes it (both copies do full
//     work — the documented degraded window).
//   p95_ms per row + byEventP95 totals (p95 sums are conservative: a sum of p95s,
//     not the p95 of sums).
//   --slo [--rounds=N] — run single + dual-warm and grade against qa/perf/slo.json.
//     Multi-round runs keep each row's best (lowest-p95) round, so one noisy run
//     never fails the gate by itself; cross-round instability beyond the configured
//     fraction makes the verdict INCONCLUSIVE (exit 3) instead of pass/fail.
//     Exit codes: 0 pass · 1 SLO violated · 2 usage · 3 inconclusive (re-run).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const REG = require('./lib/hook-registry');
const { ArgvError, printHelpAndExit, parseStrict, parsePositiveInt } = require('./lib/argv');

const REPO_ROOT = path.join(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const EVENTS = ['SessionStart', 'PreToolUse', 'UserPromptSubmit', 'Stop'];
const SURFACES = ['single', 'dual-warm', 'dual-cold'];
const SLO_CONFIG_PATH = path.join(REPO_ROOT, 'qa', 'perf', 'slo.json');

const round1 = (x) => Math.round(x * 10) / 10;
const median = (nums) => { const s = [...nums].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Nearest-rank percentile: with runs=1 p95 == the single sample == p50.
const percentile = (nums, p) => { const s = [...nums].sort((a, b) => a - b); return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]; };

// One spawn of a hook with the event on stdin; returns elapsed ms (hrtime).
function timeOne(hookPath, eventJson, env) {
  const start = process.hrtime.bigint();
  cp.spawnSync('bash', [hookPath], { input: eventJson, env, stdio: ['pipe', 'ignore', 'ignore'] });
  return Number(process.hrtime.bigint() - start) / 1e6;
}
function statsMs(hookPath, eventJson, env, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) times.push(timeOne(hookPath, eventJson, env));
  return { p50: median(times), p95: percentile(times, 95) };
}
function eventTotals(results, field) {
  const g = {};
  for (const r of results) g[r.event] = round1((g[r.event] || 0) + r[field]);
  return g;
}

// Synthetic transcript so Stop hooks reading transcript_path do representative
// work instead of fail-opening on a missing path.
function syntheticEventJson(sandbox) {
  const transcript = path.join(sandbox, 'transcript.jsonl');
  if (!fs.existsSync(transcript)) {
    fs.writeFileSync(transcript, [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'user_message', payload: { input_text: 'do the thing' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01Z', type: 'custom_tool_call', payload: { name: 'apply_patch' } }),
    ].join('\n') + '\n');
  }
  return JSON.stringify({
    session_id: 'perf-baseline', cwd: process.cwd(), transcript_path: transcript,
    tool_name: 'Bash', tool_input: { command: 'echo hi' }, prompt: 'do the thing',
  });
}

// Build (idempotently) the dual-surface fixture inside the sandbox: a real
// standalone install under <sandbox>/dual-home plus the repo checkout acting as
// the plugin bundle. Setup cost is OUTSIDE the measured window. Same-version
// standalone vs plugin arbitrates to standalone (deterministic), so dual-warm
// measures winner-full-work + loser-yield — exactly N-01's steady state.
function setupDualHome(sandbox, cold) {
  const home = path.join(sandbox, 'dual-home');
  const manifest = path.join(home, '.agentsmd-state', 'manifest.json');
  const cache = path.join(home, '.agentsmd-state', 'arbitration-cache.json');
  if (!fs.existsSync(manifest)) {
    fs.mkdirSync(home, { recursive: true });
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'install.js')],
      { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`dual-surface setup: sandbox install failed\n${(r.stderr || '').trim()}`);
  }
  if (cold) { fs.rmSync(cache, { force: true }); return home; }
  cp.spawnSync(process.execPath, [path.join(__dirname, 'lib', 'surface-arbitration.js'), '--hook-json'],
    { env: { ...process.env, CODEX_HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, stdio: 'ignore' });
  let selected = null;
  try { selected = JSON.parse(fs.readFileSync(cache, 'utf8')).selection.selected; } catch { /* handled below */ }
  if (selected !== 'standalone') {
    throw new Error(`dual-surface setup: expected arbitration to select standalone, got ${selected === null ? 'no cache' : selected} (is a codex CLI resolvable on PATH?)`);
  }
  return home;
}

// perfBaseline measures ONE surface configuration.
function perfBaseline({ runs = 10, event = null, sandbox, surface = 'single' } = {}) {
  const eventJson = syntheticEventJson(sandbox);
  let copies;
  if (surface === 'single') {
    copies = [{ copy: 'repo', hooksDir: HOOKS_DIR, env: { ...process.env, CODEX_HOME: sandbox } }];
  } else {
    const home = setupDualHome(sandbox, surface === 'dual-cold');
    const dualEnv = { ...process.env, CODEX_HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT };
    copies = [
      { copy: 'standalone', hooksDir: path.join(home, 'agentsmd', 'hooks'), env: dualEnv },
      { copy: 'plugin', hooksDir: HOOKS_DIR, env: dualEnv },
    ];
  }
  const hooks = REG.HOOK_REGISTRY.filter((h) => !event || h.hookEvent === event);
  const results = [];
  for (const c of copies) {
    const offEnv = { ...c.env, DISABLE_AGENTSMD_HOOKS: '1' };
    for (const h of hooks) {
      const hookPath = path.join(c.hooksDir, h.basename);
      const off = statsMs(hookPath, eventJson, offEnv, runs);
      const on = statsMs(hookPath, eventJson, c.env, runs);
      results.push({
        hook: h.displayName, event: h.hookEvent, copy: c.copy,
        off_ms: round1(off.p50), on_ms: round1(on.p50), delta_ms: round1(Math.max(0, on.p50 - off.p50)),
        p95_ms: round1(on.p95), timeout_budget_ms: h.timeout * 1000,
      });
    }
  }
  return { runs, surface, results, byEvent: eventTotals(results, 'on_ms'), byEventP95: eventTotals(results, 'p95_ms') };
}

// ── SLO mode (R6-02) ─────────────────────────────────────────────────────────

function loadSloConfig(p = SLO_CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (cfg.schemaVersion !== 1) throw new Error(`unsupported slo.json schemaVersion: ${cfg.schemaVersion}`);
  return cfg;
}

function envFingerprint() {
  const cpus = os.cpus();
  return {
    platform: os.platform(), release: os.release(), arch: os.arch(),
    cpu: cpus[0] ? cpus[0].model : 'unknown', cores: cpus.length,
    node: process.version, agentsmd: require('../package.json').version,
    generatedAt: new Date().toISOString(),
  };
}

// Keep, per (copy, hook), the row from its best (lowest-p95) round — one noisy
// round must not fail the gate on its own. Per-round event totals are retained
// for the stability check.
function combineRounds(rounds) {
  const byKey = new Map();
  for (const r of rounds) {
    for (const row of r.results) {
      const k = `${row.copy}:${row.hook}`;
      const prev = byKey.get(k);
      if (!prev || row.p95_ms < prev.p95_ms) byKey.set(k, row);
    }
  }
  const results = [...byKey.values()];
  return {
    runs: rounds[0].runs, surface: rounds[0].surface, rounds: rounds.length, results,
    byEvent: eventTotals(results, 'on_ms'), byEventP95: eventTotals(results, 'p95_ms'),
    roundEventP95: rounds.map((r) => r.byEventP95),
  };
}

function stabilityCheck(roundEventP95, maxFraction) {
  const perEvent = {};
  let stable = true;
  const events = new Set(roundEventP95.flatMap((m) => Object.keys(m)));
  for (const ev of events) {
    const vals = roundEventP95.map((m) => m[ev]).filter((v) => typeof v === 'number' && v > 0);
    if (vals.length < 2) continue;
    const frac = Math.max(...vals) / Math.min(...vals) - 1;
    perEvent[ev] = Math.round(frac * 100) / 100;
    if (frac > maxFraction) stable = false;
  }
  return { stable, maxFraction, roundDeltaFractionByEvent: perEvent };
}

function evaluateSlo(single, dualWarm, slo) {
  const criteria = [];
  const scope = new Set(slo.scope_events);

  // C1 — every hook copy's ON p95 stays inside its share of the registered
  // per-hook Codex timeout. Blowing this budget is how N-01 turned into
  // systematic fail-open, so headroom (not just "under timeout") is the SLO.
  const violations = [];
  for (const { surface, data } of [{ surface: 'single', data: single }, { surface: 'dual-warm', data: dualWarm }]) {
    for (const row of data.results) {
      if (!scope.has(row.event)) continue;
      const limit = round1(row.timeout_budget_ms * slo.per_hook_p95_max_fraction_of_timeout);
      if (row.p95_ms > limit) violations.push({ surface, copy: row.copy, hook: row.hook, p95_ms: row.p95_ms, limit_ms: limit });
    }
  }
  criteria.push({
    id: 'per-hook-p95-headroom', pass: violations.length === 0,
    limit: `on p95 <= ${slo.per_hook_p95_max_fraction_of_timeout} x hook timeout (scope: ${slo.scope_events.join(', ')})`,
    violations,
  });

  // C2 — the long-term N-01 regression guard: with a warm arbitration cache the
  // dual-surface PreToolUse total (both copies) may exceed single-surface only by
  // the cheap jq-based yield cost. A node spawn creeping back into the hot path
  // shows up here first.
  const singleTotal = single.byEventP95.PreToolUse || 0;
  const dualTotal = dualWarm.byEventP95.PreToolUse || 0;
  const overhead = round1(dualTotal - singleTotal);
  criteria.push({
    id: 'dual-warm-pretooluse-overhead', pass: overhead <= slo.dual_warm_pretooluse.max_total_p95_overhead_ms,
    measured: { single_total_p95_ms: singleTotal, dual_warm_total_p95_ms: dualTotal, overhead_ms: overhead },
    limit_ms: slo.dual_warm_pretooluse.max_total_p95_overhead_ms,
  });

  return { pass: criteria.every((c) => c.pass), criteria };
}

function runSlo({ runs, rounds, event, sandbox }) {
  const slo = loadSloConfig();
  const measure = (surface) => {
    const all = [];
    for (let i = 0; i < rounds; i++) all.push(perfBaseline({ runs, event, sandbox, surface }));
    return combineRounds(all);
  };
  const single = measure('single');
  const dualWarm = measure('dual-warm');
  const stability = {
    single: stabilityCheck(single.roundEventP95, slo.stability.max_round_p95_delta_fraction),
    'dual-warm': stabilityCheck(dualWarm.roundEventP95, slo.stability.max_round_p95_delta_fraction),
  };
  const graded = evaluateSlo(single, dualWarm, slo);
  const inconclusive = rounds > 1 && (!stability.single.stable || !stability['dual-warm'].stable);
  return {
    mode: 'slo', runs, rounds, env: envFingerprint(),
    slo: { ...graded, inconclusive }, stability,
    surfaces: { single, 'dual-warm': dualWarm },
  };
}

// ── reports ──────────────────────────────────────────────────────────────────

function formatReport(r) {
  const dual = r.surface && r.surface !== 'single';
  const L = [];
  L.push(`perf-baseline — ${r.runs} run(s) per hook (ms), surface=${r.surface || 'single'}. OFF = kill-switch floor; ON = full (p50); delta = hook logic cost; p95 = ON p95.`);
  L.push('');
  L.push(`${'hook'.padEnd(28)}${dual ? 'copy'.padEnd(12) : ''}${'event'.padEnd(18)}${'off'.padStart(8)}${'on'.padStart(8)}${'delta'.padStart(8)}${'p95'.padStart(8)}`);
  for (const x of r.results) {
    L.push(`${x.hook.padEnd(28)}${dual ? x.copy.padEnd(12) : ''}${x.event.padEnd(18)}${String(x.off_ms).padStart(8)}${String(x.on_ms).padStart(8)}${String(x.delta_ms).padStart(8)}${String(x.p95_ms).padStart(8)}`);
  }
  L.push('');
  L.push(`latency added per event firing (${dual ? 'BOTH copies, ' : ''}sum of ON p50 | sum of ON p95):`);
  for (const [ev, ms] of Object.entries(r.byEvent)) L.push(`  ${ev.padEnd(18)} ${ms} ms | ${r.byEventP95[ev]} ms`);
  L.push('');
  L.push('Note: direct `bash hook` spawns, not the Codex harness round-trip -> a LOWER bound.');
  L.push('Measured against a non-triggering `echo` Bash event (the common per-call case).');
  return L.join('\n');
}

function formatSloReport(r) {
  const L = [];
  L.push(`perf-slo — ${r.rounds} round(s) x ${r.runs} run(s)/hook; per-row best (lowest-p95) round kept.`);
  L.push(`env: ${r.env.cpu} x${r.env.cores}, ${r.env.platform} ${r.env.arch}, node ${r.env.node}, agentsmd ${r.env.agentsmd}`);
  for (const s of ['single', 'dual-warm']) {
    L.push('');
    L.push(`── surface: ${s} ──`);
    L.push(formatReport(r.surfaces[s]));
    const st = r.stability[s];
    if (r.rounds > 1) L.push(`stability: ${st.stable ? 'stable' : 'UNSTABLE'} (max round p95 delta fraction ${st.maxFraction}; per event: ${JSON.stringify(st.roundDeltaFractionByEvent)})`);
  }
  L.push('');
  L.push('── SLO verdicts ──');
  for (const c of r.slo.criteria) {
    L.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id}`);
    if (c.violations && c.violations.length) for (const v of c.violations) L.push(`         ${v.surface}/${v.copy}/${v.hook}: p95 ${v.p95_ms} ms > limit ${v.limit_ms} ms`);
    if (c.measured) L.push(`         single ${c.measured.single_total_p95_ms} ms -> dual-warm ${c.measured.dual_warm_total_p95_ms} ms (overhead ${c.measured.overhead_ms} ms, limit ${c.limit_ms} ms)`);
  }
  L.push('');
  L.push(r.slo.inconclusive
    ? 'VERDICT: INCONCLUSIVE — rounds disagree beyond the stability tolerance; re-run on a quiet machine (exit 3).'
    : `VERDICT: ${r.slo.pass ? 'PASS' : 'FAIL'} (see spec/OPERATOR.md §O9 for the regression/waiver flow).`);
  return L.join('\n');
}

if (require.main === module) {
  const usage = 'Usage: agentsmd-perf-baseline [--runs=N] [--event=SessionStart|PreToolUse|UserPromptSubmit|Stop] [--surface=single|dual-warm|dual-cold] [--slo] [--rounds=N] [--json]';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try { opts = parseStrict(argv, { bools: ['json', 'slo'], values: ['runs', 'event', 'surface', 'rounds'] }); }
  catch (e) {
    if (e instanceof ArgvError) { console.error(`agentsmd perf-baseline: ${e.message}\n${usage}`); process.exit(2); }
    throw e;
  }
  const slo = opts.bools.has('slo');
  let sloDefaults = null;
  if (slo) {
    try { sloDefaults = loadSloConfig(); }
    catch (e) { console.error(`agentsmd perf-baseline: cannot load ${SLO_CONFIG_PATH}: ${e.message}`); process.exit(2); }
  }
  let runs = slo ? sloDefaults.baseline_runs : 10;
  if (opts.values.runs !== undefined) {
    runs = parsePositiveInt(opts.values.runs);
    if (runs === null) { console.error(`agentsmd perf-baseline: invalid --runs value: ${opts.values.runs}\n${usage}`); process.exit(2); }
  }
  let rounds = slo ? sloDefaults.baseline_rounds : 1;
  if (opts.values.rounds !== undefined) {
    if (!slo) { console.error(`agentsmd perf-baseline: --rounds requires --slo\n${usage}`); process.exit(2); }
    rounds = parsePositiveInt(opts.values.rounds);
    if (rounds === null) { console.error(`agentsmd perf-baseline: invalid --rounds value: ${opts.values.rounds}\n${usage}`); process.exit(2); }
  }
  const event = opts.values.event || null;
  if (event && !EVENTS.includes(event)) { console.error(`agentsmd perf-baseline: unknown --event: ${event} (expected ${EVENTS.join('|')})\n${usage}`); process.exit(2); }
  const surface = opts.values.surface || 'single';
  if (!SURFACES.includes(surface)) { console.error(`agentsmd perf-baseline: unknown --surface: ${surface} (expected ${SURFACES.join('|')})\n${usage}`); process.exit(2); }
  if (slo && opts.values.surface !== undefined) { console.error(`agentsmd perf-baseline: --slo measures single + dual-warm itself; --surface conflicts\n${usage}`); process.exit(2); }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-perf-'));
  try {
    if (slo) {
      const r = runSlo({ runs, rounds, event, sandbox });
      console.log(opts.bools.has('json') ? JSON.stringify(r, null, 2) : formatSloReport(r));
      process.exit(r.slo.inconclusive ? 3 : (r.slo.pass ? 0 : 1));
    }
    const r = perfBaseline({ runs, event, sandbox, surface });
    console.log(opts.bools.has('json') ? JSON.stringify(r, null, 2) : formatReport(r));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true }); // §8.V4 sandbox disposal
  }
}
module.exports = { perfBaseline, formatReport, formatSloReport, runSlo, evaluateSlo, combineRounds, stabilityCheck, loadSloConfig, EVENTS, SURFACES, median, percentile, SLO_CONFIG_PATH };
