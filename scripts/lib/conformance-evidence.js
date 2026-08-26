'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateSchema } = require('./task-contract');

const ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'schemas', 'conformance-release-evidence.schema.json'),
  'utf8',
));
const CANDIDATE_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'schemas', 'conformance-candidate-attestation.schema.json'),
  'utf8',
));
const BINDING_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'schemas', 'conformance-release-binding.schema.json'),
  'utf8',
));
const MAX_CAPTURE_BYTES = 1024 * 1024;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

function boundedText(value, fallback = 'unknown') {
  const text = String(value == null || value === '' ? fallback : value);
  return text.slice(0, 256);
}

function deepBounds(value, at = '$', depth = 0, errors = []) {
  if (depth > 12) {
    errors.push(`${at}: nesting exceeds 12 levels`);
    return errors;
  }
  if (typeof value === 'string') {
    if (value.length > 512) errors.push(`${at}: text exceeds 512 characters`);
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`${at}: secret-shaped text is forbidden`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) errors.push(`${at}: array exceeds 128 entries`);
    value.forEach((item, index) => deepBounds(item, `${at}[${index}]`, depth + 1, errors));
    return errors;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 64) errors.push(`${at}: object exceeds 64 fields`);
    for (const [key, child] of entries) deepBounds(child, `${at}.${key}`, depth + 1, errors);
  }
  return errors;
}

function validateDecision(value, errors) {
  if (!value || !value.decision) return;
  if (value.decision.verdict === 'waived' && !value.decision.waiver) {
    errors.push('$.decision.waiver: waived evidence requires a release-only waiver');
  }
  if (value.decision.verdict !== 'waived' && value.decision.waiver !== null) {
    errors.push('$.decision.waiver: non-waived evidence must use null');
  }
  const runs = Array.isArray(value.runs) ? value.runs : [];
  const hasFailure = runs.some((run) => run && run.threshold_verdict === 'fail');
  if (value.decision.verdict === 'pass' && hasFailure) {
    errors.push('$.decision.verdict: pass contradicts a failing run threshold');
  }
  if (value.decision.verdict === 'waived' && !hasFailure) {
    errors.push('$.decision.verdict: waived requires at least one failing run threshold');
  }
}

