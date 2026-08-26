'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildPlan,
  executePlan,
  parseVerifyArgs,
  validateValidationMap,
} = require('../lib/validation-router');

const ROOT = path.resolve(__dirname, '..', '..');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'validation-map.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'validation-router-cases.json'), 'utf8'));

let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

test('validation map is internally consistent and every executable check is argv-safe', () => {
  const errors = validateValidationMap(map, ROOT);
  assert.deepStrictEqual(errors, [], errors.join('\n'));
});

for (const fixture of fixtures.cases) {
  test(`route: ${fixture.name}`, () => {
    const first = buildPlan(map, fixture.files);
    const second = buildPlan(map, fixture.files);
    assert.deepStrictEqual(second, first, 'plan/reasons must be deterministic');
    const checkIds = first.checks.map((check) => check.id);
    const categories = first.risk_categories;
    for (const id of fixture.checks_include || []) assert(checkIds.includes(id), `missing check ${id}`);
    for (const id of fixture.checks_exclude || []) assert(!checkIds.includes(id), `unexpected check ${id}`);
    for (const category of fixture.categories_include || []) assert(categories.includes(category), `missing category ${category}`);
    assert.strictEqual(first.requires_full_gate, fixture.requires_full);
    assert.strictEqual(first.touches_external_service, fixture.external_service);
    assert.strictEqual(first.auth_boundary, fixture.auth_boundary);
    if (fixture.deduplicated) assert.strictEqual(new Set(checkIds).size, checkIds.length, 'duplicate checks');
    if (fixture.uncovered) assert(first.uncovered_risks.length > 0, 'unknown path needs explicit uncovered risk');
    if (fixture.uncovered === false) assert.deepStrictEqual(first.uncovered_risks, [], 'covered path must not require manual classification');
  });
}

test('strict CLI parsing rejects malformed, unknown, and conflicting selectors', () => {
  assert.deepStrictEqual(parseVerifyArgs([]), {
    changed: true,
    since: null,
    explain: false,
    full: false,
    json: false,
  });
  assert.strictEqual(parseVerifyArgs(['--changed', '--explain', '--json']).explain, true);
  assert.strictEqual(parseVerifyArgs(['--since=HEAD~2']).since, 'HEAD~2');
  assert.strictEqual(parseVerifyArgs(['--full']).full, true);
  assert.throws(() => parseVerifyArgs(['--since']), /requires '=value'/);
  assert.throws(() => parseVerifyArgs(['--unknown']), /Unknown flag/);
  assert.throws(() => parseVerifyArgs(['--changed', '--since=HEAD']), /mutually exclusive/);
  assert.throws(() => parseVerifyArgs(['--since=--help']), /invalid commit/i);
});

test('executor skips external/hard checks and stops before a wider check after local failure', () => {
  const calls = [];
  const plan = {
    checks: [
      {
        id: 'external',
        command: ['codex', 'exec', 'canary'],
        external_service: true,
        auth_boundary: false,
        execution: 'report-only',
        width: 'targeted',
        reasons: ['fixture'],
      },
      {
        id: 'hard',
        command: ['deploy', 'production'],
        external_service: false,
        auth_boundary: true,
        execution: 'report-only',
        width: 'targeted',
        reasons: ['fixture'],
      },
      {
        id: 'targeted-red',
        command: ['node', 'red.js'],
        external_service: false,
        auth_boundary: false,
        execution: 'local',
        width: 'targeted',
        reasons: ['fixture'],
      },
      {
        id: 'full-check',
        command: ['npm', 'run', 'check'],
        external_service: false,
        auth_boundary: false,
        execution: 'local',
        width: 'full',
        reasons: ['fixture'],
      }
    ]
  };
  const result = executePlan(plan, {
    cwd: ROOT,
    spawnSync(command, args) {
      calls.push([command, ...args]);
      return { status: 1, signal: null, error: null };
    },
  });
  assert.deepStrictEqual(calls, [['node', 'red.js']]);
  assert.deepStrictEqual(result.results.map((entry) => entry.status), [
    'skipped-external',
    'skipped-auth-boundary',
    'failed',
    'not-run-after-failure',
  ]);
  assert.strictEqual(result.exit_code, 1);
});

test('force-full keeps changed-file context but cannot remove release checks', () => {
  const plan = buildPlan(map, ['package.json'], { forceFull: true });
  const ids = plan.checks.map((check) => check.id);
  assert(ids.includes('full-check'));
  assert(ids.includes('release-dry-run'));
  assert(ids.includes('security-policy'));
  assert.strictEqual(plan.requires_full_gate, true);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
