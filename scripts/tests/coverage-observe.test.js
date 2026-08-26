'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const C = require('../coverage-observe');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-coverage-fixture.'));
  const sourceFile = path.join(root, 'scripts', 'lib', 'fs-atomic.js');
  const unseenFile = path.join(root, 'scripts', 'unseen.js');
  const ignoredTest = path.join(root, 'scripts', 'tests', 'ignored.test.js');
  const captureDir = path.join(root, 'capture');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(path.dirname(ignoredTest), { recursive: true });
  fs.mkdirSync(captureDir);
  const source = [
    "'use strict';",
    'function used(value) {',
    "  if (value) return 'yes';",
    "  return 'no';",
    '}',
    'function unused() { return 2; }',
    'module.exports = { used, unused };',
    '',
  ].join('\n');
  fs.writeFileSync(sourceFile, source);
  fs.writeFileSync(unseenFile, "'use strict';\nmodule.exports = 1;\n");
  fs.writeFileSync(ignoredTest, "throw new Error('not production');\n");
  const usedStart = source.indexOf('function used');
  const usedEnd = source.indexOf('\n}', usedStart) + 2;
  const unusedStart = source.indexOf('function unused');
  const unusedEnd = source.indexOf('\n', unusedStart);
  const branchStart = source.indexOf("return 'no'");
  const branchEnd = branchStart + "return 'no'".length;
  const document = (usedCount, branchCount) => ({
    result: [{
      scriptId: '1',
      url: pathToFileURL(sourceFile).href,
      functions: [
        {
          functionName: '',
          ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
          isBlockCoverage: true,
        },
        {
          functionName: 'used',
          ranges: [
            { startOffset: usedStart, endOffset: usedEnd, count: usedCount },
            { startOffset: branchStart, endOffset: branchEnd, count: branchCount },
          ],
          isBlockCoverage: true,
        },
        {
          functionName: 'unused',
          ranges: [{ startOffset: unusedStart, endOffset: unusedEnd, count: 0 }],
          isBlockCoverage: true,
        },
      ],
    }],
  });
  fs.writeFileSync(path.join(captureDir, 'coverage-1.json'), JSON.stringify(document(1, 0)));
  fs.writeFileSync(path.join(captureDir, 'coverage-2.json'), JSON.stringify(document(0, 1)));
  return { root, sourceFile, captureDir, document };
}

function withFixture(fn) {
  const value = fixture();
  try { fn(value); }
  finally { fs.rmSync(value.root, { recursive: true, force: true }); }
}

test('strict argv requires exactly one source and bounds top', () => {
  assert.deepStrictEqual(C.parseCoverageArgs(['--run', '--json', '--top=12']), {
    run: true, captureDir: null, json: true, top: 12,
  });
  assert.deepStrictEqual(C.parseCoverageArgs(['--capture-dir=/tmp/capture']), {
    run: false, captureDir: '/tmp/capture', json: false, top: 50,
  });
  assert.throws(() => C.parseCoverageArgs([]), /exactly one/);
  assert.throws(() => C.parseCoverageArgs(['--run', '--capture-dir=x']), /exactly one/);
  assert.throws(() => C.parseCoverageArgs(['--run', '--top=0']), /1[.][.]200/);
  assert.throws(() => C.parseCoverageArgs(['--run', '--unknown']), /Unknown flag/);
});

test('multi-process captures deduplicate function and block denominators', () => withFixture(({ root, captureDir }) => {
  assert.throws(() => C.collectCoverage(captureDir, { root, top: 0 }), /top must be in/);
  const report = C.collectCoverage(captureDir, { root, top: 10 });
  assert.strictEqual(report.threshold_enforced, false);
  assert.deepStrictEqual(report.metrics.functions, { covered: 2, total: 3, percent: 66.67 });
  assert.deepStrictEqual(report.metrics.block_ranges, { covered: 1, total: 1, percent: 100 });
  assert.strictEqual(report.capture.files, 2);
  assert.strictEqual(report.capture.production_script_entries, 2);
  assert.strictEqual(report.production_files.total, 2);
  assert.strictEqual(report.production_files.observed, 1);
  assert.deepStrictEqual(report.production_files.unobserved_files, ['scripts/unseen.js']);
  assert.strictEqual(report.uncovered_function_count, 1);
  assert.deepStrictEqual(report.uncovered_functions[0], {
    file: 'scripts/lib/fs-atomic.js',
    line: 6,
    function: 'unused',
    focus: ['lifecycle_and_rollback'],
  });
  assert.strictEqual(report.exact_lines.status, 'unmeasured');
  assert.strictEqual(report.semantic_branches.status, 'unmeasured');
  assert.strictEqual(report.focus.lifecycle_and_rollback.functions.total, 3);
}));

