#!/usr/bin/env node
'use strict';

// Core A/B evaluator. Structural validation is zero-model; --run executes two
// isolated cells per selected case with deterministic order. --trace-init is a
// separate network-disabled initialization diagnostic, never a conformance run.

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateSchema } = require('../scripts/lib/task-contract');

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(ROOT, 'qa', 'core-ab', 'cases.json');
const CONFORMANCE_CASES_PATH = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const CORE_PATH = path.join(ROOT, 'spec', 'AGENTS.md');
const EXTENDED_PATH = path.join(ROOT, 'spec', 'AGENTS-extended.md');
const CASE_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'core-ab-cases.schema.json'), 'utf8'));
const RESULT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'core-ab-results.schema.json'), 'utf8'));
const CAPTURE_BASE = path.join(ROOT, 'docs', 'qa-captures', 'core-ab');
const PRIVATE_CAPTURE_PREFIX = 'agentsmd-core-ab-captures.';
const TEMP_PREFIX = 'agentsmd-core-ab-';
const SECRET_ENV_NAMES = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']);
const TRACE_FILE_OPERATIONS = new Set([
  'access', 'chmod', 'chown', 'creat', 'faccessat', 'faccessat2', 'link', 'linkat',
  'lstat', 'mkdir', 'mkdirat', 'mknod', 'mknodat', 'open', 'openat', 'openat2',
  'readlink', 'readlinkat', 'rename', 'renameat', 'renameat2', 'rmdir', 'stat',
  'statx', 'symlink', 'symlinkat', 'truncate', 'unlink', 'unlinkat', 'utime',
  'utimensat', 'utimes',
]);
const SUITES = new Set(['representative', 'auth-guard']);
const AUTH_GUARD_IDS = ['auth-hard-tidy', 'auth-clear-create'];
const AUTH_GUARD_SAFE_COMMAND = "grep -q 'hello conformance' notes.md";
const CONDITIONS = new Set(['current-core', 'no-core', 'candidate-core']);
const CATEGORIES = new Set([
  'small-bug', 'cross-module-feature', 'read-only-diagnosis', 'docs-only',
  'auth-boundary', 'long-task-resume', 'ambiguous-request', 'near-negative',
]);
const ASSERT_TYPES = new Set([
  'file_contains', 'file_not_contains', 'file_absent', 'file_unchanged',
  'changed_files_exact', 'no_changes', 'commits_delta', 'command_regex_min',
  'command_regex_max', 'last_regex', 'last_not_regex',
]);

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function isSafeRelative(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && !value.split('/').includes('..')
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRepositoryCaptureBase(value) {
  const resolved = path.resolve(value);
  const allowed = path.resolve(CAPTURE_BASE);
  return resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`);
}

function isBoundedPrivateCaptureBase(value) {
  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const name = path.basename(resolved);
  return path.dirname(resolved) === tempRoot
    && name.startsWith(PRIVATE_CAPTURE_PREFIX)
    && /^[A-Za-z0-9._-]{6,96}$/u.test(name.slice(PRIVATE_CAPTURE_PREFIX.length));
}

function requirePrivateCaptureBase(value) {
  if (!isBoundedPrivateCaptureBase(value)) {
    throw new Error(`subscription-backed --out must be a bounded private capture parent: ${path.join(os.tmpdir(), `${PRIVATE_CAPTURE_PREFIX}XXXXXX`)}`);
  }
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label}: expected object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\n') !== wanted.join('\n')) {
    errors.push(`${label}: fields ${actual.join(',')} != ${wanted.join(',')}`);
  }
}

function validateCaseLibrary(lib) {
  const errors = validateSchema(lib, CASE_SCHEMA, CASE_SCHEMA).map((error) => `schema: ${error}`);
  exactKeys(lib, ['schema_version', 'kind', '_doc', 'workload_families', 'cases'], 'library', errors);
  if (lib.schema_version !== 1) errors.push('library: schema_version must be 1');
  if (lib.kind !== 'agentsmd-core-ab-cases') errors.push('library: invalid kind');
  if (typeof lib._doc !== 'string' || lib._doc.length < 80) errors.push('library: _doc too short');
  if (!Array.isArray(lib.workload_families)) errors.push('library: workload_families must be an array');
  if (!Array.isArray(lib.cases) || lib.cases.length !== 24) errors.push('library: exactly 24 cases required');
  if (errors.length || !Array.isArray(lib.cases)) return [...new Set(errors)];

  const familySet = new Set(lib.workload_families);
  if (familySet.size !== CATEGORIES.size || [...CATEGORIES].some((item) => !familySet.has(item))) {
    errors.push('library: workload_families must equal the closed eight-category set');
  }
  const ids = new Set();
  const counts = Object.fromEntries([...CATEGORIES].map((item) => [item, 0]));
  for (const item of lib.cases) {
    const label = item && item.id ? item.id : 'case';
    exactKeys(item, [
      'id', 'category', 'intent', 'prompt', 'setup_files', 'assertions',
      'auth_expectation', 'question_expectation', 'validation_expectation',
      ...(item && Object.prototype.hasOwnProperty.call(item, 'validation_regex') ? ['validation_regex'] : []),
    ], label, errors);
    if (!item || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.id || '')) errors.push(`${label}: invalid id`);
    if (ids.has(item.id)) errors.push(`${label}: duplicate id`);
    ids.add(item.id);
    if (!CATEGORIES.has(item.category)) errors.push(`${label}: invalid category`);
    else counts[item.category] += 1;
    if (!['change', 'read-only', 'authorization'].includes(item.intent)) errors.push(`${label}: invalid intent`);
    if (typeof item.prompt !== 'string' || item.prompt.length < 20 || item.prompt.length > 2048) errors.push(`${label}: invalid prompt`);
    if (!Array.isArray(item.setup_files) || item.setup_files.length > 16) errors.push(`${label}: invalid setup_files`);
    for (const file of item.setup_files || []) {
      exactKeys(file, ['path', 'content'], `${label}: setup file`, errors);
      if (!isSafeRelative(file.path)) errors.push(`${label}: unsafe setup path ${file.path}`);
      if (typeof file.content !== 'string' || file.content.length > 8192) errors.push(`${label}: invalid setup content ${file.path}`);
    }
    if (!Array.isArray(item.assertions) || item.assertions.length < 1 || item.assertions.length > 16) errors.push(`${label}: invalid assertions`);
    for (const assertion of item.assertions || []) {
      if (!ASSERT_TYPES.has(assertion.type)) errors.push(`${label}: unknown assertion ${assertion.type}`);
      const fieldsByType = {
        file_contains: ['type', 'path', 'regex'],
        file_not_contains: ['type', 'path', 'regex'],
        file_absent: ['type', 'path'],
        file_unchanged: ['type', 'path'],
        changed_files_exact: ['type', 'paths'],
        no_changes: ['type'],
        commits_delta: ['type', 'delta'],
        command_regex_min: ['type', 'regex', 'min'],
        command_regex_max: ['type', 'regex', 'max'],
        last_regex: ['type', 'regex'],
        last_not_regex: ['type', 'regex'],
      };
      exactKeys(assertion, fieldsByType[assertion.type] || ['type'], `${label}: ${assertion.type}`, errors);
      if (assertion.path !== undefined && !isSafeRelative(assertion.path)) errors.push(`${label}: unsafe assertion path`);
      if (assertion.paths !== undefined && (!Array.isArray(assertion.paths) || assertion.paths.some((entry) => !isSafeRelative(entry)))) errors.push(`${label}: unsafe assertion paths`);
      if (assertion.regex !== undefined) {
        try { new RegExp(assertion.regex, 'iu'); } catch { errors.push(`${label}: invalid regex for ${assertion.type}`); }
      }
      if (['file_contains', 'file_not_contains'].includes(assertion.type) && (!assertion.path || !assertion.regex)) errors.push(`${label}: ${assertion.type} requires path and regex`);
      if (['file_absent', 'file_unchanged'].includes(assertion.type) && !assertion.path) errors.push(`${label}: ${assertion.type} requires path`);
      if (assertion.type === 'changed_files_exact' && !Array.isArray(assertion.paths)) errors.push(`${label}: changed_files_exact requires paths`);
      if (['command_regex_min', 'command_regex_max', 'last_regex', 'last_not_regex'].includes(assertion.type) && !assertion.regex) errors.push(`${label}: ${assertion.type} requires regex`);
      if (assertion.type === 'command_regex_min' && (!Number.isInteger(assertion.min) || assertion.min < 0 || assertion.min > 32)) errors.push(`${label}: invalid min`);
      if (assertion.type === 'command_regex_max' && (!Number.isInteger(assertion.max) || assertion.max < 0 || assertion.max > 32)) errors.push(`${label}: invalid max`);
      if (assertion.type === 'commits_delta' && (!Number.isInteger(assertion.delta) || Math.abs(assertion.delta) > 8)) errors.push(`${label}: invalid delta`);
    }
    if (!['none', 'required', 'not-applicable'].includes(item.auth_expectation)) errors.push(`${label}: invalid auth_expectation`);
    if (!['none', 'required', 'allowed'].includes(item.question_expectation)) errors.push(`${label}: invalid question_expectation`);
    if (!['required', 'not-required'].includes(item.validation_expectation)) errors.push(`${label}: invalid validation_expectation`);
    if (item.validation_expectation === 'required') {
      if (typeof item.validation_regex !== 'string' || item.validation_regex.length < 1 || item.validation_regex.length > 512) {
        errors.push(`${label}: required validation_regex is invalid`);
      } else {
        try { new RegExp(item.validation_regex, 'iu'); } catch { errors.push(`${label}: required validation_regex is invalid`); }
      }
    } else if (item.validation_regex !== undefined) errors.push(`${label}: validation_regex is required-only`);
  }
  for (const [category, count] of Object.entries(counts)) {
    if (count !== 3) errors.push(`library: ${category} has ${count} cases, expected 3`);
  }
  return [...new Set(errors)];
}

function validateAuthGuardLibrary(lib) {
  const errors = [];
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) return ['auth-guard library: expected object'];
  if (lib.schema_version !== 1) errors.push('auth-guard library: schema_version must be 1');
  if (!Array.isArray(lib.cases)) return [...errors, 'auth-guard library: cases must be an array'];

  const selected = AUTH_GUARD_IDS.map((id) => lib.cases.filter((item) => item && item.id === id));
  for (const [index, matches] of selected.entries()) {
    if (matches.length !== 1) errors.push(`auth-guard library: ${AUTH_GUARD_IDS[index]} must occur exactly once`);
  }
  if (errors.length) return [...new Set(errors)];

  for (const [index, matches] of selected.entries()) {
    const id = AUTH_GUARD_IDS[index];
    const item = matches[0];
    const expectedKeys = id === 'auth-hard-tidy'
      ? ['id', 'category', 'rule', 'kind', 'prompt', 'setup_files', 'git_add', 'git_commit_setup', 'assert']
      : ['id', 'category', 'rule', 'kind', 'prompt', 'assert'];
    exactKeys(item, expectedKeys, id, errors);
    if (item.category !== 'auth' || item.rule !== '§5') errors.push(`${id}: must remain the canonical auth/§5 case`);
    if (item.kind !== (id === 'auth-hard-tidy' ? 'positive' : 'near-negative')) errors.push(`${id}: unexpected kind`);
    if (typeof item.prompt !== 'string' || item.prompt.length < 20 || item.prompt.length > 2048) errors.push(`${id}: invalid prompt`);

    const setupFiles = item.setup_files || [];
    if (!Array.isArray(setupFiles) || setupFiles.length > 16) errors.push(`${id}: invalid setup_files`);
    for (const setup of Array.isArray(setupFiles) ? setupFiles : []) {
      exactKeys(setup, ['path', 'content'], `${id}: setup file`, errors);
      if (!isSafeRelative(setup.path)) errors.push(`${id}: unsafe setup path ${setup.path}`);
      if (typeof setup.content !== 'string' || setup.content.length > 8192) errors.push(`${id}: invalid setup content`);
    }
    const expectedSetup = id === 'auth-hard-tidy'
      ? ['src/main.js', 'data/records.csv', 'tmp/scratch.txt'] : [];
    if ((Array.isArray(setupFiles) ? setupFiles.map((entry) => entry.path) : []).join('\n') !== expectedSetup.join('\n')) {
      errors.push(`${id}: canonical setup paths drifted`);
    }
    const gitAdd = item.git_add || [];
    if (!Array.isArray(gitAdd) || gitAdd.some((entry) => !isSafeRelative(entry))) errors.push(`${id}: invalid git_add`);
    const expectedGitAdd = id === 'auth-hard-tidy' ? ['src/main.js', 'data/records.csv'] : [];
    if ((Array.isArray(gitAdd) ? gitAdd : []).join('\n') !== expectedGitAdd.join('\n')) errors.push(`${id}: canonical git_add drifted`);
    if (Boolean(item.git_commit_setup) !== (id === 'auth-hard-tidy')) errors.push(`${id}: canonical git_commit_setup drifted`);

    if (!Array.isArray(item.assert) || item.assert.length < 1 || item.assert.length > 8) {
      errors.push(`${id}: invalid assertions`);
      continue;
    }
    const expectedTypes = id === 'auth-hard-tidy'
      ? ['file_exists', 'last_regex'] : ['file_exists', 'cmd_green', 'last_not_regex'];
    if (item.assert.map((assertion) => assertion.type).join('\n') !== expectedTypes.join('\n')) {
      errors.push(`${id}: canonical assertion types drifted`);
    }
    for (const assertion of item.assert) {
      const fields = assertion.type === 'file_exists' ? ['type', 'path']
        : (assertion.type === 'cmd_green' ? ['type', 'cmd'] : ['type', 'regex']);
      exactKeys(assertion, fields, `${id}: ${assertion.type}`, errors);
      if (assertion.path !== undefined && !isSafeRelative(assertion.path)) errors.push(`${id}: unsafe assertion path`);
      if (assertion.regex !== undefined) {
        try { new RegExp(assertion.regex, 'iu'); } catch { errors.push(`${id}: invalid assertion regex`); }
      }
      if (assertion.type === 'cmd_green' && assertion.cmd !== AUTH_GUARD_SAFE_COMMAND) {
        errors.push(`${id}: unsafe cmd_green`);
      }
    }
  }
  return [...new Set(errors)];
}

function loadCaseSuite(name = 'representative') {
  if (!SUITES.has(name)) throw new Error(`unknown suite: ${name}`);
  const sourcePath = name === 'auth-guard' ? CONFORMANCE_CASES_PATH : CASES_PATH;
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const library = JSON.parse(raw);
  if (name === 'representative') {
    return { name, sourcePath, raw, caseSha: sha256(raw), library, cases: library.cases, errors: validateCaseLibrary(library) };
  }
  const errors = validateAuthGuardLibrary(library);
  const cases = errors.length ? [] : AUTH_GUARD_IDS.map((id) => {
    const source = library.cases.find((item) => item.id === id);
    return {
      id: source.id,
      category: 'auth-boundary',
      intent: id === 'auth-hard-tidy' ? 'authorization' : 'change',
      prompt: source.prompt,
      setup_files: structuredClone(source.setup_files || []),
      assertions: structuredClone(source.assert),
      git_add: structuredClone(source.git_add || []),
      git_commit_setup: source.git_commit_setup === true,
      fixture_kind: 'conformance',
      auth_expectation: id === 'auth-hard-tidy' ? 'required' : 'none',
      question_expectation: id === 'auth-hard-tidy' ? 'allowed' : 'none',
      validation_expectation: 'not-required',
    };
  });
  return { name, sourcePath, raw, caseSha: sha256(raw), library, cases, errors };
}

function parseArgs(argv) {
  const out = {
    validate: false,
    list: false,
    run: false,
    traceInit: false,
    suite: 'representative',
    codex: 'codex',
    model: null,
    seed: null,
    out: CAPTURE_BASE,
    conditions: null,
    candidateCore: null,
    subscriptionHome: null,
    only: null,
    resume: null,
    help: false,
  };
  const seen = new Set();
  for (const arg of argv) {
    if (arg === '--validate' || arg === '--list' || arg === '--run' || arg === '--trace-init' || arg === '--help' || arg === '-h') {
      const rawKey = arg === '-h' ? 'help' : arg.slice(2);
      const key = rawKey === 'trace-init' ? 'traceInit' : rawKey;
      if (seen.has(key)) throw new Error(`duplicate flag: --${key}`);
      seen.add(key); out[key] = true; continue;
    }
    const match = arg.match(/^--([a-z-]+)=(.+)$/u);
    if (!match) throw new Error(`unknown or malformed option: ${arg}`);
    const [, key, value] = match;
    if (seen.has(key)) throw new Error(`duplicate flag: --${key}`);
    seen.add(key);
    if (key === 'codex') out.codex = value;
    else if (key === 'model') out.model = value;
    else if (key === 'seed') out.seed = value;
    else if (key === 'suite') out.suite = value;
    else if (key === 'out') out.out = path.resolve(ROOT, value);
    else if (key === 'conditions') out.conditions = value.split(',');
    else if (key === 'candidate-core') out.candidateCore = path.resolve(ROOT, value);
    else if (key === 'subscription-home') out.subscriptionHome = value;
    else if (key === 'only') out.only = value.split(',');
    else if (key === 'resume') out.resume = path.resolve(ROOT, value);
    else throw new Error(`unknown option: --${key}`);
  }
  const modes = [out.validate, out.list, out.run, out.traceInit].filter(Boolean).length;
  if (!out.help && modes !== 1) throw new Error('choose exactly one of --validate, --list, --run, or --trace-init');
  if (!SUITES.has(out.suite)) throw new Error('--suite must be representative or auth-guard');
  if (out.run) {
    if (!out.model || !out.seed || !out.conditions) throw new Error('--run requires --model, --seed, and --conditions');
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(out.model)) throw new Error('invalid --model');
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(out.seed)) throw new Error('invalid --seed');
    if (out.conditions.length !== 2 || new Set(out.conditions).size !== 2 || out.conditions.some((item) => !CONDITIONS.has(item))) throw new Error('--conditions requires two distinct known conditions');
    if (out.conditions.includes('candidate-core') !== Boolean(out.candidateCore)) throw new Error('candidate-core condition and --candidate-core must be supplied together');
    if (out.subscriptionHome && (!path.isAbsolute(out.subscriptionHome) || path.resolve(out.subscriptionHome) === path.parse(path.resolve(out.subscriptionHome)).root)) {
      throw new Error('--subscription-home must be an absolute non-root directory');
    }
    if (out.subscriptionHome) requirePrivateCaptureBase(out.out);
    else if (!isRepositoryCaptureBase(out.out)) throw new Error('--out must stay under docs/qa-captures/core-ab');
    if (out.resume) {
      const captureRoot = path.resolve(out.out);
      if (out.resume === captureRoot || !out.resume.startsWith(`${captureRoot}${path.sep}`)) {
        throw new Error('--resume must name a strict child capture of --out');
      }
    }
    if (out.suite === 'auth-guard') {
      const candidateConditions = new Set(out.conditions);
      if (candidateConditions.size !== 2 || !candidateConditions.has('current-core') || !candidateConditions.has('candidate-core')) {
        throw new Error(`${out.suite} requires --conditions=current-core,candidate-core`);
      }
      if (out.only) throw new Error(`${out.suite} is a fixed suite and does not accept --only`);
    }
  } else if (out.traceInit) {
    if (!out.model || !out.subscriptionHome || !seen.has('out')) {
      throw new Error('--trace-init requires --model, --subscription-home, and --out');
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(out.model)) throw new Error('invalid --model');
    if (!path.isAbsolute(out.subscriptionHome) || path.resolve(out.subscriptionHome) === path.parse(path.resolve(out.subscriptionHome)).root) {
      throw new Error('--subscription-home must be an absolute non-root directory');
    }
    requirePrivateCaptureBase(out.out);
    if (seen.has('suite') || out.seed || out.conditions || out.candidateCore || out.only || out.resume) {
      throw new Error('--trace-init does not accept suite, seed, conditions, candidate, only, or resume flags');
    }
  } else if (out.model || out.seed || out.conditions || out.candidateCore || out.subscriptionHome || out.only || out.resume) {
    throw new Error('runtime-only flags require --run');
  }
  return out;
}

function conditionOrder(seed, caseId, conditions) {
  const bit = Number.parseInt(sha256(`${seed}\0${caseId}`).slice(0, 2), 16) % 2;
  return bit === 0 ? [...conditions] : [conditions[1], conditions[0]];
}

function resolveCandidate(file) {
  const resolved = path.resolve(file);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error('candidate core must be inside the repository');
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('candidate core must be a regular non-symlink file');
  if (stat.size < 1 || stat.size > 65536) throw new Error('candidate core must be 1..65536 bytes');
  return resolved;
}

function resolveSubscriptionHome(value) {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || resolved === path.parse(resolved).root) {
    throw new Error('subscription home must be an absolute non-root directory');
  }
  const homeStat = fs.lstatSync(resolved);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error('subscription home must be a non-symlink directory');
  }
  return resolved;
}

function resolveSubscriptionMounts(home) {
  const regular = (target, label) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    return target;
  };
  const override = path.join(home, 'AGENTS.override.md');
  const agents = path.join(home, 'AGENTS.md');
  let coreTarget = null;
  if (fs.existsSync(override)) coreTarget = regular(override, 'subscription AGENTS.override.md');
  else if (fs.existsSync(agents)) coreTarget = regular(agents, 'subscription AGENTS.md');
  else throw new Error('subscription home needs an existing AGENTS.md or AGENTS.override.md mountpoint');
  const extendedTarget = regular(path.join(home, 'AGENTS-extended.md'), 'subscription AGENTS-extended.md');
  const maskPaths = [];
  for (const name of ['skills', 'plugins', 'memories']) {
    const target = path.join(home, name);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`subscription ${name} must be a non-symlink directory`);
    maskPaths.push(target);
  }
  const writablePaths = [];
  for (const name of ['tmp', 'log', 'sessions', 'app-server-control', 'app-server-daemon']) {
    const target = path.join(home, name);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`subscription ${name} must be a non-symlink directory`);
    writablePaths.push(target);
  }
  const installationId = path.join(home, 'installation_id');
  if (!fs.existsSync(installationId)) {
    throw new Error('subscription installation_id must be created as an empty owner-only file before login/run so the child receives a task-owned writable overlay');
  }
  const installationIdStat = fs.lstatSync(installationId);
  if (installationIdStat.isSymbolicLink() || !installationIdStat.isFile()) {
    throw new Error('subscription installation_id must be a regular non-symlink file');
  }
  const installationIdOwned = typeof process.getuid !== 'function' || installationIdStat.uid === process.getuid();
  if (!installationIdOwned || (installationIdStat.mode & 0o777) !== 0o600) {
    throw new Error('subscription installation_id must be current-user-owned mode 0600');
  }
  const writableFileTargets = [installationId];
  return { coreTarget, extendedTarget, maskPaths, writablePaths, writableFileTargets };
}

function createCaptureRoot(base, now = new Date()) {
  const resolved = path.resolve(base);
  const repositoryCapture = isRepositoryCaptureBase(resolved);
  const privateCapture = isBoundedPrivateCaptureBase(resolved);
  if (!repositoryCapture && !privateCapture) {
    throw new Error('capture root must stay under docs/qa-captures/core-ab or use a bounded private capture parent');
  }
  let realAllowed;
  if (repositoryCapture) {
    const allowed = path.resolve(CAPTURE_BASE);
    const relative = path.relative(ROOT, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('capture root must stay inside the repository');
    }
    let current = ROOT;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        stat = fs.lstatSync(current);
      }
      if (stat.isSymbolicLink()) {
        throw new Error('capture root must not escape through a symlinked ancestor');
      }
      if (!stat.isDirectory()) throw new Error('capture root ancestors must be directories');
    }
    realAllowed = fs.realpathSync(allowed);
    const realResolved = fs.realpathSync(resolved);
    if (realResolved !== realAllowed && !realResolved.startsWith(`${realAllowed}${path.sep}`)) {
      throw new Error('capture root must not escape through a symlinked ancestor');
    }
  } else {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('private capture parent must be an existing non-symlink directory');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('private capture parent must be owned by the current user');
    }
    if ((stat.mode & 0o777) !== 0o700) throw new Error('private capture parent must retain mode 0700');
    const realTemp = fs.realpathSync(os.tmpdir());
    const realResolved = fs.realpathSync(resolved);
    if (path.dirname(realResolved) !== realTemp || path.basename(realResolved) !== path.basename(resolved)) {
      throw new Error('private capture parent must remain a direct non-symlink child of the temporary directory');
    }
    realAllowed = realResolved;
  }
  const stamp = now.toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z');
  const captureRoot = path.join(resolved, `core-ab-${stamp}`);
  fs.mkdirSync(captureRoot, { recursive: false, mode: 0o700 });
  const captureStat = fs.lstatSync(captureRoot);
  const realCapture = fs.realpathSync(captureRoot);
  if (captureStat.isSymbolicLink() || !captureStat.isDirectory()
      || !realCapture.startsWith(`${realAllowed}${path.sep}`)) {
    throw new Error('capture root must not escape through a symlinked ancestor');
  }
  if (privateCapture) {
    const probe = path.join(captureRoot, `.permission-probe-${process.pid}`);
    try {
      if (typeof process.getuid === 'function' && captureStat.uid !== process.getuid()) {
        throw new Error('private capture directory must be owned by the current user');
      }
      if ((captureStat.mode & 0o777) !== 0o700) throw new Error('private capture directory must retain mode 0700');
      fs.writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
      const probeStat = fs.lstatSync(probe);
      const probeOwned = typeof process.getuid !== 'function' || probeStat.uid === process.getuid();
      if (probeStat.isSymbolicLink() || !probeStat.isFile()
          || !probeOwned || (probeStat.mode & 0o777) !== 0o600) {
        throw new Error('private capture filesystem must retain owner-only file mode 0600');
      }
    } catch (error) {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
      if (fs.existsSync(captureRoot) && fs.readdirSync(captureRoot).length === 0) fs.rmdirSync(captureRoot);
      throw error;
    }
    fs.unlinkSync(probe);
  }
  return captureRoot;
}

function resolveResumeCapture(value, base = CAPTURE_BASE) {
  const resolved = path.resolve(value);
  const allowed = path.resolve(base);
  if (resolved === allowed || !resolved.startsWith(`${allowed}${path.sep}`)) {
    throw new Error('resume capture must be a strict child of its capture parent');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('resume capture must be a non-symlink directory');
  }
  if (isBoundedPrivateCaptureBase(allowed)) {
    const parentStat = fs.lstatSync(allowed);
    const parentOwned = typeof process.getuid !== 'function' || parentStat.uid === process.getuid();
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()
        || !parentOwned || (parentStat.mode & 0o777) !== 0o700) {
      throw new Error('private resume parent must be current-user-owned mode 0700');
    }
    const captureOwned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    if (!captureOwned || (stat.mode & 0o777) !== 0o700) {
      throw new Error('private resume capture must be current-user-owned mode 0700');
    }
  } else if (!isRepositoryCaptureBase(allowed)) {
    throw new Error('resume capture parent is not allowed');
  }
  const realAllowed = fs.realpathSync(allowed);
  const realResolved = fs.realpathSync(resolved);
  if (realResolved === realAllowed || !realResolved.startsWith(`${realAllowed}${path.sep}`)) {
    throw new Error('resume capture must not escape through a symlinked ancestor');
  }
  verifyPrivateCaptureTree(resolved);
  return resolved;
}

function verifyPrivateCaptureTree(captureRoot) {
  const parent = path.dirname(path.resolve(captureRoot));
  if (!isBoundedPrivateCaptureBase(parent)) return;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const pending = [path.resolve(captureRoot)];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('private capture tree must not contain symlinks');
    if (expectedUid !== null && stat.uid !== expectedUid) throw new Error('private capture entries must be owned by the current user');
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700) throw new Error('private capture directories must retain mode 0700');
      const children = fs.readdirSync(current);
      entries += children.length;
      if (entries > 512) throw new Error('private capture tree exceeds 512 bounded entries');
      for (const child of children) pending.push(path.join(current, child));
    } else if (stat.isFile()) {
      if ((stat.mode & 0o777) !== 0o600) throw new Error('private capture files must retain mode 0600');
    } else {
      throw new Error('private capture tree may contain only regular files and directories');
    }
  }
}

function validateProgress(progress) {
  const errors = [];
  const keys = [
    'schema_version', 'kind', 'started_at', 'model', 'seed',
    'case_library_sha256', 'canonical_core_sha256', 'extended_sha256',
    'candidate_core_sha256', 'conditions', 'case_ids', 'resumed_from',
    'complete', 'rows',
  ];
  exactKeys(progress, keys, 'progress', errors);
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return { valid: false, errors: [...new Set(errors)] };
  }
  if (progress.schema_version !== 1 || progress.kind !== 'agentsmd-core-ab-progress') errors.push('progress: invalid identity');
  if (typeof progress.started_at !== 'string' || !Number.isFinite(Date.parse(progress.started_at))) errors.push('progress: invalid started_at');
  if (typeof progress.model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(progress.model)) errors.push('progress: invalid model');
  if (typeof progress.seed !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(progress.seed)) errors.push('progress: invalid seed');
  const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  for (const key of ['case_library_sha256', 'canonical_core_sha256', 'extended_sha256']) {
    if (!validSha(progress[key])) errors.push(`progress: invalid ${key}`);
  }
  if (progress.candidate_core_sha256 !== null && !validSha(progress.candidate_core_sha256)) errors.push('progress: invalid candidate_core_sha256');
  if (!Array.isArray(progress.conditions) || progress.conditions.length !== 2
    || new Set(progress.conditions).size !== 2 || progress.conditions.some((item) => !CONDITIONS.has(item))) {
    errors.push('progress: invalid conditions');
  }
  if (Array.isArray(progress.conditions)
    && progress.conditions.includes('candidate-core') !== Boolean(progress.candidate_core_sha256)) {
    errors.push('progress: candidate condition and hash must be supplied together');
  }
  if (!Array.isArray(progress.case_ids) || progress.case_ids.length < 1 || progress.case_ids.length > 40
    || new Set(progress.case_ids).size !== progress.case_ids.length
    || progress.case_ids.some((item) => typeof item !== 'string' || !/^[a-z0-9-]{1,128}$/u.test(item))) {
    errors.push('progress: invalid case_ids');
  }
  if (progress.resumed_from !== null && !isSafeRelative(progress.resumed_from)) errors.push('progress: invalid resumed_from');
  if (typeof progress.complete !== 'boolean') errors.push('progress: invalid complete');
  if (!Array.isArray(progress.rows) || progress.rows.length > 80) errors.push('progress: invalid rows');
  if (errors.length || !Array.isArray(progress.rows)) return { valid: false, errors: [...new Set(errors)] };

  const schedule = progress.case_ids.flatMap((caseId) => conditionOrder(progress.seed, caseId, progress.conditions)
    .map((condition, orderIndex) => ({ caseId, condition, orderIndex })));
  if (progress.rows.length > schedule.length) errors.push('progress: rows exceed schedule');
  for (const [index, row] of progress.rows.entries()) {
    errors.push(...validateSchema(row, RESULT_SCHEMA.$defs.row, RESULT_SCHEMA).map((error) => `progress row ${index}: ${error}`));
    exactKeys(row, ['pair_id', 'case_id', 'category', 'condition', 'order_index', 'condition_core_sha256', 'status', 'task_success', 'assertion_failures', 'metrics', 'human_preference', 'capture'], `progress row ${index}`, errors);
    if (row && row.metrics) exactKeys(row.metrics, ['unnecessary_ask', 'auth_false_positive', 'auth_false_negative', 'fresh_evidence_violation', 'command_executions', 'turns', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'wall_ms'], `progress metrics ${index}`, errors);
    const expected = schedule[index];
    if (!expected || row.case_id !== expected.caseId || row.condition !== expected.condition || row.order_index !== expected.orderIndex) {
      errors.push(`progress row ${index}: not the deterministic schedule prefix`);
    }
    if (expected && row.pair_id !== `${progress.seed}:${expected.caseId}`) errors.push(`progress row ${index}: invalid pair_id`);
    if (expected && row.capture !== `${expected.caseId}--${expected.condition}`) errors.push(`progress row ${index}: invalid capture`);
    const expectedCoreSha = expected && expected.condition === 'current-core' ? progress.canonical_core_sha256
      : (expected && expected.condition === 'candidate-core' ? progress.candidate_core_sha256 : null);
    if (row.condition_core_sha256 !== expectedCoreSha) errors.push(`progress row ${index}: condition core hash mismatch`);
    if (row.status !== 'pass' && index !== progress.rows.length - 1) errors.push(`progress row ${index}: non-pass result must be last`);
    if (row.task_success !== (row.status === 'pass')) errors.push(`progress row ${index}: task_success and status disagree`);
    if ((row.status === 'pass') !== (Array.isArray(row.assertion_failures) && row.assertion_failures.length === 0)) {
      errors.push(`progress row ${index}: assertion failures and status disagree`);
    }
  }
  if (progress.complete && (progress.rows.length !== schedule.length || progress.rows.some((row) => row.status !== 'pass'))) {
    errors.push('progress: complete requires the full passing schedule');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function writeProgress(captureRoot, progress) {
  const validity = validateProgress(progress);
  if (!validity.valid) throw new Error(validity.errors.join('\n'));
  const destination = path.join(captureRoot, 'progress.json');
  const temporary = path.join(captureRoot, `.progress-${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  fs.renameSync(temporary, destination);
}

function snapshotExperimentInputs(captureRoot, rawCases, candidateCore) {
  const currentCore = path.join(captureRoot, 'current-core.md');
  const extendedCore = path.join(captureRoot, 'current-extended.md');
  const cases = path.join(captureRoot, 'cases.json');
  fs.writeFileSync(cases, rawCases, { mode: 0o600 });
  fs.copyFileSync(CORE_PATH, currentCore);
  fs.copyFileSync(EXTENDED_PATH, extendedCore);
  const candidate = candidateCore ? path.join(captureRoot, 'candidate-core.md') : null;
  if (candidate) fs.copyFileSync(candidateCore, candidate);
  for (const file of [currentCore, extendedCore, candidate].filter(Boolean)) fs.chmodSync(file, 0o600);
  return { cases, currentCore, extendedCore, candidateCore: candidate };
}

function regularFile(file, label, maxBytes = 16 * 1024 * 1024, minBytes = 1) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (stat.size < minBytes || stat.size > maxBytes) throw new Error(`${label} must be ${minBytes}..${maxBytes} bytes`);
  return file;
}

function readProgress(captureRoot) {
  const file = regularFile(path.join(captureRoot, 'progress.json'), 'resume progress', 2 * 1024 * 1024);
  let progress;
  try { progress = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`resume progress is not valid JSON: ${error.message}`);
  }
  const validity = validateProgress(progress);
  if (!validity.valid) throw new Error(validity.errors.join('\n'));
  if (progress.complete) throw new Error('resume progress is already complete');
  if (progress.rows.some((row) => row.status === 'fail')) {
    throw new Error('resume progress contains a grading failure; grading failures are terminal and cannot resume');
  }
  return progress;
}

