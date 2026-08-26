#!/usr/bin/env node
'use strict';

const { parsePositiveInt, parseStrict } = require('./lib/argv');
const { listBlockingEvents, reviewOutcome } = require('./lib/outcomes');

const USAGE = [
  'Usage: agentsmd outcomes list [--days=N] [--json] [--include-self]',
  '       agentsmd outcomes review --event=ID --outcome=OUTCOME --reason=REASON',
  '         [--reviewed-at=ISO] [--days=N] [--replace]',
  '',
  'OUTCOME: true-block | false-block | unmeasurable',
  'Reviews are private local evidence; raw telemetry is never rewritten.',
].join('\n');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['list', 'review'].includes(command)) return { error: 'expected list or review subcommand' };
  let parsed;
  try {
    parsed = parseStrict(rest, {
      bools: command === 'list' ? ['json', 'include-self'] : ['replace'],
      values: command === 'list' ? ['days'] : ['event', 'outcome', 'reason', 'reviewed-at', 'days'],
    });
  } catch (error) {
    return { error: error.message };
  }
  let days = 30;
  if (parsed.values.days !== undefined) {
    days = parsePositiveInt(parsed.values.days);
    if (days === null || days > 3650) {
      return { error: `invalid --days value: ${parsed.values.days} (expected 1-3650)` };
    }
  }
  if (command === 'list') {
    return { command, days, json: parsed.bools.has('json'), includeSelf: parsed.bools.has('include-self') };
  }
  for (const name of ['event', 'outcome', 'reason']) {
    if (!parsed.values[name]) return { error: `--${name}=VALUE is required` };
  }
  const reviewedAt = parsed.values['reviewed-at'];
  if (reviewedAt !== undefined && !Number.isFinite(Date.parse(reviewedAt))) {
    return { error: 'invalid --reviewed-at timestamp' };
  }
  return {
    command,
    days,
    eventId: parsed.values.event,
    outcome: parsed.values.outcome,
    reason: parsed.values.reason,
    reviewedAt: reviewedAt ? new Date(Date.parse(reviewedAt)).toISOString() : null,
    replace: parsed.bools.has('replace'),
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { // argv-lint:allow
    console.log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.error) {
    console.error(`outcomes: ${options.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    if (options.command === 'list') {
      const events = listBlockingEvents({ days: options.days, includeSelf: options.includeSelf });
      if (options.json) console.log(JSON.stringify({ days: options.days, events }, null, 2));
      else if (events.length === 0) console.log('No blocking events in the selected scope/window.');
      else for (const event of events) {
        console.log(`${event.event_id || 'unmeasurable'}  ${event.ts}  ${event.project_class}  ${event.review.state}  ${event.hook}  ${event.spec_section}`);
      }
      return 0;
    }
    const result = reviewOutcome(options);
    console.log(`agentsmd outcome ${result.changed ? 'recorded' : 'unchanged'}: ${options.eventId} revision ${result.revision}`);
    return 0;
  } catch (error) {
    console.error(`outcomes: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { USAGE, main, parseArgs };
