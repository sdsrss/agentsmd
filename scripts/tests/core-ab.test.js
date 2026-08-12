'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'qa', 'core-ab-eval.js');
const CASES = path.join(ROOT, 'qa', 'core-ab', 'cases.json');
const CONFORMANCE_CASES = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const OPERATOR = path.join(ROOT, 'spec', 'OPERATOR.md');
const CASE_SCHEMA = path.join(ROOT, 'schemas', 'core-ab-cases.schema.json');
const RESULT_SCHEMA = path.join(ROOT, 'schemas', 'core-ab-results.schema.json');
const REPO_TMP = path.join(ROOT, 'tmp');
const CAPTURE_BASE = path.join(ROOT, 'docs', 'qa-captures', 'core-ab');
const TEST_DIRECTORIES = [...new Set([
  os.tmpdir(), REPO_TMP, path.join(ROOT, 'docs'), path.join(ROOT, 'docs', 'qa-captures'), CAPTURE_BASE,
])];
const TEST_DIRECTORY_EXISTED = new Map(TEST_DIRECTORIES.map((directory) => [directory, fs.existsSync(directory)]));
for (const directory of TEST_DIRECTORIES) fs.mkdirSync(directory, { recursive: true });
const api = require(RUNNER);

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

function metricRow(condition, overrides = {}) {
  return {
    pair_id: 'seed:fixture',
    case_id: 'fixture',
    category: 'small-bug',
    condition,
    order_index: condition === 'current-core' ? 0 : 1,
    condition_core_sha256: condition === 'no-core' ? null : 'a'.repeat(64),
    status: 'pass',
    task_success: true,
    assertion_failures: [],
    metrics: {
      unnecessary_ask: false,
      auth_false_positive: false,
      auth_false_negative: false,
      fresh_evidence_violation: false,
      command_executions: 1,
      turns: 1,
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 10,
      reasoning_output_tokens: 3,
      wall_ms: 50,
      ...(overrides.metrics || {}),
    },
    human_preference: null,
    capture: `fixture--${condition}`,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'metrics')),
  };
}

test('runner exports the structural and runtime boundary helpers', () => {
  for (const name of [
    'aggregateRows', 'buildCodexInvocation', 'buildReport', 'childEnvironment',
    'changedFiles', 'conditionOrder', 'eventFacts', 'hasClarifyingQuestion', 'parseArgs',
    'createCaptureRoot', 'parseEvents', 'resolveCandidate', 'resolveResumeCapture', 'resolveSubscriptionHome',
    'resolveSubscriptionMounts',
    'loadCaseSuite', 'runCell', 'runExperiment',
    'safeCleanupTemp', 'sha256', 'validateCaseLibrary', 'validateProgress', 'validateResultReport',
    'validateAuthGuardLibrary',
  ]) assert.strictEqual(typeof api[name], 'function', name);
});

test('committed case library is exactly 24 cases and three per required family', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  assert.deepStrictEqual(api.validateCaseLibrary(lib), []);
  assert.strictEqual(lib.cases.length, 24);
  const counts = {};
  for (const item of lib.cases) counts[item.category] = (counts[item.category] || 0) + 1;
  assert.strictEqual(Object.keys(counts).length, 8);
  for (const count of Object.values(counts)) assert.strictEqual(count, 3);
  assert.strictEqual(new Set(lib.cases.map((item) => item.id)).size, 24);
});

test('authorization cases that expect a block explicitly withhold operation authorization', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  for (const id of ['auth-ci-workflow', 'auth-production-config-delete']) {
    const item = lib.cases.find((candidate) => candidate.id === id);
    assert(item, id);
    assert.match(item.prompt, /does not authorize/iu, id);
  }
});

test('auth-guard suite adapts exactly the two canonical conformance cases', () => {
  const sourceRaw = fs.readFileSync(CONFORMANCE_CASES, 'utf8');
  const source = JSON.parse(sourceRaw);
  const suite = api.loadCaseSuite('auth-guard');
  assert.strictEqual(suite.name, 'auth-guard');
  assert.strictEqual(suite.raw, sourceRaw);
  assert.strictEqual(suite.caseSha, api.sha256(sourceRaw));
  assert.deepStrictEqual(suite.errors, []);
  assert.deepStrictEqual(suite.cases.map((item) => item.id), ['auth-hard-tidy', 'auth-clear-create']);
  for (const item of suite.cases) {
    const canonical = source.cases.find((candidate) => candidate.id === item.id);
    assert(canonical, item.id);
    assert.strictEqual(item.prompt, canonical.prompt);
    assert.deepStrictEqual(item.setup_files, canonical.setup_files || []);
    assert.deepStrictEqual(item.assertions, canonical.assert);
  }
  const hard = suite.cases[0];
  assert.deepStrictEqual(hard.git_add, ['src/main.js', 'data/records.csv']);
  assert.strictEqual(hard.git_commit_setup, true);
  assert.strictEqual(hard.auth_expectation, 'required');
  const clear = suite.cases[1];
  assert.deepStrictEqual(clear.git_add, []);
  assert.strictEqual(clear.git_commit_setup, false);
  assert.strictEqual(clear.auth_expectation, 'none');

  const unsafe = structuredClone(source);
  unsafe.cases.find((item) => item.id === 'auth-hard-tidy').setup_files[0].path = '../escape';
  assert(api.validateAuthGuardLibrary(unsafe).some((error) => /unsafe setup path/u.test(error)));
  const unsafeCommand = structuredClone(source);
  unsafeCommand.cases.find((item) => item.id === 'auth-clear-create').assert[1].cmd = 'touch escaped';
  assert(api.validateAuthGuardLibrary(unsafeCommand).some((error) => /unsafe cmd_green/u.test(error)));
});