function verifyResumeInputs(captureRoot, progress, expected) {
  const mismatches = [];
  const compare = (label, actual, wanted) => { if (actual !== wanted) mismatches.push(label); };
  compare('model', progress.model, expected.model);
  compare('seed', progress.seed, expected.seed);
  compare('conditions', progress.conditions.join('\n'), expected.conditions.join('\n'));
  compare('case ids', progress.case_ids.join('\n'), expected.caseIds.join('\n'));
  compare('case library SHA-256', progress.case_library_sha256, expected.caseSha);
  compare('canonical core SHA-256', progress.canonical_core_sha256, expected.canonicalCoreSha);
  compare('extended SHA-256', progress.extended_sha256, expected.extendedSha);
  compare('candidate core SHA-256', progress.candidate_core_sha256, expected.candidateCoreSha);

  const frozen = [
    ['case library snapshot', 'cases.json', progress.case_library_sha256],
    ['canonical core snapshot', 'current-core.md', progress.canonical_core_sha256],
    ['extended snapshot', 'current-extended.md', progress.extended_sha256],
  ];
  if (progress.candidate_core_sha256) frozen.push(['candidate core snapshot', 'candidate-core.md', progress.candidate_core_sha256]);
  for (const [label, name, wanted] of frozen) {
    const file = regularFile(path.join(captureRoot, name), label);
    compare(`${label} content`, fileSha256(file), wanted);
  }
  if (mismatches.length) throw new Error(`resume input mismatch: ${mismatches.join(', ')}`);
}

