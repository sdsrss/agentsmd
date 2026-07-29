#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ArgvError, parseStrict } = require('../scripts/lib/argv');
const { doctor } = require('../scripts/doctor');
const { perfBaseline } = require('../scripts/perf-baseline');
const { status } = require('../scripts/status');
const { validateSchema } = require('../scripts/lib/task-contract');
const EVENT_CANARY = require('./event-journal-runtime-canary');
const PACKAGE = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'runtime-canary.schema.json'), 'utf8'));
const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'perf', 'baseline.json'), 'utf8'));
const MAX_OUTPUT_BYTES = 128 * 1024;
const USAGE = `Usage: node qa/runtime-canary.js --channel=pinned|latest [options]

Run isolated install health, the structural hook contract, positive and
near-negative real-runtime turns, and a five-run informational performance trend.

  --channel=NAME  Required matrix lane: pinned or latest
  --codex=PATH    Codex executable (default: codex)
  --model=NAME    Optional model override
  --out=DIR       Capture root (default: docs/qa-captures)
  -h, --help      Show this help

Exit: 0 observed pass · 1 runtime/contract failure · 2 usage error`;

function parseArgs(argv) {
  const help = argv.some((arg) => arg === '-h' || arg === '--help');
  const remaining = argv.filter((arg) => arg !== '-h' && arg !== '--help');
  const parsed = parseStrict(remaining, {
    values: ['channel', 'codex', 'model', 'out'],
  });
  const keys = remaining.map((arg) => arg.slice(2).split('=', 1)[0]);
  if (new Set(keys).size !== keys.length) throw new ArgvError('Duplicate options are not allowed');
  for (const key of ['channel', 'codex', 'model', 'out']) {
    if (Object.hasOwn(parsed.values, key) && parsed.values[key].trim() === '') {
      throw new ArgvError(`--${key} requires a non-empty value`);
    }
  }
  const channel = parsed.values.channel;
  if (!['pinned', 'latest'].includes(channel)) {
    throw new ArgvError('--channel is required and must be pinned or latest');
  }
  return {
    channel,
    codex: parsed.values.codex || 'codex',
    model: parsed.values.model || null,
    out: parsed.values.out || null,
    help,
  };
}

function bounded(value, fallback = 'unknown', max = 256) {
  return String(value == null || value === '' ? fallback : value).slice(0, max);
}

function validateReport(report) {
  const errors = validateSchema(report, SCHEMA, SCHEMA);
  let raw = '';
  try { raw = JSON.stringify(report); } catch (error) { errors.push(`$: cannot serialize (${error.message})`); }
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) errors.push(`$: exceeds ${MAX_OUTPUT_BYTES} bytes`);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function scenarioSummary(item) {
  const evidence = item && item.evidence ? item.evidence : {};
  return {
    scenario: item && item.scenario === 'near-negative' ? 'near-negative' : 'positive',
    pass: Boolean(item && item.pass),
    failures: Array.isArray(item && item.failures)
      ? item.failures.slice(0, 32).map((failure) => bounded(failure, 'unknown failure', 512))
      : ['missing scenario result'],
    evidence: {
      events: Number.isInteger(evidence.events) && evidence.events >= 0 ? evidence.events : 0,
      changed_files: Array.isArray(evidence.changed_files)
        ? evidence.changed_files.slice(0, 16).map((file) => bounded(file))
        : [],
      validation_completed: Boolean(evidence.validation_completed),
      privacy_allowlist: Boolean(evidence.privacy_allowlist),
    },
  };
}

