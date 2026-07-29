#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ArgvError, printHelpAndExit } = require('./lib/argv');
const {
  buildPlan,
  collectChangedFiles,
  executePlan,
  parseVerifyArgs,
  renderPlan,
} = require('./lib/validation-router');

const ROOT = path.resolve(__dirname, '..');
const USAGE = [
  'Usage: agentsmd verify [--changed | --since=<commit>] [--explain] [--full] [--json]',
  '',
  'Selects validation from qa/validation-map.json. The default selector is --changed.',
  '--explain prints the deterministic plan without executing checks.',
  '--full widens to the repository full gate; it never removes release checks.',
  'External-service and AUTH-boundary operations are report-only and are never executed.',
].join('\n');

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
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'validation-map.json'), 'utf8'));
    const changedFiles = collectChangedFiles(process.cwd(), { since: options.since });
    const plan = buildPlan(map, changedFiles, { forceFull: options.full });
    const execution = options.explain ? null : executePlan(plan, { cwd: process.cwd() });
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
