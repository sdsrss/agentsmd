#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseStrict } = require('./lib/argv');
const { writeImmutableEvidence } = require('./conformance-evidence');
const {
  validateConformanceCandidateAttestation,
  validateConformanceReleaseBinding,
} = require('./lib/conformance-evidence');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'docs', 'qa-captures', 'release-bindings');
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const USAGE = [
  'Usage: node scripts/conformance-binding.js --candidate=FILE',
  '  --release-tarball=FILE --registry-tarball=FILE --provenance=FILE',
  '  --release-commit=SHA --published-at=ISO --verified-at=ISO',
  '  [--out=FILE]',
  '',
  'Verifies candidate bytes, GitHub/npm tarball equality, and npm SLSA subject,',
  'tag, workflow, and commit binding before emitting a post-publication record.',
].join('\n');

function digest(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

function regularBytes(file, max) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file}: expected a regular non-symlink file`);
  }
  if (stat.size > max) throw new Error(`${file}: exceeds ${max} bytes`);
  return fs.readFileSync(file);
}

function jsonBytes(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label}: expected valid JSON (${error.message})`); }
}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseStrict(argv, {
      bools: [],
      values: [
        'candidate', 'release-tarball', 'registry-tarball', 'provenance',
        'release-commit', 'published-at', 'verified-at', 'out',
      ],
    });
  } catch (error) {
    return { error: error.message };
  }
  const value = (name) => parsed.values[name];
  for (const name of [
    'candidate', 'release-tarball', 'registry-tarball', 'provenance',
    'release-commit', 'published-at', 'verified-at',
  ]) {
    if (!value(name)) return { error: `--${name}=VALUE is required` };
  }
  for (const name of ['candidate', 'release-tarball', 'registry-tarball', 'provenance', 'out']) {
    if (value(name) !== undefined && value(name).length > 4096) return { error: `--${name} path is too long` };
  }
  if (!/^[a-f0-9]{40}$/.test(value('release-commit'))) {
    return { error: '--release-commit must be a full lowercase Git SHA' };
  }
  if (!Number.isFinite(Date.parse(value('published-at')))) return { error: 'invalid --published-at' };
  if (!Number.isFinite(Date.parse(value('verified-at')))) return { error: 'invalid --verified-at' };
  return {
    candidate: value('candidate'),
    releaseTarball: value('release-tarball'),
    registryTarball: value('registry-tarball'),
    provenance: value('provenance'),
    releaseCommit: value('release-commit'),
    publishedAt: new Date(Date.parse(value('published-at'))).toISOString(),
    verifiedAt: new Date(Date.parse(value('verified-at'))).toISOString(),
    out: value('out') || null,
  };
}

function releaseTreeForCommit(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(String(commit || ''))) throw new Error('release commit identity is invalid');
  const result = cp.spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${commit}^{tree}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });
  const tree = String(result.stdout || '').trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(tree)) {
    throw new Error('release commit tree is unavailable from the current repository');
  }
  return tree;
}

