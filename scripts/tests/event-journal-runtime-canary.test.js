'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CANARY_PATH = path.join(ROOT, 'qa', 'event-journal-runtime-canary.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${error.stack || error}`);
  }
}

test('runtime canary module exists and exports deterministic grading', () => {
  assert.ok(fs.existsSync(CANARY_PATH), 'qa/event-journal-runtime-canary.js is missing');
  const canary = require(CANARY_PATH);
  assert.strictEqual(typeof canary.gradeRuntimeCapture, 'function');
  assert.strictEqual(typeof canary.gradeNearNegativeCapture, 'function');
  assert.strictEqual(typeof canary.parseArgs, 'function');
});

test('grading accepts one native mutation followed by successful validation', () => {
  const { gradeRuntimeCapture } = require(CANARY_PATH);
  const rows = [
    {
      schema_version: 1,
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'patch-1',
      state: 'mutation_intent',
      outcome: 'started',
      repo_relative_files: ['canary.txt'],
    },
    {
      schema_version: 1,
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'patch-1',
      state: 'mutation_completed',
      outcome: 'success',
      repo_relative_files: ['canary.txt'],
    },
    {
      schema_version: 1,
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_use_id: 'test-1',
      state: 'validation_completed',
      outcome: 'success',
      validation_type: 'test',
      repo_relative_files: [],
    },
  ];
  const result = gradeRuntimeCapture({
    rows,
    fileContents: 'AFTER\n',
    processExitCode: 0,
    stopTelemetry: [{ hook: 'session-exit-checkpoint', event: 'observe', extra: { source: 'native-event-journal' } }],
    unvalidatedFlags: [],
  });
  assert.strictEqual(result.pass, true);
  assert.deepStrictEqual(result.failures, []);
  assert.strictEqual(result.session_id, 'session-1');
  assert.strictEqual(result.turn_id, 'turn-1');
});

test('near-negative grading requires validation but rejects every mutation or changed file', () => {
  const { gradeNearNegativeCapture } = require(CANARY_PATH);
  const base = {
    rows: [{
      schema_version: 1,
      session_id: 'session-near',
      turn_id: 'turn-near',
      tool_use_id: 'test-near',
      state: 'validation_completed',
      outcome: 'success',
      validation_type: 'test',
      repo_relative_files: [],
    }],
    fileContents: 'STABLE\n',
    processExitCode: 0,
    stopTelemetry: [{ hook: 'session-exit-checkpoint', event: 'observe', extra: { source: 'native-event-journal' } }],
    unvalidatedFlags: [],
    changedFiles: [],
  };
  assert.deepStrictEqual(gradeNearNegativeCapture(base).failures, []);
  const mutated = gradeNearNegativeCapture({
    ...base,
    rows: [...base.rows, {
      schema_version: 1,
      session_id: 'session-near',
      turn_id: 'turn-near',
      tool_use_id: 'patch-near',
      state: 'mutation_completed',
      outcome: 'success',
      repo_relative_files: ['canary.txt'],
    }],
    fileContents: 'CHANGED\n',
    changedFiles: ['canary.txt'],
  });
  assert.strictEqual(mutated.pass, false);
  for (const failure of [
    'near-negative fixture content changed',
    'near-negative emitted a mutation event',
    'near-negative changed tracked files',
  ]) assert.ok(mutated.failures.includes(failure), `missing failure: ${failure}`);
});

test('grading rejects stale, cross-turn, failed, or privacy-leaking evidence', () => {
  const { gradeRuntimeCapture } = require(CANARY_PATH);
  const result = gradeRuntimeCapture({
    rows: [
      {
        schema_version: 1,
        session_id: 'session-1',
        turn_id: 'turn-1',
        tool_use_id: 'patch-1',
        state: 'mutation_completed',
        outcome: 'success',
        repo_relative_files: ['/private/canary.txt'],
        command: 'PRIVATE RAW COMMAND',
      },
      {
        schema_version: 1,
        session_id: 'session-1',
        turn_id: 'turn-2',
        tool_use_id: 'test-1',
        state: 'validation_completed',
        outcome: 'failure',
        validation_type: 'test',
        repo_relative_files: [],
      },
    ],
    fileContents: 'BEFORE\n',
    processExitCode: 1,
    stopTelemetry: [],
    unvalidatedFlags: ['unvalidated-session-1.flag'],
  });
  assert.strictEqual(result.pass, false);
  for (const failure of [
    'runtime process did not exit 0',
    'canary mutation did not land',
    'missing mutation intent',
    'missing fresh successful validation in the mutation turn',
    'Stop did not consume the native journal',
    'Stop left an unvalidated-work flag',
    'journal rows violate the privacy allowlist',
  ]) assert.ok(result.failures.includes(failure), `missing failure: ${failure}`);
});

test('argv parser rejects unknown, duplicate, bare-valued, and invalid options', () => {
  const { parseArgs } = require(CANARY_PATH);
  assert.deepStrictEqual(parseArgs([]), {
    codex: 'codex',
    model: null,
    out: null,
    scenario: 'positive',
    keep: false,
    help: false,
  });
  assert.strictEqual(parseArgs(['--codex=/bin/codex', '--model=gpt-test', '--out=tmp/capture', '--scenario=near-negative', '--keep']).scenario, 'near-negative');
  for (const argv of [
    ['--unknown'],
    ['--codex'],
    ['--codex=a', '--codex=b'],
    ['--model='],
    ['--out='],
    ['--scenario='],
    ['--scenario=other'],
    ['positional'],
  ]) assert.throws(() => parseArgs(argv));
});

test('destructive cleanup removes only its exact temp fixture and preserves a sibling', () => {
  const os = require('os');
  const { safeCleanupTemp } = require(CANARY_PATH);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-event-journal-runtime-'));
  const sibling = path.join(os.tmpdir(), `agentsmd-event-journal-sibling-${process.pid}-${Date.now()}`);
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

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
