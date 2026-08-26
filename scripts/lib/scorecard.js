'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const CT = require('./config-toml');
const { parsePositiveInt, parseStrict } = require('./argv');
const { audit, classifyProject, readRows, TEST_TAGS } = require('../audit');
const { doctor } = require('../doctor');
const { lessonBypassAudit } = require('../lesson-bypass-audit');
const { rulesAudit } = require('../rules');
const { samplingAudit } = require('../sampling-audit');
const { sparkline } = require('../sparkline');
const { status } = require('../status');
const { validateSchema } = require('./task-contract');
const F = require('./fs-atomic');
const { inspectReleaseArtifact } = require('./release-artifact');
const {
  externalConformanceSummary,
  validateConformanceCandidateAttestation,
  validateConformanceEvidencePair,
  validateConformanceReleaseBinding,
  validateConformanceReleaseEvidence,
} = require('./conformance-evidence');
const { classifyFailOpenCauses, summarizeReviewedOutcomes } = require('./outcomes');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'scorecard.schema.json'), 'utf8'));
const MAX_DAYS = 3650;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FRESH_DAYS = 45;
const REQUIRED_RECIPES = [
  'weekly-runtime-canary.md',
  'weekly-governance-review.md',
  'release-readiness.md',
  'pr-review.md',
];
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

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function safeBytes(file, max = MAX_CAPTURE_BYTES) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return 0;
    return stat.size;
  } catch {
    return 0;
  }
}

function probeRegularFile(file, max = MAX_CAPTURE_BYTES, io = fs) {
  const target = path.resolve(String(file));
  let stat;
  try {
    stat = io.lstatSync(target);
  } catch (error) {
    return {
      path: target,
      state: error && error.code === 'ENOENT' ? 'missing' : 'unavailable',
      bytes: error && error.code === 'ENOENT' ? 0 : null,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) {
    return { path: target, state: 'invalid', bytes: null };
  }
  let descriptor;
  try {
    if (typeof io.openSync === 'function') {
      descriptor = io.openSync(target, 'r');
      if (typeof io.fstatSync === 'function') {
        const opened = io.fstatSync(descriptor);
        const sameIdentity = stat.dev === undefined || stat.ino === undefined
          || opened.dev === undefined || opened.ino === undefined
          || (stat.dev === opened.dev && stat.ino === opened.ino);
        if (!opened.isFile() || opened.size > max || !sameIdentity) {
          if (typeof io.closeSync === 'function') io.closeSync(descriptor);
          descriptor = undefined;
          return { path: target, state: 'invalid', bytes: null };
        }
        stat = opened;
      }
      if (typeof io.closeSync === 'function') io.closeSync(descriptor);
      descriptor = undefined;
    }
  } catch {
    if (descriptor !== undefined && typeof io.closeSync === 'function') {
      try { io.closeSync(descriptor); } catch {}
    }
    return { path: target, state: 'unavailable', bytes: null };
  }
  return { path: target, state: stat.size === 0 ? 'empty' : 'measured', bytes: stat.size };
}

function safeRead(file, max = MAX_CAPTURE_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file}: expected a regular non-symlink file`);
  }
  if (stat.size > max) throw new Error(`${file}: exceeds ${max} bytes`);
  return fs.readFileSync(file, 'utf8');
}

function safeJson(file, max = MAX_CAPTURE_BYTES) {
  const raw = safeRead(file, max);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file}: expected valid JSON (${error.message})`);
  }
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

