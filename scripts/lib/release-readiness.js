'use strict';

const { validateConformanceCandidateAttestation } = require('./conformance-evidence');
const { evaluateConformanceResults } = require('./conformance-results');
const { sha256 } = require('./release-measurement');
const { HOOK_REGISTRY } = require('./hook-registry');
const { evaluateSlo, stabilityCheck } = require('../perf-baseline');

const MAX_PROOF_BYTES = 48000;
const SHA = /^[a-f0-9]{64}$/u;
const keys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) throw new Error('unexpected or missing evidence fields');
};
const requireTrue = (value, reason) => { if (!value) throw new Error(reason); };
const pick = (value, names) => Object.fromEntries(names.map((name) => [name, value[name]]));
const SUBJECT_KEYS = ['package', 'version', 'source_commit', 'source_tree', 'source_tracked_clean', 'deploy_sha256'];
const RUNTIME_KEYS = ['codex_version', 'model', 'surface', 'profile'];
const META_KEYS = ['stamp', 'codex', 'model', 'agentsmd', 'surface', 'profile', 'cases_sha256', 'thresholds_sha256', 'source_commit', 'source_tracked_clean', 'cases'];
const RECEIPT_KEYS = ['run_id', 'declaration_sha256', 'deploy_sha256', 'stable'];
function sameSubject(left, right, allowMerge = false) {
  return SUBJECT_KEYS.every((key) => allowMerge && key === 'source_commit' ? true : left?.[key] === right?.[key]);
}
function validRuntime(runtime) {
  keys(runtime, RUNTIME_KEYS);
  requireTrue(/^\d+\.\d+\.\d+$/u.test(runtime.codex_version)
    && typeof runtime.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/u.test(runtime.model)
    && !['unknown', 'config-default', 'multiple'].includes(runtime.model)
    && runtime.surface === 'standalone' && runtime.profile === 'full', 'runtime must be explicitly declared (standalone/full)');
}
function validateDeclaration(declaration, identity, now = Date.now()) {
  keys(declaration, ['schema_version', 'kind', 'declared_at', 'subject', 'runtime']);
  requireTrue(declaration.schema_version === 1 && declaration.kind === 'agentsmd-release-declaration', 'invalid declaration kind');
  keys(declaration.subject, SUBJECT_KEYS);
  requireTrue(declaration.subject.source_tracked_clean === true && sameSubject(declaration.subject, identity, true), 'declaration subject mismatch');
  requireTrue(Number.isFinite(Date.parse(declaration.declared_at)) && Date.parse(declaration.declared_at) <= now, 'invalid declaration timestamp');
  validRuntime(declaration.runtime);
}

function performanceProjection(report) {
  const surfaces = {};
  for (const name of ['single', 'dual-warm']) {
    const data = report.surfaces[name];
    surfaces[name] = {
      results: data.results.map((row) => pick(row, ['hook', 'event', 'copy', 'p95_ms', 'timeout_budget_ms'])),
      byEventP95: data.byEventP95,
      byEventWall: Object.fromEntries(Object.entries(data.byEventWall).map(([event, row]) => [event, { p95_ms: row.p95_ms }])),
      roundEventP95: data.roundEventP95, roundEventWallP95: data.roundEventWallP95,
    };
  }
  return { source: report.source, recorded_at: report.env.generatedAt, runs: report.runs, rounds: report.rounds,
    pass: report.slo.pass, inconclusive: report.slo.inconclusive, surfaces };
}