test('top bounds uncovered output without changing the full count', () => withFixture(({ root, captureDir, document }) => {
  const file = path.join(root, 'scripts', 'extra.js');
  const source = 'function anotherUnused() { return 1; }\n';
  fs.writeFileSync(file, source);
  const extraCapture = document(0, 0);
  extraCapture.result[0] = {
    scriptId: '2',
    url: pathToFileURL(file).href,
    functions: [{
      functionName: 'anotherUnused',
      ranges: [{ startOffset: 0, endOffset: source.length - 1, count: 0 }],
      isBlockCoverage: true,
    }],
  };
  fs.writeFileSync(path.join(captureDir, 'coverage-3.json'), JSON.stringify(extraCapture));
  const report = C.collectCoverage(captureDir, { root, top: 1 });
  assert.strictEqual(report.uncovered_function_count, 2);
  assert.strictEqual(report.uncovered_functions.length, 1);
  assert.strictEqual(report.uncovered_functions_truncated, 1);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
}));

test('malformed, oversized, and source-drifted captures fail closed', () => withFixture(({ root, captureDir }) => {
  const first = path.join(captureDir, 'coverage-1.json');
  const original = fs.readFileSync(first);
  const link = path.join(captureDir, 'coverage-0-link.json');
  fs.symlinkSync(first, link);
  assert.throws(() => C.collectCoverage(captureDir, { root }), /not a regular file/);
  fs.unlinkSync(link);
  fs.writeFileSync(first, '{ malformed');
  assert.throws(() => C.collectCoverage(captureDir, { root }), /invalid coverage JSON/);
  fs.writeFileSync(first, original);
  assert.throws(() => C.collectCoverage(captureDir, {
    root,
    limits: { maxCaptureFileBytes: 10 },
  }), /exceeds 10 bytes/);
  const document = JSON.parse(original);
  document.result[0].functions[0].ranges[0].endOffset = 999999;
  fs.writeFileSync(first, JSON.stringify(document));
  assert.throws(() => C.collectCoverage(captureDir, { root }), /source-drifted/);
}));

test('run mode cleans only its exact workspace on success', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-coverage-run-test.'));
  const neighbor = path.join(tmpDir, 'neighbor.txt');
  fs.writeFileSync(neighbor, 'keep');
  const sourceFile = path.join(tmpDir, 'scripts', 'probe.js');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  const source = "'use strict';\nmodule.exports = 1;\n";
  fs.writeFileSync(sourceFile, source);
  const spawnSync = (_command, args, options) => {
    assert.deepStrictEqual(args, ['test']);
    assert.notStrictEqual(options.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options.env, 'OPENAI_API_KEY'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options.env, 'CODEX_API_KEY'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options.env, 'CODEX_ACCESS_TOKEN'), false);
    fs.writeFileSync(path.join(options.env.NODE_V8_COVERAGE, 'coverage-stub.json'), JSON.stringify({
      result: [{
        scriptId: '1',
        url: pathToFileURL(sourceFile).href,
        functions: [{
          functionName: '',
          ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
          isBlockCoverage: true,
        }],
      }],
    }));
    return { status: 0, stdout: '', stderr: '' };
  };
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'coverage-observer-test-placeholder';
  try {
    const report = C.runObservation({ root: tmpDir, tmpDir, spawnSync, top: 5 });
    assert.strictEqual(report.test_run.exit_code, 0);
    assert.strictEqual(report.production_files.observed, 1);
    assert.strictEqual(fs.readFileSync(neighbor, 'utf8'), 'keep');
    assert.deepStrictEqual(fs.readdirSync(tmpDir).filter((name) => name.startsWith('agentsmd-coverage-observe-')), []);
    assert.throws(() => C.cleanupCoverageWorkspace(tmpDir, tmpDir), /refusing unexpected/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run mode cleans its exact workspace after test failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-coverage-fail-test.'));
  try {
    assert.throws(() => C.runObservation({
      root: tmpDir,
      tmpDir,
      spawnSync: () => ({ status: 7, stdout: 'failed stdout', stderr: 'failed stderr' }),
    }), /exit 7/);
    assert.deepStrictEqual(fs.readdirSync(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
