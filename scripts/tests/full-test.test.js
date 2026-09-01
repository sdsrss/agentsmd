'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'full-test.js');
const PLAN = path.join(ROOT, 'scripts', 'full-test-plan.json');
const PHASE4_ONLY = new Set([
  'scripts/tests/runtime-canary.test.js',
  'scripts/tests/workflow-static.test.js',
]);

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('manifest covers every main-gate test exactly once and keeps smoke last', () => {
  const api = require(RUNNER);
  const plan = api.loadPlan(PLAN);
  assert.strictEqual(require(path.join(ROOT, 'package.json')).scripts.test, 'node scripts/full-test.js');
  const planned = plan.steps
    .filter((step) => step.argv[0] === 'node' && /\.test\.js$/u.test(step.argv[1]))
    .map((step) => step.argv[1])
    .sort();
  const available = fs.readdirSync(path.join(ROOT, 'scripts', 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `scripts/tests/${name}`)
    .filter((name) => !PHASE4_ONLY.has(name))
    .sort();
  assert.deepStrictEqual(planned, available);
  assert.strictEqual(new Set(plan.steps.map((step) => step.id)).size, plan.steps.length);
  assert.deepStrictEqual(plan.steps.at(-1), { id: 'hook-smoke', argv: ['bash', 'hooks/tests/smoke.sh'] });
});

test('strict argv accepts one resume point and rejects unknown input', () => {
  const { parseArgs } = require(RUNNER);
  assert.deepStrictEqual(parseArgs([]), { from: null });
  assert.deepStrictEqual(parseArgs(['--from=hook-smoke']), { from: 'hook-smoke' });
  assert.throws(() => parseArgs(['--unknown']), /Unknown flag/u);
});

test('runner is sequential, fail-fast, always verifies, and reports exact resume', () => {
  const { runPlan } = require(RUNNER);
  const calls = [];
  const childEnvs = [];
  const lines = [];
  const plan = { schemaVersion: 1, steps: [
    { id: 'first', argv: ['node', 'scripts/tests/argv.test.js'] },
    { id: 'second', argv: ['node', 'scripts/tests/verify.test.js'] },
    { id: 'third', argv: ['node', 'scripts/tests/drift.test.js'] },
  ] };
  const statuses = [0, 0, 7, 0];
  const result = runPlan({
    plan,
    spawnSync(command, argv, options) {
      calls.push([command, ...argv]);
      childEnvs.push(options.env);
      return { status: statuses.shift(), signal: null, error: null };
    },
    write(line) { lines.push(line); },
    now: (() => { let value = 0; return () => { value += 10; return value; }; })(),
    fixtureCodex: process.execPath,
    env: {
      PATH: process.env.PATH || '',
      PRESERVED_FIXTURE: 'yes',
      PLUGIN_ROOT: '/caller/plugin',
      CLAUDE_PLUGIN_ROOT: '/caller/compat-plugin',
      AGENTSMD_PLUGIN_ROOT: '/caller/skill-plugin',
    },
  });
  assert.deepStrictEqual(calls.map((call) => call.slice(0, 3)), [
    ['node', 'scripts/tests/live-guard.js', 'snapshot'],
    ['node', 'scripts/tests/argv.test.js'],
    ['node', 'scripts/tests/verify.test.js'],
    ['node', 'scripts/tests/live-guard.js', 'verify'],
  ]);
  assert.strictEqual(result.exitCode, 7);
  assert.deepStrictEqual(result.remaining, ['second', 'third']);
  assert(lines.some((line) => line.includes('resume: node scripts/full-test.js --from=second')));
  for (const env of childEnvs) {
    assert.strictEqual(env.PRESERVED_FIXTURE, 'yes');
    assert.strictEqual(env.PLUGIN_ROOT, undefined);
    assert.strictEqual(env.CLAUDE_PLUGIN_ROOT, undefined);
    assert.strictEqual(env.AGENTSMD_PLUGIN_ROOT, undefined);
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.stack || error}`); }
}
console.log(`\nRESULT: ${passed} passed, ${tests.length - passed} failed`);
if (passed !== tests.length) process.exit(1);
