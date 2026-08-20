#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseStrict } = require('./lib/argv');
const { thresholdVerdict, validateConformanceReleaseEvidence } = require('./lib/scorecard');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_ROOT = path.join(ROOT, 'docs', 'qa-captures');
const RELEASE_ROOT = path.join(ROOT, 'qa', 'conformance', 'releases');
const MAX_RESULT_BYTES = 1024 * 1024;
const USAGE = [
  'Usage: node scripts/conformance-evidence.js --release-version=SEMVER',
  '  --release-commit=SHA --evaluated-commit=SHA --published-at=ISO',
  '  --decision=pass|fail|waived --results=FILE[,FILE...]',
  '  [--waiver-scope=CATEGORY] [--allow-legacy-source] [--out=FILE]',
  '',
  'Reads only bounded results.json files below docs/qa-captures and emits an',
  'allowlisted release summary. --out must be qa/conformance/releases/vVERSION.json.',
].join('\n');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function platformCanonicalPath(input, platform = process.platform) {
  const resolved = path.resolve(input);
  if (platform === 'darwin' && (resolved === '/var' || resolved.startsWith('/var/'))) {
    return `/private${resolved}`;
  }
  return resolved;
}

function regularBytes(file, max = MAX_RESULT_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file}: expected a regular non-symlink file`);
  if (stat.size > max) throw new Error(`${file}: exceeds ${max} bytes`);
  return fs.readFileSync(file);
}

function boundedCaptureFile(raw) {
  const captureRoot = path.resolve(CAPTURE_ROOT);
  const canonicalCaptureRoot = platformCanonicalPath(captureRoot);
  const rootStat = fs.lstatSync(captureRoot);
  if (!rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || fs.realpathSync(captureRoot) !== canonicalCaptureRoot) {
    throw new Error('docs/qa-captures must be a real non-symlink directory');
  }
  const target = path.resolve(ROOT, raw);
  if (!target.startsWith(`${captureRoot}${path.sep}`)) {
    throw new Error(`${raw}: result must stay below docs/qa-captures`);
  }
  const real = fs.realpathSync(target);
  const canonicalTarget = platformCanonicalPath(target);
  if (!real.startsWith(`${canonicalCaptureRoot}${path.sep}`) || real !== canonicalTarget) {
    throw new Error(`${raw}: result must not use symlink indirection`);
  }
  if (path.basename(real) !== 'results.json' || !/^conformance-\d{8}T\d{6}Z$/.test(path.basename(path.dirname(real)))) {
    throw new Error(`${raw}: expected conformance-STAMP/results.json`);
  }
  return real;
}

function readJsonBytes(file) {
  const bytes = regularBytes(file);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw new Error(`${file}: expected valid JSON (${error.message})`);
  }
}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseStrict(argv, {
      bools: ['allow-legacy-source'],
      values: [
        'release-version', 'release-commit', 'evaluated-commit', 'published-at',
        'decision', 'results', 'waiver-scope', 'out',
      ],
    });
  } catch (error) {
    return { error: error.message };
  }
  const value = (name) => parsed.values[name];
  for (const name of [
    'release-version', 'release-commit', 'evaluated-commit', 'published-at', 'decision', 'results',
  ]) {
    if (!value(name)) return { error: `--${name}=VALUE is required` };
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value('release-version'))) {
    return { error: 'invalid --release-version' };
  }
  if (!/^[a-f0-9]{40}$/.test(value('release-commit')) || !/^[a-f0-9]{40}$/.test(value('evaluated-commit'))) {
    return { error: '--release-commit and --evaluated-commit must be full lowercase Git SHAs' };
  }
  if (!['pass', 'fail', 'waived'].includes(value('decision'))) return { error: 'invalid --decision' }; // argv-lint:allow
  if (!Number.isFinite(Date.parse(value('published-at')))) return { error: 'invalid --published-at' };
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
    releaseVersion: value('release-version'),
    releaseCommit: value('release-commit'),
    evaluatedCommit: value('evaluated-commit'),
    publishedAt: new Date(Date.parse(value('published-at'))).toISOString(),
    decision: value('decision'),
    results,
    waiverScope,
    allowLegacySource: parsed.bools.has('allow-legacy-source'),
    out: value('out') || null,
  };
}

function categorySummary(cases) {
  const categories = {};
  for (const item of cases) {
    const bucket = categories[item.category] || { pass: 0, total: 0, errors: 0 };
    if (item.verdict === 'error') bucket.errors += 1;
    else bucket.total += 1;
    if (item.verdict === 'pass') bucket.pass += 1;
    categories[item.category] = bucket;
  }
  return categories;
}

function stampDate(stamp) {
  const match = String(stamp || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const value = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`);
  return Number.isFinite(value) ? value : null;
}

