'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../js-syntax-check');

const ROOT = path.resolve(__dirname, '..', '..');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-js-syntax.'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'valid.js'), [
    "'use strict';",
    "const text = 'function broken( {';",
    'const pattern = /case 1: case 1:/u;',
    'module.exports = { text, pattern };',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'also-valid.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(root, 'qa', 'ignored.txt'), 'function broken( {\n');
  return root;
}

function withFixture(fn) {
  const root = fixture();
  try { fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('strict argv accepts only the JSON rendering flag', () => {
  assert.deepStrictEqual(C.parseArgs([]), { json: false });
  assert.deepStrictEqual(C.parseArgs(['--json']), { json: true });
  assert.throws(() => C.parseArgs(['--unknown']), /Unknown flag/);
  assert.throws(() => C.parseArgs(['extra.js']), /Unknown argument/);
});

test('collector is sorted, bounded, and skips non-JS plus symlinks', () => withFixture((root) => {
  const outside = path.join(root, 'outside.js');
  const link = path.join(root, 'hooks', 'lib', 'linked.js');
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-js-syntax-outside.'));
  fs.writeFileSync(outside, 'module.exports = 2;\n');
  fs.writeFileSync(path.join(outsideDirectory, 'escaped.js'), 'module.exports = 3;\n');
  fs.symlinkSync(outside, link);
  try {
    assert.deepStrictEqual(C.collectJavaScriptFiles(root), [
      'bin/valid.js',
      'scripts/tests/also-valid.js',
    ]);
    fs.unlinkSync(link);
    fs.rmdirSync(path.join(root, 'hooks', 'lib'));
    fs.symlinkSync(outsideDirectory, path.join(root, 'hooks', 'lib'));
    assert.deepStrictEqual(C.collectJavaScriptFiles(root), [
      'bin/valid.js',
      'scripts/tests/also-valid.js',
    ]);
    assert.throws(() => C.collectJavaScriptFiles(root, { limits: { maxFiles: 1 } }), /count exceeds 1/);
    assert.throws(() => C.collectJavaScriptFiles(root, { limits: { maxFileBytes: 8 } }), /exceeds 8 bytes/);
  } finally {
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }
}));

test('active Node parser accepts valid near-negative source without executing it', () => withFixture((root) => {
  const report = C.checkJavaScript(root);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.files_checked, 2);
  assert.strictEqual(report.failures, 0);
  assert.strictEqual(report.measurement_boundary.includes('no source file is executed'), true);
}));

test('invalid syntax fails with a bounded repo-relative diagnostic', () => withFixture((root) => {
  fs.writeFileSync(path.join(root, 'qa', 'invalid.js'), 'function broken( {\n');
  const report = C.checkJavaScript(root);
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.failures, 1);
  assert.strictEqual(report.failure_details[0].file, 'qa/invalid.js');
  assert.strictEqual(report.failure_details[0].exit_code, 1);
  assert.match(report.failure_details[0].diagnostic, /SyntaxError/u);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
}));

test('spawn timeout/error and diagnostic truncation stay explicit and bounded', () => withFixture((root) => {
  const report = C.checkJavaScript(root, {
    limits: { maxReportedFailures: 1, maxDiagnosticChars: 12 },
    spawnSync: () => ({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('timed out while parsing a very long diagnostic'), { code: 'ETIMEDOUT' }),
      stdout: '',
      stderr: '',
    }),
  });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.failures, 2);
  assert.strictEqual(report.failure_details.length, 1);
  assert.strictEqual(report.failure_details_truncated, 1);
  assert.strictEqual(report.failure_details[0].error_code, 'ETIMEDOUT');
  assert(report.failure_details[0].diagnostic.length <= 12);
}));

test('current repository JavaScript parses on the active runtime', () => {
  const report = C.checkJavaScript(ROOT);
  assert.strictEqual(report.ok, true, JSON.stringify(report.failure_details, null, 2));
  assert(report.files_checked >= 100, `unexpected JavaScript scope: ${report.files_checked}`);
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
