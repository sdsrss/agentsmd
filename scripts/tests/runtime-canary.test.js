'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CANARY = path.join(ROOT, 'qa', 'runtime-canary.js');

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

test('runtime matrix module exports strict parsing and report validation', () => {
  assert(fs.existsSync(CANARY), 'qa/runtime-canary.js is missing');
  const runtime = require(CANARY);
  for (const name of ['buildReport', 'buildUnverifiedReport', 'parseArgs', 'safeCleanupTemp', 'validateReport', 'writeUnverifiedReport']) {
    assert.strictEqual(typeof runtime[name], 'function', `${name} export`);
  }
});

test('missing automation credentials produce bounded unverified evidence without a model claim', () => {
  const { buildUnverifiedReport } = require(CANARY);
  const pinned = buildUnverifiedReport({
    channel: 'pinned',
    capturedAt: '2026-09-01T12:00:00.000Z',
    runtimePackage: '@openai/codex@0.145.0',
    sourceCommit: 'a'.repeat(40),
  });
  assert.deepStrictEqual(Object.keys(pinned).sort(), [
    'captured_at',
    'channel',
    'kind',
    'limits',
    'model_called',
    'reason',
    'release_blocking',
    'runtime_package',
    'schema_version',
    'source_commit',
    'state',
    'support_policy_effect',
  ]);
  assert.strictEqual(pinned.state, 'unverified');
  assert.strictEqual(pinned.reason, 'automation-credential-unavailable');
  assert.strictEqual(pinned.model_called, false);
  assert.strictEqual(pinned.release_blocking, true);
  assert.strictEqual(pinned.support_policy_effect, 'pinned-evidence-unverified');
  assert.match(pinned.limits.join('\n'), /not runtime or model compatibility evidence/i);

  const latest = buildUnverifiedReport({
    channel: 'latest',
    capturedAt: '2026-09-01T12:00:00.000Z',
    runtimePackage: '@openai/codex@latest',
    sourceCommit: 'b'.repeat(40),
  });
  assert.strictEqual(latest.release_blocking, false);
  assert.strictEqual(latest.support_policy_effect, 'compatibility-unverified');
  assert.throws(() => buildUnverifiedReport({ channel: 'other' }));
});