test('operator contract declares the zero-model and four-cell auth guard', () => {
  const operator = fs.readFileSync(OPERATOR, 'utf8');
  assert.match(operator, /--validate --suite=auth-guard/u);
  assert.match(operator, /--run\s+--suite=auth-guard[\s\S]{0,500}costs exactly four completed\s+model cells/u);
  assert.match(operator, /selects exactly `auth-hard-tidy` and\s+`auth-clear-create`/u);
  const representativeRow = operator.split('\n').find((line) => line.includes('| Representative core A/B structure / real run |'));
  assert(representativeRow);
  assert.match(representativeRow, /--subscription-home=<\/absolute\/CODEX_HOME>/u);

  const help = cp.spawnSync(process.execPath, [RUNNER, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /Linux ChatGPT subscription runs require --subscription-home=\/absolute\/CODEX_HOME/u);
  assert.match(help.stdout, /Custom\/fake Codex runners may omit --subscription-home/u);
});

test('port-validation assertion accepts standard Error subclasses', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const item = lib.cases.find((candidate) => candidate.id === 'bug-port-validation');
  const assertion = item.assertions.find((candidate) => candidate.type === 'file_contains');
  assert.match('throw new Error("Invalid port")', new RegExp(assertion.regex, 'iu'));
  assert.match('throw new TypeError("Invalid port")', new RegExp(assertion.regex, 'iu'));
});

test('renderer prompt makes the unchanged index contract explicit', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const item = lib.cases.find((candidate) => candidate.id === 'feature-json-renderer');
  assert.match(item.prompt, /already re-exports/iu);
  assert.match(item.prompt, /do not edit src\/index\.js/iu);
});

test('source-create prompt makes the pre-existing test coverage explicit', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const item = lib.cases.find((candidate) => candidate.id === 'auth-near-negative-source-create');
  assert.match(item.prompt, /already contains.*coverage/iu);
  assert.match(item.prompt, /do not edit test\.js/iu);
});

test('case library rejects duplicate IDs, unsafe paths, unknown fields, and invalid regex', () => {
  const original = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const duplicate = structuredClone(original);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert(api.validateCaseLibrary(duplicate).some((error) => /duplicate id/u.test(error)));
  const unsafe = structuredClone(original);
  unsafe.cases[0].setup_files[0].path = '../escape';
  assert(api.validateCaseLibrary(unsafe).some((error) => /unsafe setup path|required pattern/u.test(error)));
  const unknown = structuredClone(original);
  unknown.cases[0].surprise = true;
  assert(api.validateCaseLibrary(unknown).some((error) => /fields|unknown field/u.test(error)));
  const invalidRegex = structuredClone(original);
  invalidRegex.cases[0].assertions[0].regex = '[';
  assert(api.validateCaseLibrary(invalidRegex).some((error) => /invalid regex/u.test(error)));
  const missingValidationRegex = structuredClone(original);
  delete missingValidationRegex.cases[0].validation_regex;
  assert(api.validateCaseLibrary(missingValidationRegex).some((error) => /validation_regex/u.test(error)));
  const irrelevantAssertionField = structuredClone(original);
  irrelevantAssertionField.cases[6].assertions[0].regex = 'anything';
  assert(api.validateCaseLibrary(irrelevantAssertionField).some((error) => /fields/u.test(error)));
});

test('case and result JSON schemas are strict bounded contracts', () => {
  const cases = JSON.parse(fs.readFileSync(CASE_SCHEMA, 'utf8'));
  const results = JSON.parse(fs.readFileSync(RESULT_SCHEMA, 'utf8'));
  assert.strictEqual(cases.additionalProperties, false);
  assert.strictEqual(cases.properties.cases.minItems, 24);
  assert.strictEqual(cases.properties.cases.maxItems, 24);
  assert.strictEqual(cases.$defs.case.additionalProperties, false);
  assert.strictEqual(results.additionalProperties, false);
  assert.strictEqual(results.$defs.row.additionalProperties, false);
  assert.strictEqual(results.properties.aggregate.additionalProperties, false);
  assert(results.$defs.aggregateSummary.required.includes('token_state'));
  assert(results.$defs.nullableNonnegative.oneOf.some((entry) => entry.type === 'null'));
});

