#!/usr/bin/env node
'use strict';

const {
  buildScorecard,
  compareScorecards,
  formatScorecard,
  loadComparison,
  parseArgs,
} = require('./lib/scorecard');

const USAGE = [
  'Usage: agentsmd scorecard [--days=N] [--json] [--compare=CAPTURE]',
  '  [--conformance-candidate=FILE] [--conformance-binding=FILE]',
  '  [--outcomes=FILE]',
  '',
  'Aggregate health, compatibility, quality, performance, memory, prompt-budget,',
  'automation, and measurement-limit evidence. This command is read-only and',
  'never promotes/demotes rules or mutates worktrees.',
].join('\n');

function main(argv) {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`agentsmd scorecard: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    let card = buildScorecard({
      days: parsed.days,
      candidateEvidenceFile: parsed.candidateEvidenceFile,
      releaseBindingFile: parsed.releaseBindingFile,
      outcomesPath: parsed.outcomesPath,
    });
    if (parsed.compare) {
      card = compareScorecards(card, loadComparison(parsed.compare), parsed.compare);
    }
    console.log(parsed.json ? JSON.stringify(card, null, 2) : formatScorecard(card));
    return 0;
  } catch (error) {
    console.error(`agentsmd scorecard: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, USAGE };