function buildEvidence(options) {
  const casesFile = path.join(ROOT, 'qa', 'conformance', 'cases.json');
  const thresholdsFile = path.join(ROOT, 'qa', 'conformance', 'thresholds.json');
  const casesInput = readJsonBytes(casesFile);
  const thresholdsInput = readJsonBytes(thresholdsFile);
  const expectedIds = casesInput.value && Array.isArray(casesInput.value.cases)
    ? casesInput.value.cases.map((item) => item && item.id)
    : [];
  if (!expectedIds.length || expectedIds.some((id) => typeof id !== 'string')
    || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error('canonical conformance case library is invalid');
  }
  const casesSha = sha256(casesInput.bytes);
  const thresholdsSha = sha256(thresholdsInput.bytes);
  const expectedSet = new Set(expectedIds);
  const runs = options.results.map((raw) => {
    const file = boundedCaptureFile(raw);
    const input = readJsonBytes(file);
    const result = input.value;
    if (!result || !result.meta || !Array.isArray(result.cases) || result.cases.length !== expectedIds.length) {
      throw new Error(`${raw}: expected one complete ${expectedIds.length}-case result`);
    }
    const ids = result.cases.map((item) => item && item.id);
    if (new Set(ids).size !== expectedIds.length || !ids.every((id) => expectedSet.has(id))) {
      throw new Error(`${raw}: case ID set does not match the canonical library`);
    }
    if (result.meta.cases_sha256 !== casesSha || result.meta.thresholds_sha256 !== thresholdsSha) {
      throw new Error(`${raw}: cases/thresholds hash mismatch`);
    }
    const hasSource = /^[a-f0-9]{40}$/.test(String(result.meta.source_commit || ''))
      && typeof result.meta.source_tracked_clean === 'boolean';
    if (!hasSource && !options.allowLegacySource) {
      throw new Error(`${raw}: source identity missing; use --allow-legacy-source only for reviewed historical captures`);
    }
    if (hasSource && (result.meta.source_commit !== options.evaluatedCommit || result.meta.source_tracked_clean !== true)) {
      throw new Error(`${raw}: source identity does not match the clean evaluated commit`);
    }
    if (result.meta.agentsmd !== options.releaseVersion) {
      throw new Error(`${raw}: agentsmd version does not match the release version`);
    }
    const recordedMs = stampDate(result.meta.stamp);
    if (recordedMs === null || recordedMs > Date.parse(options.publishedAt)) {
      throw new Error(`${raw}: invalid or post-publication capture stamp`);
    }
    const categories = categorySummary(result.cases);
    const passed = result.cases.filter((item) => item && item.verdict === 'pass').length;
    const errors = result.cases.filter((item) => item && item.verdict === 'error').length;
    const verdict = thresholdVerdict(categories, thresholdsInput.value, errors, passed, result.cases.length);
    if (verdict === 'unknown') throw new Error(`${raw}: threshold verdict is not measurable`);
    return {
      capture: path.basename(path.dirname(file)),
      recorded_at: new Date(recordedMs).toISOString(),
      results_sha256: sha256(input.bytes),
      codex_version: String(result.meta.codex || 'unknown'),
      model: String(result.meta.model || 'unknown'),
      agentsmd_version: String(result.meta.agentsmd),
      surface: String(result.meta.surface || 'unknown'),
      profile: String(result.meta.profile || 'unknown'),
      passed,
      total: result.cases.length,
      errors,
      false_block_near_negatives: result.cases.filter((item) => (
        item && item.category === 'false-block' && item.kind !== 'positive' && item.verdict === 'pass'
      )).length,
      threshold_verdict: verdict,
    };
  });
  const hasThresholdFailure = runs.some((run) => run.threshold_verdict === 'fail');
  if (options.decision === 'pass' && hasThresholdFailure) {
    throw new Error('--decision=pass contradicts a failing run threshold');
  }
  if (options.decision === 'waived' && !hasThresholdFailure) {
    throw new Error('--decision=waived requires at least one failing run threshold');
  }
  const record = {
    schema_version: 1,
    kind: 'agentsmd-conformance-release-evidence',
    release: {
      package: '@sdsrs/agentsmd',
      version: options.releaseVersion,
      commit: options.releaseCommit,
      published_at: options.publishedAt,
    },
    subject: {
      evaluated_commit: options.evaluatedCommit,
      cases_sha256: casesSha,
      thresholds_sha256: thresholdsSha,
    },
    runs,
    decision: {
      verdict: options.decision,
      waiver: options.decision === 'waived' ? {
        scope: options.waiverScope,
        release_only: true,
        thresholds_unchanged: true,
        reason: 'two-pass-threshold',
      } : null,
    },
  };
  const validation = validateConformanceReleaseEvidence(record);
  if (!validation.valid) throw new Error(`generated invalid release evidence:\n${validation.errors.join('\n')}`);
  return record;
}