test('strict argv separates zero-model modes from explicitly costed runtime', () => {
  assert.strictEqual(api.parseArgs(['--validate']).validate, true);
  assert.strictEqual(api.parseArgs(['--validate', '--suite=auth-guard']).suite, 'auth-guard');
  assert.strictEqual(api.parseArgs(['--list']).list, true);
  const run = api.parseArgs(['--run', '--model=gpt-test', '--seed=baseline-1', '--conditions=current-core,no-core']);
  assert.deepStrictEqual(run.conditions, ['current-core', 'no-core']);
  const subscription = api.parseArgs([
    '--run', '--model=gpt-test', '--seed=baseline-1', '--conditions=current-core,no-core',
    '--subscription-home=/home/tester/.codex',
  ]);
  assert.strictEqual(subscription.subscriptionHome, '/home/tester/.codex');
  const resume = api.parseArgs([
    '--run', '--model=gpt-test', '--seed=baseline-1', '--conditions=current-core,no-core',
    '--resume=docs/qa-captures/core-ab/core-ab-fixture',
  ]);
  assert.strictEqual(resume.resume, path.join(ROOT, 'docs', 'qa-captures', 'core-ab', 'core-ab-fixture'));
  const guard = api.parseArgs([
    '--run', '--suite=auth-guard', '--model=gpt-test', '--seed=guard-1',
    '--conditions=current-core,candidate-core', '--candidate-core=docs/qa-candidates/core/level-auth-separation.md',
  ]);
  assert.strictEqual(guard.suite, 'auth-guard');
  assert.strictEqual(guard.only, null);
  for (const argv of [
    [],
    ['--validate', '--run'],
    ['--run', '--model=gpt-test', '--conditions=current-core,no-core'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,current-core'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,candidate-core'],
    ['--validate', '--model=gpt-test'],
    ['--validate', '--subscription-home=/home/tester/.codex'],
    ['--validate', '--resume=docs/qa-captures/core-ab/core-ab-fixture'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,no-core', '--subscription-home=relative/home'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,no-core', '--subscription-home=/'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,no-core', '--out=/tmp/out'],
    ['--run', '--model=gpt-test', '--seed=s', '--conditions=current-core,no-core', '--resume=/tmp/capture'],
    ['--validate', '--suite=unknown'],
    ['--run', '--suite=auth-guard', '--model=gpt-test', '--seed=s', '--conditions=current-core,no-core'],
    ['--run', '--suite=auth-guard', '--model=gpt-test', '--seed=s', '--conditions=current-core,candidate-core', '--candidate-core=docs/qa-candidates/core/level-auth-separation.md', '--only=auth-hard-tidy'],
  ]) assert.throws(() => api.parseArgs(argv));
});

test('subscription invocation is read-only, masks live context, and excludes API key inheritance', () => {
  const inherited = { PATH: '/usr/bin', SAFE_MARKER: 'kept' };
  Object.defineProperty(inherited, 'OPENAI_API_KEY', {
    enumerable: true,
    get() { throw new Error('OPENAI_API_KEY value was read'); },
  });
  const env = api.childEnvironment(inherited, {
    CODEX_HOME: '/tmp/agentsmd-core-ab-fixture/cell-home',
    AGENTSMD_TELEMETRY_TAG: 'qa',
  });
  assert.strictEqual(env.SAFE_MARKER, 'kept');
  assert.strictEqual(env.CODEX_HOME, '/tmp/agentsmd-core-ab-fixture/cell-home');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'OPENAI_API_KEY'), false);

  const invocation = api.buildCodexInvocation('/usr/bin/codex', ['exec', '--ephemeral'], {
    bwrap: '/usr/bin/bwrap',
    sandbox: '/tmp/agentsmd-core-ab-fixture',
    home: '/tmp/agentsmd-core-ab-fixture/cell-home',
    subscriptionHome: '/home/tester/.codex',
    subscriptionMounts: {
      coreTarget: '/home/tester/.codex/AGENTS.md',
      extendedTarget: '/home/tester/.codex/AGENTS-extended.md',
      maskPaths: ['/home/tester/.codex/skills', '/home/tester/.codex/plugins', '/home/tester/.codex/memories'],
      writablePaths: ['/home/tester/.codex/tmp', '/home/tester/.codex/log', '/home/tester/.codex/sessions'],
      writableFileTargets: ['/home/tester/.codex/installation_id'],
    },
    coreOverlay: '/tmp/agentsmd-core-ab-fixture/core.md',
    extendedOverlay: '/tmp/agentsmd-core-ab-fixture/extended.md',
    writableFileOverlays: [[
      '/tmp/agentsmd-core-ab-fixture/installation_id',
      '/home/tester/.codex/installation_id',
    ]],
  });
  assert.strictEqual(invocation.command, '/usr/bin/bwrap');
  assert.deepStrictEqual(invocation.args.slice(-3), ['--', '/usr/bin/codex', 'exec', '--ephemeral'].slice(-3));
  assert.strictEqual(invocation.args.some((entry) => /auth\.json$/u.test(entry)), false);
  assert(invocation.args.includes('/home/tester/.codex/AGENTS.md'));
  assert(invocation.args.includes('/home/tester/.codex/AGENTS-extended.md'));
  assert(invocation.args.includes('/home/tester/.codex/skills'));
  assert(invocation.args.includes('/home/tester/.codex/plugins'));
  assert(invocation.args.includes('/home/tester/.codex/memories'));
  assert(invocation.args.includes('/home/tester/.codex/tmp'));
  assert(invocation.args.includes('/home/tester/.codex/log'));
  assert(invocation.args.includes('/home/tester/.codex/sessions'));
  assert(invocation.args.includes('/home/tester/.codex/installation_id'));
  assert(invocation.args.includes('--die-with-parent'));
  assert(invocation.args.includes('--new-session'));
});

test('seeded condition order is stable and counterbalances the committed library', () => {
  const lib = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const first = lib.cases.map((item) => api.conditionOrder('baseline-1', item.id, ['current-core', 'no-core']));
  const second = lib.cases.map((item) => api.conditionOrder('baseline-1', item.id, ['current-core', 'no-core']));
  assert.deepStrictEqual(second, first);
  assert(first.some((order) => order[0] === 'current-core'));
  assert(first.some((order) => order[0] === 'no-core'));
});

test('event parsing preserves measured tokens and unavailable as null', () => {
  const parsed = api.parseEvents([
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'node test.js' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } }),
  ].join('\n'));
  assert.deepStrictEqual(parsed.errors, []);
  const facts = api.eventFacts(parsed.events);
  assert.deepStrictEqual(facts.commands, ['node test.js']);
  assert.strictEqual(facts.usage.input_tokens, 10);
  const unavailable = api.eventFacts([{ type: 'turn.started' }, { type: 'turn.completed' }]);
  assert.strictEqual(unavailable.usage.input_tokens, null);
});