function buildReport({
  channel,
  capturedAt,
  codexVersion,
  model,
  statusResult,
  doctorResult,
  hookContract,
  scenarios,
  performance,
}) {
  const checks = Array.isArray(doctorResult && doctorResult.checks) ? doctorResult.checks : [];
  const failedChecks = checks.filter((check) => !check.ok)
    .slice(0, 32)
    .map((check) => bounded(check.name, 'unnamed check', 512));
  const scenarioRows = (scenarios || []).map(scenarioSummary);
  const scenarioNames = new Set(scenarioRows.map((row) => row.scenario));
  const scenarioComplete = scenarioRows.length === 2
    && scenarioNames.size === 2
    && scenarioNames.has('positive')
    && scenarioNames.has('near-negative');
  const healthPass = Boolean(
    statusResult
    && statusResult.installed
    && statusResult.enforcement !== false
    && doctorResult
    && doctorResult.ok
  );
  const contractPass = Boolean(hookContract && hookContract.exit_code === 0 && hookContract.failed === 0);
  const pass = healthPass && contractPass && scenarioComplete && scenarioRows.every((row) => row.pass);
  const failures = [];
  if (!healthPass) failures.push('isolated install status/doctor did not pass');
  if (!contractPass) failures.push('structural hook contract did not pass');
  if (!scenarioComplete) failures.push('runtime scenario pair is incomplete');
  for (const row of scenarioRows) {
    for (const failure of row.failures) failures.push(`${row.scenario}: ${failure}`);
  }
  const releaseBlocking = channel === 'pinned' && !pass;
  const report = {
    schema_version: 1,
    kind: 'agentsmd-runtime-canary',
    captured_at: capturedAt,
    channel,
    pass,
    release_blocking: releaseBlocking,
    support_policy_effect: pass
      ? 'observed-pass'
      : (releaseBlocking ? 'pinned-release-block' : 'compatibility-report-only'),
    runtime: {
      codex_version: bounded(codexVersion),
      model: bounded(model, 'config-default'),
      agentsmd_version: PACKAGE.version,
      surface: bounded(statusResult && statusResult.selectedSurface),
    },
    health: {
      install_pass: Boolean(statusResult && statusResult.installed),
      doctor_pass: Boolean(doctorResult && doctorResult.ok),
      enforcement: Boolean(statusResult && statusResult.enforcement !== false),
      doctor_checks: checks.length,
      failed_checks: failedChecks,
    },
    hook_contract: {
      exit_code: Number.isInteger(hookContract && hookContract.exit_code) ? hookContract.exit_code : -1,
      passed: Number.isInteger(hookContract && hookContract.passed) ? hookContract.passed : 0,
      failed: Number.isInteger(hookContract && hookContract.failed) ? hookContract.failed : 1,
    },
    scenarios: scenarioRows,
    performance,
    failures: failures.slice(0, 32).map((failure) => bounded(failure, 'unknown failure', 512)),
    limits: [
      'Each scenario is one real runtime/model turn graded by deterministic repository assertions.',
      'The five-run performance lane is informational and does not replace the formal multi-round SLO.',
      'A latest-lane failure creates a compatibility report and does not invalidate the pinned supported runtime.',
      'All install and hook state is isolated from the live CODEX_HOME; the runner performs no push, issue, spec, or release mutation.',
    ],
  };
  const validation = validateReport(report);
  if (!validation.valid) throw new Error(`invalid runtime canary report:\n${validation.errors.join('\n')}`);
  return report;
}