function verifiedReleaseRoot(releaseRoot) {
  const resolvedRoot = path.resolve(releaseRoot);
  const parent = path.dirname(resolvedRoot);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || fs.realpathSync(parent) !== platformCanonicalPath(parent)) {
    throw new Error(`${parent}: release evidence parent must be a real non-symlink directory`);
  }
  try {
    const stat = fs.lstatSync(resolvedRoot);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || fs.realpathSync(resolvedRoot) !== platformCanonicalPath(resolvedRoot)) {
      throw new Error(`${resolvedRoot}: release evidence root must be a real non-symlink directory`);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    fs.mkdirSync(resolvedRoot, { recursive: false, mode: 0o755 });
  }
  return resolvedRoot;
}

function writeEvidence(file, releaseVersion, text, bounds = {}) {
  const root = bounds.root || ROOT;
  const releaseRoot = bounds.releaseRoot || RELEASE_ROOT;
  const expected = path.join(path.resolve(releaseRoot), `v${releaseVersion}.json`);
  const destination = path.resolve(root, file);
  if (destination !== expected) throw new Error(`--out must equal ${path.relative(ROOT, expected)}`);
  verifiedReleaseRoot(releaseRoot);
  try {
    const existing = regularBytes(destination);
    if (existing.toString('utf8') !== text) throw new Error(`${destination}: refusing to overwrite different evidence`);
    return destination;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o644 });
    fs.linkSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return destination;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { // argv-lint:allow
    console.log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.error) {
    console.error(`conformance-evidence: ${options.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const text = `${JSON.stringify(buildEvidence(options), null, 2)}\n`;
    if (options.out) console.log(path.relative(ROOT, writeEvidence(options.out, options.releaseVersion, text)));
    else process.stdout.write(text);
    return 0;
  } catch (error) {
    console.error(`conformance-evidence: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  CAPTURE_ROOT,
  RELEASE_ROOT,
  USAGE,
  buildEvidence,
  main,
  parseArgs,
  platformCanonicalPath,
  verifiedReleaseRoot,
  writeEvidence,
};
