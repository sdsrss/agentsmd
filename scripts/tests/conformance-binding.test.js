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
