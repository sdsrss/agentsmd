'use strict';

// Category total counts graded behavior only; run total also includes infra errors.
function thresholdVerdict(categories, thresholds, errors, passed, total) {
  if (errors > 0) return 'fail';
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) return 'unknown';
  let measured = 0;
  for (const [category, threshold] of Object.entries(thresholds)) {
    if (!threshold || !Number.isInteger(threshold.min_pass)) continue;
    const bucket = categories && categories[category];
    if (!bucket || !Number.isInteger(bucket.pass) || !Number.isInteger(bucket.total)
      || bucket.total <= 0) return 'unknown';
    measured += 1;
    if (bucket.pass < threshold.min_pass) return 'fail';
  }
  return measured > 0 && total > 0 && passed <= total ? 'pass' : 'unknown';
}

function evaluateConformanceResults(result, canonicalCases, thresholds) {
  if (!Array.isArray(canonicalCases) || canonicalCases.length === 0) {
    throw new Error('canonical case library unavailable');
  }
  const canonical = new Map(canonicalCases.map((row) => [row.id, row]));
  if (canonical.size !== canonicalCases.length || canonicalCases.some((row) => (
    !row || typeof row.id !== 'string' || typeof row.category !== 'string' || typeof row.kind !== 'string'
  ))) throw new Error('canonical case metadata is invalid');
  if (!result || !result.meta || !Array.isArray(result.cases)
    || result.cases.length !== canonical.size || result.meta.cases !== canonical.size) {
    throw new Error('case count must equal the complete canonical library');
  }
  const categories = Object.create(null);
  const seen = new Set();
  const failures = [];
  let passed = 0;
  let errors = 0;
  let falseBlock = 0;
  for (const row of result.cases) {
    const item = row && canonical.get(row.id);
    if (!item || seen.has(row.id) || row.category !== item.category || row.kind !== item.kind) {
      throw new Error('case ID/category/kind must match unique canonical metadata');
    }
    seen.add(row.id);
    if (!['pass', 'fail', 'error'].includes(row.verdict)) throw new Error('invalid case verdict');
    const bucket = categories[item.category] ||= { pass: 0, total: 0, errors: 0 };
    if (row.verdict === 'error') { bucket.errors += 1; errors += 1; }
    else bucket.total += 1;
    if (row.verdict === 'pass') {
      bucket.pass += 1;
      passed += 1;
      if (item.category === 'false-block' && item.kind !== 'positive') falseBlock += 1;
    }
    if (row.verdict === 'fail') failures.push({ id: item.id, category: item.category });
  }
  if (Object.hasOwn(result, 'categories')) {
    const supplied = result.categories;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || Object.keys(supplied).length !== Object.keys(categories).length
      || Object.entries(categories).some(([category, bucket]) => (
        !Object.hasOwn(supplied, category)
        || !supplied[category] || Object.keys(supplied[category]).length !== 3
        || ['pass', 'total', 'errors'].some((key) => supplied[category][key] !== bucket[key])
      ))) throw new Error('category aggregates contradict canonical case results');
  }
  const knownFailures = new Set(thresholds?.baseline?.known_fail || []);
  const unexpectedFailures = failures.filter((row) => !knownFailures.has(row.id));
  const numericVerdict = thresholdVerdict(categories, thresholds, errors, passed, result.cases.length);
  return {
    categories, passed, total: result.cases.length, errors,
    false_block_near_negatives: falseBlock,
    failures, unexpectedFailures,
    threshold_verdict: errors > 0 || unexpectedFailures.length > 0 ? 'fail' : numericVerdict,
  };
}

function validateBehaviorWaiver(scope, evaluations) {
  if (evaluations.some((run) => run.errors > 0)) {
    throw new Error('infrastructure errors cannot be covered by a behavior waiver');
  }
  const failedCategories = new Set(evaluations.flatMap((run) => run.failures.map((row) => row.category)));
  const scopes = typeof scope === 'string' ? scope.split(',') : [];
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length
    || scopes.length !== failedCategories.size || scopes.some((name) => !failedCategories.has(name))) {
    throw new Error('waiver scope must exactly cover actual failing behavior categories');
  }
}

module.exports = { evaluateConformanceResults, thresholdVerdict, validateBehaviorWaiver };