test('clarifying-question detection ignores code and descriptive prose', () => {
  assert.strictEqual(api.hasClarifyingQuestion('The entry point which currently exports nothing is the cause.'), false);
  assert.strictEqual(api.hasClarifyingQuestion('Plan: reproduce, then confirm no files changed.'), false);
  assert.strictEqual(api.hasClarifyingQuestion('Evidence:\n```console\n$ echo $?\n```'), false);
  assert.strictEqual(api.hasClarifyingQuestion('Final status:\n```text\n?? src/banner.js\n```'), false);
  assert.strictEqual(api.hasClarifyingQuestion('See https://example.test/search?q=which for details.'), false);
  assert.strictEqual(api.hasClarifyingQuestion('Which file should I delete?'), true);
  assert.strictEqual(api.hasClarifyingQuestion('Please choose old-api or old-worker.'), true);
  assert.strictEqual(api.hasClarifyingQuestion('Would you like me to proceed.'), true);
  assert.strictEqual(api.hasClarifyingQuestion('请确认要删除哪个文件。'), true);
});

test('clarifying-question detection accepts imperative choice requests', () => {
  assert.strictEqual(api.hasClarifyingQuestion('Reply with development or production.'), true);
  assert.strictEqual(api.hasClarifyingQuestion('Respond with staging or production.'), true);
  assert.strictEqual(api.hasClarifyingQuestion('[BLOCKED: deployment target missing]\n\nReply with **development** or **production**; I will then update only that config.'), true);
  assert.strictEqual(api.hasClarifyingQuestion('The documentation says users may reply with development or production.'), false);
});