function validatePerformance(performance, subject, config, configSha, start, end) {
  keys(performance, ['source', 'recorded_at', 'runs', 'rounds', 'pass', 'inconclusive', 'surfaces']);
  keys(performance.source, ['state', ...SUBJECT_KEYS, 'slo_sha256']);
  requireTrue(performance.source.state === 'measured' && sameSubject(performance.source, subject)
    && performance.source.slo_sha256 === configSha, 'SLO source/config identity mismatch');
  requireTrue(performance.pass === true && performance.inconclusive === false, 'SLO failed or inconclusive');
  requireTrue(Number.isInteger(performance.runs) && performance.runs >= config.baseline_runs && performance.runs <= 1000
    && Number.isInteger(performance.rounds) && performance.rounds >= config.baseline_rounds && performance.rounds <= 16, 'SLO sampling below formal minimum or unbounded');
  const at = Date.parse(performance.recorded_at);
  requireTrue(Number.isFinite(at) && at >= start && at <= end, 'SLO timestamp outside declared measurement interval');
  keys(performance.surfaces, ['single', 'dual-warm']);
  for (const [name, data] of Object.entries(performance.surfaces)) {
    keys(data, ['results', 'byEventP95', 'byEventWall', 'roundEventP95', 'roundEventWallP95']);
    const copies = name === 'single' ? ['repo'] : ['standalone', 'plugin'];
    const expected = new Map(copies.flatMap((copy) => HOOK_REGISTRY.map((hook) => [`${copy}/${hook.displayName}`, hook])));
    requireTrue(Array.isArray(data.results) && data.results.length === expected.size, 'SLO hook coverage incomplete');
    const seen = new Set();
    const sums = {};
    for (const row of data.results) {
      keys(row, ['hook', 'event', 'copy', 'p95_ms', 'timeout_budget_ms']);
      const id = `${row.copy}/${row.hook}`;
      const hook = expected.get(id);
      requireTrue(hook && !seen.has(id) && row.event === hook.hookEvent && row.timeout_budget_ms === hook.timeout * 1000
        && Number.isFinite(row.p95_ms) && row.p95_ms >= 0, 'SLO hook row mismatch');
      seen.add(id); sums[row.event] = (sums[row.event] || 0) + row.p95_ms;
    }
    const events = [...new Set(HOOK_REGISTRY.map((hook) => hook.hookEvent))];
    keys(data.byEventP95, events); keys(data.byEventWall, events);
    for (const event of events) {
      keys(data.byEventWall[event], ['p95_ms']);
      requireTrue(Number.isFinite(data.byEventP95[event]) && data.byEventP95[event] > 0
        && Math.abs(data.byEventP95[event] - sums[event]) <= 0.11
        && Number.isFinite(data.byEventWall[event].p95_ms) && data.byEventWall[event].p95_ms > 0, 'SLO aggregate/wall measurements invalid');
    }
    for (const rounds of [data.roundEventP95, data.roundEventWallP95]) {
      requireTrue(Array.isArray(rounds) && rounds.length === performance.rounds, 'SLO stability rounds incomplete');
      for (const round of rounds) {
        keys(round, events);
        requireTrue(Object.values(round).every((v) => Number.isFinite(v) && v > 0), 'SLO stability values unavailable');
      }
      requireTrue(stabilityCheck(rounds, config.stability.max_round_p95_delta_fraction).stable, 'SLO rounds are unstable');
    }
    for (const event of events) {
      requireTrue(data.byEventWall[event].p95_ms === Math.min(...data.roundEventWallP95.map((round) => round[event])), 'SLO selected wall value contradicts rounds');
      requireTrue(data.roundEventP95.every((round) => data.byEventP95[event] <= round[event] + 0.11), 'SLO selected hook aggregate contradicts rounds');
    }
  }
  const verdict = evaluateSlo(performance.surfaces.single, performance.surfaces['dual-warm'], config);
  requireTrue(verdict.pass && verdict.criteria.every((criterion) => criterion.skipped !== true), 'SLO recomputation failed or skipped');
}