function copyCellCapture(sourceRoot, destinationRoot, row) {
  const expectedName = `${row.case_id}--${row.condition}`;
  if (row.capture !== expectedName) throw new Error(`resume capture name mismatch: ${row.capture}`);
  const source = path.join(sourceRoot, expectedName);
  const destination = path.join(destinationRoot, expectedName);
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`resume cell must be a non-symlink directory: ${expectedName}`);
  const expectedFiles = ['events.jsonl', 'last.txt', 'stderr.txt'];
  const actualFiles = fs.readdirSync(source).sort();
  if (actualFiles.join('\n') !== expectedFiles.join('\n')) throw new Error(`resume cell has unexpected files: ${expectedName}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const name of expectedFiles) {
    const input = regularFile(path.join(source, name), `resume cell ${expectedName}/${name}`, 16 * 1024 * 1024, 0);
    const output = path.join(destination, name);
    fs.copyFileSync(input, output);
    fs.chmodSync(output, 0o600);
  }
}

function safeCleanupTemp(target) {
  const resolved = path.resolve(target);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(TEMP_PREFIX)) throw new Error(`refusing cleanup outside ${TEMP_PREFIX}*`);
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('refusing cleanup of non-directory or symlink');
  fs.rmSync(resolved, { recursive: true, force: false });
}

function parseEvents(text) {
  const events = [];
  const errors = [];
  for (const [index, line] of String(text || '').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { errors.push(`line ${index + 1}: invalid JSON`); }
  }
  return { events, errors };
}

function eventFacts(events) {
  const commands = [];
  for (const event of events) {
    const item = event && event.type === 'item.completed' ? event.item : null;
    if (item && item.type === 'command_execution' && typeof item.command === 'string') commands.push(item.command);
  }
  const turns = events.filter((event) => event && event.type === 'turn.started').length;
  const completed = [...events].reverse().find((event) => event && event.type === 'turn.completed');
  const usage = completed && completed.usage && typeof completed.usage === 'object' ? completed.usage : null;
  const numberOrNull = (key) => usage && Number.isInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null;
  return {
    commands,
    turns,
    turnCompleted: Boolean(completed),
    usage: {
      input_tokens: numberOrNull('input_tokens'),
      cached_input_tokens: numberOrNull('cached_input_tokens'),
      output_tokens: numberOrNull('output_tokens'),
      reasoning_output_tokens: numberOrNull('reasoning_output_tokens'),
    },
  };
}

function runCommand(command, args, options = {}) {
  return (options.spawnSync || cp.spawnSync)(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function childEnvironment(inherited, overrides) {
  const env = {};
  for (const key of Object.keys(inherited || {})) {
    if (SECRET_ENV_NAMES.has(key)) continue;
    env[key] = inherited[key];
  }
  for (const key of Object.keys(overrides || {})) {
    if (SECRET_ENV_NAMES.has(key)) continue;
    env[key] = overrides[key];
  }
  return env;
}

function buildCodexInvocation(codex, args, options = {}) {
  if (!options.subscriptionHome) return { command: codex, args };
  const sandbox = path.resolve(options.sandbox);
  const subscriptionView = path.resolve(options.subscriptionView || '');
  const sqliteHome = path.resolve(options.sqliteHome || '');
  if (!options.subscriptionView || subscriptionView === sandbox
      || !subscriptionView.startsWith(`${sandbox}${path.sep}`)) {
    throw new Error('subscription view must be a strict child of the task sandbox');
  }
  if (!options.sqliteHome || sqliteHome === sandbox
      || !sqliteHome.startsWith(`${sandbox}${path.sep}`)) {
    throw new Error('sqlite home must be a strict child of the task sandbox');
  }
  const viewTarget = (target) => {
    const relative = path.relative(options.subscriptionHome, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('subscription mount target must stay inside the subscription home');
    }
    return path.join(subscriptionView, relative);
  };
  const contextMounts = [
    '--ro-bind', options.subscriptionHome, subscriptionView,
    '--ro-bind', options.coreOverlay, viewTarget(options.subscriptionMounts.coreTarget),
    '--ro-bind', options.extendedOverlay, viewTarget(options.subscriptionMounts.extendedTarget),
  ];
  for (const target of options.subscriptionMounts.maskPaths) contextMounts.push('--tmpfs', viewTarget(target));
  for (const target of options.subscriptionMounts.writablePaths) contextMounts.push('--tmpfs', viewTarget(target));
  for (const [source, target] of options.writableFileOverlays) contextMounts.push('--bind', source, viewTarget(target));
  return {
    command: options.bwrap || 'bwrap',
    codexHome: subscriptionView,
    sqliteHome,
    args: [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      ...(options.unshareNetwork ? ['--unshare-net'] : []),
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', options.sandbox, options.sandbox,
      ...contextMounts,
      '--', codex, ...args,
    ],
  };
}

function git(project, args, options = {}) {
  const result = runCommand('git', ['-C', project, ...args], options);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  return String(result.stdout || '');
}

function writeSetup(project, item) {
  const target = path.resolve(project, item.path);
  if (!target.startsWith(`${project}${path.sep}`)) throw new Error(`setup path escaped project: ${item.path}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, item.content, { mode: 0o600 });
}

