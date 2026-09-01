#!/usr/bin/env node
'use strict';

// Structured, sequential full-test runner. The manifest replaces the fragile
// package.json shell chain without changing gate order, fail-fast behavior, or
// the live CODEX_HOME snapshot/verify boundary.

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PLAN = path.join(__dirname, 'full-test-plan.json');
const LIVE_GUARD = 'scripts/tests/live-guard.js';
const SURFACE_ROOT_ENV = ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'AGENTSMD_PLUGIN_ROOT'];

function parseArgs(argv) {
  const parsed = parseStrict(argv, { values: ['from'] });
  const from = parsed.values.from || null;
  if (from !== null && !/^[a-z0-9][a-z0-9-]*$/u.test(from)) {
    throw new ArgvError('--from must be a step id');
  }
  return { from };
}

function validatePlan(plan, root = ROOT) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || Object.keys(plan).sort().join(',') !== 'schemaVersion,steps'
      || plan.schemaVersion !== 1 || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('full-test plan: invalid schema');
  }
  const ids = new Set();
  for (const step of plan.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)
        || Object.keys(step).sort().join(',') !== 'argv,id'
        || !/^[a-z0-9][a-z0-9-]*$/u.test(step.id || '')
        || !Array.isArray(step.argv) || step.argv.length !== 2
        || !step.argv.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error('full-test plan: invalid step');
    }
    if (ids.has(step.id)) throw new Error(`full-test plan: duplicate step ${step.id}`);
    ids.add(step.id);
    const [command, relative] = step.argv;
    const nodeTest = command === 'node' && /^scripts\/tests\/[a-z0-9-]+\.test\.js$/u.test(relative);
    const shellSmoke = command === 'bash' && relative === 'hooks/tests/smoke.sh';
    if (!nodeTest && !shellSmoke) throw new Error(`full-test plan: unsafe argv for ${step.id}`);
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error(`full-test plan: path escaped for ${step.id}`);
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`full-test plan: target must be a regular file for ${step.id}`);
    }
  }
  return plan;
}

function loadPlan(file = DEFAULT_PLAN) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 65536) {
    throw new Error('full-test plan must be a 1..65536 byte regular non-symlink file');
  }
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`full-test plan: ${error.message}`); }
  return validatePlan(plan);
}

function statusOf(result) {
  if (result && Number.isInteger(result.status)) return result.status;
  return 1;
}

function runPlan(options = {}) {
  const plan = validatePlan(options.plan || loadPlan());
  const from = options.from || null;
  const startIndex = from === null ? 0 : plan.steps.findIndex((step) => step.id === from);
  if (startIndex < 0) throw new Error(`unknown full-test step: ${from}`);
  const spawnSync = options.spawnSync || cp.spawnSync;
  const now = options.now || (() => Number(process.hrtime.bigint()) / 1e6);
  const write = options.write || ((line) => process.stdout.write(`${line}\n`));
  const fixtureCodex = options.fixtureCodex || path.join(ROOT, 'scripts', 'tests', 'fixtures', 'codex');
  const baseEnv = options.env || process.env;
  fs.accessSync(fixtureCodex, fs.constants.X_OK);
  const env = {
    ...baseEnv,
    PATH: `${path.dirname(fixtureCodex)}${path.delimiter}${baseEnv.PATH || ''}`,
  };
  for (const name of SURFACE_ROOT_ENV) delete env[name];
  const run = (command, argv) => spawnSync(command, argv, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  const results = [];
  let failed = null;
  let snapshotTaken = false;

  const snapshot = run('node', [LIVE_GUARD, 'snapshot']);
  if (statusOf(snapshot) !== 0) {
    failed = 'live-guard-snapshot';
    write(`[full-test] FAIL ${failed} exit=${statusOf(snapshot)}`);
  } else {
    snapshotTaken = true;
    for (let index = startIndex; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      const started = now();
      const result = run(step.argv[0], step.argv.slice(1));
      const durationMs = Math.max(0, Math.round(now() - started));
      const status = statusOf(result);
      results.push({ id: step.id, status, durationMs });
      write(`[full-test] ${status === 0 ? 'PASS' : 'FAIL'} ${step.id} ${durationMs}ms${status === 0 ? '' : ` exit=${status}`}`);
      if (status !== 0) {
        failed = step.id;
        break;
      }
    }
  }

  let verifyStatus = 0;
  if (snapshotTaken) {
    const verify = run('node', [LIVE_GUARD, 'verify']);
    verifyStatus = statusOf(verify);
    if (verifyStatus !== 0) {
      write(`[full-test] FAIL live-guard-verify exit=${verifyStatus}`);
      if (!failed) failed = 'live-guard-verify';
    } else {
      write('[full-test] PASS live-guard-verify');
    }
  }

  const failedIndex = failed && failed !== 'live-guard-snapshot' && failed !== 'live-guard-verify'
    ? plan.steps.findIndex((step) => step.id === failed)
    : -1;
  const remaining = failedIndex >= 0
    ? plan.steps.slice(failedIndex).map((step) => step.id)
    : (failed === 'live-guard-snapshot' ? plan.steps.slice(startIndex).map((step) => step.id) : []);
  if (remaining.length) write(`[full-test] remaining: ${remaining.join(', ')}`);
  if (failed) {
    const resume = failedIndex >= 0
      ? `node scripts/full-test.js --from=${failed}`
      : 'node scripts/full-test.js';
    write(`[full-test] resume: ${resume}`);
  } else {
    write(`[full-test] PASS ${results.length}/${plan.steps.length - startIndex} steps`);
  }
  const failedResult = failedIndex >= 0 ? results.find((entry) => entry.id === failed) : null;
  return {
    exitCode: failedResult ? failedResult.status : (verifyStatus || (failed ? 1 : 0)),
    failed,
    remaining,
    results,
  };
}

if (require.main === module) {
  const usage = 'Usage: node scripts/full-test.js [--from=<step-id>]';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  try {
    const args = parseArgs(argv);
    const result = runPlan({ plan: loadPlan(), from: args.from });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`full-test: ${error.message}\n${usage}`);
    process.exitCode = error instanceof ArgvError ? 2 : 1;
  }
}

module.exports = { DEFAULT_PLAN, loadPlan, parseArgs, runPlan, statusOf, validatePlan };
