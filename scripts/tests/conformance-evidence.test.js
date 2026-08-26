'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CAPTURE_ROOT,
  buildEvidence,
  parseArgs,
  platformCanonicalPath,
  writeEvidence,
} = require('../conformance-evidence');
const { validateConformanceReleaseEvidence } = require('../lib/scorecard');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_FILE = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const THRESHOLDS_FILE = path.join(ROOT, 'qa', 'conformance', 'thresholds.json');
const RELEASE_FILE = path.join(ROOT, 'qa', 'conformance', 'releases', 'v5.3.0.json');
const COMMIT = 'a'.repeat(40);
const RELEASE_COMMIT = 'b'.repeat(40);
const PRIVATE_MARKER = 'LAST_MESSAGE_FROM_PRIVATE_CAPTURE_MUST_NOT_SURVIVE';

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const captureRootExisted = fs.existsSync(CAPTURE_ROOT);
fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(CAPTURE_ROOT, 'conformance-evidence-test.'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conformance-evidence-outside.'));
const fixtureVersion = `99.99.${process.pid}`;
const outputFile = path.join(ROOT, 'qa', 'conformance', 'releases', `v${fixtureVersion}.json`);

try {
  assert.strictEqual(fs.existsSync(outputFile), false, `unexpected pre-existing fixture output: ${outputFile}`);
  const caseBytes = fs.readFileSync(CASES_FILE);
  const thresholdBytes = fs.readFileSync(THRESHOLDS_FILE);
  const library = JSON.parse(caseBytes.toString('utf8'));
  const casesSha = sha256(caseBytes);
  const thresholdsSha = sha256(thresholdBytes);

  function writeRun(stamp, failures, { source = true } = {}) {
    const capture = path.join(fixtureRoot, `conformance-${stamp}`);
    fs.mkdirSync(capture);
    const result = {
      meta: {
        stamp,
        codex: '0.147.0',
        model: 'gpt-5.6-sol',
        agentsmd: fixtureVersion,
        surface: 'standalone',
        profile: 'full',
        cases_sha256: casesSha,
        thresholds_sha256: thresholdsSha,
        hook_trust: 'automation-bypass',
        cases: library.cases.length,
        ...(source ? { source_commit: COMMIT, source_tracked_clean: true } : {}),
      },
      cases: library.cases.map((item) => ({
        id: item.id,
        category: item.category,
        kind: item.kind,
        verdict: failures.includes(item.id) ? 'fail' : 'pass',
        why: [PRIVATE_MARKER],
      })),
    };
    const file = path.join(capture, 'results.json');
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    return file;
  }

  const first = writeRun('20260820T010000Z', ['discipline-outcome-first']);
  const second = writeRun('20260820T020000Z', [
    'discipline-task-orphan',
    'discipline-outcome-first',
  ]);
  const legacy = writeRun('20260820T030000Z', ['discipline-outcome-first'], { source: false });
  const base = {
    releaseVersion: fixtureVersion,
    releaseCommit: RELEASE_COMMIT,
    evaluatedCommit: COMMIT,
    publishedAt: '2026-08-20T04:00:00.000Z',
    decision: 'waived',
    results: [first, second],
    waiverScope: 'task-discipline',
    allowLegacySource: false,
    out: null,
  };

  test('builder emits only bounded aggregate fields and preserves the two-run waiver', () => {
    const record = buildEvidence(base);
    const validation = validateConformanceReleaseEvidence(record);
    assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
    assert.deepStrictEqual(record.runs.map((run) => run.passed), [29, 28]);
    assert.deepStrictEqual(record.runs.map((run) => run.threshold_verdict), ['pass', 'fail']);
    assert.strictEqual(record.decision.verdict, 'waived');
    assert.deepStrictEqual(record.decision.waiver, {
      scope: 'task-discipline',
      release_only: true,
      thresholds_unchanged: true,
      reason: 'two-pass-threshold',
    });
    const serialized = JSON.stringify(record);
    assert.strictEqual(serialized.includes(PRIVATE_MARKER), false);
    assert.strictEqual(serialized.includes('why'), false);
    assert.strictEqual(serialized.includes('cases'), true, 'subject cases hash is retained');
  });

  test('builder rejects unreviewed legacy identity, path escape, symlink, and false pass decisions', () => {
    assert.throws(() => buildEvidence({ ...base, results: [legacy] }), /source identity missing/u);
    assert.strictEqual(buildEvidence({
      ...base,
      results: [legacy],
      allowLegacySource: true,
      decision: 'pass',
      waiverScope: null,
    }).runs.length, 1);

    const outside = path.join(outsideRoot, 'results.json');
    fs.writeFileSync(outside, '{}\n');
    assert.throws(() => buildEvidence({ ...base, results: [outside] }), /must stay below/u);

    const linkedDir = path.join(fixtureRoot, 'conformance-20260820T050000Z');
    fs.mkdirSync(linkedDir);
    fs.symlinkSync(first, path.join(linkedDir, 'results.json'));
    assert.throws(() => buildEvidence({ ...base, results: [path.join(linkedDir, 'results.json')] }), /symlink/u);

    assert.throws(() => buildEvidence({ ...base, decision: 'pass', waiverScope: null }), /contradicts/u);
  });

  test('strict argv requires explicit waiver and rejects silent positional fallback', () => {
    const parsed = parseArgs([
      `--release-version=${fixtureVersion}`,
      `--release-commit=${RELEASE_COMMIT}`,
      `--evaluated-commit=${COMMIT}`,
      '--published-at=2026-08-20T04:00:00Z',
      '--decision=waived',
      '--waiver-scope=task-discipline',
      `--results=${first},${second}`,
    ]);
    assert.strictEqual(parsed.error, undefined);
    assert.strictEqual(parseArgs(['capture.json']).error.includes('Unknown argument'), true);
    assert.strictEqual(parseArgs([
      `--release-version=${fixtureVersion}`,
      `--release-commit=${RELEASE_COMMIT}`,
      `--evaluated-commit=${COMMIT}`,
      '--published-at=2026-08-20T04:00:00Z',
      '--decision=waived',
      `--results=${first}`,
    ]).error.includes('waiver-scope'), true);
  });

  test('canonical path comparison permits only the macOS /var system alias', () => {
    assert.strictEqual(
      platformCanonicalPath('/var/folders/example', 'darwin'),
      '/private/var/folders/example',
    );
    assert.strictEqual(platformCanonicalPath('/private/var/folders/example', 'darwin'), '/private/var/folders/example');
    assert.strictEqual(platformCanonicalPath('/variant/example', 'darwin'), '/variant/example');
    assert.strictEqual(platformCanonicalPath('/var/folders/example', 'linux'), '/var/folders/example');
  });

  test('writer creates the exact version path idempotently and refuses different overwrite bytes', () => {
    const text = `${JSON.stringify(buildEvidence(base), null, 2)}\n`;
    assert.strictEqual(writeEvidence(outputFile, fixtureVersion, text), outputFile);
    assert.strictEqual(writeEvidence(outputFile, fixtureVersion, text), outputFile);
    assert.strictEqual(fs.readFileSync(outputFile, 'utf8'), text);
    assert.throws(() => writeEvidence(outputFile, fixtureVersion, `${text} `), /refusing to overwrite/u);
    assert.throws(() => writeEvidence(path.join(outsideRoot, 'record.json'), fixtureVersion, text), /must equal/u);

    const boundedRoot = path.join(outsideRoot, 'bounded-writer');
    const boundedParent = path.join(boundedRoot, 'qa', 'conformance');
    const escaped = path.join(outsideRoot, 'escaped-writer');
    fs.mkdirSync(boundedParent, { recursive: true });
    fs.mkdirSync(escaped);
    const linkedReleaseRoot = path.join(boundedParent, 'releases');
    fs.symlinkSync(escaped, linkedReleaseRoot);
    const linkedOutput = path.join(linkedReleaseRoot, `v${fixtureVersion}.json`);
    assert.throws(() => writeEvidence(linkedOutput, fixtureVersion, text, {
      root: boundedRoot,
      releaseRoot: linkedReleaseRoot,
    }), /release evidence root must be a real non-symlink directory/u);
    assert.deepStrictEqual(fs.readdirSync(escaped), []);
  });

  test('committed v5.3.0 record retains its historical input identity after case evolution', () => {
    const record = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'));
    const validation = validateConformanceReleaseEvidence(record);
    assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
    assert.strictEqual(record.subject.cases_sha256, '7a2372d7096347f1abe7e460e06d5e128db2b1fa65cbbc0011660e21ed2a626a');
    assert.strictEqual(record.subject.thresholds_sha256, '57e3c049dd08eb15c3ddbf37e949a2d3b6e0e3cd1c420e845812f33899d34c68');
    assert.notStrictEqual(record.subject.cases_sha256, casesSha,
      'historical evidence must not be rebound to the evolved case library');
    assert.strictEqual(record.subject.thresholds_sha256, thresholdsSha,
      'the release threshold remains unchanged');
    assert.deepStrictEqual(record.runs.map((run) => run.passed), [29, 28]);
    assert.strictEqual(record.decision.verdict, 'waived');
  });
} finally {
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  fs.rmSync(fixtureRoot, { recursive: true, force: false });
  fs.rmSync(outsideRoot, { recursive: true, force: false });
  if (!captureRootExisted) {
    try { fs.rmdirSync(CAPTURE_ROOT); } catch {}
  }
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