function validateReadiness(proof, context = {}) {
  try {
    requireTrue(Buffer.byteLength(JSON.stringify(proof)) <= MAX_PROOF_BYTES, 'readiness proof exceeds byte limit');
    keys(proof, ['schema_version', 'kind', 'declaration', 'candidate', 'runs', 'performance']);
    requireTrue(proof.schema_version === 1 && proof.kind === 'agentsmd-release-readiness', 'invalid readiness kind');
    const { identity, casesBytes, thresholdsBytes, sloBytes, now = Date.now() } = context;
    requireTrue(identity?.source_tracked_clean === true, 'current release identity is not clean');
    validateDeclaration(proof.declaration, identity, now);
    const candidate = proof.candidate;
    requireTrue(validateConformanceCandidateAttestation(candidate).valid, 'candidate archive invalid');
    requireTrue(sameSubject(candidate.subject, proof.declaration.subject), 'candidate/declaration subject mismatch');
    requireTrue(candidate.decision.verdict === 'pass' && candidate.decision.waiver === null, 'automatic readiness requires pass without waiver');
    requireTrue(candidate.subject.cases_sha256 === sha256(casesBytes) && candidate.subject.thresholds_sha256 === sha256(thresholdsBytes), 'current conformance inputs mismatch');
    const library = JSON.parse(casesBytes);
    const thresholds = JSON.parse(thresholdsBytes);
    const canonical = new Map(library.cases.map((row) => [row.id, row]));
    requireTrue(Array.isArray(proof.runs) && proof.runs.length === 2 && candidate.runs.length === 2, 'exactly two independent runs required');
    const start = Date.parse(proof.declaration.declared_at), end = Date.parse(candidate.attested_at);
    requireTrue(Number.isFinite(end) && start <= end && end <= now, 'candidate timestamp outside declared interval');
    const ids = new Set(), hashes = new Set(), captures = new Set(), sessions = new Set();
    for (const [index, run] of proof.runs.entries()) {
      keys(run, ['results_sha256', 'meta', 'measurement', 'cases']);
      keys(run.meta, META_KEYS); keys(run.measurement, RECEIPT_KEYS);
      const summary = candidate.runs[index], measurement = run.measurement;
      requireTrue(SHA.test(measurement.run_id) && !ids.has(measurement.run_id)
        && SHA.test(run.results_sha256) && !hashes.has(run.results_sha256)
        && !captures.has(summary.capture), 'duplicate or invalid run identity');
      ids.add(measurement.run_id); hashes.add(run.results_sha256); captures.add(summary.capture);
      requireTrue(measurement.stable === true && measurement.deploy_sha256 === candidate.subject.deploy_sha256
        && measurement.declaration_sha256 === sha256(JSON.stringify(proof.declaration)), 'run declaration/deployment receipt missing or mismatched');
      requireTrue(run.results_sha256 === summary.results_sha256 && summary.capture === `conformance-${run.meta.stamp}`
        && run.meta.source_commit === candidate.subject.source_commit && run.meta.source_tracked_clean === true
        && run.meta.cases_sha256 === candidate.subject.cases_sha256 && run.meta.thresholds_sha256 === candidate.subject.thresholds_sha256
        && run.meta.agentsmd === candidate.subject.version, 'run source/input/capture mismatch');
      const stamp = run.meta.stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
      const recorded = stamp && `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`;
      requireTrue(recorded && Number.isFinite(Date.parse(recorded))
        && new Date(Date.parse(recorded)).toISOString() === recorded
        && Date.parse(recorded) === Date.parse(summary.recorded_at), 'capture stamp contradicts recorded_at');
      const runtime = { codex_version: run.meta.codex, model: run.meta.model, surface: run.meta.surface, profile: run.meta.profile };
      validRuntime(runtime);
      requireTrue(RUNTIME_KEYS.every((key) => runtime[key] === proof.declaration.runtime[key] && runtime[key] === summary[key]), 'run runtime differs from declaration');
      requireTrue(Date.parse(summary.recorded_at) >= start && Date.parse(summary.recorded_at) <= end, 'run precedes declared runtime');
      requireTrue(Array.isArray(run.cases), 'case measurements unavailable');
      const rows = run.cases.map((row) => {
        keys(row, ['id', 'verdict', 'session_sha256']);
        requireTrue(SHA.test(row.session_sha256) && !sessions.has(row.session_sha256), 'session identity missing or reused');
        sessions.add(row.session_sha256);
        const item = canonical.get(row.id);
        requireTrue(item, 'unknown canonical case ID');
        return { ...row, category: item.category, kind: item.kind };
      });
      const result = evaluateConformanceResults({ meta: run.meta, cases: rows }, library.cases, thresholds);
      requireTrue(result.threshold_verdict === 'pass' && result.errors === 0, 'conformance run failed');
      for (const key of ['passed', 'total', 'errors', 'false_block_near_negatives', 'threshold_verdict']) {
        requireTrue(result[key] === summary[key], 'candidate aggregate contradicts case measurements');
      }
    }
    validatePerformance(proof.performance, candidate.subject, JSON.parse(sloBytes), sha256(sloBytes), start, end);
    const baseline = thresholds.baseline || {};
    return { ready: true, errors: [], runtime_applicability: 'declared-two-run',
      historical_baseline_applicability: baseline.codex === proof.declaration.runtime.codex_version
        && baseline.model === proof.declaration.runtime.model && baseline.agentsmd === identity.version
        && baseline.cases_sha256 === sha256(casesBytes) ? 'matching' : 'mismatch' };
  } catch (error) { return { ready: false, errors: [error.message] }; }
}

function buildReadiness({ declaration, candidate, results, performance }, context) {
  const library = JSON.parse(context.casesBytes), thresholds = JSON.parse(context.thresholdsBytes);
  const runs = results.map((bytes) => {
    requireTrue(bytes.length <= 1024 * 1024, 'raw result exceeds byte limit');
    const raw = JSON.parse(bytes);
    evaluateConformanceResults(raw, library.cases, thresholds);
    return { results_sha256: sha256(bytes), meta: pick(raw.meta, META_KEYS),
      measurement: pick(raw.meta.measurement || {}, RECEIPT_KEYS),
      cases: raw.cases.map((row) => pick(row, ['id', 'verdict', 'session_sha256'])) };
  });
  const proof = { schema_version: 1, kind: 'agentsmd-release-readiness', declaration, candidate, runs,
    performance: performanceProjection(performance) };
  const validation = validateReadiness(proof, context);
  requireTrue(validation.ready, validation.errors.join('; '));
  return proof;
}

module.exports = { MAX_PROOF_BYTES, validateDeclaration, validateReadiness, buildReadiness, performanceProjection };