function safeCleanupTemp(sandbox) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(sandbox));
  const stat = fs.lstatSync(sandbox);
  if (parent !== tempRoot
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || !path.basename(sandbox).startsWith('agentsmd-runtime-canary-')) {
    throw new Error(`refusing unsafe runtime-canary cleanup target: ${sandbox}`);
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function withEnvironment(values, fn) {
  const before = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function commandResult(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    env: options.env || process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    exit_code: Number.isInteger(result.status) ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function contractResult(home, codex) {
  const result = commandResult(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'hook-contract.test.js')], {
    env: { ...process.env, CODEX_HOME: home, AGENTSMD_CODEX_BIN: codex, AGENTSMD_TELEMETRY_TAG: 'qa' },
  });
  const counts = result.stdout.match(/RESULT:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
  return {
    exit_code: result.exit_code,
    passed: counts ? Number(counts[1]) : 0,
    failed: counts ? Number(counts[2]) : (result.exit_code === 0 ? 0 : 1),
  };
}

function performanceTrend(sandbox) {
  const perfDir = path.join(sandbox, 'perf');
  fs.mkdirSync(perfDir, { recursive: true });
  const result = perfBaseline({ runs: 5, event: 'PreToolUse', sandbox: perfDir, surface: 'single' });
  const aggregate = result.byEventP95.PreToolUse ?? null;
  const wall = result.byEventWall.PreToolUse ? result.byEventWall.PreToolUse.p95_ms : null;
  const baselineAggregate = BASELINE.aggregateProcess.byEventP95.single.PreToolUse;
  const baselineWall = BASELINE.concurrentWall.byEventP95.single.PreToolUse;
  return {
    runs: 5,
    aggregate_pretooluse_p95_ms: aggregate,
    concurrent_pretooluse_p95_ms: wall,
    aggregate_baseline_p95_ms: baselineAggregate,
    concurrent_baseline_p95_ms: baselineWall,
    aggregate_ratio: aggregate && baselineAggregate ? Math.round((aggregate / baselineAggregate) * 100) / 100 : null,
    concurrent_ratio: wall && baselineWall ? Math.round((wall / baselineWall) * 100) / 100 : null,
    state: 'informational',
  };
}

function failedScenario(scenario, message) {
  return {
    scenario,
    pass: false,
    failures: [bounded(message, 'scenario failed', 512)],
    evidence: {
      events: 0,
      changed_files: [],
      validation_completed: false,
      privacy_allowlist: false,
    },
  };
}

function runRuntimeCanary(options) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-runtime-canary-'));
  try {
    const home = path.join(sandbox, 'codex-home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const environment = {
      ...process.env,
      CODEX_HOME: home,
      AGENTSMD_CODEX_BIN: options.codex,
      AGENTSMD_TELEMETRY_TAG: 'qa',
    };
    const install = commandResult(process.execPath, [path.join(ROOT, 'scripts', 'install.js'), '--json'], {
      env: environment,
      timeout: 180000,
    });
    let statusResult = {
      installed: false,
      installedVersion: null,
      selectedSurface: null,
      enforcement: false,
    };
    let doctorResult = { ok: false, checks: [{ name: 'install failed', ok: false }] };
    if (install.exit_code === 0) {
      try {
        ({ statusResult, doctorResult } = withEnvironment({
          CODEX_HOME: home,
          AGENTSMD_CODEX_BIN: options.codex,
          AGENTSMD_TELEMETRY_TAG: 'qa',
        }, () => ({ statusResult: status(), doctorResult: doctor() })));
      } catch (error) {
        doctorResult = { ok: false, checks: [{ name: bounded(error.message, 'doctor failed', 512), ok: false }] };
      }
    }
    const hookContract = contractResult(home, options.codex);
    const scenarios = [];
    for (const scenario of ['positive', 'near-negative']) {
      try {
        const result = EVENT_CANARY.runCanary({
          codex: options.codex,
          model: options.model,
          out: path.join(sandbox, 'scenario-captures'),
          scenario,
          keep: false,
        });
        scenarios.push({
          scenario,
          pass: result.report.pass,
          failures: result.report.failures,
          evidence: result.report.evidence,
        });
      } catch (error) {
        scenarios.push(failedScenario(scenario, error.message));
      }
    }
    let performance;
    try {
      performance = performanceTrend(sandbox);
    } catch {
      performance = {
        runs: 5,
        aggregate_pretooluse_p95_ms: null,
        concurrent_pretooluse_p95_ms: null,
        aggregate_baseline_p95_ms: BASELINE.aggregateProcess.byEventP95.single.PreToolUse,
        concurrent_baseline_p95_ms: BASELINE.concurrentWall.byEventP95.single.PreToolUse,
        aggregate_ratio: null,
        concurrent_ratio: null,
        state: 'informational',
      };
    }
    const version = commandResult(options.codex, ['--version'], { timeout: 10000 });
    const codexVersion = ((version.stdout || '').match(/\d+\.\d+\.\d+/) || ['unknown'])[0];
    const capturedAt = new Date().toISOString();
    const report = buildReport({
      channel: options.channel,
      capturedAt,
      codexVersion,
      model: options.model || 'config-default',
      statusResult,
      doctorResult,
      hookContract,
      scenarios,
      performance,
    });
    const captureRoot = path.resolve(options.out || path.join(ROOT, 'docs', 'qa-captures'));
    const stamp = capturedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const captureDir = path.join(captureRoot, `runtime-canary-${options.channel}-${stamp}`);
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    return { report, captureDir };
  } finally {
    if (fs.existsSync(sandbox)) safeCleanupTemp(sandbox);
  }
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`agentsmd runtime canary: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = runRuntimeCanary(options);
    process.stdout.write(`${JSON.stringify({
      pass: result.report.pass,
      channel: result.report.channel,
      release_blocking: result.report.release_blocking,
      support_policy_effect: result.report.support_policy_effect,
      failures: result.report.failures,
      capture: result.captureDir,
    }, null, 2)}\n`);
    return result.report.pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(`agentsmd runtime canary: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  buildReport,
  main,
  parseArgs,
  runRuntimeCanary,
  safeCleanupTemp,
  validateReport,
};