function buildReleaseBinding(options) {
  const candidateBytes = Buffer.from(options.candidateBytes);
  const candidate = jsonBytes(candidateBytes, 'candidate attestation');
  const candidateValidation = validateConformanceCandidateAttestation(candidate);
  if (!candidateValidation.valid) {
    throw new Error(`invalid candidate attestation:\n${candidateValidation.errors.join('\n')}`);
  }
  const releaseBytes = Buffer.from(options.releaseTarballBytes);
  const registryBytes = Buffer.from(options.registryTarballBytes);
  if (!releaseBytes.equals(registryBytes)) throw new Error('registry and release tarball bytes differ');
  if (!/^[a-f0-9]{40}$/.test(String(options.releaseCommit || ''))
    || !/^[a-f0-9]{40}$/.test(String(options.releaseTree || ''))) {
    throw new Error('release commit/tree identity is invalid');
  }
  if (options.releaseTree !== candidate.subject.source_tree) {
    throw new Error('release tree does not match the candidate source tree');
  }
  const attestedMs = Date.parse(candidate.attested_at);
  const publishedMs = Date.parse(options.publishedAt);
  const verifiedMs = Date.parse(options.verifiedAt);
  if (!Number.isFinite(publishedMs) || !Number.isFinite(verifiedMs)
    || attestedMs > publishedMs || publishedMs > verifiedMs) {
    throw new Error('candidate, publication, and verification timestamp order is invalid');
  }
  const provenanceBytes = Buffer.from(options.provenanceBytes);
  const provenance = jsonBytes(provenanceBytes, 'SLSA provenance');
  const version = candidate.subject.version;
  const tag = `v${version}`;
  const repository = 'https://github.com/sdsrss/agentsmd';
  const ref = `refs/tags/${tag}`;
  const workflow = '.github/workflows/release.yml';
  const subjectName = `pkg:npm/%40sdsrs/agentsmd@${version}`;
  const tarballSha512 = digest('sha512', registryBytes);
  const subjects = Array.isArray(provenance && provenance.subject) ? provenance.subject : [];
  const matchingSubjects = subjects.filter((subject) => (
    subject && subject.name === subjectName && subject.digest && subject.digest.sha512 === tarballSha512
  ));
  if (matchingSubjects.length !== 1) throw new Error('provenance subject does not match the registry tarball');
  const definition = provenance && provenance.predicate && provenance.predicate.buildDefinition;
  const provenanceWorkflow = definition && definition.externalParameters && definition.externalParameters.workflow;
  if (!provenanceWorkflow
    || provenanceWorkflow.repository !== repository
    || provenanceWorkflow.ref !== ref
    || provenanceWorkflow.path !== workflow) {
    throw new Error('provenance repository/ref/workflow does not match the release');
  }
  const dependencyUri = `git+${repository}@${ref}`;
  const dependencies = Array.isArray(definition.resolvedDependencies) ? definition.resolvedDependencies : [];
  const matchingDependencies = dependencies.filter((dependency) => (
    dependency && dependency.uri === dependencyUri
    && dependency.digest && dependency.digest.gitCommit === options.releaseCommit
  ));
  if (matchingDependencies.length !== 1) throw new Error('provenance commit does not match the release commit');
  const tarballSha256 = digest('sha256', registryBytes);
  const record = {
    schema_version: 1,
    kind: 'agentsmd-conformance-release-binding',
    verified_at: new Date(verifiedMs).toISOString(),
    candidate: {
      sha256: digest('sha256', candidateBytes),
      package: candidate.subject.package,
      version,
      source_commit: candidate.subject.source_commit,
      source_tree: candidate.subject.source_tree,
      deploy_sha256: candidate.subject.deploy_sha256,
      attested_at: candidate.attested_at,
    },
    release: {
      package: candidate.subject.package,
      version,
      commit: options.releaseCommit,
      tree: options.releaseTree,
      tag,
      published_at: new Date(publishedMs).toISOString(),
    },
    artifacts: {
      registry_sha256: tarballSha256,
      release_sha256: digest('sha256', releaseBytes),
      sha512: tarballSha512,
    },
    provenance: {
      sha256: digest('sha256', provenanceBytes),
      subject: subjectName,
      subject_sha512: tarballSha512,
      repository,
      ref,
      workflow,
      commit: options.releaseCommit,
    },
  };
  const validation = validateConformanceReleaseBinding(record);
  if (!validation.valid) throw new Error(`generated invalid release binding:\n${validation.errors.join('\n')}`);
  return record;
}

function writeBinding(file, version, text, outputRoot = OUTPUT_ROOT) {
  const resolvedRoot = path.resolve(outputRoot);
  const expected = path.join(resolvedRoot, `v${version}.json`);
  return writeImmutableEvidence(file, expected, text, {
    root: ROOT,
    outputRoot: resolvedRoot,
    noun: 'binding',
    mode: 0o600,
  });
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { // argv-lint:allow
    console.log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.error) {
    console.error(`conformance-binding: ${options.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const candidateBytes = regularBytes(path.resolve(options.candidate), MAX_JSON_BYTES);
    const record = buildReleaseBinding({
      candidateBytes,
      releaseTarballBytes: regularBytes(path.resolve(options.releaseTarball), MAX_ARTIFACT_BYTES),
      registryTarballBytes: regularBytes(path.resolve(options.registryTarball), MAX_ARTIFACT_BYTES),
      provenanceBytes: regularBytes(path.resolve(options.provenance), MAX_JSON_BYTES),
      releaseCommit: options.releaseCommit,
      releaseTree: releaseTreeForCommit(ROOT, options.releaseCommit),
      publishedAt: options.publishedAt,
      verifiedAt: options.verifiedAt,
    });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (options.out) console.log(path.relative(ROOT, writeBinding(options.out, record.release.version, text)));
    else process.stdout.write(text);
    return 0;
  } catch (error) {
    console.error(`conformance-binding: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_JSON_BYTES,
  OUTPUT_ROOT,
  USAGE,
  buildReleaseBinding,
  main,
  parseArgs,
  releaseTreeForCommit,
  writeBinding,
};