function validateConformanceReleaseEvidence(value) {
  const errors = validateSchema(value, RELEASE_SCHEMA, RELEASE_SCHEMA);
  deepBounds(value, '$', 0, errors);
  if (value && value.decision) {
    if (value.decision.verdict === 'waived' && !value.decision.waiver) {
      errors.push('$.decision.waiver: waived evidence requires a release-only waiver');
    }
    if (value.decision.verdict !== 'waived' && value.decision.waiver !== null) {
      errors.push('$.decision.waiver: non-waived evidence must use null');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateConformanceCandidateAttestation(value) {
  const errors = validateSchema(value, CANDIDATE_SCHEMA, CANDIDATE_SCHEMA);
  deepBounds(value, '$', 0, errors);
  validateDecision(value, errors);
  if (value && value.subject && Array.isArray(value.runs)) {
    const attestedMs = Date.parse(value.attested_at);
    for (const [index, run] of value.runs.entries()) {
      if (run && run.agentsmd_version !== value.subject.version) {
        errors.push(`$.runs[${index}].agentsmd_version: must equal the candidate version`);
      }
      const recordedMs = Date.parse(run && run.recorded_at);
      if (!Number.isFinite(recordedMs) || !Number.isFinite(attestedMs) || recordedMs > attestedMs) {
        errors.push(`$.runs[${index}].recorded_at: must not follow attested_at`);
      }
      if (run && (run.passed > run.total || run.errors > run.total)) {
        errors.push(`$.runs[${index}]: pass/error counts exceed total`);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateConformanceReleaseBinding(value) {
  const errors = validateSchema(value, BINDING_SCHEMA, BINDING_SCHEMA);
  deepBounds(value, '$', 0, errors);
  if (value && value.candidate && value.release && value.artifacts && value.provenance) {
    if (value.candidate.package !== value.release.package
      || value.candidate.version !== value.release.version) {
      errors.push('$.release: package/version must equal the candidate identity');
    }
    if (value.candidate.source_tree !== value.release.tree) {
      errors.push('$.release.tree: must equal the candidate source tree');
    }
    if (value.release.tag !== `v${value.release.version}`) {
      errors.push('$.release.tag: must equal v<release.version>');
    }
    if (value.artifacts.registry_sha256 !== value.artifacts.release_sha256) {
      errors.push('$.artifacts: registry and release SHA-256 must match');
    }
    if (value.artifacts.sha512 !== value.provenance.subject_sha512) {
      errors.push('$.provenance.subject_sha512: must equal the artifact SHA-512');
    }
    const expectedSubject = `pkg:npm/%40sdsrs/agentsmd@${value.release.version}`;
    const expectedRef = `refs/tags/${value.release.tag}`;
    if (value.provenance.subject !== expectedSubject) {
      errors.push('$.provenance.subject: package/version identity mismatch');
    }
    if (value.provenance.ref !== expectedRef) errors.push('$.provenance.ref: release tag mismatch');
    if (value.provenance.commit !== value.release.commit) {
      errors.push('$.provenance.commit: release commit mismatch');
    }
    const attestedMs = Date.parse(value.candidate.attested_at);
    const publishedMs = Date.parse(value.release.published_at);
    const verifiedMs = Date.parse(value.verified_at);
    if (!Number.isFinite(attestedMs) || !Number.isFinite(publishedMs) || !Number.isFinite(verifiedMs)
      || attestedMs > publishedMs || publishedMs > verifiedMs) {
      errors.push('$: candidate, publication, and verification timestamp order is invalid');
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateConformanceEvidencePair(candidateBytes, binding = null) {
  const bytes = Buffer.from(candidateBytes || '');
  let candidate;
  const errors = [];
  try { candidate = JSON.parse(bytes.toString('utf8')); }
  catch (error) { return { valid: false, errors: [`candidate: expected valid JSON (${error.message})`] }; }
  errors.push(...validateConformanceCandidateAttestation(candidate).errors);
  if (binding) {
    errors.push(...validateConformanceReleaseBinding(binding).errors);
    if (binding.candidate) {
      const candidateSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (binding.candidate.sha256 !== candidateSha256) {
        errors.push('binding candidate SHA-256 does not match the exact candidate bytes');
      }
      if (candidate && candidate.subject && (
        binding.candidate.package !== candidate.subject.package
        || binding.candidate.version !== candidate.subject.version
        || binding.candidate.source_commit !== candidate.subject.source_commit
        || binding.candidate.source_tree !== candidate.subject.source_tree
        || binding.candidate.deploy_sha256 !== candidate.subject.deploy_sha256
        || binding.candidate.attested_at !== candidate.attested_at
      )) {
        errors.push('binding candidate package/version/identity does not match the candidate attestation');
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], candidate };
}

function safeRead(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file}: expected a regular non-symlink file`);
  }
  if (stat.size > MAX_CAPTURE_BYTES) throw new Error(`${file}: exceeds ${MAX_CAPTURE_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8');
}

function safeJson(file) {
  const raw = safeRead(file);
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${file}: expected valid JSON (${error.message})`); }
}

function ageDays(recordedMs, now) {
  return recordedMs === null ? null : Math.round(((now - recordedMs) / 86400000) * 10) / 10;
}

function commonText(values) {
  const bounded = values.map((value) => boundedText(value));
  return new Set(bounded).size === 1 ? bounded[0] : 'multiple';
}

function provenance({
  kind = 'none', applicability = 'unavailable', reason = 'no-evidence-input',
  source = 'none', releaseVersion = 'unknown', releaseCommit = 'unknown',
  currentCommit = 'unknown', inputsMatch = null, evidencePhase = null,
} = {}) {
  const result = {
    kind,
    applicability,
    reason: boundedText(reason),
    source: boundedText(source),
    release_version: boundedText(releaseVersion),
    release_commit: boundedText(releaseCommit),
    current_commit: boundedText(currentCommit),
    inputs_match: typeof inputsMatch === 'boolean' ? inputsMatch : null,
  };
  if (evidencePhase) result.evidence_phase = boundedText(evidencePhase);
  return result;
}

function emptyConformance(state = 'unavailable', evidenceProvenance = provenance()) {
  return {
    state,
    capture: 'none',
    recorded_at: 'unknown',
    age_days: null,
    passed: 0,
    total: 0,
    errors: 0,
    codex_version: 'unknown',
    model: 'unknown',
    agentsmd_version: 'unknown',
    false_block_near_negatives: 0,
    runs: 0,
    threshold_verdict: 'unknown',
    provenance: evidenceProvenance,
  };
}

function candidateApplicability({
  candidate, binding, sourceIdentity, inputIdentity, packageIdentity, artifactIdentity,
}) {
  const inputsMatch = Boolean(
    inputIdentity
    && candidate.subject.cases_sha256 === inputIdentity.cases_sha256
    && candidate.subject.thresholds_sha256 === inputIdentity.thresholds_sha256,
  );
  const packageMatches = candidate.subject.package === packageIdentity.name
    && candidate.subject.version === packageIdentity.version;
  const artifactMeasured = artifactIdentity && artifactIdentity.state === 'measured'
    && /^[a-f0-9]{64}$/.test(String(artifactIdentity.deploy_sha256 || ''));
  const artifactMatches = artifactMeasured
    && artifactIdentity.deploy_sha256 === candidate.subject.deploy_sha256;
  if (!packageMatches) return { applicability: 'mismatch', reason: 'package-version-mismatch', inputsMatch };
  if (!inputsMatch) return { applicability: 'mismatch', reason: 'conformance-input-mismatch', inputsMatch };
  if (artifactIdentity && artifactIdentity.state === 'invalid') {
    return { applicability: 'invalid', reason: 'current-artifact-identity-invalid', inputsMatch };
  }
  if (!artifactMeasured) {
    return { applicability: 'historical', reason: 'current-artifact-identity-unavailable', inputsMatch };
  }
  if (!artifactMatches) return { applicability: 'mismatch', reason: 'deploy-tree-mismatch', inputsMatch };
  if (sourceIdentity && sourceIdentity.state === 'measured') {
    if (sourceIdentity.tracked_clean !== true) {
      return { applicability: 'mismatch', reason: 'current-tree-dirty', inputsMatch };
    }
    if (binding && sourceIdentity.commit !== binding.release.commit) {
      return { applicability: 'mismatch', reason: 'release-commit-mismatch', inputsMatch };
    }
    if (!binding && sourceIdentity.commit !== candidate.subject.source_commit) {
      return { applicability: 'mismatch', reason: 'source-commit-mismatch', inputsMatch };
    }
    if (/^[a-f0-9]{40}$/.test(String(sourceIdentity.tree || ''))
      && sourceIdentity.tree !== candidate.subject.source_tree) {
      return {
        applicability: 'mismatch',
        reason: binding ? 'release-tree-mismatch' : 'source-tree-mismatch',
        inputsMatch,
      };
    }
  }
  return {
    applicability: 'current',
    reason: binding ? 'published-binding-and-artifact-match' : 'candidate-and-artifact-match',
    inputsMatch,
  };
}

function externalConformanceSummary({
  candidateEvidenceFile, releaseBindingFile, now, expected, sourceIdentity,
  inputIdentity, packageIdentity, artifactIdentity, freshDays,
}) {
  if (!candidateEvidenceFile && !releaseBindingFile) return null;
  if (!candidateEvidenceFile) {
    return emptyConformance('invalid', provenance({
      kind: 'release-evidence', applicability: 'invalid', reason: 'candidate-evidence-required',
      source: path.resolve(releaseBindingFile), evidencePhase: 'published-binding',
    }));
  }
  const candidatePath = path.resolve(candidateEvidenceFile);
  let candidateText;
  try { candidateText = safeRead(candidatePath); }
  catch (error) {
    const missing = error && error.code === 'ENOENT';
    return emptyConformance(missing ? 'unavailable' : 'invalid', provenance({
      kind: missing ? 'none' : 'release-evidence',
      applicability: missing ? 'unavailable' : 'invalid',
      reason: missing ? 'candidate-evidence-unavailable' : 'invalid-candidate-evidence',
      source: candidatePath,
      evidencePhase: 'local-candidate',
    }));
  }
  let binding = null;
  let bindingPath = null;
  if (releaseBindingFile) {
    bindingPath = path.resolve(releaseBindingFile);
    try { binding = safeJson(bindingPath); }
    catch (error) {
      const missing = error && error.code === 'ENOENT';
      return emptyConformance(missing ? 'unavailable' : 'invalid', provenance({
        kind: missing ? 'none' : 'release-evidence',
        applicability: missing ? 'unavailable' : 'invalid',
        reason: missing ? 'release-binding-unavailable' : 'invalid-release-binding',
        source: bindingPath,
        evidencePhase: 'published-binding',
      }));
    }
  }
  const pair = validateConformanceEvidencePair(Buffer.from(candidateText), binding);
  const phase = binding ? 'published-binding' : 'local-candidate';
  if (!pair.valid) {
    return emptyConformance('invalid', provenance({
      kind: 'release-evidence', applicability: 'invalid',
      reason: binding ? 'invalid-release-binding' : 'invalid-candidate-evidence',
      source: bindingPath || candidatePath, evidencePhase: phase,
    }));
  }
  const candidate = pair.candidate;
  const runsValid = candidate.runs.every((run) => (
    run.total === expected.length
    && run.passed <= run.total
    && run.errors <= run.total
    && Number.isFinite(Date.parse(run.recorded_at))
    && Date.parse(run.recorded_at) <= now
  ));
  if (!runsValid || Date.parse(candidate.attested_at) > now
    || (binding && (Date.parse(binding.release.published_at) > now || Date.parse(binding.verified_at) > now))) {
    return emptyConformance('invalid', provenance({
      kind: 'release-evidence', applicability: 'invalid',
      reason: binding ? 'invalid-release-binding' : 'invalid-candidate-evidence',
      source: bindingPath || candidatePath, evidencePhase: phase,
    }));
  }
  const { applicability, reason, inputsMatch } = candidateApplicability({
    candidate, binding, sourceIdentity, inputIdentity, packageIdentity, artifactIdentity,
  });
  const latestMs = Math.max(...candidate.runs.map((run) => Date.parse(run.recorded_at)));
  const age = ageDays(latestMs, now);
  return {
    state: applicability === 'invalid'
      ? 'invalid'
      : (applicability === 'current' && age !== null && age <= freshDays ? 'fresh' : 'stale'),
    capture: path.basename(bindingPath || candidatePath),
    recorded_at: new Date(latestMs).toISOString(),
    age_days: age,
    passed: candidate.runs.reduce((sum, run) => sum + run.passed, 0),
    total: candidate.runs.reduce((sum, run) => sum + run.total, 0),
    errors: candidate.runs.reduce((sum, run) => sum + run.errors, 0),
    codex_version: commonText(candidate.runs.map((run) => run.codex_version)),
    model: commonText(candidate.runs.map((run) => run.model)),
    agentsmd_version: commonText(candidate.runs.map((run) => run.agentsmd_version)),
    false_block_near_negatives: candidate.runs
      .reduce((sum, run) => sum + run.false_block_near_negatives, 0),
    runs: candidate.runs.length,
    threshold_verdict: candidate.decision.verdict,
    provenance: provenance({
      kind: 'release-evidence', applicability, reason,
      source: bindingPath || candidatePath,
      releaseVersion: candidate.subject.version,
      releaseCommit: binding && binding.release.commit,
      currentCommit: sourceIdentity && sourceIdentity.commit,
      inputsMatch,
      evidencePhase: phase,
    }),
  };
}

module.exports = {
  externalConformanceSummary,
  validateConformanceCandidateAttestation,
  validateConformanceEvidencePair,
  validateConformanceReleaseBinding,
  validateConformanceReleaseEvidence,
};