function validateScorecard(value) {
  const errors = validateSchema(value, SCHEMA, SCHEMA);
  deepBounds(value, '$', 0, errors);
  const falseBlocks = value && value.false_blocks;
  if (falseBlocks && Number.isInteger(falseBlocks.rate_denominator)) {
    if (falseBlocks.rate_denominator !== falseBlocks.true_blocks + falseBlocks.confirmed_false_blocks) {
      errors.push('$.false_blocks.rate_denominator: must equal true_blocks + confirmed_false_blocks');
    }
    if (falseBlocks.blocking_events !== falseBlocks.eligible_field_events + falseBlocks.excluded_non_field_events) {
      errors.push('$.false_blocks.blocking_events: must equal eligible_field_events + excluded_non_field_events');
    }
    if (falseBlocks.eligible_field_events !== falseBlocks.rate_denominator
      + falseBlocks.unreviewed_events + falseBlocks.unmeasurable_events) {
      errors.push('$.false_blocks.eligible_field_events: must equal denominator + unreviewed + unmeasurable');
    }
    const expectedRate = falseBlocks.rate_denominator > 0
      ? falseBlocks.confirmed_false_blocks / falseBlocks.rate_denominator : null;
    if (falseBlocks.state === 'invalid') {
      if (falseBlocks.false_block_rate !== null) errors.push('$.false_blocks.false_block_rate: invalid evidence requires null');
    } else if (falseBlocks.false_block_rate !== expectedRate) {
      errors.push('$.false_blocks.false_block_rate: must equal confirmed_false_blocks / rate_denominator');
    }
  }
  const automation = value && value.automation;
  if (automation && automation.fail_open_causes) {
    const causeTotal = Object.values(automation.fail_open_causes)
      .reduce((sum, count) => sum + count, 0);
    if (causeTotal !== automation.fail_open_events) {
      errors.push('$.automation.fail_open_causes: categories must sum to fail_open_events');
    }
  }
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch (error) { errors.push(`$: is not JSON serializable (${error.message})`); }
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) {
    errors.push(`$: serialized scorecard exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function stampDate(stamp) {
  const match = String(stamp || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function ageDays(recordedMs, now) {
  return recordedMs === null ? null : Math.round(((now - recordedMs) / 86400000) * 10) / 10;
}

function conformanceProvenance({
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

function emptyConformance(state = 'unavailable', provenance = conformanceProvenance()) {
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
    provenance,
  };
}

function sha256Regular(file) {
  try {
    return crypto.createHash('sha256').update(safeRead(file)).digest('hex');
  } catch {
    return null;
  }
}

function currentSourceIdentity(root) {
  const git = (args, stdio = ['ignore', 'pipe', 'pipe']) => cp.spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio,
    timeout: 3000,
  });
  try {
    const revision = git(['rev-parse', '--verify', 'HEAD']);
    const commit = String(revision.stdout || '').trim();
    if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(commit)) {
      return { state: 'unavailable', commit: 'unknown', tree: 'unknown', tracked_clean: null };
    }
    const treeRevision = git(['rev-parse', '--verify', 'HEAD^{tree}']);
    const tree = String(treeRevision.stdout || '').trim();
    if (treeRevision.status !== 0 || !/^[a-f0-9]{40}$/.test(tree)) {
      return { state: 'unavailable', commit, tree: 'unknown', tracked_clean: null };
    }
    const diff = git(['diff-index', '--quiet', 'HEAD', '--'], ['ignore', 'ignore', 'ignore']);
    if (diff.status !== 0 && diff.status !== 1) {
      return { state: 'unavailable', commit, tree, tracked_clean: null };
    }
    return { state: 'measured', commit, tree, tracked_clean: diff.status === 0 };
  } catch {
    return { state: 'unavailable', commit: 'unknown', tree: 'unknown', tracked_clean: null };
  }
}

function currentConformanceArtifactIdentity(root, sourceIdentity) {
  try {
    const pluginFile = path.join(root, '.codex-plugin', 'plugin.json');
    let hasPackagedSource = false;
    try {
      const stat = fs.lstatSync(pluginFile);
      hasPackagedSource = stat.isFile() && !stat.isSymbolicLink();
    } catch {}
    if (hasPackagedSource || (sourceIdentity && sourceIdentity.state === 'measured')) {
      const artifact = inspectReleaseArtifact(root);
      if (/^[a-f0-9]{64}$/.test(String(artifact.deploySha256 || ''))) {
        return { state: artifact.complete ? 'measured' : 'invalid', deploy_sha256: artifact.deploySha256 };
      }
      return { state: 'invalid', deploy_sha256: null };
    }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'invalid', deploy_sha256: null };
    return { state: 'measured', deploy_sha256: F.sha256Tree(root) };
  } catch {
    return { state: 'unavailable', deploy_sha256: null };
  }
}

function currentPackageIdentity(root) {
  try {
    const value = safeJson(path.join(root, 'package.json'));
    if (!value || typeof value.name !== 'string' || typeof value.version !== 'string') {
      return { name: 'unknown', version: 'unknown' };
    }
    return { name: boundedText(value.name), version: boundedText(value.version) };
  } catch {
    return { name: 'unknown', version: 'unknown' };
  }
}

function currentConformanceInputIdentity(root) {
  return {
    cases_sha256: sha256Regular(path.join(root, 'qa', 'conformance', 'cases.json')),
    thresholds_sha256: sha256Regular(path.join(root, 'qa', 'conformance', 'thresholds.json')),
  };
}

function currentConformanceThresholds(root) {
  try {
    const value = safeJson(path.join(root, 'qa', 'conformance', 'thresholds.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function thresholdVerdict(categories, thresholds, errors, passed, total) {
  if (errors > 0) return 'fail';
  if (passed === total) return 'pass';
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) return 'unknown';
  let measured = 0;
  for (const [category, threshold] of Object.entries(thresholds)) {
    if (!threshold || !Number.isInteger(threshold.min_pass)) continue;
    const bucket = categories && categories[category];
    if (!bucket || !Number.isInteger(bucket.pass) || !Number.isInteger(bucket.total) || bucket.total === 0) continue;
    measured += 1;
    if (bucket.pass < threshold.min_pass) return 'fail';
  }
  return measured > 0 ? 'pass' : 'unknown';
}

function commonText(values) {
  const bounded = values.map((value) => boundedText(value));
  return new Set(bounded).size === 1 ? bounded[0] : 'multiple';
}

function rawConformanceSummary({
  captureRoot, now, expected, sourceIdentity, inputIdentity, thresholds,
}) {
  const expectedSet = new Set(expected);
  let entries;
  try {
    const resolvedRoot = path.resolve(captureRoot);
    const stat = fs.lstatSync(resolvedRoot);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || fs.realpathSync(resolvedRoot) !== P.platformCanonicalPath(resolvedRoot)) {
      return emptyConformance('invalid', conformanceProvenance({
        applicability: 'invalid', reason: 'invalid-capture-root', source: resolvedRoot,
      }));
    }
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return emptyConformance('invalid', conformanceProvenance({
        applicability: 'invalid', reason: 'invalid-capture-root', source: path.resolve(captureRoot),
      }));
    }
    return null;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && /^conformance-\d{8}T\d{6}Z$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 256);
  let fallback = null;
  let invalidSeen = false;
  for (const name of names) {
    const file = path.join(captureRoot, name, 'results.json');
    let result;
    try { result = safeJson(file); } catch { invalidSeen = true; continue; }
    if (!result || !result.meta || !Array.isArray(result.cases) || result.cases.length > 512) {
      invalidSeen = true;
      continue;
    }
    const ids = result.cases.map((entry) => entry && entry.id);
    const fullSuite = result.meta.cases === expected.length
      && ids.length === expected.length
      && new Set(ids).size === expected.length
      && ids.every((id) => expectedSet.has(id));
    if (!fullSuite) continue;
    const recordedMs = stampDate(result.meta.stamp);
    if (recordedMs === null || recordedMs > now) { invalidSeen = true; continue; }
    const total = result.cases.length;
    const passed = result.cases.filter((entry) => entry && entry.verdict === 'pass').length;
    const errors = Object.values(result.categories || {})
      .reduce((sum, bucket) => sum + (Number.isInteger(bucket && bucket.errors) ? bucket.errors : 0), 0);
    const age = ageDays(recordedMs, now);
    const falseBlock = result.cases.filter((entry) => (
      entry
      && entry.category === 'false-block'
      && entry.kind !== 'positive'
      && entry.verdict === 'pass'
    )).length;
    const captureHasSource = /^[a-f0-9]{40}$/.test(String(result.meta.source_commit || ''))
      && typeof result.meta.source_tracked_clean === 'boolean';
    const inputsMatch = Boolean(
      inputIdentity
      && typeof inputIdentity.cases_sha256 === 'string'
      && typeof inputIdentity.thresholds_sha256 === 'string'
      && result.meta.cases_sha256 === inputIdentity.cases_sha256
      && result.meta.thresholds_sha256 === inputIdentity.thresholds_sha256,
    );
    let applicability = 'current';
    let reason = 'source-and-inputs-match';
    if (!captureHasSource) {
      applicability = 'historical';
      reason = 'capture-source-identity-missing';
    } else if (!sourceIdentity || sourceIdentity.state !== 'measured') {
      applicability = 'historical';
      reason = 'current-source-identity-unavailable';
    } else if (!inputsMatch) {
      applicability = 'mismatch';
      reason = 'conformance-input-mismatch';
    } else if (result.meta.source_commit !== sourceIdentity.commit) {
      applicability = 'mismatch';
      reason = 'source-commit-mismatch';
    } else if (result.meta.source_tracked_clean !== true) {
      applicability = 'mismatch';
      reason = 'capture-source-dirty';
    } else if (sourceIdentity.tracked_clean !== true) {
      applicability = 'mismatch';
      reason = 'current-tree-dirty';
    }
    const summary = {
      state: applicability === 'current' && age !== null && age <= FRESH_DAYS ? 'fresh' : 'stale',
      capture: name,
      recorded_at: new Date(recordedMs).toISOString(),
      age_days: age,
      passed,
      total,
      errors,
      codex_version: boundedText(result.meta.codex),
      model: boundedText(result.meta.model),
      agentsmd_version: boundedText(result.meta.agentsmd),
      false_block_near_negatives: falseBlock,
      runs: 1,
      threshold_verdict: thresholdVerdict(result.categories, thresholds, errors, passed, total),
      provenance: conformanceProvenance({
        kind: captureHasSource ? 'current-tree-capture' : 'legacy-capture',
        applicability,
        reason,
        source: name,
        currentCommit: sourceIdentity && sourceIdentity.commit,
        inputsMatch,
      }),
    };
    if (applicability === 'current') return summary;
    if (!fallback) fallback = summary;
  }
  if (fallback) return fallback;
  return invalidSeen
    ? emptyConformance('invalid', conformanceProvenance({ applicability: 'invalid', reason: 'invalid-capture' }))
    : null;
}

function releaseEvidenceSummary({
  releaseEvidenceRoot, now, expected, sourceIdentity, inputIdentity, packageIdentity,
}) {
  let entries;
  try {
    const resolvedRoot = path.resolve(releaseEvidenceRoot);
    const stat = fs.lstatSync(resolvedRoot);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || fs.realpathSync(resolvedRoot) !== P.platformCanonicalPath(resolvedRoot)) {
      return emptyConformance('invalid', conformanceProvenance({
        applicability: 'invalid', reason: 'invalid-release-evidence-root', source: resolvedRoot,
      }));
    }
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return emptyConformance('invalid', conformanceProvenance({
        applicability: 'invalid', reason: 'invalid-release-evidence-root', source: path.resolve(releaseEvidenceRoot),
      }));
    }
    return null;
  }
  const candidates = [];
  let invalidSeen = false;
  for (const entry of entries
    .filter((item) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.json$/.test(item.name))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, 256)) {
    if (!entry.isFile() || entry.isSymbolicLink()) { invalidSeen = true; continue; }
    const file = path.join(releaseEvidenceRoot, entry.name);
    let record;
    try { record = safeJson(file); } catch { invalidSeen = true; continue; }
    const validation = validateConformanceReleaseEvidence(record);
    const runsValid = record && Array.isArray(record.runs)
      && record.runs.every((run) => (
        run.total === expected.length
        && run.passed <= run.total
        && run.errors <= run.total
        && Number.isFinite(Date.parse(run.recorded_at))
        && Date.parse(run.recorded_at) <= now
      ));
    const publishedMs = Date.parse(record && record.release && record.release.published_at);
    if (!validation.valid || !runsValid || !Number.isFinite(publishedMs) || publishedMs > now) {
      invalidSeen = true;
      continue;
    }
    candidates.push({ entry, record, publishedMs });
  }
  if (!candidates.length) {
    return invalidSeen
      ? emptyConformance('invalid', conformanceProvenance({ applicability: 'invalid', reason: 'invalid-release-evidence' }))
      : null;
  }
  candidates.sort((left, right) => right.publishedMs - left.publishedMs);
  const exact = candidates.filter(({ record }) => (
    record.release.package === packageIdentity.name
    && record.release.version === packageIdentity.version
  ));
  const selected = exact[0] || candidates[0];
  const { entry, record } = selected;
  const inputsMatch = Boolean(
    inputIdentity
    && record.subject.cases_sha256 === inputIdentity.cases_sha256
    && record.subject.thresholds_sha256 === inputIdentity.thresholds_sha256,
  );
  const packageMatches = record.release.package === packageIdentity.name
    && record.release.version === packageIdentity.version;
  let applicability = 'current';
  let reason = 'release-and-inputs-match';
  if (!packageMatches) {
    applicability = 'mismatch';
    reason = 'package-version-mismatch';
  } else if (!inputsMatch) {
    applicability = 'mismatch';
    reason = 'conformance-input-mismatch';
  } else if (!sourceIdentity || sourceIdentity.state !== 'measured') {
    applicability = 'historical';
    reason = 'packaged-release-evidence';
  } else if (sourceIdentity.commit !== record.release.commit) {
    applicability = 'mismatch';
    reason = 'release-commit-mismatch';
  } else if (sourceIdentity.tracked_clean !== true) {
    applicability = 'mismatch';
    reason = 'current-tree-dirty';
  }
  const latestMs = Math.max(...record.runs.map((run) => Date.parse(run.recorded_at)));
  const age = ageDays(latestMs, now);
  return {
    state: applicability === 'current' && age !== null && age <= FRESH_DAYS ? 'fresh' : 'stale',
    capture: entry.name,
    recorded_at: new Date(latestMs).toISOString(),
    age_days: age,
    passed: record.runs.reduce((sum, run) => sum + run.passed, 0),
    total: record.runs.reduce((sum, run) => sum + run.total, 0),
    errors: record.runs.reduce((sum, run) => sum + run.errors, 0),
    codex_version: commonText(record.runs.map((run) => run.codex_version)),
    model: commonText(record.runs.map((run) => run.model)),
    agentsmd_version: commonText(record.runs.map((run) => run.agentsmd_version)),
    false_block_near_negatives: record.runs
      .reduce((sum, run) => sum + run.false_block_near_negatives, 0),
    runs: record.runs.length,
    threshold_verdict: record.decision.verdict,
    provenance: conformanceProvenance({
      kind: 'release-evidence',
      applicability,
      reason,
      source: entry.name,
      releaseVersion: record.release.version,
      releaseCommit: record.release.commit,
      currentCommit: sourceIdentity && sourceIdentity.commit,
      inputsMatch,
    }),
  };
}

function conformanceSummary({
  captureRoot, releaseEvidenceRoot, now, expectedCaseIds, sourceIdentity,
  inputIdentity, packageIdentity, thresholds, candidateEvidenceFile,
  releaseBindingFile, artifactIdentity,
}) {
  const expected = Array.isArray(expectedCaseIds)
    ? [...new Set(expectedCaseIds.filter((id) => typeof id === 'string' && id.length > 0))]
    : [];
  if (!expected.length) {
    return emptyConformance('unavailable', conformanceProvenance({ reason: 'case-library-unavailable' }));
  }
  const raw = rawConformanceSummary({
    captureRoot, now, expected, sourceIdentity, inputIdentity, thresholds,
  });
  if (raw && raw.provenance.applicability === 'current') return raw;
  const external = externalConformanceSummary({
    candidateEvidenceFile, releaseBindingFile, now, expected, sourceIdentity,
    inputIdentity, packageIdentity, artifactIdentity, freshDays: FRESH_DAYS,
  });
  if (external && external.provenance.applicability === 'current') return external;
  const release = releaseEvidenceSummary({
    releaseEvidenceRoot, now, expected, sourceIdentity, inputIdentity, packageIdentity,
  });
  if (external) return external;
  if (release) return release;
  if (raw) return raw;
  return emptyConformance('unavailable', conformanceProvenance({ reason: 'no-evidence-input' }));
}

function expectedConformanceCaseIds(root) {
  try {
    const library = safeJson(path.join(root, 'qa', 'conformance', 'cases.json'));
    if (!library || !Array.isArray(library.cases) || library.cases.length > 512) return [];
    const ids = library.cases.map((entry) => entry && entry.id);
    if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) return [];
    return ids;
  } catch {
    return [];
  }
}

function performanceSummary(file, now) {
  const empty = (state = 'unavailable') => ({
    state,
    recorded_at: 'unknown',
    age_days: null,
    slo_verdict: 'unavailable',
    aggregate_process_ratio: null,
    concurrent_wall_ratio: null,
    worst_timeout_fraction: null,
    agentsmd_version: 'unknown',
    codex_version: 'unknown',
  });
  let value;
  try { value = safeJson(file); } catch (error) {
    try { fs.lstatSync(file); return empty('invalid'); } catch { return empty(); }
  }
  if (!value || value.schemaVersion !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.recorded || ''))) {
    return empty('invalid');
  }
  const recordedMs = Date.parse(`${value.recorded}T00:00:00.000Z`);
  if (!Number.isFinite(recordedMs) || recordedMs > now) return empty('invalid');
  const age = ageDays(recordedMs, now);
  return {
    state: age <= FRESH_DAYS ? 'fresh' : 'stale',
    recorded_at: new Date(recordedMs).toISOString(),
    age_days: age,
    slo_verdict: boundedText(value.sloVerdict, 'unknown'),
    aggregate_process_ratio: finite(value.aggregateProcess && value.aggregateProcess.dualWarmPretoolUseRatio),
    concurrent_wall_ratio: finite(value.concurrentWall && value.concurrentWall.dualWarmPretoolUseRatio),
    worst_timeout_fraction: finite(value.worstHookP95FractionOfTimeout),
    agentsmd_version: boundedText(value.env && value.env.agentsmd),
    codex_version: boundedText(value.env && value.env.codex),
  };
}

function dataClass(row) {
  const tag = row && row.tag == null ? '' : String(row.tag);
  if (tag === 'test') return 'test';
  if (tag === 'qa') return 'qa';
  return classifyProject(row && row.project);
}

function compatibilitySummary(logPath, days, now) {
  const cutoff = now - days * 86400000;
  const rows = readRows(logPath).filter((row) => {
    const ts = Date.parse(row && row.ts);
    return !Number.isNaN(ts) && ts >= cutoff && ts <= now;
  });
  const classes = { external: 0, self: 0, test: 0, qa: 0, unknown: 0 };
  for (const row of rows) classes[dataClass(row)] += 1;
  const dimensions = new Map();
  const fieldSessions = new Set();
  for (const row of rows) {
    if (!row || TEST_TAGS.has(String(row.tag || ''))) continue;
    if (row.session_id && row.event !== 'session-dimension') fieldSessions.add(String(row.session_id));
    if (row.event === 'session-dimension' && row.session_id && !dimensions.has(String(row.session_id))) {
      dimensions.set(String(row.session_id), row);
    }
  }
  const splits = new Map();
  for (const row of dimensions.values()) {
    const values = [
      boundedText(row.spec_version),
      boundedText(row.agentsmd_version),
      boundedText(row.surface),
      boundedText(row.codex_version),
      boundedText(row.model),
      boundedText(row.platform),
    ];
    const key = JSON.stringify(values);
    if (!splits.has(key)) {
      splits.set(key, {
        spec_version: values[0],
        agentsmd_version: values[1],
        surface: values[2],
        codex_version: values[3],
        model: values[4],
        platform: values[5],
        sessions: 0,
      });
    }
    splits.get(key).sessions += 1;
  }
  const runtimeSplits = [...splits.values()]
    .sort((a, b) => b.sessions - a.sessions || JSON.stringify(a).localeCompare(JSON.stringify(b)))
    .slice(0, 128);
  let missing = 0;
  for (const sid of fieldSessions) if (!dimensions.has(sid)) missing += 1;
  return {
    dimension_sessions: dimensions.size,
    missing_dimension_sessions: missing,
    runtime_splits: runtimeSplits,
    data_classes: classes,
    excluded_test_qa_from_field_metrics: true,
  };
}

function projectInstructionMeasurement(projectRoot) {
  let current = path.resolve(projectRoot);
  const files = [];
  let total = 0;
  let complete = true;
  try {
    if (!fs.statSync(current).isDirectory()) {
      return { root: current, state: 'unavailable', bytes: null, files };
    }
  } catch {
    return { root: current, state: 'unavailable', bytes: null, files };
  }
  for (let depth = 0; depth < 64; depth += 1) {
    const override = path.join(current, 'AGENTS.override.md');
    const standard = path.join(current, 'AGENTS.md');
    const overrideProbe = probeRegularFile(override, 65536);
    if (overrideProbe.state === 'measured' || overrideProbe.state === 'empty') {
      files.push(overrideProbe);
      total += overrideProbe.bytes;
    } else if (overrideProbe.state === 'missing') {
      const standardProbe = probeRegularFile(standard, 65536);
      if (standardProbe.state === 'measured' || standardProbe.state === 'empty') {
        files.push(standardProbe);
        total += standardProbe.bytes;
      } else if (standardProbe.state !== 'missing') {
        files.push(standardProbe);
        complete = false;
      }
    } else {
      files.push(overrideProbe);
      complete = false;
    }
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    root: path.resolve(projectRoot),
    state: complete ? 'measured' : 'partial',
    bytes: complete ? total : null,
    files,
  };
}

function promptBudget(configPath, globalAgentsPath, projectRoot, context = {}) {
  let config = probeRegularFile(configPath, 262144);
  const selectedStandalone = context.selectedSurface === 'standalone';
  const runtimeVisibilityUnknown = context.statusSource === 'runtime-filesystem'
    && context.healthState === 'unavailable';
  const sharedFilesExpected = selectedStandalone || runtimeVisibilityUnknown;
  if (sharedFilesExpected && config.state === 'missing') config = { ...config, bytes: null };
  let cap = null;
  if (config.state === 'missing' && config.bytes === 0) {
    cap = CT.DEFAULT_DOC_MAX_BYTES;
  } else if (config.state === 'measured' || config.state === 'empty') {
    try {
      cap = CT.projectDocMaxBytes(safeRead(config.path, 262144));
    } catch {
      config = { ...config, state: 'unavailable', bytes: null };
    }
  }
  let global = probeRegularFile(globalAgentsPath, 262144);
  if (sharedFilesExpected && global.state === 'missing') global = { ...global, bytes: null };
  const project = projectInstructionMeasurement(projectRoot);
  const globalBytes = global.bytes;
  const projectBytes = project.bytes;
  const total = Number.isInteger(globalBytes) && Number.isInteger(projectBytes)
    ? globalBytes + projectBytes
    : null;
  const complete = Number.isInteger(cap) && total !== null;
  const state = complete
    ? (total > cap ? 'over-budget' : 'measured')
    : ([cap, globalBytes, projectBytes].some((value) => Number.isInteger(value)) ? 'partial' : 'unavailable');
  return {
    cap,
    global_bytes: globalBytes,
    project_bytes: projectBytes,
    total_bytes: total,
    headroom_bytes: complete ? cap - total : null,
    over_bytes: complete ? total - cap : null,
    state,
    sources: { config, global, project },
  };
}

function parseWorktrees(projectRoot) {
  let raw;
  try {
    raw = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    return [];
  }
  const records = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = {
        path: line.slice('worktree '.length),
        current: false,
        locked: false,
        prunable: false,
      };
    } else if (current && line.startsWith('locked')) current.locked = true;
    else if (current && line.startsWith('prunable')) current.prunable = true;
  }
  if (current) records.push(current);
  const here = path.resolve(projectRoot);
  for (const record of records) record.current = path.resolve(record.path) === here;
  return records;
}

function workflowSummary(workflowsRoot) {
  let names = [];
  try {
    names = fs.readdirSync(workflowsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 128);
  } catch {}
  let scheduled = 0;
  for (const name of names) {
    try {
      if (/^\s*schedule\s*:/m.test(safeRead(path.join(workflowsRoot, name), 262144))) scheduled += 1;
    } catch {}
  }
  return {
    scheduled,
    runtime: names.some((name) => /runtime-canary/i.test(name)),
    governance: names.some((name) => /governance/i.test(name)),
  };
}

function automationSummary({ automationRoot, workflowsRoot, worktrees, projectRoot, pointAudit }) {
  let recipes = 0;
  for (const name of REQUIRED_RECIPES) {
    if (safeBytes(path.join(automationRoot, name), 262144)) recipes += 1;
  }
  const workflow = workflowSummary(workflowsRoot);
  const records = worktrees || parseWorktrees(projectRoot);
  const protectedCount = records.filter((entry) => entry.current || entry.locked).length;
  const residue = records.filter((entry) => !entry.current && !entry.locked).length;
  return {
    recipes_present: recipes,
    recipes_expected: REQUIRED_RECIPES.length,
    scheduled_workflows: workflow.scheduled,
    runtime_canary_workflow: workflow.runtime,
    governance_workflow: workflow.governance,
    fallback_events: pointAudit.byEvent['compat-fallback'] || 0,
    fail_open_events: pointAudit.byEvent['fail-open'] || 0,
    fail_open_causes: classifyFailOpenCauses(pointAudit.byFailOpen),
    worktrees: records.length,
    protected_worktrees: protectedCount,
    worktree_residue: residue,
  };
}

function healthSummary(statusResult, doctorResult, provenance) {
  const checks = Array.isArray(doctorResult && doctorResult.checks) ? doctorResult.checks : [];
  const failed = checks.filter((check) => !check.ok).length;
  const disabled = statusResult && statusResult.killSwitches;
  const killSwitches = (disabled && disabled.global ? 1 : 0)
    + (disabled && Array.isArray(disabled.disabled) ? disabled.disabled.length : 0);
  const installed = Boolean(statusResult && statusResult.installed);
  const enforcement = statusResult && typeof statusResult.enforcement === 'boolean'
    ? statusResult.enforcement
    : null;
  const doctorOk = Boolean(doctorResult && doctorResult.ok);
  let state = 'healthy';
  if (!installed || enforcement === null) state = 'unavailable';
  else if (!enforcement || !doctorOk || failed || killSwitches) state = 'degraded';
  return {
    state,
    installed,
    installed_version: boundedText(statusResult && statusResult.installedVersion),
    selected_surface: boundedText(statusResult && statusResult.selectedSurface),
    enforcement,
    doctor_ok: doctorOk,
    total_checks: checks.length,
    failed_checks: failed,
    kill_switches: killSwitches,
    provenance: {
      root: boundedText(provenance.root),
      codex_home: boundedText(provenance.codexHome),
      status_source: provenance.statusSource,
      doctor_source: provenance.doctorSource,
    },
  };
}

function evidenceSummary(sampling) {
  const bucket = (key) => sampling.byRule[key] || { hits: 0 };
  return {
    transcripts: sampling.transcripts,
    assistant_turns: sampling.turns,
    vocabulary_violations: bucket('§10-V').hits,
    report_order_violations: bucket('§10-four-section-order').hits,
    truncated_transcripts: sampling.truncated,
    calibration: Object.entries(sampling.byCalibration).map(([rule, value]) => ({
      rule,
      eligible: value.eligible,
      violations: value.violations,
      external_eligible: value.byClass.external.eligible,
      external_violations: value.byClass.external.violations,
    })),
    calibration_is_governance_signal: false,
  };
}

function actionsFor(card, rules) {
  const actions = [];
  const add = (priority, code, action, evidence) => actions.push({ priority, code, action, evidence });
  if (card.health.state === 'unavailable') {
    add('high', 'health-unavailable', 'Inspect installation status and restore measurable enforcement before relying on hook results.', `Installed is ${card.health.installed}; enforcement is ${card.health.enforcement ?? 'unmeasured'}; status source is ${card.health.provenance.status_source}.`);
  } else if (card.health.state === 'degraded') {
    add('high', 'health-degraded', 'Review failing doctor checks and disabled enforcement before relying on hook results.', `${card.health.failed_checks} failed check(s); ${card.health.kill_switches} active kill switch(es).`);
  }
  if (card.prompt_budget.state === 'partial' || card.prompt_budget.state === 'unavailable') {
    add('high', 'prompt-budget-incomplete', 'Restore readable prompt-budget inputs before treating discovery headroom as measured.', `Prompt-budget state is ${card.prompt_budget.state}; unavailable values remain null.`);
  } else if (card.prompt_budget.state === 'over-budget') {
    add('high', 'prompt-budget-over', 'Reduce the measured discovery chain or raise the reviewed project_doc_max_bytes cap.', `${card.prompt_budget.total_bytes}/${card.prompt_budget.cap} measured bytes.`);
  }
  if (card.compatibility.missing_dimension_sessions) {
    add('medium', 'dimension-missing', 'Inspect SessionStart coverage for field sessions without a session-dimension row.', `${card.compatibility.missing_dimension_sessions} field session(s) could not be joined to runtime dimensions.`);
  }
  if (card.conformance.state === 'unavailable') {
    add('high', 'conformance-evidence-unavailable', 'Configure or import a bounded conformance evidence source; run the declared full suite only when no valid evidence exists.', `Conformance evidence reason is ${card.conformance.provenance.reason}.`);
  } else if (card.conformance.state === 'invalid') {
    add('high', 'conformance-evidence-invalid', 'Inspect and replace the invalid bounded conformance evidence record before relying on this dimension.', `Conformance evidence reason is ${card.conformance.provenance.reason}.`);
  } else if (card.conformance.provenance.evidence_phase === 'local-candidate'
    && card.conformance.provenance.applicability === 'current'
    && card.conformance.state === 'fresh') {
    add('medium', 'conformance-candidate-unbound', 'Retain this exact candidate attestation and create a post-publication binding before treating it as published-release proof.', `Candidate ${card.conformance.provenance.release_version} matches the current deploy tree but has no release binding.`);
  } else if (card.conformance.provenance.applicability === 'historical') {
    add('medium', 'conformance-historical', 'Retain the historical release evidence; obtain a current-tree capture only when the current tree requires fresh proof.', `Release ${card.conformance.provenance.release_version} evidence is available with threshold verdict ${card.conformance.threshold_verdict}.`);
  } else if (card.conformance.provenance.applicability === 'mismatch') {
    add('high', 'conformance-mismatch', 'Do not project this evidence onto the current package or tree; refresh evidence only after identifying the changed conformance subject.', `Conformance evidence mismatch reason is ${card.conformance.provenance.reason}.`);
  } else if (card.conformance.state !== 'fresh') {
    add('high', 'conformance-stale', 'Run the declared full conformance suite and retain its machine-readable current-tree capture.', `Current-tree conformance capture age is ${card.conformance.age_days ?? 'unknown'} day(s).`);
  }
  if (card.false_blocks.state === 'invalid') {
    add('high', 'false-block-outcomes-invalid', 'Inspect the bounded reviewed-outcome sidecar and repair its event identity or schema before calculating a field rate.', `Outcome source is ${card.false_blocks.outcomes_source}; no false-block rate is reported.`);
  } else if (card.false_blocks.state === 'unmeasured' && card.false_blocks.eligible_field_events > 0) {
    add('medium', 'false-block-outcomes-unmeasured', 'Review bounded field blocking events with agentsmd outcomes; do not use conformance near-negatives as field labels.', `${card.false_blocks.unreviewed_events} unreviewed and ${card.false_blocks.unmeasurable_events} unmeasurable field event(s).`);
  } else if (card.false_blocks.state === 'partial') {
    add('medium', 'false-block-outcomes-partial', 'Continue bounded field-event review; keep unreviewed and unmeasurable events outside the rate denominator.', `Denominator ${card.false_blocks.rate_denominator}; ${card.false_blocks.unreviewed_events} unreviewed and ${card.false_blocks.unmeasurable_events} unmeasurable event(s).`);
  }
  if (card.performance.state !== 'fresh') {
    add('high', 'performance-stale', 'Run the formal performance SLO on the reference machine and refresh the versioned baseline.', `Performance state is ${card.performance.state}.`);
  }
  if (card.automation.fallback_events || card.automation.fail_open_events) {
    const causes = card.automation.fail_open_causes;
    add('medium', 'fallback-usage', 'Review compatibility fallback and fail-open reasons by runtime split.', `${card.automation.fallback_events} fallback and ${card.automation.fail_open_events} fail-open event(s): dependency/input-missing ${causes.dependency_missing}, timeout ${causes.timeout}, parse-error ${causes.parse_error}, other ${causes.other}.`);
  }
  if (card.automation.worktree_residue) {
    add('low', 'worktree-residue', 'Review unprotected worktree residue; clean only task-owned, inactive, unpinned entries.', `${card.automation.worktree_residue} unprotected worktree(s) require ownership review.`);
  }
  if (rules.reviewDue.length) {
    add('medium', 'governance-review-due', 'Perform the operator governance review; do not change rule scope from this scorecard alone.', `${rules.reviewDue.length} rule review(s) are due.`);
  }
  if (!actions.length) {
    add('low', 'no-immediate-action', 'Retain the current cadence and review measurement limits before drawing trend conclusions.', 'No deterministic health, freshness, fallback, residue, or cadence trigger fired.');
  }
  return actions.slice(0, 32);
}

function buildScorecard(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const days = Number.isSafeInteger(options.days) && options.days >= 1 && options.days <= MAX_DAYS ? options.days : 30;
  const root = options.root || ROOT;
  const codexHome = options.codexHome || P.codexHome();
  const projectRoot = options.projectRoot || process.cwd();
  const logPath = options.logPath || path.join(codexHome, 'logs', 'agentsmd.jsonl');
  const sessionsDir = options.sessionsDir || path.join(codexHome, 'sessions');
  const pointAudit = audit({ days, now, logPath });
  const falseBlocks = summarizeReviewedOutcomes({
    days,
    now,
    logPath,
    outcomesPath: options.outcomesPath || path.join(codexHome, 'logs', 'agentsmd-outcomes.json'),
  });
  const rules = rulesAudit({
    days,
    now,
    logPath,
    hardRulesPath: path.join(root, 'spec', 'hard-rules.json'),
  });
  const sampling = samplingAudit({ days, now, sessionsDir });
  const lessons = lessonBypassAudit({ days, now, logPath, sessionsDir });
  const trend = sparkline({ now, logPath, windows: 6, bucketDays: Math.max(1, Math.ceil(days / 6)) });
  const statusSupplied = Object.prototype.hasOwnProperty.call(options, 'statusResult');
  const doctorSupplied = Object.prototype.hasOwnProperty.call(options, 'doctorResult');
  const statusResult = statusSupplied ? options.statusResult : status();
  const doctorResult = doctorSupplied ? options.doctorResult : doctor();
  const blocking = (pointAudit.byEvent.block || 0) + (pointAudit.byEvent.deny || 0);
  const bypasses = pointAudit.byEvent.bypass || 0;
  const decisionTotal = blocking + bypasses;
  const memoryState = lessons.measurable > 0 ? 'measured' : 'unavailable';

  const health = healthSummary(statusResult, doctorResult, {
    root,
    codexHome,
    statusSource: statusSupplied ? 'supplied' : 'runtime-filesystem',
    doctorSource: doctorSupplied ? 'supplied' : 'runtime-filesystem',
  });
  const conformanceSourceIdentity = options.sourceIdentity || currentSourceIdentity(root);
  const candidateEvidenceFile = options.candidateEvidenceFile || null;
  const conformanceArtifactIdentity = options.conformanceArtifactIdentity
    || (candidateEvidenceFile ? currentConformanceArtifactIdentity(root, conformanceSourceIdentity) : null);
  const card = {
    schema_version: 2,
    generated_at: new Date(now).toISOString(),
    window: {
      days,
      start: new Date(now - days * 86400000).toISOString(),
      end: new Date(now).toISOString(),
    },
    health,
    compatibility: compatibilitySummary(logPath, days, now),
    conformance: conformanceSummary({
      captureRoot: options.conformanceRoot || path.join(root, 'docs', 'qa-captures'),
      releaseEvidenceRoot: options.releaseEvidenceRoot || path.join(root, 'qa', 'conformance', 'releases'),
      now,
      expectedCaseIds: options.expectedConformanceCaseIds || expectedConformanceCaseIds(root),
      sourceIdentity: conformanceSourceIdentity,
      inputIdentity: options.conformanceInputIdentity || currentConformanceInputIdentity(root),
      packageIdentity: options.packageIdentity || currentPackageIdentity(root),
      thresholds: options.conformanceThresholds || currentConformanceThresholds(root),
      candidateEvidenceFile,
      releaseBindingFile: options.releaseBindingFile || null,
      artifactIdentity: conformanceArtifactIdentity,
    }),
    false_blocks: falseBlocks,
    bypasses: {
      blocking_decisions: blocking,
      bypass_decisions: bypasses,
      bypass_rate: decisionTotal ? bypasses / decisionTotal : null,
      review_rules: rules.bypassReview.length + rules.bypassReviewSelfOnly.length,
      review_due: rules.reviewDue.length,
      no_opportunity: rules.noOpportunity.length,
      insufficient_opportunity: rules.insufficientExposure.length,
      went_silent: trend.silent.length,
      no_opportunity_is_success: false,
    },
    evidence_discipline: evidenceSummary(sampling),
    performance: performanceSummary(
      options.perfPath || path.join(root, 'qa', 'perf', 'baseline.json'),
      now,
    ),
    memory: {
      state: memoryState,
      suggest_events: lessons.suggestEvents,
      measurable: lessons.measurable,
      applied: lessons.applied,
      bypassed: lessons.bypassed,
      unmeasurable: lessons.unmeasurable,
      cite_recall: finite(lessons.citeRecall),
      citation_is_adherence: false,
    },
    prompt_budget: promptBudget(
      options.configPath || path.join(codexHome, 'config.toml'),
      options.globalAgentsPath || path.join(codexHome, 'AGENTS.md'),
      projectRoot,
      {
        healthState: health.state,
        selectedSurface: health.selected_surface,
        statusSource: health.provenance.status_source,
      },
    ),
    automation: null,
    recommended_actions: [],
    measurement_limits: [
      'Raw rule hits measure enforcement activity, not rule value; this command never promotes or demotes rules.',
      'No-opportunity and insufficient-opportunity are missing denominators, not successful outcomes.',
      'Sampling preflight and planning classifications are structural proxies and are not semantic proof.',
      'Memory cite-recall measures later file-name engagement; citation is not adherence or correctness.',
      'Field false-block rate uses only reviewed external true/false outcomes; self, test, QA, unknown, unreviewed, and unmeasurable events stay outside its denominator.',
      'Test and QA rows remain visible in data_classes but are excluded from field governance and runtime splits.',
      'Conformance fresh requires a matching current capture or an explicit candidate/binding whose package, inputs, clean source identity, and deterministic deploy tree match; packaged historical evidence never proves changed source.',
      'A published binding verifies internal byte/hash and decoded SLSA payload consistency; file acquisition, npm signature audit, and Sigstore authenticity remain release-closure evidence outside this offline scorecard.',
      'Latest-runtime canary results describe compatibility observations and do not rewrite the pinned support policy.',
      'Confirmed absent prompt files may contribute zero; missing files that contradict or cannot resolve the active surface, plus unreadable or invalid inputs, remain null and prevent a measured headroom claim.',
    ],
  };
  card.automation = automationSummary({
    automationRoot: options.automationRoot || path.join(root, 'automation'),
    workflowsRoot: options.workflowsRoot || path.join(root, '.github', 'workflows'),
    worktrees: options.worktrees,
    projectRoot,
    pointAudit,
  });
  card.recommended_actions = actionsFor(card, rules);
  const validation = validateScorecard(card);
  if (!validation.valid) throw new Error(`generated invalid scorecard:\n${validation.errors.join('\n')}`);
  return card;
}

function metric(card, getter) {
  try {
    const value = getter(card);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function delta(current, previous, getter) {
  const a = metric(current, getter);
  const b = metric(previous, getter);
  return a === null || b === null ? null : a - b;
}

function compareScorecards(current, previous, capture = 'comparison.json') {
  const result = structuredClone(current);
  const failures = (card) => card.conformance.total - card.conformance.passed;
  const evidenceViolations = (card) => (
    card.evidence_discipline.vocabulary_violations
    + card.evidence_discipline.report_order_violations
  );
  result.comparison = {
    capture: boundedText(path.basename(capture)),
    generated_at: previous.generated_at,
    deltas: {
      failed_health_checks: delta(current, previous, (card) => card.health.failed_checks),
      missing_dimension_sessions: delta(current, previous, (card) => card.compatibility.missing_dimension_sessions),
      conformance_failures: delta(current, previous, failures),
      blocking_events: delta(current, previous, (card) => card.false_blocks.blocking_events),
      bypass_decisions: delta(current, previous, (card) => card.bypasses.bypass_decisions),
      evidence_violations: delta(current, previous, evidenceViolations),
      fallback_events: delta(current, previous, (card) => card.automation.fallback_events),
      worktree_residue: delta(current, previous, (card) => card.automation.worktree_residue),
    },
  };
  const validation = validateScorecard(result);
  if (!validation.valid) throw new Error(`comparison produced invalid scorecard:\n${validation.errors.join('\n')}`);
  return result;
}

function loadComparison(file) {
  const value = safeJson(path.resolve(file), MAX_CAPTURE_BYTES);
  if (!value || value.schema_version !== 2) {
    throw new Error(`${file}: unsupported scorecard schema_version (expected 2; v1 lacks measurement provenance)`);
  }
  const validation = validateScorecard(value);
  if (!validation.valid) throw new Error(`${file}: invalid scorecard capture\n${validation.errors.join('\n')}`);
  return value;
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatScorecard(card) {
  const lines = [`agentsmd scorecard — ${card.window.days}d through ${card.generated_at}`];
  const section = (name, values) => lines.push('', name, ...values);
  section('Health', [
    `state: ${card.health.state} · enforcement: ${card.health.enforcement ?? 'n/a'} · doctor: ${card.health.total_checks - card.health.failed_checks}/${card.health.total_checks} · kill switches: ${card.health.kill_switches}`,
    `sources: status ${card.health.provenance.status_source} · doctor ${card.health.provenance.doctor_source} · root ${card.health.provenance.root} · CODEX_HOME ${card.health.provenance.codex_home}`,
  ]);
  section('Compatibility', [
    `dimension sessions: ${card.compatibility.dimension_sessions} · missing joins: ${card.compatibility.missing_dimension_sessions} · runtime splits: ${card.compatibility.runtime_splits.length}`,
    `data classes (rows): external ${card.compatibility.data_classes.external} · self ${card.compatibility.data_classes.self} · test ${card.compatibility.data_classes.test} · qa ${card.compatibility.data_classes.qa} · unknown ${card.compatibility.data_classes.unknown}`,
  ]);
  section('Conformance', [
    `state: ${card.conformance.state} · ${card.conformance.passed}/${card.conformance.total} pass · errors ${card.conformance.errors} · runs ${card.conformance.runs} · threshold ${card.conformance.threshold_verdict} · capture ${card.conformance.capture}`,
    `provenance: ${card.conformance.provenance.kind}/${card.conformance.provenance.applicability}${card.conformance.provenance.evidence_phase ? ` · phase ${card.conformance.provenance.evidence_phase}` : ''} · reason ${card.conformance.provenance.reason} · inputs ${card.conformance.provenance.inputs_match ?? 'n/a'} · release ${card.conformance.provenance.release_version}`,
  ]);
  section('False blocks', [
    `state: ${card.false_blocks.state} · blocking events ${card.false_blocks.blocking_events} · field ${card.false_blocks.eligible_field_events} · reviewed ${card.false_blocks.reviewed_outcomes}`,
    `true ${card.false_blocks.true_blocks} · false ${card.false_blocks.confirmed_false_blocks} · unreviewed ${card.false_blocks.unreviewed_events} · unmeasurable ${card.false_blocks.unmeasurable_events} · denominator ${card.false_blocks.rate_denominator} · rate ${pct(card.false_blocks.false_block_rate)}`,
    `limit: ${card.false_blocks.limit}`,
  ]);
  section('Bypasses', [
    `blocks ${card.bypasses.blocking_decisions} · bypasses ${card.bypasses.bypass_decisions} · rate ${pct(card.bypasses.bypass_rate)} · review rules ${card.bypasses.review_rules}`,
    `no-opportunity ${card.bypasses.no_opportunity} · insufficient ${card.bypasses.insufficient_opportunity} · went silent ${card.bypasses.went_silent}`,
  ]);
  section('Evidence discipline', [
    `assistant turns ${card.evidence_discipline.assistant_turns} · vocabulary violations ${card.evidence_discipline.vocabulary_violations} · report-order violations ${card.evidence_discipline.report_order_violations}`,
    'calibration detectors are proxies, not governance signals',
  ]);
  section('Performance', [
    `state: ${card.performance.state} · SLO ${card.performance.slo_verdict} · aggregate ratio ${card.performance.aggregate_process_ratio ?? 'n/a'} · concurrent-wall ratio ${card.performance.concurrent_wall_ratio ?? 'n/a'}`,
  ]);
  section('Memory', [
    `state: ${card.memory.state} · applied ${card.memory.applied} · bypassed ${card.memory.bypassed} · unmeasurable ${card.memory.unmeasurable} · cite-recall ${pct(card.memory.cite_recall)}`,
    'citation engagement is not adherence',
  ]);
  section('Prompt budget', [
    `state: ${card.prompt_budget.state} · ${card.prompt_budget.total_bytes ?? 'n/a'}/${card.prompt_budget.cap ?? 'n/a'} bytes · headroom ${card.prompt_budget.headroom_bytes ?? 'n/a'}`,
    `sources: config ${card.prompt_budget.sources.config.state} · global ${card.prompt_budget.sources.global.state} · project ${card.prompt_budget.sources.project.state}`,
  ]);
  section('Automation', [
    `recipes ${card.automation.recipes_present}/${card.automation.recipes_expected} · scheduled workflows ${card.automation.scheduled_workflows} · fallback ${card.automation.fallback_events} · fail-open ${card.automation.fail_open_events}`,
    `fail-open causes dependency/input-missing ${card.automation.fail_open_causes.dependency_missing} · timeout ${card.automation.fail_open_causes.timeout} · parse-error ${card.automation.fail_open_causes.parse_error} · other ${card.automation.fail_open_causes.other}`,
    `worktrees ${card.automation.worktrees} · protected ${card.automation.protected_worktrees} · residue ${card.automation.worktree_residue}`,
  ]);
  section('Recommended operator actions', card.recommended_actions.map((item) => (
    `- [${item.priority}] ${item.code}: ${item.action} (${item.evidence})`
  )));
  section('Measurement limits', card.measurement_limits.map((item) => `- ${item}`));
  if (card.comparison) {
    section('Comparison', [
      `capture: ${card.comparison.capture} (${card.comparison.generated_at})`,
      `deltas: ${Object.entries(card.comparison.deltas).map(([key, value]) => `${key}=${value ?? 'n/a'}`).join(' · ')}`,
    ]);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseStrict(argv, {
      bools: ['json'],
      values: ['days', 'compare', 'conformance-candidate', 'conformance-binding', 'outcomes'],
    });
  } catch (error) {
    return { error: error.message };
  }
  const rawDays = parsed.values.days;
  const days = rawDays === undefined ? 30 : parsePositiveInt(rawDays);
  if (days === null || days > MAX_DAYS) return { error: `invalid --days value: ${rawDays} (expected 1-${MAX_DAYS})` };
  const compare = parsed.values.compare;
  if (compare !== undefined && (!compare || compare.length > 4096)) {
    return { error: 'invalid --compare value: expected a non-empty path no longer than 4096 characters' };
  }
  const candidateEvidenceFile = parsed.values['conformance-candidate'];
  const releaseBindingFile = parsed.values['conformance-binding'];
  const outcomesPath = parsed.values.outcomes;
  if (candidateEvidenceFile !== undefined && (!candidateEvidenceFile || candidateEvidenceFile.length > 4096)) {
    return { error: 'invalid --conformance-candidate value: expected a non-empty bounded path' };
  }
  if (releaseBindingFile !== undefined && (!releaseBindingFile || releaseBindingFile.length > 4096)) {
    return { error: 'invalid --conformance-binding value: expected a non-empty bounded path' };
  }
  if (releaseBindingFile && !candidateEvidenceFile) {
    return { error: '--conformance-binding requires --conformance-candidate' };
  }
  if (outcomesPath !== undefined && (!outcomesPath || outcomesPath.length > 4096)) {
    return { error: 'invalid --outcomes value: expected a non-empty bounded path' };
  }
  const result = { days, json: parsed.bools.has('json'), compare: compare || null };
  if (candidateEvidenceFile) result.candidateEvidenceFile = candidateEvidenceFile;
  if (releaseBindingFile) result.releaseBindingFile = releaseBindingFile;
  if (outcomesPath) result.outcomesPath = outcomesPath;
  return result;
}

module.exports = {
  FRESH_DAYS,
  MAX_CAPTURE_BYTES,
  MAX_DAYS,
  MAX_OUTPUT_BYTES,
  REQUIRED_RECIPES,
  buildScorecard,
  compareScorecards,
  formatScorecard,
  loadComparison,
  parseArgs,
  probeRegularFile,
  thresholdVerdict,
  validateConformanceCandidateAttestation,
  validateConformanceEvidencePair,
  validateConformanceReleaseEvidence,
  validateConformanceReleaseBinding,
  validateScorecard,
};