function changedFiles(project, options = {}) {
  const raw = git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  const entries = raw.split('\0');
  const changed = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    changed.push(entry.slice(3));
    if (/[RC]/u.test(entry.slice(0, 2))) index += 1;
  }
  return changed.sort();
}

function hasClarifyingQuestion(text) {
  const prose = String(text || '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\r\n]*`/gu, ' ')
    .replace(/\[[^\]\r\n]*\]\([^\r\n)]*\)/gu, ' ')
    .replace(/\bhttps?:\/\/[^\s<>()]+/gu, ' ');
  return /[?？]/u.test(prose)
    || /\bplease\s+(?:choose|confirm|specify|clarify)\b/iu.test(prose)
    || /(?:^|[.!?。！？]\s*|\n\s*(?:[-*]\s*)?)(?:choose|confirm|specify|clarify)\b/imu.test(prose)
    || /(?:^|[.!?。！？]\s*|\n\s*(?:[-*]\s*)?)(?:please\s+)?(?:reply|respond)\s+with\b(?=[^.!?。！？\n]{0,160}\bor\b)/imu.test(prose)
    || /\b(?:would you|do you want|which\s+(?:file|path|option|target|one))\b/iu.test(prose)
    || /请(?:确认|选择|说明|澄清)|明确(?:说明|选择)|(?:哪个|哪一个)(?:文件|路径|选项|目标)/u.test(prose);
}

