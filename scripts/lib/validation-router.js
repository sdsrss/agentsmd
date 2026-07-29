'use strict';

const cp = require('child_process');
const { ArgvError, parseStrict } = require('./argv');

function safeRepositoryPath(file) {
  return typeof file === 'string'
    && file.length >= 1
    && file.length <= 1024
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').includes('..')
    && !/[\u0000-\u001f\u007f]/u.test(file);
}

function globToRegExp(glob) {
  let out = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`, 'u');
}

function validateValidationMap(map) {
  const errors = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return ['map must be an object'];
  if (map.schema_version !== 1) errors.push('schema_version must be 1');
  if (!map.checks || typeof map.checks !== 'object' || Array.isArray(map.checks)) {
    errors.push('checks must be an object');
  }
  const checks = map.checks || {};
  for (const [id, check] of Object.entries(checks)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) errors.push(`check ${id}: invalid id`);
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`check ${id}: must be an object`);
      continue;
    }
    if (!Array.isArray(check.command) || check.command.length === 0
        || check.command.length > 32 || check.command.some((part) => typeof part !== 'string' || !part || part.length > 1024)) {
      errors.push(`check ${id}: command must be a bounded non-empty argv array`);
    }
    if (Array.isArray(check.command)
        && ((check.command[0] === 'sh' || check.command[0] === 'bash') && check.command[1] === '-c')) {
      errors.push(`check ${id}: shell command strings are forbidden; use an argv array`);
    }
    if (!['local', 'report-only'].includes(check.execution)) errors.push(`check ${id}: invalid execution`);
    if (typeof check.external_service !== 'boolean') errors.push(`check ${id}: external_service must be boolean`);
    if (typeof check.auth_boundary !== 'boolean') errors.push(`check ${id}: auth_boundary must be boolean`);
    if (!['targeted', 'widened', 'full'].includes(check.width)) errors.push(`check ${id}: invalid width`);
    if (!Number.isInteger(check.order) || check.order < 0) errors.push(`check ${id}: order must be a non-negative integer`);
    if ((check.external_service || check.auth_boundary) && check.execution !== 'report-only') {
      errors.push(`check ${id}: external/auth checks must be report-only`);
    }
  }

  if (!Array.isArray(map.routes) || map.routes.length === 0) errors.push('routes must be a non-empty array');
  const routeIds = new Set();
  for (const [index, route] of (map.routes || []).entries()) {
    const at = `route[${index}]`;
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (typeof route.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(route.id)) errors.push(`${at}: invalid id`);
    if (routeIds.has(route.id)) errors.push(`${at}: duplicate id ${route.id}`);
    routeIds.add(route.id);
    if (!Array.isArray(route.patterns) || route.patterns.length === 0) errors.push(`${at}: patterns must be non-empty`);
    for (const pattern of route.patterns || []) {
      if (!safeRepositoryPath(pattern) || pattern.startsWith('*')) errors.push(`${at}: unsafe pattern ${JSON.stringify(pattern)}`);
      else {
        try { globToRegExp(pattern); } catch { errors.push(`${at}: invalid pattern ${JSON.stringify(pattern)}`); }
      }
    }
    if (!Array.isArray(route.risk_categories) || route.risk_categories.length === 0
        || route.risk_categories.some((value) => typeof value !== 'string' || !value)) {
      errors.push(`${at}: risk_categories must be non-empty strings`);
    }
    if (!Array.isArray(route.checks)) errors.push(`${at}: checks must be an array`);
    for (const check of route.checks || []) {
      if (!Object.prototype.hasOwnProperty.call(checks, check)) errors.push(`${at}: unknown check ${check}`);
    }
    if (typeof route.reason !== 'string' || !route.reason.trim() || route.reason.length > 1024) errors.push(`${at}: invalid reason`);
    if (typeof route.requires_full !== 'boolean') errors.push(`${at}: requires_full must be boolean`);
    if (typeof route.auth_boundary !== 'boolean') errors.push(`${at}: auth_boundary must be boolean`);
  }

  if (!map.full_gate || !Object.prototype.hasOwnProperty.call(checks, map.full_gate.check)) {
    errors.push('full_gate.check must name a defined check');
  }
  if (!map.unknown || map.unknown.requires_full !== true
      || typeof map.unknown.risk_category !== 'string' || typeof map.unknown.reason !== 'string') {
    errors.push('unknown policy must name a risk category/reason and require full');
  }
  return errors;
}

function addCheck(selected, map, id, reason) {
  const existing = selected.get(id);
  if (existing) {
    existing.reasons.add(reason);
    return;
  }
  selected.set(id, { id, ...map.checks[id], reasons: new Set([reason]) });
}

function buildPlan(map, files, { forceFull = false } = {}) {
  const mapErrors = validateValidationMap(map);
  if (mapErrors.length) throw new Error(`invalid validation map:\n${mapErrors.join('\n')}`);
  const changedFiles = [...new Set(files)].sort();
  for (const file of changedFiles) {
    if (!safeRepositoryPath(file)) throw new Error(`unsafe changed-file path: ${JSON.stringify(file)}`);
  }

  const selected = new Map();
  const categories = new Set();
  const matchedRoutes = [];
  const uncovered = [];
  let requiresFull = forceFull;
  let authBoundary = false;

  for (const file of changedFiles) {
    let matched = false;
    for (const route of map.routes) {
      const pattern = route.patterns.find((candidate) => globToRegExp(candidate).test(file));
      if (!pattern) continue;
      matched = true;
      matchedRoutes.push({ file, route: route.id, pattern, reason: route.reason });
      route.risk_categories.forEach((category) => categories.add(category));
      const selectionReason = `${route.id}: ${file} matches ${pattern}; ${route.reason}`;
      route.checks.forEach((id) => addCheck(selected, map, id, selectionReason));
      requiresFull = requiresFull || route.requires_full;
      authBoundary = authBoundary || route.auth_boundary;
    }
    if (!matched) {
      categories.add(map.unknown.risk_category);
      uncovered.push(`${file}: ${map.unknown.reason}`);
      requiresFull = true;
    }
  }

  if (requiresFull) {
    const reason = forceFull
      ? `--full: ${map.full_gate.reason}`
      : `automatic widen: ${map.full_gate.reason}`;
    addCheck(selected, map, map.full_gate.check, reason);
  }

  const checks = [...selected.values()]
    .map((check) => ({ ...check, reasons: [...check.reasons].sort() }))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

  return {
    schema_version: 1,
    changed_files: changedFiles,
    risk_categories: [...categories].sort(),
    checks,
    matched_routes: matchedRoutes,
    uncovered_risks: uncovered.sort(),
    requires_full_gate: requiresFull,
    touches_external_service: checks.some((check) => check.external_service),
    auth_boundary: authBoundary || checks.some((check) => check.auth_boundary),
  };
}

function parseVerifyArgs(argv) {
  const parsed = parseStrict(argv, {
    bools: ['changed', 'explain', 'full', 'json'],
    values: ['since'],
  });
  if (parsed.bools.has('changed') && parsed.values.since !== undefined) {
    throw new ArgvError('--changed and --since are mutually exclusive');
  }
  let since = null;
  if (parsed.values.since !== undefined) {
    since = parsed.values.since;
    if (!/^(?!-)[A-Za-z0-9][A-Za-z0-9._/@~^{}:+-]{0,199}$/.test(since) || since.includes('..')) {
      throw new ArgvError(`invalid commit selector for --since: ${JSON.stringify(since)}`);
    }
  }
  return {
    changed: since === null,
    since,
    explain: parsed.bools.has('explain'),
    full: parsed.bools.has('full'),
    json: parsed.bools.has('json'),
  };
}

function splitNul(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function git(cwd, args, spawnSync = cp.spawnSync) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${String(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function collectChangedFiles(cwd, { since = null, spawnSync = cp.spawnSync } = {}) {
  const files = [];
  if (since !== null) {
    const resolved = String(git(cwd, ['rev-parse', '--verify', '--end-of-options', `${since}^{commit}`], spawnSync)).trim();
    files.push(...splitNul(git(cwd, ['diff', '--name-only', '-z', resolved], spawnSync)));
  } else {
    files.push(...splitNul(git(cwd, ['diff', '--name-only', '-z'], spawnSync)));
    files.push(...splitNul(git(cwd, ['diff', '--cached', '--name-only', '-z'], spawnSync)));
  }
  files.push(...splitNul(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], spawnSync)));
  return [...new Set(files)].sort();
}

function executePlan(plan, { cwd = process.cwd(), spawnSync = cp.spawnSync } = {}) {
  const results = [];
  let failed = false;
  for (const check of plan.checks) {
    if (failed) {
      results.push({ id: check.id, status: 'not-run-after-failure', command: check.command });
      continue;
    }
    if (check.external_service) {
      results.push({ id: check.id, status: 'skipped-external', command: check.command });
      continue;
    }
    if (check.auth_boundary) {
      results.push({ id: check.id, status: 'skipped-auth-boundary', command: check.command });
      continue;
    }
    if (check.execution !== 'local') {
      results.push({ id: check.id, status: 'skipped-report-only', command: check.command });
      continue;
    }
    const result = spawnSync(check.command[0], check.command.slice(1), {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    const passed = !result.error && !result.signal && result.status === 0;
    results.push({
      id: check.id,
      status: passed ? 'passed' : 'failed',
      command: check.command,
      exit_code: result.status === null || result.status === undefined ? 1 : result.status,
      signal: result.signal || null,
      error: result.error ? result.error.message : null,
    });
    if (!passed) failed = true;
  }
  return { exit_code: failed ? 1 : 0, results };
}

function renderPlan(plan, execution = null) {
  const lines = ['Changed files:'];
  lines.push(...(plan.changed_files.length ? plan.changed_files.map((file) => `- ${file}`) : ['- none']));
  lines.push('Risk categories:');
  lines.push(...(plan.risk_categories.length ? plan.risk_categories.map((risk) => `- ${risk}`) : ['- none']));
  lines.push('Checks:');
  lines.push(...(plan.checks.length
    ? plan.checks.map((check) => `- ${check.id} [${check.execution}/${check.width}]: ${check.reasons.join(' | ')}`)
    : ['- none']));
  lines.push('Uncovered risks:');
  lines.push(...(plan.uncovered_risks.length ? plan.uncovered_risks.map((risk) => `- ${risk}`) : ['- none']));
  lines.push(`Requires full gate: ${plan.requires_full_gate ? 'yes' : 'no'}`);
  lines.push(`Touches external service: ${plan.touches_external_service ? 'yes (report-only)' : 'no'}`);
  lines.push(`AUTH boundary: ${plan.auth_boundary ? 'yes' : 'no'}`);
  if (execution) {
    lines.push('Execution:');
    lines.push(...(execution.results.length
      ? execution.results.map((result) => `- ${result.id}: ${result.status}`)
      : ['- none']));
  }
  return lines.join('\n');
}

module.exports = {
  buildPlan,
  collectChangedFiles,
  executePlan,
  globToRegExp,
  parseVerifyArgs,
  renderPlan,
  safeRepositoryPath,
  validateValidationMap,
};
