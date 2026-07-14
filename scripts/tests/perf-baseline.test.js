'use strict';
// perf-baseline.test.js — the hook-latency measurement tool (E1) + SLO gate (R6-02).
// Proves it runs, emits well-formed numeric stats for every registry hook, filters
// by event, and — critically — isolates its spawns in an INTERNAL CODEX_HOME
// sandbox so measuring writes NO telemetry/state to the ambient ~/.codex (§8.V3).
// R6-02 additions are graded STRUCTURALLY only (shapes, schema, exit-code space):
// npm test never asserts absolute wall-clock numbers — timing enforcement belongs
// to the explicit `--slo` run (spec/OPERATOR.md §O9), not a CI box of unknown load.
// --runs=1 for speed. Dual-surface runs need a `codex` on PATH: standalone
// invocations get the fixtures shim prepended, matching the npm-test PATH.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const REG = require('../lib/hook-registry');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const script = path.join(__dirname, '..', 'perf-baseline.js');
const FIXTURES_PATH = `${path.join(__dirname, 'fixtures')}${path.delimiter}${process.env.PATH}`;

t('runs, exits 0, covers every registry hook with non-negative numeric stats', () => {
  const ambient = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-perf-ambient-'));
  try {
    const out = cp.execFileSync(process.execPath, [script, '--runs=1', '--json'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: ambient } });
    const r = JSON.parse(out);
    assert.strictEqual(r.runs, 1);
    assert.strictEqual(r.surface, 'single');
    assert.strictEqual(r.results.length, REG.HOOK_REGISTRY.length, 'one row per hook');
    for (const x of r.results) {
      assert.strictEqual(x.copy, 'repo', 'single surface rows are repo-copy: ' + x.hook);
      assert.ok(typeof x.off_ms === 'number' && x.off_ms >= 0, 'off_ms numeric: ' + x.hook);
      assert.ok(typeof x.on_ms === 'number' && x.on_ms >= 0, 'on_ms numeric: ' + x.hook);
      assert.ok(typeof x.delta_ms === 'number' && x.delta_ms >= 0, 'delta_ms >= 0: ' + x.hook);
      assert.ok(typeof x.p95_ms === 'number' && x.p95_ms >= x.on_ms, 'p95 >= p50: ' + x.hook);
      const reg = REG.HOOK_REGISTRY.find((h) => h.displayName === x.hook);
      assert.strictEqual(x.timeout_budget_ms, reg.timeout * 1000, 'timeout budget mirrors registry: ' + x.hook);
    }
    assert.ok('Stop' in r.byEvent && 'PreToolUse' in r.byEvent, 'byEvent grouping present');
    assert.ok('PreToolUse' in r.byEventP95, 'byEventP95 grouping present');
    // §8.V3: measuring wrote NOTHING to the ambient CODEX_HOME (internal sandbox used).
    assert.ok(!fs.existsSync(path.join(ambient, 'logs', 'agentsmd.jsonl')), 'must not pollute ambient telemetry');
    assert.ok(!fs.existsSync(path.join(ambient, '.agentsmd-state')), 'must not write ambient state');
  } finally { fs.rmSync(ambient, { recursive: true, force: true }); }
});

t('--event filters to that group; all usage errors exit 2', () => {
  const out = cp.execFileSync(process.execPath, [script, '--runs=1', '--event=PreToolUse', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.results.length === 5 && r.results.every((x) => x.event === 'PreToolUse'), 'only the 5 PreToolUse:Bash hooks');
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--nope']).status, 2);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--event=Nope']).status, 2);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--runs=abc']).status, 2);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--surface=tripled']).status, 2);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--rounds=2']).status, 2, '--rounds without --slo');
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--slo', '--surface=single']).status, 2, '--slo conflicts with --surface');
});

