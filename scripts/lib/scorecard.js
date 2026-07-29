'use strict';

const cp = require('child_process');
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

function conformanceSummary(captureRoot, now, expectedCaseIds) {
  const empty = (state = 'unavailable') => ({
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
  });
  const expected = Array.isArray(expectedCaseIds)
    ? [...new Set(expectedCaseIds.filter((id) => typeof id === 'string' && id.length > 0))]
    : [];
  if (!expected.length) return empty();
  const expectedSet = new Set(expected);
  let names;
  try {
    names = fs.readdirSync(captureRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^conformance-\d{8}T\d{6}Z$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 256);
  } catch {
    return empty();
  }
  for (const name of names) {
    const file = path.join(captureRoot, name, 'results.json');
    let result;
    try { result = safeJson(file); } catch { continue; }
    if (!result || !result.meta || !Array.isArray(result.cases) || result.cases.length > 512) continue;
    const ids = result.cases.map((entry) => entry && entry.id);
    const fullSuite = result.meta.cases === expected.length
      && ids.length === expected.length
      && new Set(ids).size === expected.length
      && ids.every((id) => expectedSet.has(id));
    if (!fullSuite) continue;
    const recordedMs = stampDate(result.meta.stamp);
    if (recordedMs === null || recordedMs > now) continue;
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
    return {
      state: age !== null && age <= FRESH_DAYS ? 'fresh' : 'stale',
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
    };
  }
  return empty('unavailable');
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

function projectInstructionBytes(projectRoot) {
  let current = path.resolve(projectRoot);
  const files = [];
  for (let depth = 0; depth < 64; depth += 1) {
    const override = path.join(current, 'AGENTS.override.md');
    const standard = path.join(current, 'AGENTS.md');
    if (safeBytes(override, 65536)) files.push(override);
    else if (safeBytes(standard, 65536)) files.push(standard);
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files.reduce((total, file) => total + safeBytes(file, 65536), 0);
}

function promptBudget(configPath, globalAgentsPath, projectRoot) {
  let config = '';
  try { config = safeRead(configPath, 262144); } catch {}
  const budget = CT.chainBudget(
    config,
    safeBytes(globalAgentsPath, 262144),
    projectInstructionBytes(projectRoot),
  );
  return {
    cap: budget.cap,
    global_bytes: budget.globalBytes,
    project_bytes: budget.projectBytes,
    total_bytes: budget.total,
    headroom_bytes: budget.headroom,
    over_bytes: budget.over,
    state: budget.over > 0 ? 'over-budget' : 'within-budget',
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
    worktrees: records.length,
    protected_worktrees: protectedCount,
    worktree_residue: residue,
  };
}

function healthSummary(statusResult, doctorResult) {
  const checks = Array.isArray(doctorResult && doctorResult.checks) ? doctorResult.checks : [];
  const failed = checks.filter((check) => !check.ok).length;
  const disabled = statusResult && statusResult.killSwitches;
  const killSwitches = (disabled && disabled.global ? 1 : 0)
    + (disabled && Array.isArray(disabled.disabled) ? disabled.disabled.length : 0);
  const installed = Boolean(statusResult && statusResult.installed);
  const enforcement = Boolean(statusResult && statusResult.enforcement !== false);
  const doctorOk = Boolean(doctorResult && doctorResult.ok);
  let state = 'healthy';
  if (!installed) state = 'unavailable';
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
  if (card.health.state !== 'healthy') {
    add('high', 'health-degraded', 'Review failing doctor checks and disabled enforcement before relying on hook results.', `${card.health.failed_checks} failed check(s); ${card.health.kill_switches} active kill switch(es).`);
  }
  if (card.compatibility.missing_dimension_sessions) {
    add('medium', 'dimension-missing', 'Inspect SessionStart coverage for field sessions without a session-dimension row.', `${card.compatibility.missing_dimension_sessions} field session(s) could not be joined to runtime dimensions.`);
  }
  if (card.conformance.state !== 'fresh') {
    add('high', 'conformance-stale', 'Run the declared full conformance suite and retain its machine-readable capture.', `Conformance state is ${card.conformance.state}.`);
  }
  if (card.performance.state !== 'fresh') {
    add('high', 'performance-stale', 'Run the formal performance SLO on the reference machine and refresh the versioned baseline.', `Performance state is ${card.performance.state}.`);
  }
  if (card.automation.fallback_events || card.automation.fail_open_events) {
    add('medium', 'fallback-usage', 'Review compatibility fallback and fail-open reasons by runtime split.', `${card.automation.fallback_events} fallback and ${card.automation.fail_open_events} fail-open event(s).`);
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
  const rules = rulesAudit({
    days,
    now,
    logPath,
    hardRulesPath: path.join(root, 'spec', 'hard-rules.json'),
  });
  const sampling = samplingAudit({ days, now, sessionsDir });
  const lessons = lessonBypassAudit({ days, now, logPath, sessionsDir });
  const trend = sparkline({ now, logPath, windows: 6, bucketDays: Math.max(1, Math.ceil(days / 6)) });
  const statusResult = options.statusResult || status();
  const doctorResult = options.doctorResult || doctor();
  const blocking = (pointAudit.byEvent.block || 0) + (pointAudit.byEvent.deny || 0);
  const bypasses = pointAudit.byEvent.bypass || 0;
  const decisionTotal = blocking + bypasses;
  const memoryState = lessons.measurable > 0 ? 'measured' : 'unavailable';

  const card = {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    window: {
      days,
      start: new Date(now - days * 86400000).toISOString(),
      end: new Date(now).toISOString(),
    },
    health: healthSummary(statusResult, doctorResult),
    compatibility: compatibilitySummary(logPath, days, now),
    conformance: conformanceSummary(
      options.conformanceRoot || path.join(root, 'docs', 'qa-captures'),
      now,
      options.expectedConformanceCaseIds || expectedConformanceCaseIds(root),
    ),
    false_blocks: {
      state: 'unmeasured',
      blocking_events: blocking,
      reviewed_outcomes: 0,
      confirmed_false_blocks: 0,
      limit: 'Blocking telemetry has no human-reviewed outcome label; conformance near-negatives are regression evidence, not a field false-block rate.',
    },
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
    ),
    automation: null,
    recommended_actions: [],
    measurement_limits: [
      'Raw rule hits measure enforcement activity, not rule value; this command never promotes or demotes rules.',
      'No-opportunity and insufficient-opportunity are missing denominators, not successful outcomes.',
      'Sampling preflight and planning classifications are structural proxies and are not semantic proof.',
      'Memory cite-recall measures later file-name engagement; citation is not adherence or correctness.',
      'False-block rate is unmeasured until blocking events receive bounded human-reviewed outcome labels.',
      'Test and QA rows remain visible in data_classes but are excluded from field governance and runtime splits.',
      'Conformance and performance captures become stale; a green historical capture does not prove the current tree.',
      'Latest-runtime canary results describe compatibility observations and do not rewrite the pinned support policy.',
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
  if (!value || value.schema_version !== 1) {
    throw new Error(`${file}: unsupported scorecard schema_version (expected 1)`);
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
    `state: ${card.health.state} · doctor: ${card.health.total_checks - card.health.failed_checks}/${card.health.total_checks} · kill switches: ${card.health.kill_switches}`,
  ]);
  section('Compatibility', [
    `dimension sessions: ${card.compatibility.dimension_sessions} · missing joins: ${card.compatibility.missing_dimension_sessions} · runtime splits: ${card.compatibility.runtime_splits.length}`,
    `data classes (rows): external ${card.compatibility.data_classes.external} · self ${card.compatibility.data_classes.self} · test ${card.compatibility.data_classes.test} · qa ${card.compatibility.data_classes.qa} · unknown ${card.compatibility.data_classes.unknown}`,
  ]);
  section('Conformance', [
    `state: ${card.conformance.state} · ${card.conformance.passed}/${card.conformance.total} pass · errors ${card.conformance.errors} · capture ${card.conformance.capture}`,
  ]);
  section('False blocks', [
    `state: ${card.false_blocks.state} · blocking events ${card.false_blocks.blocking_events} · confirmed false blocks ${card.false_blocks.confirmed_false_blocks}`,
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
    `state: ${card.prompt_budget.state} · ${card.prompt_budget.total_bytes}/${card.prompt_budget.cap} bytes · headroom ${card.prompt_budget.headroom_bytes}`,
  ]);
  section('Automation', [
    `recipes ${card.automation.recipes_present}/${card.automation.recipes_expected} · scheduled workflows ${card.automation.scheduled_workflows} · fallback ${card.automation.fallback_events} · fail-open ${card.automation.fail_open_events}`,
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
    parsed = parseStrict(argv, { bools: ['json'], values: ['days', 'compare'] });
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
  return { days, json: parsed.bools.has('json'), compare: compare || null };
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
  validateScorecard,
};
