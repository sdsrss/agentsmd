'use strict';
// perf-baseline.test.js — the hook-latency measurement tool (E1). Proves it runs,
// emits well-formed numeric medians for every registry hook, filters by event, and
// — critically — isolates its spawns in an INTERNAL CODEX_HOME sandbox so measuring
// writes NO telemetry/state to the ambient ~/.codex (§8.V3). --runs=1 for speed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const REG = require('../lib/hook-registry');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const script = path.join(__dirname, '..', 'perf-baseline.js');

t('runs, exits 0, covers every registry hook with non-negative numeric medians', () => {
  const ambient = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-perf-ambient-'));
  try {
    const out = cp.execFileSync(process.execPath, [script, '--runs=1', '--json'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: ambient } });
    const r = JSON.parse(out);
    assert.strictEqual(r.runs, 1);
    assert.strictEqual(r.results.length, REG.HOOK_REGISTRY.length, 'one row per hook');
    for (const x of r.results) {
      assert.ok(typeof x.off_ms === 'number' && x.off_ms >= 0, 'off_ms numeric: ' + x.hook);
      assert.ok(typeof x.on_ms === 'number' && x.on_ms >= 0, 'on_ms numeric: ' + x.hook);
      assert.ok(typeof x.delta_ms === 'number' && x.delta_ms >= 0, 'delta_ms >= 0: ' + x.hook);
    }
    assert.ok('Stop' in r.byEvent && 'PreToolUse' in r.byEvent, 'byEvent grouping present');
    // §8.V3: measuring wrote NOTHING to the ambient CODEX_HOME (internal sandbox used).
    assert.ok(!fs.existsSync(path.join(ambient, 'logs', 'agentsmd.jsonl')), 'must not pollute ambient telemetry');
    assert.ok(!fs.existsSync(path.join(ambient, '.agentsmd-state')), 'must not write ambient state');
  } finally { fs.rmSync(ambient, { recursive: true, force: true }); }
});

t('--event filters to that group; unknown flag exits 2; unknown --event exits 1', () => {
  const out = cp.execFileSync(process.execPath, [script, '--runs=1', '--event=PreToolUse', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.results.length === 5 && r.results.every((x) => x.event === 'PreToolUse'), 'only the 5 PreToolUse:Bash hooks');
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--nope']).status, 2);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--event=Nope']).status, 1);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--runs=abc']).status, 1);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