t('median: odd N picks the middle; even N averages the two middles; p95 nearest-rank', () => {
  const P = require('../perf-baseline');
  assert.strictEqual(P.median([3, 1, 2]), 2);        // odd → middle
  assert.strictEqual(P.median([4, 1, 3, 2]), 2.5);   // even → (2 + 3) / 2, not the upper-middle 3
  assert.strictEqual(P.percentile([5], 95), 5);      // runs=1 → the sample itself
  assert.strictEqual(P.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10); // ceil(0.95*10)=10th
  assert.strictEqual(P.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);  // nearest-rank p50
});

t('--surface=dual-warm times BOTH physical copies; ambient stays clean', () => {
  const ambient = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-perf-ambient-'));
  try {
    const out = cp.execFileSync(process.execPath, [script, '--runs=1', '--event=PreToolUse', '--surface=dual-warm', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: FIXTURES_PATH, CODEX_HOME: ambient } });
    const r = JSON.parse(out);
    assert.strictEqual(r.surface, 'dual-warm');
    assert.strictEqual(r.results.length, 10, '5 PreToolUse hooks x 2 copies');
    for (const copy of ['standalone', 'plugin']) {
      assert.strictEqual(r.results.filter((x) => x.copy === copy).length, 5, `5 rows for ${copy} copy`);
    }
    assert.ok(r.byEvent.PreToolUse > 0 && r.byEventP95.PreToolUse > 0, 'dual totals cover both copies');
    assert.ok(!fs.existsSync(path.join(ambient, '.agentsmd-state')), 'dual fixture install stayed inside the internal sandbox');
    assert.ok(!fs.existsSync(path.join(ambient, 'agentsmd')), 'no deploy tree in ambient CODEX_HOME');
  } finally { fs.rmSync(ambient, { recursive: true, force: true }); }
});

t('slo.json: schema, scope, fractions, and referenced defaults are coherent', () => {
  const P = require('../perf-baseline');
  const cfg = P.loadSloConfig();
  assert.strictEqual(cfg.schemaVersion, 1);
  assert.ok(Array.isArray(cfg.scope_events) && cfg.scope_events.length > 0, 'scope_events non-empty');
  for (const ev of cfg.scope_events) {
    assert.ok(P.EVENTS.includes(ev), 'known event: ' + ev);
    assert.ok(REG.HOOK_REGISTRY.some((h) => h.hookEvent === ev), 'scope event has registry hooks: ' + ev);
  }
  assert.ok(cfg.scope_events.includes('PreToolUse'), 'the hot path is in scope');
  assert.ok(!cfg.scope_events.includes('SessionStart'), 'SessionStart (once per session, pays the inspector) stays out of scope');
  assert.ok(cfg.per_hook_p95_max_fraction_of_timeout > 0 && cfg.per_hook_p95_max_fraction_of_timeout <= 1, 'headroom fraction in (0,1]');
  assert.ok(cfg.dual_warm_pretooluse.max_total_p95_overhead_ms > 0, 'dual-warm overhead cap positive');
  assert.ok(cfg.stability.max_round_p95_delta_fraction > 0, 'stability tolerance positive');
  assert.ok(Number.isInteger(cfg.baseline_runs) && cfg.baseline_runs >= 10, 'baseline_runs >= 10 for a meaningful p95');
  assert.ok(Number.isInteger(cfg.baseline_rounds) && cfg.baseline_rounds >= 2, 'two-round stability is the acceptance bar');
  // The referenced reference-machine baseline must exist and cover every graded surface.
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', cfg.baseline_reference), 'utf8'));
  assert.strictEqual(base.schemaVersion, 1);
  for (const s of ['single', 'dual-warm']) {
    for (const ev of cfg.scope_events) assert.ok(base.byEventP95[s][ev] > 0, `baseline covers ${s}/${ev}`);
  }
  assert.ok(base.dualWarmPretoolUseOverheadMs < cfg.dual_warm_pretooluse.max_total_p95_overhead_ms, 'recorded baseline overhead sits under the cap it calibrated');
});