test('unverified evidence writer uses a task-owned timestamped directory', () => {
  const { writeUnverifiedReport } = require(CANARY);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-runtime-unverified-test-'));
  try {
    const result = writeUnverifiedReport({
      channel: 'pinned',
      capturedAt: '2026-09-01T12:00:00.000Z',
      out: sandbox,
      runtimePackage: '@openai/codex@0.145.0',
      sourceCommit: 'c'.repeat(40),
    });
    assert.strictEqual(path.dirname(result.captureFile), result.captureDir);
    assert.strictEqual(path.basename(result.captureDir), 'runtime-canary-pinned-unverified-20260901T120000Z');
    assert.strictEqual(path.basename(result.captureFile), 'result.json');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(result.captureFile, 'utf8')), result.report);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('report keeps pinned blocking distinct from latest informational compatibility', () => {
  const { buildReport, validateReport } = require(CANARY);
  const common = {
    capturedAt: '2026-07-29T12:00:00.000Z',
    codexVersion: '0.145.0',
    model: 'gpt-5.6-sol',
    statusResult: { installed: true, installedVersion: '5.0.1', selectedSurface: 'standalone', enforcement: true },
    doctorResult: { ok: true, checks: [{ name: 'hook wiring', ok: true }] },
    hookContract: { exit_code: 0, passed: 7, failed: 0 },
    scenarios: [
      { scenario: 'positive', pass: true, failures: [], evidence: { events: 3, changed_files: ['canary.txt'], validation_completed: true, privacy_allowlist: true } },
      { scenario: 'near-negative', pass: false, failures: ['runtime process did not exit 0'], evidence: { events: 1, changed_files: [], validation_completed: false, privacy_allowlist: true } },
    ],
    performance: {
      runs: 5,
      aggregate_pretooluse_p95_ms: 100,
      concurrent_pretooluse_p95_ms: 50,
      aggregate_baseline_p95_ms: 200,
      concurrent_baseline_p95_ms: 40,
      aggregate_ratio: 0.5,
      concurrent_ratio: 1.25,
      state: 'informational',
    },
  };
  const pinned = buildReport({ ...common, channel: 'pinned' });
  const latest = buildReport({ ...common, channel: 'latest' });
  assert.strictEqual(pinned.pass, false);
  assert.strictEqual(pinned.release_blocking, true);
  assert.strictEqual(latest.pass, false);
  assert.strictEqual(latest.release_blocking, false);
  assert.strictEqual(latest.support_policy_effect, 'compatibility-report-only');
  assert.strictEqual(validateReport(pinned).valid, true);
  assert.strictEqual(validateReport(latest).valid, true);
});

test('passing report is bounded and scenario-complete', () => {
  const { buildReport, validateReport } = require(CANARY);
  const report = buildReport({
    channel: 'pinned',
    capturedAt: '2026-07-29T12:00:00.000Z',
    codexVersion: '0.145.0',
    model: 'config-default',
    statusResult: { installed: true, installedVersion: '5.0.1', selectedSurface: 'standalone', enforcement: true },
    doctorResult: { ok: true, checks: [] },
    hookContract: { exit_code: 0, passed: 7, failed: 0 },
    scenarios: [
      { scenario: 'positive', pass: true, failures: [], evidence: { events: 3, changed_files: ['canary.txt'], validation_completed: true, privacy_allowlist: true } },
      { scenario: 'near-negative', pass: true, failures: [], evidence: { events: 1, changed_files: [], validation_completed: true, privacy_allowlist: true } },
    ],
    performance: {
      runs: 5,
      aggregate_pretooluse_p95_ms: 100,
      concurrent_pretooluse_p95_ms: 50,
      aggregate_baseline_p95_ms: 200,
      concurrent_baseline_p95_ms: 40,
      aggregate_ratio: 0.5,
      concurrent_ratio: 1.25,
      state: 'informational',
    },
  });
  assert.strictEqual(report.pass, true);
  assert.strictEqual(report.release_blocking, false);
  assert.strictEqual(report.scenarios.length, 2);
  assert.strictEqual(validateReport(report).valid, true);
  assert(Buffer.byteLength(JSON.stringify(report)) < 131072);
  assert.strictEqual(validateReport({ ...report, unknown: true }).valid, false);
});

test('argv rejects ambiguity and requires an explicit matrix channel', () => {
  const { parseArgs } = require(CANARY);
  assert.deepStrictEqual(parseArgs(['--channel=pinned']), {
    channel: 'pinned',
    codex: 'codex',
    model: null,
    out: null,
    help: false,
  });
  assert.strictEqual(parseArgs(['--channel=latest', '--codex=/tmp/codex', '--model=gpt-test', '--out=tmp/out']).channel, 'latest');
  for (const argv of [
    [],
    ['--channel'],
    ['--channel=other'],
    ['--channel=pinned', '--channel=latest'],
    ['--codex=codex'],
    ['--channel=pinned', '--model='],
    ['--channel=pinned', '--unknown'],
  ]) assert.throws(() => parseArgs(argv));
});

test('destructive cleanup is confined to the exact task-owned temp fixture', () => {
  const { safeCleanupTemp } = require(CANARY);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-runtime-canary-'));
  const sibling = path.join(os.tmpdir(), `agentsmd-runtime-canary-sibling-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(sandbox, 'owned'), 'remove');
  fs.writeFileSync(sibling, 'preserve');
  try {
    safeCleanupTemp(sandbox);
    assert.strictEqual(fs.existsSync(sandbox), false);
    assert.strictEqual(fs.readFileSync(sibling, 'utf8'), 'preserve');
    assert.throws(() => safeCleanupTemp(os.tmpdir()));
  } finally {
    fs.rmSync(sibling, { force: true });
    if (fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
