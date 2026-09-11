#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { ArgvError, printHelpAndExit } = require('./lib/argv');
const {
  buildPlan,
  collectChangedFiles,
  executePlan,
  parseVerifyArgs,
  renderPlan,
  validateValidationMap,
} = require('./lib/validation-router');

const USAGE = [
  'Usage: agentsmd verify [--changed | --since=<commit>] [--explain] [--full] [--json]',
  '',
  'Selects validation from the current Git project\'s qa/validation-map.json.',
  'A missing project map reports uncovered risks and executes no checks.',
  '--explain prints the deterministic plan without executing checks.',
  '--full widens to the repository full gate; it never removes release checks.',
  'External-service and AUTH-boundary operations are report-only and are never executed.',
].join('\n');

function projectMap(root) {
  const dir = path.join(root, 'qa');
  const file = path.join(dir, 'validation-map.json');
  try {
    const parent = fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('qa must be a regular directory');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 262144) {
      throw new Error('expected a 1..262144 byte regular non-symlink file');
    }
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validateValidationMap(map);
    if (errors.length) throw new Error(errors.join('; '));
    return map;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`project validation map: ${error.message}`);
  }
}

function unmappedPlan(files) {
  return {
    schema_version: 1, changed_files: files, risk_categories: ['validation-map-unavailable'],
    checks: [], matched_routes: [],
    uncovered_risks: ['Missing project validation map qa/validation-map.json; select project-native checks from the project instructions. No checks were inferred.'],
    requires_full_gate: true, touches_external_service: false, auth_boundary: false,
  };
}

function main(argv) {
  printHelpAndExit(argv, USAGE);
  let options;
  try {
    options = parseVerifyArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    console.error(`agentsmd verify: ${error.message}`);
    console.error(USAGE);
    return 2;
  }

  try {
    const root = fs.realpathSync(cp.execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).replace(/\n$/, ''));
    const map = projectMap(root);
    const changedFiles = collectChangedFiles(root, { since: options.since });
    const plan = map === null ? unmappedPlan(changedFiles)
      : buildPlan(map, changedFiles, { forceFull: options.full });
    const execution = options.explain ? null : executePlan(plan, { cwd: root });
    if (options.json) {
      console.log(JSON.stringify({
        ...plan,
        mode: options.since === null ? 'changed' : 'since',
        since: options.since,
        explain_only: options.explain,
        execution,
      }, null, 2));
    } else {
      console.log(renderPlan(plan, execution));
    }
    if (options.explain) return 0;
    if (execution.exit_code !== 0) return execution.exit_code;
    return plan.uncovered_risks.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`agentsmd verify: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
