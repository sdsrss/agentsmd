#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseStrict } = require('./lib/argv');
const { validateConformanceCandidateAttestation } = require('./lib/conformance-evidence');
const { inspectReleaseArtifact } = require('./lib/release-artifact');
const { buildEvidence, writeImmutableEvidence } = require('./conformance-evidence');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'docs', 'qa-captures', 'release-candidates');
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = [
  'Usage: node scripts/conformance-candidate.js --attested-at=ISO',
  '  --decision=pass|fail|waived --results=FILE[,FILE...]',
  '  [--waiver-scope=CATEGORY] [--allow-legacy-source] [--out=FILE]',
  '',
  'Reads bounded conformance results, verifies the clean current source and',
  'deterministic deploy tree, and emits a pre-publication candidate attestation.',
].join('\n');

function regularBytes(file, max = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file}: expected a regular non-symlink file`);
  }
  if (stat.size > max) throw new Error(`${file}: exceeds ${max} bytes`);
  return fs.readFileSync(file);
}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseStrict(argv, {
      bools: ['allow-legacy-source'],
      values: ['attested-at', 'decision', 'results', 'waiver-scope', 'out'],
    });
  } catch (error) {
    return { error: error.message };
  }
  const value = (name) => parsed.values[name];
  for (const name of ['attested-at', 'decision', 'results']) {
    if (!value(name)) return { error: `--${name}=VALUE is required` };
  }
  if (!Number.isFinite(Date.parse(value('attested-at')))) return { error: 'invalid --attested-at' };
  if (!['pass', 'fail', 'waived'].includes(value('decision'))) return { error: 'invalid --decision' }; // argv-lint:allow
  const results = value('results').split(',');
  if (results.length < 1 || results.length > 8 || results.some((item) => item.length === 0 || item.length > 4096)) {
    return { error: '--results must contain 1-8 bounded comma-separated paths' };
  }
  const waiverScope = value('waiver-scope') || null;
  if (value('decision') === 'waived' && (!waiverScope || waiverScope.length > 256)) {
    return { error: '--decision=waived requires --waiver-scope=CATEGORY' };
  }
  if (value('decision') !== 'waived' && waiverScope) {
    return { error: '--waiver-scope is valid only with --decision=waived' };
  }
  if (value('out') !== undefined && (!value('out') || value('out').length > 4096)) {
    return { error: '--out must be a non-empty bounded path' };
  }
  return {
    attestedAt: new Date(Date.parse(value('attested-at'))).toISOString(),
    decision: value('decision'),
    results,
    waiverScope,
    allowLegacySource: parsed.bools.has('allow-legacy-source'),
    out: value('out') || null,
  };
}

function gitValue(root, args) {
  const result = cp.spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function candidateIdentity(root = ROOT) {
  const packageFile = path.join(root, 'package.json');
  const packageInfo = JSON.parse(regularBytes(packageFile).toString('utf8'));
  if (packageInfo.name !== '@sdsrs/agentsmd' || !SEMVER_RE.test(String(packageInfo.version || ''))) {
    throw new Error('package.json identity/version is invalid');
  }
  const sourceCommit = gitValue(root, ['rev-parse', '--verify', 'HEAD']);
  const sourceTree = gitValue(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{40}$/.test(sourceTree)) {
    throw new Error('source commit/tree identity is invalid');
  }
  const clean = cp.spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });
  if (clean.status !== 0 || String(clean.stdout || '').trim() !== '') {
    throw new Error('candidate attestation requires a clean source tree');
  }
  const artifact = inspectReleaseArtifact(root);
  if (!artifact.complete || !/^[a-f0-9]{64}$/.test(String(artifact.deploySha256 || ''))) {
    throw new Error(`candidate deploy tree is incomplete: ${(artifact.errors || []).join('; ')}`);
  }
  return {
    package: packageInfo.name,
    version: packageInfo.version,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    source_tracked_clean: true,
    deploy_sha256: artifact.deploySha256,
  };
}

function buildCandidateAttestation(options) {
  const identity = options && options.identity;
  if (!identity || identity.source_tracked_clean !== true) {
    throw new Error('candidate attestation requires a clean source identity');
  }
  if (identity.package !== '@sdsrs/agentsmd'
    || !SEMVER_RE.test(String(identity.version || ''))
    || !/^[a-f0-9]{40}$/.test(String(identity.source_commit || ''))
    || !/^[a-f0-9]{40}$/.test(String(identity.source_tree || ''))
    || !/^[a-f0-9]{64}$/.test(String(identity.deploy_sha256 || ''))) {
    throw new Error('candidate source/package/deploy identity is invalid');
  }
  const legacy = buildEvidence({
    releaseVersion: identity.version,
    releaseCommit: identity.source_commit,
    evaluatedCommit: identity.source_commit,
    publishedAt: options.attestedAt,
    decision: options.decision,
    results: options.results,
    waiverScope: options.waiverScope,
    allowLegacySource: options.allowLegacySource,
    out: null,
  });
  const record = {
    schema_version: 1,
    kind: 'agentsmd-conformance-candidate-attestation',
    attested_at: new Date(Date.parse(options.attestedAt)).toISOString(),
    subject: {
      package: identity.package,
      version: identity.version,
      source_commit: identity.source_commit,
      source_tree: identity.source_tree,
      source_tracked_clean: true,
      deploy_sha256: identity.deploy_sha256,
      cases_sha256: legacy.subject.cases_sha256,
      thresholds_sha256: legacy.subject.thresholds_sha256,
    },
    runs: legacy.runs,
    decision: legacy.decision,
  };
  const validation = validateConformanceCandidateAttestation(record);
  if (!validation.valid) throw new Error(`generated invalid candidate attestation:\n${validation.errors.join('\n')}`);
  return record;
}

function writeCandidate(file, version, text, outputRoot = OUTPUT_ROOT) {
  const resolvedRoot = path.resolve(outputRoot);
  const expected = path.join(resolvedRoot, `v${version}.json`);
  return writeImmutableEvidence(file, expected, text, {
    root: ROOT,
    outputRoot: resolvedRoot,
    noun: 'attestation',
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
    console.error(`conformance-candidate: ${options.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const identity = candidateIdentity();
    const record = buildCandidateAttestation({ ...options, identity });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (options.out) console.log(path.relative(ROOT, writeCandidate(options.out, identity.version, text)));
    else process.stdout.write(text);
    return 0;
  } catch (error) {
    console.error(`conformance-candidate: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  OUTPUT_ROOT,
  USAGE,
  buildCandidateAttestation,
  candidateIdentity,
  main,
  parseArgs,
  writeCandidate,
};