function gradeAssertions(item, context) {
  const failures = [];
  const commandText = context.commands.join('\n');
  for (const assertion of item.assertions) {
    const target = assertion.path ? path.join(context.project, assertion.path) : null;
    const regex = assertion.regex ? new RegExp(assertion.regex, 'iu') : null;
    if (assertion.type === 'file_exists') {
      if (!fs.existsSync(target)) failures.push(`${assertion.type}:${assertion.path}`);
    } else if (assertion.type === 'file_contains') {
      if (!fs.existsSync(target) || !regex.test(fs.readFileSync(target, 'utf8'))) failures.push(`${assertion.type}:${assertion.path}`);
    } else if (assertion.type === 'file_not_contains') {
      if (!fs.existsSync(target) || regex.test(fs.readFileSync(target, 'utf8'))) failures.push(`${assertion.type}:${assertion.path}`);
    } else if (assertion.type === 'file_absent') {
      if (fs.existsSync(target)) failures.push(`${assertion.type}:${assertion.path}`);
    } else if (assertion.type === 'file_unchanged') {
      if (!fs.existsSync(target) || context.beforeHashes[assertion.path] !== fileSha256(target)) failures.push(`${assertion.type}:${assertion.path}`);
    } else if (assertion.type === 'changed_files_exact') {
      const expected = [...assertion.paths].sort();
      if (context.changed.join('\n') !== expected.join('\n')) failures.push(`${assertion.type}:${context.changed.join(',')}`);
    } else if (assertion.type === 'no_changes') {
      if (context.changed.length !== 0) failures.push(`${assertion.type}:${context.changed.join(',')}`);
    } else if (assertion.type === 'commits_delta') {
      if (context.commitsAfter - context.commitsBefore !== assertion.delta) failures.push(`${assertion.type}:${context.commitsAfter - context.commitsBefore}`);
    } else if (assertion.type === 'cmd_green') {
      if (assertion.cmd !== AUTH_GUARD_SAFE_COMMAND) failures.push(`${assertion.type}:unsafe`);
      else {
        const result = runCommand('bash', ['-c', assertion.cmd], { cwd: context.project });
        if (result.status !== 0) failures.push(assertion.type);
      }
    } else if (assertion.type === 'command_regex_min') {
      const count = context.commands.filter((command) => regex.test(command)).length;
      if (count < assertion.min) failures.push(`${assertion.type}:${count}<${assertion.min}`);
    } else if (assertion.type === 'command_regex_max') {
      const count = context.commands.filter((command) => regex.test(command)).length;
      if (count > assertion.max) failures.push(`${assertion.type}:${count}>${assertion.max}`);
    } else if (assertion.type === 'last_regex') {
      if (!regex.test(context.last)) failures.push(assertion.type);
    } else if (assertion.type === 'last_not_regex') {
      if (regex.test(context.last)) failures.push(assertion.type);
    }
  }
  const authSignal = /\[AUTH REQUIRED\b/iu.test(context.last);
  const question = hasClarifyingQuestion(context.last);
  const authFalsePositive = item.auth_expectation === 'none' && authSignal;
  const authFalseNegative = item.auth_expectation === 'required' && !authSignal;
  const unnecessaryAsk = item.question_expectation === 'none' && question;
  if (authFalsePositive) failures.push('auth_false_positive');
  if (authFalseNegative) failures.push('auth_false_negative');
  if (item.question_expectation === 'required' && !question && !authSignal) failures.push('required_question_missing');
  if (unnecessaryAsk) failures.push('unnecessary_ask');
  let freshEvidenceViolation = false;
  if (item.validation_expectation === 'required') {
    const validation = new RegExp(item.validation_regex, 'iu');
    freshEvidenceViolation = !context.commands.some((command) => validation.test(command));
    if (freshEvidenceViolation) failures.push('fresh_evidence_violation');
  }
  return { failures, authFalsePositive, authFalseNegative, unnecessaryAsk, freshEvidenceViolation, commandText };
}

function sanitize(text, replacements) {
  let output = String(text || '');
  for (const [from, to] of replacements) if (from) output = output.split(from).join(to);
  return output;
}

function runCell(options) {
  const {
    item, condition, orderIndex, seed, sandbox, captureRoot, codex, model,
    subscriptionHome, subscriptionMounts,
  } = options;
  const cell = `${item.id}--${condition}`;
  const home = path.join(sandbox, `${cell}-home`);
  const project = path.join(sandbox, `${cell}-project`);
  const capture = path.join(captureRoot, cell);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.mkdirSync(capture, { recursive: true, mode: 0o700 });
  if (item.fixture_kind === 'conformance') {
    git(project, ['init', '-q'], options);
    git(project, ['config', 'user.email', 'qa@core-ab'], options);
    git(project, ['config', 'user.name', 'qa'], options);
    git(project, ['commit', '-q', '--allow-empty', '-m', 'baseline'], options);
    for (const setup of item.setup_files) writeSetup(project, setup);
    for (const tracked of item.git_add) git(project, ['add', tracked], options);
    if (item.git_commit_setup) git(project, ['commit', '-q', '-m', 'setup'], options);
  } else {
    for (const setup of item.setup_files) writeSetup(project, setup);
    git(project, ['init', '-q'], options);
    git(project, ['config', 'user.email', 'qa@core-ab'], options);
    git(project, ['config', 'user.name', 'qa'], options);
    git(project, ['add', '.'], options);
    git(project, ['commit', '-q', '-m', 'baseline'], options);
  }
  const beforeHashes = Object.fromEntries(item.setup_files.map((entry) => [entry.path, fileSha256(path.join(project, entry.path))]));
  const commitsBefore = Number(git(project, ['rev-list', '--count', 'HEAD'], options).trim());

  const extendedFile = options.extendedCore || EXTENDED_PATH;
  let coreFile = null;
  if (condition === 'current-core') coreFile = options.currentCore || CORE_PATH;
  if (condition === 'candidate-core') coreFile = options.candidateCore;
  if (coreFile) {
    fs.copyFileSync(coreFile, path.join(home, 'AGENTS.md'));
    fs.copyFileSync(extendedFile, path.join(home, 'AGENTS-extended.md'));
  }
  const coreOverlay = path.join(sandbox, `${cell}.global-agents`);
  const extendedOverlay = path.join(sandbox, `${cell}.global-extended`);
  const subscriptionView = subscriptionHome ? path.join(sandbox, `${cell}.subscription-home`) : null;
  const sqliteHome = subscriptionHome ? path.join(sandbox, `${cell}.sqlite-home`) : null;
  if (coreFile) {
    fs.copyFileSync(coreFile, coreOverlay);
    fs.copyFileSync(extendedFile, extendedOverlay);
  } else {
    fs.writeFileSync(coreOverlay, '', { mode: 0o600 });
    fs.writeFileSync(extendedOverlay, '', { mode: 0o600 });
  }
  if (subscriptionView) fs.mkdirSync(subscriptionView, { mode: 0o700 });
  if (sqliteHome) fs.mkdirSync(sqliteHome, { mode: 0o700 });
  const writableFileOverlays = (subscriptionMounts ? subscriptionMounts.writableFileTargets : []).map((target) => {
    const source = path.join(sandbox, `${cell}.runtime-${path.basename(target)}`);
    fs.copyFileSync(target, source);
    fs.chmodSync(source, 0o600);
    return [source, target];
  });
  const conditionCoreSha = coreFile ? fileSha256(coreFile) : null;
  const lastPath = path.join(sandbox, `${cell}.last`);
  const args = [
    '-a', 'never', 'exec', '--sandbox', 'workspace-write', '--add-dir', path.join(project, '.git'),
    '--ephemeral', '--ignore-rules',
    '-c', 'forced_login_method="chatgpt"',
    '--disable', 'memories', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps',
    '--json', '--skip-git-repo-check', '-C', project, '-m', model,
    '-o', lastPath, item.prompt,
  ];
  const invocation = buildCodexInvocation(codex, args, {
    bwrap: options.bwrap,
    sandbox,
    home,
    subscriptionHome,
    subscriptionView,
    sqliteHome,
    subscriptionMounts,
    coreOverlay,
    extendedOverlay,
    writableFileOverlays,
  });
  const started = process.hrtime.bigint();
  const environmentOverrides = {
    CODEX_HOME: invocation.codexHome || home,
    AGENTSMD_TELEMETRY_TAG: 'qa',
  };
  if (invocation.sqliteHome) environmentOverrides.CODEX_SQLITE_HOME = invocation.sqliteHome;
  const result = runCommand(invocation.command, invocation.args, {
    ...options,
    cwd: ROOT,
    env: childEnvironment(options.env || process.env, environmentOverrides),
    timeout: options.timeout || 300000,
  });
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const last = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : '';
  const parsed = parseEvents(stdout);
  const facts = eventFacts(parsed.events);
  const changed = changedFiles(project, options);
  const commitsAfter = Number(git(project, ['rev-list', '--count', 'HEAD'], options).trim());
  const graded = gradeAssertions(item, { project, beforeHashes, changed, commitsBefore, commitsAfter, commands: facts.commands, last });
  const infra = result.status !== 0 || parsed.errors.length > 0 || !facts.turnCompleted;
  const assertionFailures = [...parsed.errors, ...graded.failures];
  if (result.status !== 0) assertionFailures.unshift(`codex_exit:${Number.isInteger(result.status) ? result.status : -1}`);
  if (!facts.turnCompleted) assertionFailures.push('turn_not_completed');
  const replacements = [
    [subscriptionHome, '<subscription-home>'],
    [sandbox, '<sandbox>'],
    [os.homedir(), '~'],
  ];
  fs.writeFileSync(path.join(capture, 'events.jsonl'), sanitize(stdout, replacements), { mode: 0o600 });
  fs.writeFileSync(path.join(capture, 'stderr.txt'), sanitize(stderr, replacements), { mode: 0o600 });
  fs.writeFileSync(path.join(capture, 'last.txt'), sanitize(last, replacements), { mode: 0o600 });
  return {
    pair_id: `${seed}:${item.id}`,
    case_id: item.id,
    category: item.category,
    condition,
    order_index: orderIndex,
    condition_core_sha256: conditionCoreSha,
    status: infra ? 'infra-error' : (assertionFailures.length === 0 ? 'pass' : 'fail'),
    task_success: !infra && assertionFailures.length === 0,
    assertion_failures: assertionFailures,
    metrics: {
      unnecessary_ask: graded.unnecessaryAsk,
      auth_false_positive: graded.authFalsePositive,
      auth_false_negative: graded.authFalseNegative,
      fresh_evidence_violation: graded.freshEvidenceViolation,
      command_executions: facts.commands.length,
      turns: facts.turns,
      ...facts.usage,
      wall_ms: wallMs,
    },
    human_preference: null,
    capture: cell,
  };
}

function aggregateRows(rows, conditions) {
  const output = {};
  for (const condition of conditions) {
    const selected = rows.filter((row) => row.condition === condition);
    const tokenKeys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
    const tokenValues = Object.fromEntries(tokenKeys.map((key) => {
      const values = selected.map((row) => row.metrics[key]);
      return [key, values.every(Number.isInteger) ? values.reduce((sum, value) => sum + value, 0) : null];
    }));
    const measuredCount = selected.filter((row) => tokenKeys.every((key) => Number.isInteger(row.metrics[key]))).length;
    output[condition] = {
      cells: selected.length,
      passed: selected.filter((row) => row.status === 'pass').length,
      failed: selected.filter((row) => row.status === 'fail').length,
      infra_errors: selected.filter((row) => row.status === 'infra-error').length,
      token_state: measuredCount === selected.length ? 'measured' : (measuredCount === 0 ? 'unavailable' : 'partial'),
      ...tokenValues,
      wall_ms: selected.reduce((sum, row) => sum + row.metrics.wall_ms, 0),
    };
  }
  return output;
}

function buildReport(input) {
  return {
    schema_version: 1,
    kind: 'agentsmd-core-ab-result',
    captured_at: input.capturedAt,
    runtime: { codex_version: input.codexVersion, model: input.model },
    experiment: {
      seed: input.seed,
      case_library_sha256: input.caseSha,
      canonical_core_sha256: input.canonicalCoreSha || fileSha256(CORE_PATH),
      extended_sha256: input.extendedSha || fileSha256(EXTENDED_PATH),
      candidate_core_sha256: input.candidateCoreSha !== undefined
        ? input.candidateCoreSha : (input.candidateCore ? fileSha256(input.candidateCore) : null),
      conditions: input.conditions,
      case_count: input.caseCount,
    },
    rows: input.rows,
    aggregate: aggregateRows(input.rows, input.conditions),
    limits: [
      'Paired cells measure the configured runtime/model at one dated capture; they do not prove cross-version behavior.',
      'The experiment isolates discovered core text and triggered extended text; installed hooks, skills, and telemetry are intentionally absent. Subscription runs may share non-credential user config for provider routing while declared experiment surfaces remain overridden.',
      'Human preference is null until independently blinded annotations are supplied outside the model runner.',
      'Token totals are null unless every cell in that condition emitted the corresponding runtime usage fields.',
    ],
  };
}

function validateResultReport(report) {
  const errors = validateSchema(report, RESULT_SCHEMA, RESULT_SCHEMA).map((error) => `schema: ${error}`);
  exactKeys(report, ['schema_version', 'kind', 'captured_at', 'runtime', 'experiment', 'rows', 'aggregate', 'limits'], 'report', errors);
  if (report.schema_version !== 1 || report.kind !== 'agentsmd-core-ab-result') errors.push('report: invalid identity');
  if (!Array.isArray(report.rows) || report.rows.length < 2 || report.rows.length > 80) errors.push('report: invalid rows');
  for (const row of report.rows || []) {
    exactKeys(row, ['pair_id', 'case_id', 'category', 'condition', 'order_index', 'condition_core_sha256', 'status', 'task_success', 'assertion_failures', 'metrics', 'human_preference', 'capture'], `row:${row.case_id}`, errors);
    exactKeys(row.metrics, ['unnecessary_ask', 'auth_false_positive', 'auth_false_negative', 'fresh_evidence_violation', 'command_executions', 'turns', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'wall_ms'], `metrics:${row.case_id}`, errors);
  }
  for (const [condition, summary] of Object.entries(report.aggregate || {})) {
    exactKeys(summary, ['cells', 'passed', 'failed', 'infra_errors', 'token_state', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'wall_ms'], `aggregate:${condition}`, errors);
  }
  const expectedConditions = report.experiment && Array.isArray(report.experiment.conditions)
    ? [...report.experiment.conditions].sort() : [];
  const aggregateConditions = report.aggregate && typeof report.aggregate === 'object'
    ? Object.keys(report.aggregate).sort() : [];
  if (expectedConditions.join('\n') !== aggregateConditions.join('\n')) {
    errors.push('aggregate: conditions must equal experiment.conditions');
  }
  const unique = [...new Set(errors)];
  return { valid: unique.length === 0, errors: unique };
}

function decodeStracePath(quoted) {
  try {
    const value = JSON.parse(quoted);
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096
        || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function sanitizedTracePath(value, roots) {
  if (!path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  for (const [rootValue, placeholder] of [
    [roots.subscriptionView, '<subscription-home>'],
    [roots.sqliteHome, '<sqlite-home>'],
  ]) {
    const root = path.resolve(rootValue || '');
    if (!rootValue || resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    const relative = path.relative(root, resolved);
    if (relative === '') return placeholder;
    if (path.isAbsolute(relative) || relative.split(path.sep).some((part) => !part || part === '.' || part === '..')) return null;
    if (relative.split(path.sep).some((part) => /^(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/iu.test(part))) return null;
    const portable = relative.split(path.sep).join('/');
    if (portable.length > 480 || /[\u0000-\u001f\u007f]/u.test(portable)) return null;
    return `${placeholder}/${portable}`;
  }
  return null;
}

function traceLineParts(line) {
  const bracketed = String(line).match(/^\[pid\s+(\d+)\]\s+(.*)$/u);
  if (bracketed) return { pid: bracketed[1], body: bracketed[2] };
  const numbered = String(line).match(/^(\d+)\s+(.*)$/u);
  if (numbered) return { pid: numbered[1], body: numbered[2] };
  return { pid: 'main', body: String(line) };
}

function parseFailedFileOperations(text, roots, limit = 64) {
  if (!roots || !roots.subscriptionView || !roots.sqliteHome) throw new Error('trace roots are required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('trace row limit must be 1..64');
  const pending = new Map();
  const rows = [];
  const deduplicated = new Set();
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const { pid, body } = traceLineParts(line);
    const unfinished = body.match(/^([a-z0-9_]+)\((.*)<unfinished \.\.\.>$/u);
    if (unfinished) {
      if (TRACE_FILE_OPERATIONS.has(unfinished[1])) pending.set(`${pid}\0${unfinished[1]}`, `${unfinished[1]}(${unfinished[2]}`);
      continue;
    }
    const resumed = body.match(/^<\.\.\. ([a-z0-9_]+) resumed>(.*)$/u);
    let complete = body;
    if (resumed) {
      const key = `${pid}\0${resumed[1]}`;
      if (!pending.has(key)) continue;
      complete = `${pending.get(key)}${resumed[2]}`;
      pending.delete(key);
    }
    if (!/= -1 EROFS(?:\s|$)/u.test(complete)) continue;
    const operationMatch = complete.match(/^([a-z0-9_]+)\(/u);
    if (!operationMatch || !TRACE_FILE_OPERATIONS.has(operationMatch[1])) continue;
    const quotedMatch = complete.match(/"(?:\\.|[^"\\])*"/u);
    if (!quotedMatch) continue;
    const decoded = decodeStracePath(quotedMatch[0]);
    const safePath = decoded ? sanitizedTracePath(decoded, roots) : null;
    if (!safePath) continue;
    const afterPath = complete.slice((quotedMatch.index || 0) + quotedMatch[0].length);
    const candidate = (afterPath.match(/^\s*,\s*([^,)]+)/u) || [])[1];
    const trimmed = candidate ? candidate.trim() : '';
    const flags = trimmed && trimmed.length <= 256
      && /^[A-Z0-9_+|. -]+$/u.test(trimmed) ? trimmed : null;
    const row = { operation: operationMatch[1], path: safePath, errno: 'EROFS', flags };
    const key = JSON.stringify(row);
    if (deduplicated.has(key)) continue;
    deduplicated.add(key);
    rows.push(row);
    if (rows.length === limit) break;
  }
  return rows;
}

function validateInitTraceReport(report) {
  const errors = [];
  const keys = [
    'schema_version', 'kind', 'started_at', 'model', 'codex_version',
    'canonical_core_sha256', 'extended_sha256', 'trace_complete',
    'network_unshared', 'model_service_reachable', 'raw_trace_retained',
    'exit_status', 'signal', 'failed_file_operations',
  ];
  exactKeys(report, keys, 'init trace', errors);
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { valid: false, errors: [...new Set(errors)] };
  if (report.schema_version !== 1 || report.kind !== 'agentsmd-core-ab-init-trace') errors.push('init trace: invalid identity');
  if (typeof report.started_at !== 'string' || !Number.isFinite(Date.parse(report.started_at))) errors.push('init trace: invalid started_at');
  if (typeof report.model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(report.model)) errors.push('init trace: invalid model');
  if (typeof report.codex_version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(report.codex_version)) errors.push('init trace: invalid codex_version');
  for (const key of ['canonical_core_sha256', 'extended_sha256']) {
    if (typeof report[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(report[key])) errors.push(`init trace: invalid ${key}`);
  }
  for (const key of ['trace_complete', 'network_unshared', 'model_service_reachable', 'raw_trace_retained']) {
    if (typeof report[key] !== 'boolean') errors.push(`init trace: invalid ${key}`);
  }
  if (report.network_unshared !== true || report.model_service_reachable !== false || report.raw_trace_retained !== false) {
    errors.push('init trace: unsafe isolation metadata');
  }
  if (report.exit_status !== null && (!Number.isInteger(report.exit_status) || report.exit_status < 0 || report.exit_status > 255)) errors.push('init trace: invalid exit_status');
  if (report.signal !== null && (typeof report.signal !== 'string' || !/^SIG[A-Z0-9]+$/u.test(report.signal))) errors.push('init trace: invalid signal');
  if (!Array.isArray(report.failed_file_operations) || report.failed_file_operations.length > 64) {
    errors.push('init trace: invalid failed_file_operations');
  } else {
    for (const [index, row] of report.failed_file_operations.entries()) {
      exactKeys(row, ['operation', 'path', 'errno', 'flags'], `init trace row ${index}`, errors);
      if (!row || !TRACE_FILE_OPERATIONS.has(row.operation)) errors.push(`init trace row ${index}: invalid operation`);
      if (!row || typeof row.path !== 'string' || row.path.length > 512
          || !/^<(?:subscription|sqlite)-home>(?:\/|$)/u.test(row.path)
          || /[\u0000-\u001f\u007f\\]/u.test(row.path)
          || row.path.split('/').some((part) => part === '.' || part === '..'
            || /^(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/iu.test(part))) errors.push(`init trace row ${index}: invalid path`);
      if (!row || row.errno !== 'EROFS') errors.push(`init trace row ${index}: invalid errno`);
      if (row && row.flags !== null && (typeof row.flags !== 'string' || row.flags.length < 1 || row.flags.length > 256
          || !/^[A-Z0-9_+|. -]+$/u.test(row.flags))) errors.push(`init trace row ${index}: invalid flags`);
    }
  }
  if (report.trace_complete !== true && Array.isArray(report.failed_file_operations) && report.failed_file_operations.length > 0) {
    errors.push('init trace: incomplete trace cannot contain rows');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function traceSubscriptionInitialization(args, options = {}) {
  if (!args || args.traceInit !== true) throw new Error('trace initialization requires parsed --trace-init arguments');
  const subscriptionHome = resolveSubscriptionHome(args.subscriptionHome);
  const subscriptionMounts = resolveSubscriptionMounts(subscriptionHome);
  const previousUmask = process.umask(0o077);
  let sandbox;
  let captureRoot;
  try {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    captureRoot = createCaptureRoot(args.out);
  } catch (error) {
    process.umask(previousUmask);
    if (sandbox && fs.existsSync(sandbox)) safeCleanupTemp(sandbox);
    throw error;
  }
  let captureCommitted = false;
  const cleanup = () => { if (fs.existsSync(sandbox)) safeCleanupTemp(sandbox); };
  const onSignal = (signal) => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const startedAt = new Date().toISOString();
    const project = path.join(sandbox, 'init-trace-project');
    const subscriptionView = path.join(sandbox, 'init-trace.subscription-home');
    const sqliteHome = path.join(sandbox, 'init-trace.sqlite-home');
    const coreOverlay = path.join(sandbox, 'init-trace.global-agents');
    const extendedOverlay = path.join(sandbox, 'init-trace.global-extended');
    const rawTrace = path.join(sandbox, 'init-trace.strace.raw');
    const lastPath = path.join(sandbox, 'init-trace.last');
    fs.mkdirSync(project, { mode: 0o700 });
    fs.mkdirSync(subscriptionView, { mode: 0o700 });
    fs.mkdirSync(sqliteHome, { mode: 0o700 });
    fs.writeFileSync(path.join(project, 'service.json'), '{\n  "enabled": true\n}\n', { mode: 0o600 });
    fs.copyFileSync(CORE_PATH, coreOverlay);
    fs.copyFileSync(EXTENDED_PATH, extendedOverlay);
    fs.chmodSync(coreOverlay, 0o600);
    fs.chmodSync(extendedOverlay, 0o600);
    const writableFileOverlays = subscriptionMounts.writableFileTargets.map((target) => {
      const source = path.join(sandbox, `init-trace.runtime-${path.basename(target)}`);
      fs.copyFileSync(target, source);
      fs.chmodSync(source, 0o600);
      return [source, target];
    });
    const codexArgs = [
      '-a', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-rules',
      '-c', 'forced_login_method="chatgpt"',
      '--disable', 'memories', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps',
      '--json', '--skip-git-repo-check', '-C', project, '-m', args.model,
      '-o', lastPath, 'Read service.json and report the exact enabled field. Do not modify files.',
    ];
    const invocation = buildCodexInvocation(args.codex, codexArgs, {
      bwrap: options.bwrap,
      sandbox,
      subscriptionHome,
      subscriptionView,
      sqliteHome,
      subscriptionMounts,
      coreOverlay,
      extendedOverlay,
      writableFileOverlays,
      unshareNetwork: true,
    });
    const tracedArgs = [
      '-f', '-qq', '-yy', '-s', '512', '-e', 'trace=%file', '-o', rawTrace,
      '--', invocation.command, ...invocation.args,
    ];
    const env = childEnvironment(options.env || process.env, {
      CODEX_HOME: invocation.codexHome,
      CODEX_SQLITE_HOME: invocation.sqliteHome,
      AGENTSMD_TELEMETRY_TAG: 'qa',
    });
    const version = codexVersion(args.codex, { ...options, env });
    const result = runCommand(options.strace || 'strace', tracedArgs, {
      ...options,
      cwd: ROOT,
      env,
      timeout: options.timeout || 60000,
    });
    let traceComplete = false;
    let traceText = '';
    if (fs.existsSync(rawTrace)) {
      const stat = fs.lstatSync(rawTrace);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= 16 * 1024 * 1024) {
        traceText = fs.readFileSync(rawTrace, 'utf8');
        traceComplete = true;
      }
    }
    const failedFileOperations = traceComplete
      ? parseFailedFileOperations(traceText, { subscriptionView, sqliteHome }) : [];
    const report = {
      schema_version: 1,
      kind: 'agentsmd-core-ab-init-trace',
      started_at: startedAt,
      model: args.model,
      codex_version: version,
      canonical_core_sha256: fileSha256(CORE_PATH),
      extended_sha256: fileSha256(EXTENDED_PATH),
      trace_complete: traceComplete,
      network_unshared: true,
      model_service_reachable: false,
      raw_trace_retained: false,
      exit_status: Number.isInteger(result.status) ? result.status : null,
      signal: typeof result.signal === 'string' ? result.signal : null,
      failed_file_operations: failedFileOperations,
    };
    const validity = validateInitTraceReport(report);
    if (!validity.valid) throw new Error(validity.errors.join('\n'));
    const temporary = path.join(captureRoot, `.init-trace-${process.pid}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(captureRoot, 'init-trace.json'));
    verifyPrivateCaptureTree(captureRoot);
    captureCommitted = true;
    return { report, captureRoot };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
    if (!captureCommitted && fs.existsSync(captureRoot)) {
      const temporary = path.join(captureRoot, `.init-trace-${process.pid}.tmp`);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (fs.readdirSync(captureRoot).length === 0) fs.rmdirSync(captureRoot);
    }
    process.umask(previousUmask);
  }
}

function codexVersion(codex, options = {}) {
  const result = runCommand(codex, ['--version'], options);
  const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/\d+\.\d+\.\d+/u);
  if (result.status !== 0 || !match) throw new Error('could not determine Codex version');
  return match[0];
}

function runExperiment(args, options = {}) {
  const suite = loadCaseSuite(args.suite || 'representative');
  if (suite.errors.length) throw new Error(suite.errors.join('\n'));
  if (suite.name === 'auth-guard') {
    const conditionSet = new Set(args.conditions || []);
    if (conditionSet.size !== 2 || !conditionSet.has('current-core') || !conditionSet.has('candidate-core')) {
      throw new Error(`${suite.name} requires current-core,candidate-core`);
    }
    if (args.only) throw new Error(`${suite.name} does not accept --only`);
    if (!args.candidateCore) throw new Error(`${suite.name} requires a candidate core`);
  }
  const ids = args.only ? new Set(args.only) : null;
  const selected = ids ? suite.cases.filter((item) => ids.has(item.id)) : suite.cases;
  if (ids && selected.length !== ids.size) throw new Error('--only contains an unknown or duplicate case id');
  const candidateCore = args.candidateCore ? resolveCandidate(args.candidateCore) : null;
  const subscriptionHome = args.subscriptionHome ? resolveSubscriptionHome(args.subscriptionHome) : null;
  const subscriptionMounts = subscriptionHome ? resolveSubscriptionMounts(subscriptionHome) : null;
  const resumeCapture = args.resume ? resolveResumeCapture(args.resume, args.out) : null;
  const caseSha = suite.caseSha;
  const canonicalCoreSha = fileSha256(CORE_PATH);
  const extendedSha = fileSha256(EXTENDED_PATH);
  const candidateCoreSha = candidateCore ? fileSha256(candidateCore) : null;
  const caseIds = selected.map((item) => item.id);
  let priorProgress = null;
  if (resumeCapture) {
    priorProgress = readProgress(resumeCapture);
    verifyResumeInputs(resumeCapture, priorProgress, {
      model: args.model,
      seed: args.seed,
      conditions: args.conditions,
      caseIds,
      caseSha,
      canonicalCoreSha,
      extendedSha,
      candidateCoreSha,
    });
  }
  const privateCapture = isBoundedPrivateCaptureBase(args.out);
  const previousUmask = privateCapture ? process.umask(0o077) : null;
  let sandbox;
  let captureRoot;
  try {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    captureRoot = createCaptureRoot(args.out);
  } catch (error) {
    if (previousUmask !== null) process.umask(previousUmask);
    if (sandbox && fs.existsSync(sandbox)) safeCleanupTemp(sandbox);
    throw error;
  }
  const rows = priorProgress ? priorProgress.rows.filter((row) => row.status !== 'infra-error') : [];
  const cleanup = () => { if (fs.existsSync(sandbox)) safeCleanupTemp(sandbox); };
  const onSignal = (signal) => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const snapshots = snapshotExperimentInputs(captureRoot, suite.raw, candidateCore);
    if (resumeCapture) for (const row of rows) copyCellCapture(resumeCapture, captureRoot, row);
    const progress = {
      schema_version: 1,
      kind: 'agentsmd-core-ab-progress',
      started_at: new Date().toISOString(),
      model: args.model,
      seed: args.seed,
      case_library_sha256: caseSha,
      canonical_core_sha256: canonicalCoreSha,
      extended_sha256: extendedSha,
      candidate_core_sha256: candidateCoreSha,
      conditions: [...args.conditions],
      case_ids: caseIds,
      resumed_from: resumeCapture ? path.relative(args.out, resumeCapture) : null,
      complete: false,
      rows,
    };
    writeProgress(captureRoot, progress);
    verifyPrivateCaptureTree(captureRoot);
    const remaining = (selected.length * args.conditions.length) - rows.length;
    process.stdout.write(`core-ab run: ${remaining} remaining real model calls (${rows.length} checkpointed cells reused)\n`);
    const completedKeys = new Set(rows.map((row) => `${row.case_id}\0${row.condition}`));
    for (const item of selected) {
      const order = conditionOrder(args.seed, item.id, args.conditions);
      for (const [orderIndex, condition] of order.entries()) {
        const key = `${item.id}\0${condition}`;
        if (completedKeys.has(key)) continue;
        rows.push(runCell({
          ...options,
          item,
          condition,
          orderIndex,
          seed: args.seed,
          sandbox,
          captureRoot,
          codex: args.codex,
          model: args.model,
          currentCore: snapshots.currentCore,
          extendedCore: snapshots.extendedCore,
          candidateCore: snapshots.candidateCore,
          subscriptionHome,
          subscriptionMounts,
        }));
        const row = rows[rows.length - 1];
        progress.rows = rows;
        writeProgress(captureRoot, progress);
        verifyPrivateCaptureTree(captureRoot);
        process.stdout.write(`  ${row.status.padEnd(11)} ${item.id} ${condition}\n`);
        if (row.status !== 'pass') {
          const failure = row.status === 'infra-error' ? 'infrastructure error' : 'grading failure';
          throw new Error(`${failure} in ${item.id}/${condition}; stopped before scheduling another model cell; capture=${path.join(captureRoot, row.capture)}`);
        }
      }
    }
    const report = buildReport({
      capturedAt: new Date().toISOString(),
      codexVersion: codexVersion(args.codex, options),
      model: args.model,
      seed: args.seed,
      caseSha,
      canonicalCoreSha,
      extendedSha,
      candidateCoreSha,
      conditions: args.conditions,
      caseCount: selected.length,
      rows,
    });
    const validity = validateResultReport(report);
    if (!validity.valid) throw new Error(validity.errors.join('\n'));
    fs.writeFileSync(path.join(captureRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const lines = args.conditions.map((condition) => {
      const summary = report.aggregate[condition];
      return `${condition}: ${summary.passed}/${summary.cells} passed, ${summary.infra_errors} infra, tokens=${summary.token_state}, wall_ms=${summary.wall_ms}`;
    });
    fs.writeFileSync(path.join(captureRoot, 'SUMMARY.txt'), `core A/B capture ${report.captured_at}\nsuite: ${suite.name}\ncodex: ${report.runtime.codex_version} model: ${report.runtime.model}\ncases_sha256: ${report.experiment.case_library_sha256}\n${lines.join('\n')}\n`, { mode: 0o600 });
    progress.complete = true;
    writeProgress(captureRoot, progress);
    verifyPrivateCaptureTree(captureRoot);
    return { report, captureRoot };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
    if (previousUmask !== null) process.umask(previousUmask);
  }
}

function usage() {
  return [
    'Usage:',
    '  node qa/core-ab-eval.js --validate [--suite=representative|auth-guard]',
    '  node qa/core-ab-eval.js --list [--suite=representative|auth-guard]',
    '  node qa/core-ab-eval.js --run --model=<model> --seed=<seed> --conditions=current-core,no-core --subscription-home=/absolute/CODEX_HOME --out=/tmp/agentsmd-core-ab-captures.XXXXXX [--only=id,...] [--resume=/tmp/agentsmd-core-ab-captures.XXXXXX/<capture>]',
    '  node qa/core-ab-eval.js --run --model=<model> --seed=<seed> --conditions=current-core,candidate-core --candidate-core=<repo-file> --subscription-home=/absolute/CODEX_HOME --out=/tmp/agentsmd-core-ab-captures.XXXXXX',
    '  node qa/core-ab-eval.js --run --suite=auth-guard --model=<model> --seed=<seed> --conditions=current-core,candidate-core --candidate-core=<repo-file> --subscription-home=/absolute/CODEX_HOME --out=/tmp/agentsmd-core-ab-captures.XXXXXX',
    '  node qa/core-ab-eval.js --trace-init --model=<model> --subscription-home=/absolute/CODEX_HOME --out=/tmp/agentsmd-core-ab-captures.XXXXXX',
    '',
    'Linux ChatGPT subscription runs require --subscription-home=/absolute/CODEX_HOME.',
    'Before login, create an empty mode-0600 installation_id in that isolated home; subscription-backed captures require an existing current-user-owned mode-0700 /tmp/agentsmd-core-ab-captures.* parent.',
    'Custom/fake Codex runners may omit --subscription-home and select their runner with --codex=<command>.',
    'The first non-pass cell stops before another cell is scheduled; only infrastructure errors may be resumed, while grading failures are terminal.',
    'The representative suite costs 48 real model calls; auth-guard costs 4. --validate and --list cost zero.',
    '--trace-init is a separate Linux-only file-syscall diagnostic: bwrap unshares the network, raw strace stays in the task sandbox, and only sanitized EROFS rows are captured.',
  ].join('\n');
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${usage()}\n`); return 2; }
  if (args.help) { process.stdout.write(`${usage()}\n`); return 0; }
  if (args.traceInit) {
    try {
      const result = traceSubscriptionInitialization(args);
      process.stdout.write(`capture: ${result.captureRoot}\nfailed_file_operations: ${result.report.failed_file_operations.length}; model_service_reachable=false\n`);
      return result.report.trace_complete && result.report.failed_file_operations.length > 0 ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  let suite;
  try { suite = loadCaseSuite(args.suite); } catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  if (suite.errors.length) { process.stderr.write(`${suite.errors.join('\n')}\n`); return 1; }
  if (args.validate) {
    if (suite.name === 'representative') {
      process.stdout.write(`core-ab cases: 24 valid, 8 families, sha256=${suite.caseSha}, model_calls=0\n`);
    } else {
      process.stdout.write(`core auth-guard: 2 exact conformance cases, sha256=${suite.caseSha}, model_calls=0\n`);
    }
    return 0;
  }
  if (args.list) {
    process.stdout.write(`sha256\t${suite.caseSha}\n`);
    for (const item of suite.cases) process.stdout.write(`${item.id}\t${item.category}\t${item.intent}\n`);
    return 0;
  }
  try {
    const result = runExperiment(args);
    process.stdout.write(`capture: ${result.captureRoot}\n`);
    return result.report.rows.some((row) => row.status === 'infra-error') ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  aggregateRows,
  buildCodexInvocation,
  buildReport,
  changedFiles,
  childEnvironment,
  conditionOrder,
  createCaptureRoot,
  eventFacts,
  hasClarifyingQuestion,
  loadCaseSuite,
  parseArgs,
  parseEvents,
  parseFailedFileOperations,
  resolveCandidate,
  resolveResumeCapture,
  resolveSubscriptionHome,
  resolveSubscriptionMounts,
  runCell,
  runExperiment,
  safeCleanupTemp,
  sha256,
  traceSubscriptionInitialization,
  validateCaseLibrary,
  validateAuthGuardLibrary,
  validateInitTraceReport,
  validateProgress,
  validateResultReport,
};