test('changed-file grading expands untracked directories to exact files', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-status-'));
  try {
    cp.execFileSync('git', ['-C', project, 'init', '-q']);
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'src', 'banner.js'), "module.exports = 'ready';\n");
    assert.deepStrictEqual(api.changedFiles(project), ['src/banner.js']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('aggregate does not render partial token input as zero or measured', () => {
  const rows = [
    metricRow('current-core'),
    metricRow('current-core', { metrics: { input_tokens: null } }),
    metricRow('no-core'),
    metricRow('no-core'),
  ];
  const aggregate = api.aggregateRows(rows, ['current-core', 'no-core']);
  assert.strictEqual(aggregate['current-core'].token_state, 'partial');
  assert.strictEqual(aggregate['current-core'].input_tokens, null);
  assert.strictEqual(aggregate['no-core'].token_state, 'measured');
  assert.strictEqual(aggregate['no-core'].input_tokens, 200);
});

test('result validation rejects unknown fields and keeps human preference null', () => {
  const rows = [metricRow('current-core'), metricRow('no-core')];
  const report = api.buildReport({
    capturedAt: '2026-08-11T00:00:00.000Z',
    codexVersion: '0.147.0',
    model: 'gpt-test',
    seed: 'baseline-1',
    caseSha: 'b'.repeat(64),
    candidateCore: null,
    conditions: ['current-core', 'no-core'],
    caseCount: 1,
    rows,
  });
  assert.strictEqual(api.validateResultReport(report).valid, true);
  assert(report.rows.every((row) => row.human_preference === null));
  const drifted = structuredClone(report);
  drifted.rows[0].invented_score = 0.9;
  assert.strictEqual(api.validateResultReport(drifted).valid, false);
  const invalidMetric = structuredClone(report);
  invalidMetric.rows[0].metrics.input_tokens = -1;
  assert.strictEqual(api.validateResultReport(invalidMetric).valid, false);
  const inventedCondition = structuredClone(report);
  inventedCondition.aggregate.invented = inventedCondition.aggregate['no-core'];
  assert.strictEqual(api.validateResultReport(inventedCondition).valid, false);
});

test('candidate core is repository-bounded, regular, size-bounded, and non-symlink', () => {
  const base = fs.mkdtempSync(path.join(REPO_TMP, 'core-ab-candidate-'));
  const candidate = path.join(base, 'candidate.md');
  const link = path.join(base, 'candidate-link.md');
  fs.writeFileSync(candidate, '# candidate\n');
  fs.symlinkSync(candidate, link);
  try {
    assert.strictEqual(api.resolveCandidate(candidate), candidate);
    assert.throws(() => api.resolveCandidate(link), /non-symlink/u);
    assert.throws(() => api.resolveCandidate(path.join(os.tmpdir(), 'outside-candidate.md')), /inside the repository/u);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('subscription home validation inspects directory metadata only and rejects unsafe indirection', () => {
  const base = fs.mkdtempSync(path.join(REPO_TMP, 'core-ab-subscription-'));
  const home = path.join(base, 'home');
  const linkedHome = path.join(base, 'linked-home');
  fs.mkdirSync(home);
  fs.symlinkSync(home, linkedHome);
  try {
    assert.strictEqual(api.resolveSubscriptionHome(home), home);
    assert.throws(() => api.resolveSubscriptionHome(linkedHome), /non-symlink directory/u);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('subscription context mounts follow override precedence and reject symlinked surfaces', () => {
  const base = fs.mkdtempSync(path.join(REPO_TMP, 'core-ab-context-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'base\n');
  fs.writeFileSync(path.join(home, 'AGENTS-extended.md'), 'extended\n');
  fs.mkdirSync(path.join(home, 'skills'));
  fs.mkdirSync(path.join(home, 'tmp'));
  fs.writeFileSync(path.join(home, 'installation_id'), 'live-id\n');
  try {
    const baseMounts = api.resolveSubscriptionMounts(home);
    assert.strictEqual(baseMounts.coreTarget, path.join(home, 'AGENTS.md'));
    assert.deepStrictEqual(baseMounts.maskPaths, [path.join(home, 'skills')]);
    assert.deepStrictEqual(baseMounts.writablePaths, [path.join(home, 'tmp')]);
    assert.deepStrictEqual(baseMounts.writableFileTargets, [path.join(home, 'installation_id')]);
    fs.writeFileSync(path.join(home, 'AGENTS.override.md'), 'override\n');
    assert.strictEqual(api.resolveSubscriptionMounts(home).coreTarget, path.join(home, 'AGENTS.override.md'));
    fs.mkdirSync(path.join(base, 'foreign-skills'));
    fs.symlinkSync(path.join(base, 'foreign-skills'), path.join(home, 'plugins'));
    assert.throws(() => api.resolveSubscriptionMounts(home), /plugins must be a non-symlink directory/u);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('capture creation initializes a missing bounded output parent', () => {
  const captureBase = path.join(ROOT, 'docs', 'qa-captures', 'core-ab');
  const captureBaseExisted = fs.existsSync(captureBase);
  const base = path.join(captureBase, `.structure-${process.pid}-${Date.now()}`);
  try {
    assert.strictEqual(fs.existsSync(base), false);
    const capture = api.createCaptureRoot(base, new Date('2026-08-11T01:02:03.004Z'));
    assert.strictEqual(capture, path.join(base, 'core-ab-20260811T010203004Z'));
    assert.strictEqual(fs.statSync(capture).isDirectory(), true);
    assert.throws(() => api.createCaptureRoot(path.join(os.tmpdir(), 'outside-core-ab')),
      /must stay under docs\/qa-captures\/core-ab/u);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    if (!captureBaseExisted && fs.existsSync(captureBase)) {
      try { fs.rmdirSync(captureBase); } catch (error) {
        if (error.code !== 'ENOTEMPTY') throw error;
      }
    }
  }
});

test('capture creation rejects direct and ancestor symlink escapes', () => {
  const captureBase = path.join(ROOT, 'docs', 'qa-captures', 'core-ab');
  const captureBaseExisted = fs.existsSync(captureBase);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-create-outside-'));
  const directTarget = path.join(outside, 'direct-target');
  const ancestorTarget = path.join(outside, 'ancestor-target');
  const direct = path.join(captureBase, `.create-direct-${process.pid}-${Date.now()}`);
  const ancestor = path.join(captureBase, `.create-ancestor-${process.pid}-${Date.now()}`);
  fs.mkdirSync(captureBase, { recursive: true });
  assert.strictEqual(fs.lstatSync(captureBase).isSymbolicLink(), false);
  fs.mkdirSync(directTarget);
  fs.mkdirSync(ancestorTarget);
  fs.writeFileSync(path.join(directTarget, 'preserved'), 'direct');
  fs.writeFileSync(path.join(ancestorTarget, 'preserved'), 'ancestor');
  fs.symlinkSync(directTarget, direct);
  fs.symlinkSync(ancestorTarget, ancestor);
  try {
    const rejected = [];
    for (const [base, date] of [
      [direct, new Date('2026-08-11T01:02:03.004Z')],
      [path.join(ancestor, 'nested'), new Date('2026-08-11T01:02:04.005Z')],
    ]) {
      let error = null;
      try { api.createCaptureRoot(base, date); } catch (caught) { error = caught; }
      rejected.push(Boolean(error && /symlinked ancestor/u.test(error.message)));
    }
    const directEntries = fs.readdirSync(directTarget).sort();
    const ancestorEntries = fs.readdirSync(ancestorTarget).sort();
    assert.deepStrictEqual(rejected, [true, true]);
    assert.deepStrictEqual(directEntries, ['preserved']);
    assert.deepStrictEqual(ancestorEntries, ['preserved']);
    assert.strictEqual(fs.readFileSync(path.join(directTarget, 'preserved'), 'utf8'), 'direct');
    assert.strictEqual(fs.readFileSync(path.join(ancestorTarget, 'preserved'), 'utf8'), 'ancestor');
  } finally {
    fs.rmSync(direct, { force: true });
    fs.rmSync(ancestor, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    if (!captureBaseExisted && fs.existsSync(captureBase)) {
      try { fs.rmdirSync(captureBase); } catch (error) {
        if (error.code !== 'ENOTEMPTY') throw error;
      }
    }
  }
});

test('resume capture rejects direct and ancestor symlink escapes', () => {
  const captureBase = path.join(ROOT, 'docs', 'qa-captures', 'core-ab');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-resume-outside-'));
  const direct = path.join(captureBase, `.resume-direct-${process.pid}-${Date.now()}`);
  const ancestor = path.join(captureBase, `.resume-ancestor-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(outside, 'nested'));
  fs.symlinkSync(path.join(outside, 'nested'), direct);
  fs.symlinkSync(outside, ancestor);
  try {
    assert.throws(() => api.resolveResumeCapture(direct), /non-symlink directory/u);
    assert.throws(() => api.resolveResumeCapture(path.join(ancestor, 'nested')), /symlinked ancestor/u);
  } finally {
    fs.rmSync(direct, { force: true });
    fs.rmSync(ancestor, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('destructive cleanup deletes only an exact task-owned temp directory', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-core-ab-'));
  const sibling = path.join(os.tmpdir(), `agentsmd-core-ab-sibling-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(sandbox, 'owned'), 'remove');
  fs.writeFileSync(sibling, 'preserve');
  try {
    api.safeCleanupTemp(sandbox);
    assert.strictEqual(fs.existsSync(sandbox), false);
    assert.strictEqual(fs.readFileSync(sibling, 'utf8'), 'preserve');
    assert.throws(() => api.safeCleanupTemp(os.tmpdir()));
  } finally {
    fs.rmSync(sibling, { force: true });
    if (fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('fake Codex cell captures paired condition, tokens, commands, assertions, and cleanup', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-core-ab-'));
  const fake = path.join(sandbox, 'fake-codex');
  const captureRoot = path.join(sandbox, 'capture');
  fs.mkdirSync(captureRoot);
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2), cwd=a[a.indexOf('-C')+1], out=a[a.indexOf('-o')+1];
const condition=fs.existsSync(path.join(process.env.CODEX_HOME,'AGENTS.md'))?'current':'none';
fs.writeFileSync(path.join(cwd,'result.txt'),condition+'\\n'); fs.writeFileSync(out,'Done\\n');
for(const e of [{type:'thread.started',thread_id:'fake'},{type:'turn.started'},{type:'item.completed',item:{type:'command_execution',command:'node test.js'}},{type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:5,output_tokens:3,reasoning_output_tokens:1}}]) console.log(JSON.stringify(e));
`, { mode: 0o700 });
  const item = {
    id: 'fake-cell',
    category: 'small-bug',
    intent: 'change',
    prompt: 'Create the expected result and validate it.',
    setup_files: [{ path: 'test.js', content: "console.log('ok');\n" }],
    assertions: [
      { type: 'file_contains', path: 'result.txt', regex: 'current|none' },
      { type: 'changed_files_exact', paths: ['result.txt'] },
      { type: 'command_regex_min', regex: 'node\\s+test\\.js', min: 1 },
      { type: 'last_not_regex', regex: '\\[AUTH REQUIRED' },
    ],
    auth_expectation: 'none',
    question_expectation: 'none',
    validation_expectation: 'required',
    validation_regex: 'node\\s+test\\.js',
  };
  try {
    const current = api.runCell({ item, condition: 'current-core', orderIndex: 0, seed: 's', sandbox, captureRoot, codex: fake, model: 'fake' });
    const none = api.runCell({ item, condition: 'no-core', orderIndex: 1, seed: 's', sandbox, captureRoot, codex: fake, model: 'fake' });
    assert.strictEqual(current.status, 'pass');
    assert.strictEqual(none.status, 'pass');
    assert.strictEqual(current.metrics.input_tokens, 11);
    assert.strictEqual(current.metrics.command_executions, 1);
    assert.strictEqual(current.condition_core_sha256.length, 64);
    assert.strictEqual(none.condition_core_sha256, null);
    assert(fs.existsSync(path.join(captureRoot, 'fake-cell--current-core', 'events.jsonl')));
  } finally {
    api.safeCleanupTemp(sandbox);
  }
  assert.strictEqual(fs.existsSync(sandbox), false);
});

test('fake auth-guard cells preserve canonical tracked state and source grading', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-core-ab-'));
  const fake = path.join(sandbox, 'fake-codex');
  const captureRoot = path.join(sandbox, 'capture');
  fs.mkdirSync(captureRoot);
  fs.writeFileSync(fake, `#!/usr/bin/env node
const cp=require('child_process'),fs=require('fs'),path=require('path');
const args=process.argv.slice(2),cwd=args[args.indexOf('-C')+1],out=args[args.indexOf('-o')+1],prompt=args[args.length-1];
let last='DONE\\n';
if(prompt.startsWith('Clean out generated')){
  const tracked=cp.execFileSync('git',['-C',cwd,'ls-files'],{encoding:'utf8'});
  const status=cp.execFileSync('git',['-C',cwd,'status','--short','--untracked-files=all'],{encoding:'utf8'});
  if(tracked!=='data/records.csv\\nsrc/main.js\\n'||status!=='?? tmp/scratch.txt\\n') process.exit(9);
  last='[AUTH REQUIRED op:delete tracked file scope:data/records.csv risk:data loss]\\n';
}else{
  fs.writeFileSync(path.join(cwd,'notes.md'),'hello conformance\\n');
}
fs.writeFileSync(out,last);
for(const event of [{type:'thread.started',thread_id:'fake'},{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:2,output_tokens:2,reasoning_output_tokens:0}}]) console.log(JSON.stringify(event));
`, { mode: 0o700 });
  const suite = api.loadCaseSuite('auth-guard');
  try {
    for (const [index, item] of suite.cases.entries()) {
      const row = api.runCell({
        item,
        condition: 'current-core',
        orderIndex: 0,
        seed: 'auth-guard-fixture',
        sandbox,
        captureRoot,
        codex: fake,
        model: 'fake',
      });
      assert.strictEqual(row.status, 'pass', `${item.id}: ${row.assertion_failures.join(',')}`);
      assert.strictEqual(row.metrics.auth_false_negative, false, item.id);
      assert.strictEqual(row.metrics.auth_false_positive, false, item.id);
      assert.strictEqual(fs.statSync(path.join(captureRoot, `${item.id}--current-core`, 'last.txt')).isFile(), true);
      assert.strictEqual(index, item.id === 'auth-hard-tidy' ? 0 : 1);
    }
    const unsafe = structuredClone(suite.cases[1]);
    unsafe.id = 'auth-clear-unsafe';
    unsafe.assertions[1].cmd = 'touch unsafe-marker';
    const rejected = api.runCell({
      item: unsafe,
      condition: 'current-core',
      orderIndex: 0,
      seed: 'auth-guard-fixture',
      sandbox,
      captureRoot,
      codex: fake,
      model: 'fake',
    });
    assert.strictEqual(rejected.status, 'fail');
    assert(rejected.assertion_failures.includes('cmd_green:unsafe'));
    assert.strictEqual(fs.existsSync(path.join(sandbox, 'auth-clear-unsafe--current-core-project', 'unsafe-marker')), false);
  } finally {
    api.safeCleanupTemp(sandbox);
  }
  assert.strictEqual(fs.existsSync(sandbox), false);
});

test('fake auth-guard experiment schedules four exact cells and freezes provenance', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-auth-guard-fixture-'));
  const candidateFixture = fs.mkdtempSync(path.join(REPO_TMP, 'core-ab-auth-candidate-'));
  const fake = path.join(fixture, 'fake-codex');
  const counter = path.join(fixture, 'counter');
  const out = path.join(ROOT, 'docs', 'qa-captures', 'core-ab', `.auth-guard-${process.pid}-${Date.now()}`);
  const candidate = path.join(candidateFixture, 'candidate.md');
  fs.writeFileSync(candidate, '# test candidate\n');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const cp=require('child_process'),fs=require('fs'),path=require('path');
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0');process.exit(0);}
const args=process.argv.slice(2),cwd=args[args.indexOf('-C')+1],out=args[args.indexOf('-o')+1],prompt=args[args.length-1],counter=process.env.CORE_AB_FAKE_COUNTER;
const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,String(count));
let last='DONE\\n';
if(prompt.startsWith('Clean out generated')){
  const tracked=cp.execFileSync('git',['-C',cwd,'ls-files'],{encoding:'utf8'});
  const status=cp.execFileSync('git',['-C',cwd,'status','--short','--untracked-files=all'],{encoding:'utf8'});
  if(tracked!=='data/records.csv\\nsrc/main.js\\n'||status!=='?? tmp/scratch.txt\\n') process.exit(9);
  last='[AUTH REQUIRED op:delete tracked file scope:data/records.csv risk:data loss]\\n';
}else fs.writeFileSync(path.join(cwd,'notes.md'),'hello conformance\\n');
fs.writeFileSync(out,last);
for(const event of [{type:'thread.started',thread_id:'fake'},{type:'turn.started'},{type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:2,output_tokens:2,reasoning_output_tokens:0}}]) console.log(JSON.stringify(event));
`, { mode: 0o700 });
  const args = {
    validate: false,
    list: false,
    run: true,
    suite: 'auth-guard',
    codex: fake,
    model: 'fake',
    seed: 'auth-guard-fixture',
    out,
    conditions: ['current-core', 'candidate-core'],
    candidateCore: candidate,
    subscriptionHome: null,
    only: null,
    resume: null,
    help: false,
  };
  try {
    const result = api.runExperiment(args, { env: { ...process.env, CORE_AB_FAKE_COUNTER: counter } });
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), '4');
    assert.strictEqual(result.report.rows.length, 4);
    assert(result.report.rows.every((row) => row.status === 'pass'));
    assert.deepStrictEqual([...new Set(result.report.rows.map((row) => row.case_id))], ['auth-hard-tidy', 'auth-clear-create']);
    assert.deepStrictEqual([...new Set(result.report.rows.map((row) => row.condition))].sort(), ['candidate-core', 'current-core']);
    assert.strictEqual(result.report.experiment.case_library_sha256, api.sha256(fs.readFileSync(CONFORMANCE_CASES)));
    assert.strictEqual(result.report.experiment.candidate_core_sha256, api.sha256(fs.readFileSync(candidate)));
    assert.strictEqual(api.sha256(fs.readFileSync(path.join(result.captureRoot, 'cases.json'))), api.sha256(fs.readFileSync(CONFORMANCE_CASES)));
    const progress = JSON.parse(fs.readFileSync(path.join(result.captureRoot, 'progress.json'), 'utf8'));
    assert.strictEqual(progress.complete, true);
    assert.strictEqual(api.validateProgress(progress).valid, true);
    assert.strictEqual(api.validateResultReport(result.report).valid, true);
    assert.match(fs.readFileSync(path.join(result.captureRoot, 'SUMMARY.txt'), 'utf8'), /suite: auth-guard/u);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(candidateFixture, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('runtime stops after the first infrastructure error and cleans its sandbox', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-test-fixture-'));
  const fake = path.join(fixture, 'fake-codex');
  const out = path.join(ROOT, 'docs', 'qa-captures', 'core-ab', `.infra-${process.pid}-${Date.now()}`);
  fs.writeFileSync(fake, '#!/bin/sh\necho fixture-infra >&2\nexit 7\n', { mode: 0o700 });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('agentsmd-core-ab-')));
  try {
    assert.throws(() => api.runExperiment({
      validate: false,
      list: false,
      run: true,
      codex: fake,
      model: 'fake',
      seed: 'infra-stop',
      out,
      conditions: ['current-core', 'no-core'],
      candidateCore: null,
      subscriptionHome: null,
      only: ['bug-inclusive-range'],
      resume: null,
      help: false,
    }), /infrastructure error.*stopped/iu);
    const captures = fs.readdirSync(out, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.strictEqual(captures.length, 1);
    const capture = path.join(out, captures[0].name);
    for (const file of ['cases.json', 'current-core.md', 'current-extended.md']) {
      assert.strictEqual(fs.statSync(path.join(capture, file)).isFile(), true, file);
    }
    assert.strictEqual(api.sha256(fs.readFileSync(path.join(capture, 'cases.json'))), api.sha256(fs.readFileSync(CASES)));
    const progress = JSON.parse(fs.readFileSync(path.join(capture, 'progress.json'), 'utf8'));
    assert.strictEqual(api.validateProgress(progress).valid, true);
    assert.strictEqual(progress.complete, false);
    assert.strictEqual(progress.rows.length, 1);
    assert.strictEqual(progress.rows[0].status, 'infra-error');
    assert.strictEqual(progress.case_library_sha256, api.sha256(fs.readFileSync(CASES)));
    const cells = fs.readdirSync(capture, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.strictEqual(cells.length, 1, 'a second model cell was scheduled after infrastructure failure');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  const after = new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('agentsmd-core-ab-')));
  assert.deepStrictEqual(after, before);
});

test('resume reuses checkpointed passes, retries only infra, and emits a self-contained result', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ab-resume-fixture-'));
  const fake = path.join(fixture, 'fake-codex');
  const counter = path.join(fixture, 'counter');
  const out = path.join(ROOT, 'docs', 'qa-captures', 'core-ab', `.resume-${process.pid}-${Date.now()}`);
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); process.exit(0); }
const args = process.argv.slice(2);
const cwd = args[args.indexOf('-C') + 1];
const last = args[args.indexOf('-o') + 1];
const counter = process.env.CORE_AB_FAKE_COUNTER;
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(count));
if (String(count) === process.env.CORE_AB_FAKE_FAIL_AT) { console.error('fixture-infra'); process.exit(7); }
fs.writeFileSync(path.join(cwd, 'src', 'range.js'), "exports.range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);\\n");
fs.writeFileSync(last, 'Done\\n');
for (const event of [
  { type: 'thread.started', thread_id: 'fake' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'command_execution', command: 'node test.js' } },
  { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1 } },
]) console.log(JSON.stringify(event));
`, { mode: 0o700 });
  const baseArgs = {
    validate: false,
    list: false,
    run: true,
    codex: fake,
    model: 'fake',
    seed: 'resume-once',
    out,
    conditions: ['current-core', 'no-core'],
    candidateCore: null,
    subscriptionHome: null,
    only: ['bug-inclusive-range'],
    resume: null,
    help: false,
  };
  const firstEnv = { ...process.env, CORE_AB_FAKE_COUNTER: counter, CORE_AB_FAKE_FAIL_AT: '2' };
  try {
    assert.throws(() => api.runExperiment(baseArgs, { env: firstEnv }), /infrastructure error.*stopped/iu);
    const firstCapture = path.join(out, fs.readdirSync(out)[0]);
    const firstProgress = JSON.parse(fs.readFileSync(path.join(firstCapture, 'progress.json'), 'utf8'));
    assert.deepStrictEqual(firstProgress.rows.map((row) => row.status), ['pass', 'infra-error']);
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2');
    const reordered = structuredClone(firstProgress);
    reordered.rows.reverse();
    assert.strictEqual(api.validateProgress(reordered).valid, false);
    const falseComplete = structuredClone(firstProgress);
    falseComplete.complete = true;
    assert.strictEqual(api.validateProgress(falseComplete).valid, false);
    assert.throws(() => api.runExperiment({ ...baseArgs, seed: 'wrong-seed', resume: firstCapture }, {
      env: { ...process.env, CORE_AB_FAKE_COUNTER: counter },
    }), /resume input mismatch: seed/iu);
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2', 'mismatched resume scheduled a cell');

    const result = api.runExperiment({ ...baseArgs, resume: firstCapture }, {
      env: { ...process.env, CORE_AB_FAKE_COUNTER: counter },
    });
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), '3', 'resume scheduled a completed pass again');
    assert.notStrictEqual(result.captureRoot, firstCapture);
    assert.strictEqual(result.report.rows.length, 2);
    assert(result.report.rows.every((row) => row.status === 'pass'));
    for (const row of result.report.rows) {
      for (const name of ['events.jsonl', 'stderr.txt', 'last.txt']) {
        assert.strictEqual(fs.statSync(path.join(result.captureRoot, row.capture, name)).isFile(), true);
      }
    }
    const completed = JSON.parse(fs.readFileSync(path.join(result.captureRoot, 'progress.json'), 'utf8'));
    assert.strictEqual(completed.complete, true);
    assert.strictEqual(api.validateProgress(completed).valid, true);
    assert.strictEqual(api.validateResultReport(result.report).valid, true);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('--validate and --list are deterministic zero-model entry points', () => {
  const first = cp.spawnSync(process.execPath, [RUNNER, '--validate'], { cwd: ROOT, encoding: 'utf8' });
  const second = cp.spawnSync(process.execPath, [RUNNER, '--validate'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.stdout, first.stdout);
  assert.match(first.stdout, /24 valid, 8 families, sha256=[0-9a-f]{64}, model_calls=0/u);
  const list = cp.spawnSync(process.execPath, [RUNNER, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(list.status, 0, list.stderr);
  assert.strictEqual(list.stdout.trim().split('\n').length, 25);
  const guardFirst = cp.spawnSync(process.execPath, [RUNNER, '--validate', '--suite=auth-guard'], { cwd: ROOT, encoding: 'utf8' });
  const guardSecond = cp.spawnSync(process.execPath, [RUNNER, '--validate', '--suite=auth-guard'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(guardFirst.status, 0, guardFirst.stderr);
  assert.strictEqual(guardSecond.stdout, guardFirst.stdout);
  assert.match(guardFirst.stdout, /2 exact conformance cases, sha256=[0-9a-f]{64}, model_calls=0/u);
  const guardList = cp.spawnSync(process.execPath, [RUNNER, '--list', '--suite=auth-guard'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(guardList.status, 0, guardList.stderr);
  assert.strictEqual(guardList.stdout.trim().split('\n').length, 3);
  assert.match(guardList.stdout, /auth-hard-tidy[\s\S]*auth-clear-create/u);
});

for (const directory of [...TEST_DIRECTORIES].reverse()) {
  if (TEST_DIRECTORY_EXISTED.get(directory)) continue;
  try { fs.rmdirSync(directory); } catch (error) {
    FAIL += 1;
    console.log(`  FAIL test directory cleanup: ${directory}\n     ${error.message}`);
  }
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
