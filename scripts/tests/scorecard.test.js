'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildScorecard,
  compareScorecards,
  formatScorecard,
  loadComparison,
  parseArgs,
  probeRegularFile,
  validateScorecard,
} = require('../lib/scorecard');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = Date.parse('2026-07-29T12:00:00.000Z');

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

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-scorecard.'));
try {
  const home = path.join(temp, 'home');
  const project = path.join(temp, 'project');
  const captures = path.join(temp, 'captures');
  const automation = path.join(temp, 'automation');
  const workflows = path.join(temp, 'workflows');
  const logPath = path.join(home, 'logs', 'agentsmd.jsonl');
  const sessionsDir = path.join(home, 'sessions');
  const configPath = path.join(home, 'config.toml');
  const globalAgentsPath = path.join(home, 'AGENTS.md');
  const perfPath = path.join(temp, 'baseline.json');

  write(configPath, 'project_doc_max_bytes = 1000\n');
  write(globalAgentsPath, 'g'.repeat(100));
  write(path.join(project, 'AGENTS.md'), 'p'.repeat(200));
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  write(logPath, jsonl([
    {
      ts: '2026-07-28T01:00:00.000Z',
      hook: 'session-start-check',
      event: 'session-dimension',
      project: '-work-client-',
      session_id: 'external-session',
      spec_version: 'v5.0.1',
      agentsmd_version: '5.0.1',
      surface: 'standalone',
      codex_version: '0.145.0',
      model: 'gpt-5.6-sol',
      platform: 'linux-x64',
    },
    {
      ts: '2026-07-28T01:01:00.000Z',
      hook: 'transcript-structure-scan',
      event: 'advisory',
      project: '-work-client-',
      session_id: 'external-session',
      spec_section: '§10-V',
    },
    {
      ts: '2026-07-28T01:02:00.000Z',
      hook: 'session-exit-checkpoint',
      event: 'compat-fallback',
      project: '-work-client-',
      session_id: 'external-session',
      extra: { reason: 'native-summary-missing' },
    },
    {
      ts: '2026-07-28T01:03:00.000Z',
      hook: 'memory-prompt-hint',
      event: 'suggest',
      project: '-work-client-',
      session_id: 'missing-transcript',
      extra: { suggested: ['memory/release.md'] },
    },
    {
      ts: '2026-07-28T02:00:00.000Z',
      hook: 'session-start-check',
      event: 'session-dimension',
      project: '-tmp-agentsmd-fixture-',
      session_id: 'test-session',
      spec_version: 'v5.0.1',
      agentsmd_version: '5.0.1',
      surface: 'standalone',
      codex_version: '0.145.0',
      model: 'gpt-5.6-sol',
      platform: 'linux-x64',
      tag: 'test',
    },
    {
      ts: '2026-07-28T02:01:00.000Z',
      hook: 's8-rm-rf-var',
      event: 'deny',
      project: '-tmp-agentsmd-fixture-',
      session_id: 'test-session',
      spec_section: '§8-rm-rf-var',
      tag: 'test',
    },
  ]));

  write(path.join(captures, 'conformance-20260728T000000Z', 'results.json'), JSON.stringify({
    meta: {
      stamp: '20260728T000000Z',
      codex: '0.145.0',
      model: 'gpt-5.6-sol',
      agentsmd: '5.0.1',
      cases: 4,
    },
    categories: {
      auth: { pass: 2, total: 2, errors: 0 },
      'false-block': { pass: 2, total: 2, errors: 0 },
    },
    cases: [
      { id: 'auth', category: 'auth', verdict: 'pass' },
      { id: 'auth-near', category: 'auth', verdict: 'pass' },
      { id: 'false-one', category: 'false-block', verdict: 'pass' },
      { id: 'false-two', category: 'false-block', verdict: 'pass' },
    ],
  }));
  write(path.join(captures, 'conformance-20260729T010000Z', 'results.json'), JSON.stringify({
    meta: {
      stamp: '20260729T010000Z',
      codex: '0.145.0',
      model: 'gpt-5.6-sol',
      agentsmd: '5.0.1',
      cases: 1,
    },
    categories: { auth: { pass: 1, total: 1, errors: 0 } },
    cases: [{ id: 'auth', category: 'auth', verdict: 'pass' }],
  }));

  write(perfPath, JSON.stringify({
    schemaVersion: 2,
    recorded: '2026-07-28',
    sloVerdict: 'PASS',
    env: { agentsmd: '5.0.1', codex: '0.145.0' },
    aggregateProcess: { dualWarmPretoolUseRatio: 2.31 },
    concurrentWall: { dualWarmPretoolUseRatio: 1.22 },
    worstHookP95FractionOfTimeout: 0.059,
  }));

  for (const name of [
    'weekly-runtime-canary.md',
    'weekly-governance-review.md',
    'release-readiness.md',
    'pr-review.md',
  ]) write(path.join(automation, name), `${name}\n`);
  write(path.join(workflows, 'runtime-canary.yml'), 'on:\n  schedule:\n    - cron: "0 3 * * 1"\n');
  write(path.join(workflows, 'governance-review.yml'), 'on:\n  schedule:\n    - cron: "0 4 * * 1"\n');

  const scorecardOptions = {
    root: ROOT,
    codexHome: home,
    projectRoot: project,
    logPath,
    sessionsDir,
    conformanceRoot: captures,
    perfPath,
    automationRoot: automation,
    workflowsRoot: workflows,
    configPath,
    globalAgentsPath,
    now: NOW,
    days: 30,
    expectedConformanceCaseIds: ['auth', 'auth-near', 'false-one', 'false-two'],
    statusResult: {
      installed: true,
      installedVersion: '5.0.1',
      selectedSurface: 'standalone',
      enforcement: true,
      killSwitches: { global: false, disabled: [] },
    },
    doctorResult: {
      ok: true,
      checks: [
        { name: 'jq present', ok: true },
        { name: 'hook wiring', ok: true },
      ],
    },
    worktrees: [
      { path: project, current: true, locked: false, prunable: false },
      { path: path.join(temp, 'stale-worktree'), current: false, locked: false, prunable: true },
    ],
  };
  const card = buildScorecard(scorecardOptions);

  test('scorecard is versioned, bounded, and schema-valid', () => {
    const result = validateScorecard(card);
    assert.strictEqual(result.valid, true, result.errors.join('\n'));
    assert.strictEqual(card.schema_version, 2);
    assert(JSON.stringify(card).length < 262144);
  });

  test('compatibility joins dimensions and separates test data from field data', () => {
    assert.strictEqual(card.compatibility.dimension_sessions, 1);
    assert.strictEqual(card.compatibility.missing_dimension_sessions, 1);
    assert.deepStrictEqual(card.compatibility.data_classes, {
      external: 4,
      self: 0,
      test: 2,
      qa: 0,
      unknown: 0,
    });
    assert.strictEqual(card.compatibility.runtime_splits[0].codex_version, '0.145.0');
    assert.strictEqual(card.compatibility.runtime_splits[0].sessions, 1);
  });

  test('quality sections retain denominators and refuse proxy overclaims', () => {
    assert.strictEqual(card.conformance.state, 'fresh');
    assert.strictEqual(card.conformance.capture, 'conformance-20260728T000000Z');
    assert.strictEqual(card.conformance.passed, 4);
    assert.strictEqual(card.conformance.total, 4);
    assert.strictEqual(card.false_blocks.state, 'unmeasured');
    assert.match(card.false_blocks.limit, /human-reviewed outcome/);
    assert(card.bypasses.no_opportunity > 0);
    assert.strictEqual(card.bypasses.no_opportunity_is_success, false);
    assert.strictEqual(card.evidence_discipline.calibration_is_governance_signal, false);
    assert.strictEqual(card.memory.citation_is_adherence, false);
  });

  test('performance, prompt budget, automation, fallback, and residue stay explicit', () => {
    assert.strictEqual(card.performance.state, 'fresh');
    assert.strictEqual(card.performance.concurrent_wall_ratio, 1.22);
    assert.deepStrictEqual(card.prompt_budget, {
      cap: 1000,
      global_bytes: 100,
      project_bytes: 200,
      total_bytes: 300,
      headroom_bytes: 700,
      over_bytes: -700,
      state: 'measured',
      sources: {
        config: { path: configPath, state: 'measured', bytes: 29 },
        global: { path: globalAgentsPath, state: 'measured', bytes: 100 },
        project: {
          root: project,
          state: 'measured',
          bytes: 200,
          files: [{ path: path.join(project, 'AGENTS.md'), state: 'measured', bytes: 200 }],
        },
      },
    });
    assert.deepStrictEqual(card.health.provenance, {
      root: ROOT,
      codex_home: home,
      status_source: 'supplied',
      doctor_source: 'supplied',
    });
    assert.strictEqual(card.automation.recipes_present, 4);
    assert.strictEqual(card.automation.scheduled_workflows, 2);
    assert.strictEqual(card.automation.fallback_events, 1);
    assert.strictEqual(card.automation.worktree_residue, 1);
  });

  test('prompt budget distinguishes empty, missing, invalid, and unavailable inputs', () => {
    const empty = path.join(home, 'empty-AGENTS.md');
    write(empty, '');
    const emptyCard = buildScorecard({ ...scorecardOptions, globalAgentsPath: empty });
    assert.strictEqual(emptyCard.prompt_budget.state, 'measured');
    assert.strictEqual(emptyCard.prompt_budget.global_bytes, 0);
    assert.strictEqual(emptyCard.prompt_budget.sources.global.state, 'empty');

    const missing = path.join(home, 'missing-AGENTS.md');
    const missingCard = buildScorecard({ ...scorecardOptions, globalAgentsPath: missing });
    assert.strictEqual(missingCard.prompt_budget.state, 'partial');
    assert.strictEqual(missingCard.prompt_budget.global_bytes, null);
    assert.strictEqual(missingCard.prompt_budget.sources.global.state, 'missing');

    const confirmedAbsent = buildScorecard({
      ...scorecardOptions,
      configPath: path.join(home, 'missing-config.toml'),
      globalAgentsPath: missing,
      statusResult: {
        installed: false,
        selectedSurface: null,
        enforcement: true,
        killSwitches: { global: false, disabled: [] },
      },
      doctorResult: { ok: false, checks: [] },
    });
    assert.strictEqual(confirmedAbsent.prompt_budget.state, 'measured');
    assert.strictEqual(confirmedAbsent.prompt_budget.cap, 32768);
    assert.strictEqual(confirmedAbsent.prompt_budget.global_bytes, 0);
    assert.strictEqual(confirmedAbsent.prompt_budget.sources.config.state, 'missing');

    const linked = path.join(home, 'linked-AGENTS.md');
    fs.symlinkSync(globalAgentsPath, linked);
    const partial = buildScorecard({ ...scorecardOptions, globalAgentsPath: linked });
    assert.strictEqual(partial.prompt_budget.state, 'partial');
    assert.strictEqual(partial.prompt_budget.global_bytes, null);
    assert.strictEqual(partial.prompt_budget.total_bytes, null);
    assert.strictEqual(partial.prompt_budget.headroom_bytes, null);
    assert.strictEqual(partial.prompt_budget.sources.global.state, 'invalid');
    assert(partial.recommended_actions.some((item) => item.code === 'prompt-budget-incomplete'));

    const linkedConfig = path.join(home, 'linked-config.toml');
    fs.symlinkSync(configPath, linkedConfig);
    const unavailable = buildScorecard({
      ...scorecardOptions,
      configPath: linkedConfig,
      globalAgentsPath: linked,
      projectRoot: path.join(temp, 'missing-project'),
    });
    assert.strictEqual(unavailable.prompt_budget.state, 'unavailable');
    assert.strictEqual(unavailable.prompt_budget.cap, null);
    assert.strictEqual(unavailable.prompt_budget.global_bytes, null);
    assert.strictEqual(unavailable.prompt_budget.project_bytes, null);
    assert.strictEqual(unavailable.prompt_budget.sources.project.state, 'unavailable');

    const denied = new Error('permission denied');
    denied.code = 'EACCES';
    assert.deepStrictEqual(
      probeRegularFile('/denied/AGENTS.md', 262144, { lstatSync() { throw denied; } }),
      { path: '/denied/AGENTS.md', state: 'unavailable', bytes: null },
    );
    let closed = false;
    const regular = (dev, ino) => ({ dev, ino, size: 10, isFile: () => true, isSymbolicLink: () => false });
    assert.deepStrictEqual(
      probeRegularFile('/raced/AGENTS.md', 262144, {
        lstatSync: () => regular(1, 1),
        openSync: () => 7,
        fstatSync: () => regular(1, 2),
        closeSync: () => { closed = true; },
      }),
      { path: '/raced/AGENTS.md', state: 'invalid', bytes: null },
    );
    assert.strictEqual(closed, true);
  });

  test('human prompt-budget output never renders null measurements as zero or green', () => {
    const linked = path.join(home, 'format-linked-AGENTS.md');
    fs.symlinkSync(globalAgentsPath, linked);
    const partial = buildScorecard({ ...scorecardOptions, globalAgentsPath: linked });
    const text = formatScorecard(partial);
    assert.match(text, /state: partial/);
    assert.match(text, /n\/a\/1000 bytes/);
    assert.match(text, /global invalid/);
    assert.doesNotMatch(text, /within-budget/);
  });

  test('human report preserves the roadmap section order and measurement limits', () => {
    const text = formatScorecard(card);
    const labels = [
      'Health',
      'Compatibility',
      'Conformance',
      'False blocks',
      'Bypasses',
      'Evidence discipline',
      'Performance',
      'Memory',
      'Prompt budget',
      'Automation',
      'Recommended operator actions',
      'Measurement limits',
    ];
    let cursor = -1;
    for (const label of labels) {
      const index = text.indexOf(`\n${label}\n`);
      assert(index > cursor, `${label} is out of order`);
      cursor = index;
    }
  });

  test('comparison reads only a validated bounded capture and emits numeric deltas', () => {
    const previous = structuredClone(card);
    previous.generated_at = '2026-06-29T12:00:00.000Z';
    previous.health.failed_checks = 2;
    previous.automation.fallback_events = 4;
    const comparePath = path.join(temp, 'previous.json');
    write(comparePath, JSON.stringify(previous));
    const loaded = loadComparison(comparePath);
    const compared = compareScorecards(card, loaded, path.basename(comparePath));
    assert.strictEqual(compared.comparison.deltas.failed_health_checks, -2);
    assert.strictEqual(compared.comparison.deltas.fallback_events, -3);
    assert.strictEqual(validateScorecard(compared).valid, true);
  });

  test('comparison rejects symlinks, oversized files, malformed JSON, and future schema', () => {
    const target = path.join(temp, 'target.json');
    write(target, JSON.stringify(card));
    const symlink = path.join(temp, 'linked.json');
    fs.symlinkSync(target, symlink);
    assert.throws(() => loadComparison(symlink), /regular non-symlink/);
    const huge = path.join(temp, 'huge.json');
    write(huge, 'x'.repeat(1048577));
    assert.throws(() => loadComparison(huge), /1048576/);
    const malformed = path.join(temp, 'malformed.json');
    write(malformed, '{');
    assert.throws(() => loadComparison(malformed), /valid JSON/);
    const legacy = path.join(temp, 'legacy-v1.json');
    write(legacy, JSON.stringify({ ...card, schema_version: 1 }));
    assert.throws(() => loadComparison(legacy), /schema_version.*expected 2/);
    const future = path.join(temp, 'future.json');
    write(future, JSON.stringify({ ...card, schema_version: 3 }));
    assert.throws(() => loadComparison(future), /schema_version/);
  });

  test('argv is strict and keeps days/json/compare independent', () => {
    assert.deepStrictEqual(parseArgs(['--days=7', '--json', '--compare=old.json']), {
      days: 7,
      json: true,
      compare: 'old.json',
    });
    assert.strictEqual(parseArgs(['--days']).error.includes("requires '=value'"), true);
    assert.strictEqual(parseArgs(['--days=0']).error.includes('invalid --days'), true);
    assert.strictEqual(parseArgs(['--json=true']).error.includes('does not take a value'), true);
    assert.strictEqual(parseArgs(['old.json']).error.includes('Unknown argument'), true);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
