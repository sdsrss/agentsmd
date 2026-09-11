'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
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
  const childEnvs = [];
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
    spawnSync(command, args, options) {
      calls.push([command, ...args]);
      childEnvs.push(options.env);
      return { status: 1, signal: null, error: null };
    },
    env: {
      PRESERVED_FIXTURE: 'yes',
      PLUGIN_ROOT: '/caller/plugin',
      CLAUDE_PLUGIN_ROOT: '/caller/compat-plugin',
      AGENTSMD_PLUGIN_ROOT: '/caller/skill-plugin',
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
  assert.strictEqual(childEnvs.length, 1);
  assert.strictEqual(childEnvs[0].PRESERVED_FIXTURE, 'yes');
  assert.strictEqual(childEnvs[0].PLUGIN_ROOT, undefined);
  assert.strictEqual(childEnvs[0].CLAUDE_PLUGIN_ROOT, undefined);
  assert.strictEqual(childEnvs[0].AGENTSMD_PLUGIN_ROOT, undefined);
});

test('force-full keeps changed-file context but cannot remove release checks', () => {
  const plan = buildPlan(map, ['package.json'], { forceFull: true });
  const ids = plan.checks.map((check) => check.id);
  assert(ids.includes('full-check'));
  assert(ids.includes('release-dry-run'));
  assert(ids.includes('security-policy'));
  assert.strictEqual(plan.requires_full_gate, true);
});

function withProject(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-verify-project-')));
  try {
    const home = path.join(dir, '.home');
    fs.mkdirSync(home);
    const bin = path.join(dir, '.bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\ntouch "${CODEX_HOME}/unexpected-npm"\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, CODEX_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    for (const key of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'AGENTSMD_PLUGIN_ROOT']) delete env[key];
    cp.execFileSync('git', ['init', '-q'], { cwd: dir, env });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.home/\n.bin/\nchecked\n');
    fs.writeFileSync(path.join(dir, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
    const run = (args = [], cwd = dir) => cp.spawnSync(process.execPath,
      [path.join(ROOT, 'scripts/verify.js'), ...args, '--json'], { cwd, env, encoding: 'utf8', timeout: 10000 });
    fn({ dir, home, run });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const args of [[], ['--full'], ['--explain']]) {
  test(`project without a map executes no guessed checks (${args.join(' ') || 'default'})`, () => withProject(({ home, run }) => {
    const result = run(args);
    assert.strictEqual(result.status, args.includes('--explain') ? 0 : 1, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepStrictEqual(plan.checks, []);
    assert(plan.uncovered_risks.some((risk) => /project.*validation map/i.test(risk)));
    assert.strictEqual(fs.existsSync(path.join(home, 'unexpected-npm')), false);
  }));
}

test('project map and Git-root cwd drive checks even from a subdirectory', () => withProject(({ dir, home, run }) => {
  fs.mkdirSync(path.join(dir, 'qa'));
  fs.mkdirSync(path.join(dir, 'src'));
  const projectMap = {
    schema_version: 1,
    checks: { local: { command: ['node', '-e', "require('fs').writeFileSync('checked', process.cwd())"], execution: 'local', external_service: false, auth_boundary: false, width: 'full', order: 0 } },
    routes: [{ id: 'source', patterns: ['calc.js', '.gitignore', 'qa/validation-map.json'], risk_categories: ['project'], checks: ['local'], reason: 'Project-owned check.', requires_full: false, auth_boundary: false }],
    full_gate: { check: 'local', reason: 'Project full gate.' },
    unknown: { requires_full: true, risk_category: 'unknown', reason: 'Classify this project path.' },
  };
  fs.writeFileSync(path.join(dir, 'qa/validation-map.json'), JSON.stringify(projectMap));
  const result = run([], path.join(dir, 'src'));
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'checked'), 'utf8'), dir);
  const plan = JSON.parse(result.stdout);
  assert.deepStrictEqual(plan.checks.map((check) => check.id), ['local']);
  assert(plan.changed_files.includes('calc.js'));
  assert.strictEqual(fs.existsSync(path.join(home, 'unexpected-npm')), false);
}));

for (const kind of ['malformed', 'null', 'oversized', 'symlink-file', 'symlink-parent']) {
  test(`invalid project map never falls back to package checks (${kind})`, () => withProject(({ dir, home, run }) => {
    const qa = path.join(dir, 'qa');
    if (kind === 'symlink-parent') {
      fs.mkdirSync(path.join(dir, '.actual'));
      fs.symlinkSync('.actual', qa);
    } else fs.mkdirSync(qa);
    const file = path.join(qa, 'validation-map.json');
    if (kind === 'symlink-file') fs.symlinkSync(path.join(ROOT, 'qa/validation-map.json'), file);
    else fs.writeFileSync(file, kind === 'malformed' ? '{' : kind === 'null' ? 'null' : kind === 'oversized' ? ' '.repeat(262145) : JSON.stringify(map));
    const result = run();
    assert.strictEqual(result.status, 1);
    assert.strictEqual(fs.existsSync(path.join(home, 'unexpected-npm')), false);
    assert.match(result.stderr, /project validation map/i);
  }));
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
