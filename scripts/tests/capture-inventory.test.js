'use strict';

const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../capture-inventory');

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-capture-inventory.'));
  fs.chmodSync(root, 0o700);
  writeJson(path.join(root, 'release-v5.3.3-formal-pass-1', 'conformance-20260101T000000Z', 'results.json'), {
    meta: { stamp: '20260101T000000Z' }, cases: [], categories: {},
  });
  writeJson(path.join(root, 'conformance-20260102T000000Z', 'results.json'), {
    meta: { stamp: '20260102T000000Z' }, cases: [], categories: {},
  });
  writeJson(path.join(root, 'core-ab', 'core-ab-20260103T000000000Z', 'results.json'), {
    schema_version: 1, captured_at: '2026-01-03T00:00:00.000Z',
  });
  writeJson(path.join(root, 'runtime-canary-pinned-20260414T000000Z', 'result.json'), {
    schema_version: 1, captured_at: '2026-04-14T00:00:00.000Z',
  });
  writeJson(path.join(root, 'phase-a-runtime-demo-20260104', 'conformance-20260104T000000Z', 'results.json'), {
    meta: { stamp: '20260104T000000Z' }, cases: [], categories: {},
  });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'operator-owned evidence\n', { mode: 0o600 });
  return root;
}

function withFixture(fn) {
  const root = fixture();
  try { fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('strict argv is observation-first and exposes only JSON/write controls', () => {
  assert.deepStrictEqual(C.parseArgs([]), { json: false, write: false });
  assert.deepStrictEqual(C.parseArgs(['--json']), { json: true, write: false });
  assert.deepStrictEqual(C.parseArgs(['--write']), { json: false, write: true });
  assert.throws(() => C.parseArgs(['--root=/tmp']), /Unknown option|Unknown flag/u);
  assert.throws(() => C.parseArgs(['extra']), /Unknown argument/u);
});

test('known units are classified conservatively with deterministic hashes and review-only aging', () => withFixture((root) => {
  const now = new Date('2026-04-15T00:00:00.000Z');
  const first = C.inventoryCaptures(root, { now });
  const second = C.inventoryCaptures(root, { now });
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.summary.units, 6);
  assert.strictEqual(first.summary.deletion_eligible, 0);
  const byPath = new Map(first.units.map((unit) => [unit.path, unit]));
  assert.strictEqual(byPath.get('release-v5.3.3-formal-pass-1').classification, 'release-evidence');
  assert.strictEqual(byPath.get('release-v5.3.3-formal-pass-1').retention.policy, 'hold');
  assert.strictEqual(byPath.get('phase-a-runtime-demo-20260104').retention.policy, 'hold');
  assert.strictEqual(byPath.get('notes.txt').classification, 'unknown');
  assert.strictEqual(byPath.get('notes.txt').retention.policy, 'hold');
  assert.strictEqual(byPath.get('conformance-20260102T000000Z').retention.review_due, true);
  assert.strictEqual(byPath.get('core-ab/core-ab-20260103T000000000Z').retention.review_due, true);
  assert.strictEqual(byPath.get('runtime-canary-pinned-20260414T000000Z').retention.review_due, false);
  assert.match(byPath.get('conformance-20260102T000000Z').sha256, /^[a-f0-9]{64}$/u);
  const before = byPath.get('conformance-20260102T000000Z').sha256;
  fs.appendFileSync(path.join(root, 'conformance-20260102T000000Z', 'results.json'), ' ');
  const after = C.inventoryCaptures(root, { now }).units
    .find((unit) => unit.path === 'conformance-20260102T000000Z').sha256;
  assert.notStrictEqual(after, before);
}));

test('symlink, special-file, and wide-mode evidence is reported without traversal', () => withFixture((root) => {
  const unit = path.join(root, 'conformance-20260415T000000Z');
  writeJson(path.join(unit, 'results.json'), {
    meta: { stamp: '20260415T000000Z' }, cases: [], categories: {},
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-capture-outside.'));
  const outsideFile = path.join(outside, 'outside.json');
  fs.writeFileSync(outsideFile, '{"outside":true}\n', { mode: 0o600 });
  fs.symlinkSync(outsideFile, path.join(unit, 'outside-link.json'));
  fs.chmodSync(path.join(unit, 'results.json'), 0o644);
  const fifo = path.join(unit, 'capture.pipe');
  const created = cp.spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.strictEqual(created.status, 0, created.stderr);
  try {
    const report = C.inventoryCaptures(root, { now: new Date('2026-04-15T12:00:00.000Z') });
    const row = report.units.find((entry) => entry.path === 'conformance-20260415T000000Z');
    assert.strictEqual(row.symlinks, 1);
    assert.strictEqual(row.special_files, 1);
    assert(row.wide_mode_entries >= 1);
    assert.strictEqual(row.integrity_complete, false);
    assert.strictEqual(report.privacy.state, 'degraded');
    assert.strictEqual(JSON.stringify(report).includes(outsideFile), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test('root and resource boundaries fail closed instead of returning a partial green index', () => withFixture((root) => {
  assert.throws(() => C.inventoryCaptures(root, { limits: { maxEntries: 1 } }), /entry limit/u);
  assert.throws(() => C.inventoryCaptures(root, { limits: { maxTotalBytes: 8 } }), /byte limit/u);
  assert.throws(() => C.inventoryCaptures(root, { limits: { maxFileBytes: 8 } }), /file exceeds/u);
  assert.throws(() => C.inventoryCaptures(root, { limits: { maxEntries: 0 } }), /positive safe integer/u);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-capture-root-link.'));
  const link = path.join(parent, 'captures');
  fs.symlinkSync(root, link);
  try { assert.throws(() => C.inventoryCaptures(link), /non-symlink directory/u); }
  finally { fs.rmSync(parent, { recursive: true, force: true }); }
}));

test('malformed and future metadata remain explicit and cannot become review or deletion evidence', () => withFixture((root) => {
  const malformed = path.join(root, 'mystery-capture');
  fs.mkdirSync(malformed);
  fs.writeFileSync(path.join(malformed, 'result.json'), '{broken\n', { mode: 0o600 });
  writeJson(path.join(root, 'runtime-canary-latest-20270101T000000Z', 'result.json'), {
    schema_version: 1, captured_at: '2027-01-01T00:00:00.000Z',
  });
  const report = C.inventoryCaptures(root, { now: new Date('2026-04-15T00:00:00.000Z') });
  const malformedRow = report.units.find((entry) => entry.path === 'mystery-capture');
  const futureRow = report.units.find((entry) => entry.path.startsWith('runtime-canary-latest-'));
  assert.strictEqual(malformedRow.metadata_status, 'invalid');
  assert.strictEqual(malformedRow.captured_at, null);
  assert.strictEqual(malformedRow.retention.policy, 'hold');
  assert.strictEqual(futureRow.metadata_status, 'future');
  assert.strictEqual(futureRow.age_days, null);
  assert.strictEqual(futureRow.retention.review_due, false);
  assert.strictEqual(futureRow.retention.deletion_eligible, false);
}));

test('fixed index writer is atomic, byte-stable, excludes controls, and preserves payloads', () => withFixture((root) => {
  const payload = path.join(root, 'conformance-20260102T000000Z', 'results.json');
  const payloadBefore = sha256(payload);
  fs.writeFileSync(path.join(root, 'RETENTION.md'), 'local policy\n', { mode: 0o600 });
  const options = { now: new Date('2026-04-15T00:00:00.000Z') };
  const first = C.writeIndex(root, options);
  const index = path.join(root, 'index.json');
  const bytes = fs.readFileSync(index);
  const second = C.writeIndex(root, options);
  assert.deepStrictEqual(fs.readFileSync(index), bytes);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.summary.units, 6);
  assert.strictEqual(first.units.some((unit) => unit.path === 'RETENTION.md'), false);
  assert.strictEqual(first.units.some((unit) => unit.path === 'index.json'), false);
  assert.strictEqual(sha256(payload), payloadBefore);
  assert.strictEqual(fs.readdirSync(root).some((name) => name.includes('.agentsmd-tmp-')), false);
}));

test('index writer refuses a symlink with zero target and payload mutation', () => withFixture((root) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-capture-index-target.'));
  const target = path.join(outside, 'target.json');
  const payload = path.join(root, 'conformance-20260102T000000Z', 'results.json');
  fs.writeFileSync(target, 'foreign-index-target\n', { mode: 0o600 });
  fs.symlinkSync(target, path.join(root, 'index.json'));
  const targetBefore = sha256(target);
  const payloadBefore = sha256(payload);
  try {
    assert.throws(
      () => C.writeIndex(root, { now: new Date('2026-04-15T00:00:00.000Z') }),
      /symbolic link/u,
    );
    assert.strictEqual(sha256(target), targetBefore);
    assert.strictEqual(sha256(payload), payloadBefore);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test('missing ignored capture root fails closed without mutation or absolute-path disclosure', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-capture-missing.'));
  const captureRoot = path.join(parent, 'docs', 'qa-captures');
  let observed;
  try {
    assert.throws(
      () => C.inventoryCaptures(captureRoot),
      (error) => {
        observed = error;
        return /capture root does not exist/u.test(error.message);
      },
    );
    assert.strictEqual(fs.existsSync(captureRoot), false);
    assert.strictEqual(observed.message.includes(parent), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