t('evaluateSlo + stabilityCheck: pure grading logic (no timing dependence)', () => {
  const P = require('../perf-baseline');
  const cfg = { scope_events: ['PreToolUse'], per_hook_p95_max_fraction_of_timeout: 0.5, dual_warm_pretooluse: { max_total_p95_overhead_ms: 100 } };
  const row = (hook, p95, copy = 'repo') => ({ hook, event: 'PreToolUse', copy, on_ms: p95, p95_ms: p95, timeout_budget_ms: 3000 });
  const surf = (rows) => ({ results: rows, byEventP95: { PreToolUse: rows.reduce((a, x) => a + x.p95_ms, 0) } });
  // In budget + cheap yield → both criteria pass.
  let g = P.evaluateSlo(surf([row('a', 100)]), surf([row('a', 120, 'standalone'), row('a', 40, 'plugin')]), cfg);
  assert.ok(g.pass && g.criteria.length === 2 && g.criteria.every((c) => c.pass));
  // A hook past 50% of its 3s timeout → headroom criterion fails with the violator named.
  g = P.evaluateSlo(surf([row('a', 1600)]), surf([row('a', 100, 'standalone'), row('a', 40, 'plugin')]), cfg);
  const c1 = g.criteria.find((c) => c.id === 'per-hook-p95-headroom');
  assert.ok(!g.pass && !c1.pass && c1.violations.length === 1 && c1.violations[0].hook === 'a' && c1.violations[0].limit_ms === 1500);
  // Dual-warm overhead past the cap → N-01 guard fails with both totals cited.
  g = P.evaluateSlo(surf([row('a', 100)]), surf([row('a', 100, 'standalone'), row('a', 150, 'plugin')]), cfg);
  const c2 = g.criteria.find((c) => c.id === 'dual-warm-pretooluse-overhead');
  assert.ok(!g.pass && !c2.pass && c2.measured.overhead_ms === 150);
  // Stability: within tolerance stable; beyond it unstable; single round → no verdict.
  assert.strictEqual(P.stabilityCheck([{ PreToolUse: 100 }, { PreToolUse: 130 }], 0.5).stable, true);
  assert.strictEqual(P.stabilityCheck([{ PreToolUse: 100 }, { PreToolUse: 200 }], 0.5).stable, false);
  assert.deepStrictEqual(P.stabilityCheck([{ PreToolUse: 100 }], 0.5).roundDeltaFractionByEvent, {});
  // combineRounds keeps each row's best (lowest-p95) round.
  const combined = P.combineRounds([
    { runs: 1, surface: 'single', results: [row('a', 300)], byEvent: {}, byEventP95: { PreToolUse: 300 } },
    { runs: 1, surface: 'single', results: [row('a', 200)], byEvent: {}, byEventP95: { PreToolUse: 200 } },
  ]);
  assert.strictEqual(combined.results[0].p95_ms, 200);
  assert.strictEqual(combined.roundEventP95.length, 2);
});

t('--slo end-to-end: structural report shape; exit code stays in the contract {0,1,3}', () => {
  const r = cp.spawnSync(process.execPath, [script, '--slo', '--runs=1', '--rounds=1', '--event=PreToolUse', '--json'],
    { encoding: 'utf8', env: { ...process.env, PATH: FIXTURES_PATH } });
  assert.ok([0, 1, 3].includes(r.status), 'slo exit in {0,1,3}, got ' + r.status + '\n' + (r.stderr || ''));
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.mode, 'slo');
  assert.ok(out.surfaces.single && out.surfaces['dual-warm'], 'both graded surfaces present');
  assert.ok(Array.isArray(out.slo.criteria) && out.slo.criteria.length === 2, 'two criteria');
  assert.ok(out.slo.criteria.every((c) => typeof c.pass === 'boolean'), 'each criterion carries a verdict');
  assert.ok(out.env && typeof out.env.cpu === 'string' && out.env.agentsmd, 'env fingerprint labels the run');
  assert.strictEqual(typeof out.slo.inconclusive, 'boolean');
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
