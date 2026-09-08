'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CAPTURE_ROOT,
} = require('../conformance-evidence');
const {
  buildCandidateAttestation,
  parseArgs: parseCandidateArgs,
  writeCandidate,
} = require('../conformance-candidate');
const {
  buildReleaseBinding,
  parseArgs: parseBindingArgs,
  releaseTreeForCommit,
  writeBinding,
} = require('../conformance-binding');
const {
  validateConformanceCandidateAttestation,
  validateConformanceEvidencePair,
  validateConformanceReleaseBinding,
} = require('../lib/scorecard');

const ROOT = path.resolve(__dirname, '..', '..');
const CASES_FILE = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const THRESHOLDS_FILE = path.join(ROOT, 'qa', 'conformance', 'thresholds.json');
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const RELEASE_COMMIT = 'c'.repeat(40);
const DEPLOY_SHA256 = 'd'.repeat(64);
const PRIVATE_MARKER = 'PRIVATE_TRANSCRIPT_TEXT_MUST_NOT_SURVIVE';

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

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('hex');
}

const captureRootExisted = fs.existsSync(CAPTURE_ROOT);
fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(CAPTURE_ROOT, 'conformance-binding-test.'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conformance-binding.'));

try {
  const caseBytes = fs.readFileSync(CASES_FILE);
  const thresholdBytes = fs.readFileSync(THRESHOLDS_FILE);
  const library = JSON.parse(caseBytes.toString('utf8'));
  const fixtureVersion = `99.98.${process.pid}`;
  const capture = path.join(fixtureRoot, 'conformance-20260825T010000Z');
  fs.mkdirSync(capture);
  const resultFile = path.join(capture, 'results.json');
  fs.writeFileSync(resultFile, `${JSON.stringify({
    meta: {
      stamp: '20260825T010000Z',
      codex: '0.147.0',
      model: 'gpt-5.6-sol',
      agentsmd: fixtureVersion,
      surface: 'standalone',
      profile: 'full',
      cases_sha256: sha256(caseBytes),
      thresholds_sha256: sha256(thresholdBytes),
      source_commit: COMMIT,
      source_tracked_clean: true,
      cases: library.cases.length,
    },
    cases: library.cases.map((item) => ({
      id: item.id,
      category: item.category,
      kind: item.kind,
      verdict: 'pass',
      why: [PRIVATE_MARKER],
    })),
  }, null, 2)}\n`);

  const identity = {
    package: '@sdsrs/agentsmd',
    version: fixtureVersion,
    source_commit: COMMIT,
    source_tree: TREE,
    source_tracked_clean: true,
    deploy_sha256: DEPLOY_SHA256,
  };
  const candidateOptions = {
    identity,
    attestedAt: '2026-08-25T02:00:00.000Z',
    decision: 'pass',
    results: [resultFile],
    waiverScope: null,
    allowLegacySource: false,
  };
  const candidate = buildCandidateAttestation(candidateOptions);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const releaseTarball = Buffer.from('identical-published-package-bytes');
  const releaseSha256 = sha256(releaseTarball);
  const releaseSha512 = sha512(releaseTarball);
  const tag = `v${fixtureVersion}`;
  const repository = 'https://github.com/sdsrss/agentsmd';
  const provenance = {
    subject: [{
      name: `pkg:npm/%40sdsrs/agentsmd@${fixtureVersion}`,
      digest: { sha512: releaseSha512 },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            ref: `refs/tags/${tag}`,
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [{
          uri: `git+${repository}@refs/tags/${tag}`,
          digest: { gitCommit: RELEASE_COMMIT },
        }],
      },
    },
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  const bindingOptions = {
    candidateBytes,
    releaseTarballBytes: releaseTarball,
    registryTarballBytes: Buffer.from(releaseTarball),
    provenanceBytes,
    releaseCommit: RELEASE_COMMIT,
    releaseTree: TREE,
    publishedAt: '2026-08-25T03:00:00.000Z',
    verifiedAt: '2026-08-25T04:00:00.000Z',
  };

  test('candidate attestation binds clean source, deploy tree, inputs, and bounded summaries', () => {
    const validation = validateConformanceCandidateAttestation(candidate);
    assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
    assert.strictEqual(candidate.kind, 'agentsmd-conformance-candidate-attestation');
    assert.strictEqual(candidate.subject.package, '@sdsrs/agentsmd');
    assert.strictEqual(candidate.subject.version, fixtureVersion);
    assert.strictEqual(candidate.subject.source_commit, COMMIT);
    assert.strictEqual(candidate.subject.source_tree, TREE);
    assert.strictEqual(candidate.subject.deploy_sha256, DEPLOY_SHA256);
    assert.strictEqual(candidate.runs.length, 1);
    assert.strictEqual(candidate.runs[0].threshold_verdict, 'pass');
    assert.strictEqual(candidate.decision.verdict, 'pass');
    assert.strictEqual(JSON.stringify(candidate).includes(PRIVATE_MARKER), false);
    assert.strictEqual(JSON.stringify(candidate).includes('why'), false);
  });

  test('strict readiness is separate from single-run historical candidate validity', () => {
    const { validateReadiness } = require('../lib/release-readiness');
    assert.strictEqual(validateConformanceCandidateAttestation(candidate).valid, true);
    assert.strictEqual(validateReadiness(candidate, { identity }).ready, false);
  });

  function readinessFixture() {
    const { buildReadiness } = require('../lib/release-readiness');
    const { HOOK_REGISTRY } = require('../lib/hook-registry');
    const sloBytes = fs.readFileSync(path.join(ROOT, 'qa/perf/slo.json'));
    const config = JSON.parse(sloBytes);
    const declaration = { schema_version: 1, kind: 'agentsmd-release-declaration',
      declared_at: '2026-08-25T00:00:00.000Z', subject: identity,
      runtime: { codex_version: '0.147.0', model: 'gpt-5.6-sol', surface: 'standalone', profile: 'full' } };
    const nextCandidate = structuredClone(candidate);
    const results = [0, 1].map((index) => {
      const rawResult = JSON.parse(fs.readFileSync(resultFile));
      rawResult.meta.stamp = `20260825T010${index}00Z`;
      rawResult.meta.measurement = { run_id: sha256(`run-${index}`), declaration_sha256: sha256(JSON.stringify(declaration)), deploy_sha256: DEPLOY_SHA256, stable: true };
      rawResult.cases.forEach((row) => { row.session_sha256 = sha256(`${index}/${row.id}`); });
      const bytes = Buffer.from(JSON.stringify(rawResult));
      nextCandidate.runs[index] = { ...candidate.runs[0], capture: `conformance-${rawResult.meta.stamp}`,
        recorded_at: `2026-08-25T01:0${index}:00.000Z`, results_sha256: sha256(bytes) };
      return bytes;
    });
    const surfaces = {};
    for (const name of ['single', 'dual-warm']) {
      const copies = name === 'single' ? ['repo'] : ['standalone', 'plugin'];
      const rows = copies.flatMap((copy) => HOOK_REGISTRY.map((hook) => ({
        hook: hook.displayName, event: hook.hookEvent, copy, p95_ms: 1, timeout_budget_ms: hook.timeout * 1000,
      })));
      const byEventP95 = {};
      for (const row of rows) byEventP95[row.event] = (byEventP95[row.event] || 0) + row.p95_ms;
      const byEventWall = Object.fromEntries(Object.keys(byEventP95).map((event) => [event, { p95_ms: name === 'single' ? 10 : 12 }]));
      surfaces[name] = { results: rows, byEventP95, byEventWall,
        roundEventP95: Array.from({ length: config.baseline_rounds }, () => ({ ...byEventP95 })),
        roundEventWallP95: Array.from({ length: config.baseline_rounds }, () => Object.fromEntries(Object.entries(byEventWall).map(([key, row]) => [key, row.p95_ms]))),
      };
    }
    const performance = { source: { state: 'measured', ...identity, slo_sha256: sha256(sloBytes) },
      env: { generatedAt: '2026-08-25T01:30:00.000Z' }, runs: config.baseline_runs, rounds: config.baseline_rounds,
      slo: { pass: true, inconclusive: false }, surfaces };
    const ctx = { identity, casesBytes: caseBytes, thresholdsBytes: thresholdBytes, sloBytes, now: Date.parse('2026-08-25T03:00:00Z') };
    const input = { declaration, candidate: nextCandidate, results, performance };
    return { proof: buildReadiness(input, ctx), ctx, input };
  }

  test('strict readiness accepts independently identified declared runs and recomputed full SLO', () => {
    const { validateReadiness, MAX_PROOF_BYTES } = require('../lib/release-readiness');
    const { proof, ctx } = readinessFixture();
    const verdict = validateReadiness(proof, ctx);
    assert.strictEqual(verdict.ready, true, verdict.errors.join('\n'));
    assert.strictEqual(verdict.historical_baseline_applicability, 'mismatch');
    assert.strictEqual(JSON.stringify(proof).includes(PRIVATE_MARKER), false);
    assert(Buffer.byteLength(JSON.stringify(proof)) < MAX_PROOF_BYTES);
    assert.strictEqual(validateReadiness(proof, { ...ctx, identity: { ...identity, source_commit: RELEASE_COMMIT } }).ready, true, 'identical merged tree is allowed');
  });

  test('strict readiness refuses replay, runtime uncertainty, missing receipts and incomplete SLO', () => {
    const { validateReadiness } = require('../lib/release-readiness');
    const { proof, ctx } = readinessFixture();
    for (const mutate of [
      (p) => { p.runs.pop(); },
      (p) => { p.runs[1].measurement.run_id = p.runs[0].measurement.run_id; },
      (p) => { p.runs[1].results_sha256 = p.runs[0].results_sha256; },
      (p) => { p.runs[1].cases[0].session_sha256 = p.runs[0].cases[0].session_sha256; },
      (p) => { p.runs[0].meta.model = 'unknown'; },
      (p) => { p.runs[0].meta.model = 'different-model'; },
      (p) => { p.runs[0].meta.stamp = '20250101T000000Z'; p.candidate.runs[0].capture = 'conformance-20250101T000000Z'; },
      (p) => { p.declaration.declared_at = p.candidate.attested_at; },
      (p) => { p.runs[0].measurement.stable = false; },
      (p) => { p.runs[0].measurement.deploy_sha256 = '0'.repeat(64); },
      (p) => { delete p.runs[0].cases[0].session_sha256; },
      (p) => { p.runs[0].cases[0].verdict = 'error'; },
      (p) => { p.runs[0].cases[0].verdict = 'fail'; },
      (p) => { p.candidate.runs[0].passed -= 1; },
      (p) => { p.performance.source.state = 'unverified'; },
      (p) => { p.performance.source.source_tree = '0'.repeat(40); },
      (p) => { p.performance.pass = false; },
      (p) => { p.performance.inconclusive = true; },
      (p) => { p.performance.runs = 1; },
      (p) => { p.performance.surfaces.single.results.pop(); },
      (p) => { p.performance.surfaces.single.roundEventP95.pop(); },
      (p) => { p.performance.surfaces.single.byEventP95.PreToolUse = 0; },
      (p) => { p.performance.surfaces.single.roundEventP95[1].PreToolUse *= 10; },
      (p) => { p.performance.surfaces['dual-warm'].byEventWall.PreToolUse.p95_ms *= 10; },
      (p) => { p.performance.surfaces['dual-warm'].roundEventWallP95.forEach((round) => { round.PreToolUse = 12000; }); },
      (p) => { p.performance.surfaces.single.roundEventP95.forEach((round) => { round.PreToolUse = 1; }); },
      (p) => { p.raw_transcript = PRIVATE_MARKER; },
    ]) {
      const changed = structuredClone(proof); mutate(changed);
      assert.strictEqual(validateReadiness(changed, ctx).ready, false, mutate.toString());
    }
    assert.strictEqual(validateReadiness(proof, { ...ctx, identity: { ...identity, deploy_sha256: '0'.repeat(64) } }).ready, false);
  });

  test('readiness argv is mode-specific and missing CI proof exits before source inspection', () => {
    const { parseArgs, main } = require('../release-readiness');
    assert.strictEqual(parseArgs(['--mode=verify', '--proof-env']).proofEnv, true);
    for (const args of [[], ['--mode=build'], ['--mode=declare', '--model=x'], ['--mode=verify', '--proof'], ['--mode=verify', '--proof=x', '--proof-env'], ['--mode=verify', '--proof=x', '--model=x'], ['--mode=verify', '--proof-env', '--proof-event']]) {
      assert.throws(() => parseArgs(args));
    }
    const prior = process.env.AGENTSMD_READINESS_JSON;
    try { delete process.env.AGENTSMD_READINESS_JSON; assert.strictEqual(main(['--mode=verify', '--proof-env']), 1); }
    finally { if (prior !== undefined) process.env.AGENTSMD_READINESS_JSON = prior; }
  });

  test('readiness CLI validates file and hosted event inputs as data without printing submitted proof', () => {
    const { main } = require('../release-readiness');
    const { proof, ctx } = readinessFixture();
    const proofFile = path.join(temp, 'readiness.json'), eventFile = path.join(temp, 'event.json');
    fs.writeFileSync(proofFile, JSON.stringify(proof));
    fs.writeFileSync(eventFile, JSON.stringify({ inputs: { readiness_json: JSON.stringify(proof) } }));
    const previous = process.env.GITHUB_EVENT_PATH, originalLog = console.log;
    const messages = [];
    try {
      console.log = (message) => messages.push(message);
      process.env.GITHUB_EVENT_PATH = eventFile;
      assert.strictEqual(main(['--mode=verify', `--proof=${proofFile}`], () => ctx), 0);
      assert.strictEqual(main(['--mode=verify', '--proof-event'], () => ctx), 0);
      assert(messages.every((message) => JSON.parse(message).ready === true && message.length < 512));
      fs.writeFileSync(eventFile, JSON.stringify({ inputs: { readiness_json: null } }));
      let contextCalls = 0;
      assert.strictEqual(main(['--mode=verify', '--proof-event'], () => { contextCalls += 1; return ctx; }), 1);
      assert.strictEqual(contextCalls, 0, 'missing proof must fail before source inspection');
    } finally {
      console.log = originalLog;
      if (previous === undefined) delete process.env.GITHUB_EVENT_PATH; else process.env.GITHUB_EVENT_PATH = previous;
    }
  });

  test('candidate builder rejects dirty identity and capture/version replay', () => {
    assert.throws(() => buildCandidateAttestation({
      ...candidateOptions,
      identity: { ...identity, source_tracked_clean: false },
    }), /clean source/u);
    assert.throws(() => buildCandidateAttestation({
      ...candidateOptions,
      identity: { ...identity, version: '99.98.0' },
    }), /agentsmd version/u);
  });

  test('candidate imports enforce the same count and infrastructure invariants as release archives', () => {
    for (const mutate of [
      (r) => { r.runs[0].errors = 1; },
      (r) => { r.runs[0].false_block_near_negatives = r.runs[0].passed + 1; },
      (r) => { r.runs[0].threshold_verdict = 'fail'; },
    ]) {
      const record = structuredClone(candidate);
      mutate(record);
      assert.strictEqual(validateConformanceCandidateAttestation(record).valid, false);
    }
  });

  test('release binding cross-links candidate, release and registry bytes, and SLSA provenance', () => {
    const binding = buildReleaseBinding(bindingOptions);
    const validation = validateConformanceReleaseBinding(binding);
    assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
    assert.strictEqual(binding.kind, 'agentsmd-conformance-release-binding');
    assert.strictEqual(binding.candidate.sha256, sha256(candidateBytes));
    assert.strictEqual(binding.candidate.deploy_sha256, DEPLOY_SHA256);
    assert.strictEqual(binding.release.version, fixtureVersion);
    assert.strictEqual(binding.release.tree, TREE);
    assert.strictEqual(binding.release.tag, tag);
    assert.strictEqual(binding.artifacts.registry_sha256, releaseSha256);
    assert.strictEqual(binding.artifacts.release_sha256, releaseSha256);
    assert.strictEqual(binding.artifacts.sha512, releaseSha512);
    assert.strictEqual(binding.provenance.sha256, sha256(provenanceBytes));
    assert.strictEqual(binding.provenance.subject_sha512, releaseSha512);
    assert.strictEqual(binding.provenance.commit, RELEASE_COMMIT);
    assert.strictEqual(validateConformanceEvidencePair(candidateBytes, binding).valid, true);
  });

  test('binding rejects byte substitution, tree mismatch, provenance rollback, and invalid time order', () => {
    assert.throws(() => buildReleaseBinding({
      ...bindingOptions,
      registryTarballBytes: Buffer.from('different-registry-bytes'),
    }), /registry and release tarball bytes differ/u);
    assert.throws(() => buildReleaseBinding({
      ...bindingOptions,
      releaseTree: 'e'.repeat(40),
    }), /release tree does not match/u);
    const rollback = structuredClone(provenance);
    rollback.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40);
    assert.throws(() => buildReleaseBinding({
      ...bindingOptions,
      provenanceBytes: Buffer.from(`${JSON.stringify(rollback)}\n`),
    }), /provenance commit/u);
    assert.throws(() => buildReleaseBinding({
      ...bindingOptions,
      verifiedAt: '2026-08-25T02:30:00.000Z',
    }), /timestamp order/u);
  });

  test('pair validator rejects exact-candidate tampering and replayed candidate identity', () => {
    const binding = buildReleaseBinding(bindingOptions);
    const tampered = Buffer.from(candidateBytes.toString('utf8').replace(
      '"model": "gpt-5.6-sol"',
      '"model": "gpt-5.6-ter"',
    ));
    const tamperedResult = validateConformanceEvidencePair(tampered, binding);
    assert.strictEqual(tamperedResult.valid, false);
    assert(tamperedResult.errors.some((error) => error.includes('candidate SHA-256')));

    const replayed = structuredClone(candidate);
    replayed.subject.version = '99.98.0';
    const replayedBytes = Buffer.from(`${JSON.stringify(replayed, null, 2)}\n`);
    const replayedResult = validateConformanceEvidencePair(replayedBytes, binding);
    assert.strictEqual(replayedResult.valid, false);
    assert(replayedResult.errors.some((error) => /candidate (package|version|identity)/u.test(error)));
  });

  test('candidate and binding writers are exact-path, idempotent, and symlink refusing', () => {
    const candidateRoot = path.join(temp, 'candidate-output');
    const candidateFile = path.join(candidateRoot, `v${fixtureVersion}.json`);
    const candidateText = candidateBytes.toString('utf8');
    assert.strictEqual(writeCandidate(candidateFile, fixtureVersion, candidateText, candidateRoot), candidateFile);
    assert.strictEqual(writeCandidate(candidateFile, fixtureVersion, candidateText, candidateRoot), candidateFile);
    assert.throws(() => writeCandidate(candidateFile, fixtureVersion, `${candidateText} `, candidateRoot), /refusing to overwrite/u);

    const binding = buildReleaseBinding(bindingOptions);
    const bindingRoot = path.join(temp, 'binding-output');
    const bindingFile = path.join(bindingRoot, `v${fixtureVersion}.json`);
    const bindingText = `${JSON.stringify(binding, null, 2)}\n`;
    assert.strictEqual(writeBinding(bindingFile, fixtureVersion, bindingText, bindingRoot), bindingFile);
    assert.strictEqual(writeBinding(bindingFile, fixtureVersion, bindingText, bindingRoot), bindingFile);
    assert.throws(() => writeBinding(bindingFile, fixtureVersion, `${bindingText} `, bindingRoot), /refusing to overwrite/u);

    const escaped = path.join(temp, 'escaped-output');
    const linkedRoot = path.join(temp, 'linked-output');
    fs.mkdirSync(escaped);
    fs.symlinkSync(escaped, linkedRoot);
    assert.throws(() => writeBinding(
      path.join(linkedRoot, `v${fixtureVersion}.json`),
      fixtureVersion,
      bindingText,
      linkedRoot,
    ), /non-symlink directory/u);
    assert.deepStrictEqual(fs.readdirSync(escaped), []);
  });

  test('candidate and binding argv reject positional and incomplete invocations', () => {
    assert.match(parseCandidateArgs(['capture.json']).error, /Unknown argument/u);
    assert.match(parseCandidateArgs(['--results=result.json']).error, /attested-at/u);
    assert.match(parseBindingArgs(['binding.json']).error, /Unknown argument/u);
    assert.match(parseBindingArgs(['--candidate=candidate.json']).error, /release-tarball/u);
    const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const tree = require('child_process').execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    assert.strictEqual(releaseTreeForCommit(ROOT, head), tree);
    assert.throws(() => releaseTreeForCommit(ROOT, 'f'.repeat(40)), /unavailable/u);
  });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: false });
  fs.rmSync(temp, { recursive: true, force: false });
  if (!captureRootExisted) {
    try { fs.rmdirSync(CAPTURE_ROOT); } catch {}
  }
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
