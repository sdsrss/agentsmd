'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyFailOpenCauses,
  listBlockingEvents,
  loadOutcomeLedger,
  reviewOutcome,
  summarizeReviewedOutcomes,
  validateOutcomeLedger,
} = require('../lib/outcomes');
const { parseArgs } = require('../outcomes');

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const IDS = {
  trueBlock: 'evt-20260825T080000Z-101-1001-1',
  falseBlock: 'evt-20260825T080100Z-102-1002-1',
  unmeasurable: 'evt-20260825T080200Z-103-1003-1',
  self: 'evt-20260825T080300Z-104-1004-1',
  unknown: 'evt-20260825T080400Z-105-1005-1',
  qa: 'evt-20260825T080500Z-106-1006-1',
};

let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function block(ts, eventId, project, extra = {}) {
  const row = {
    ts,
    hook: 'pre-bash-safety',
    event: 'block',
    project,
    session_id: `private-${eventId || 'legacy'}`,
    spec_section: '§8-rm-rf-var',
    extra: { command: 'PRIVATE COMMAND MUST NOT SURVIVE', ...extra },
  };
  if (eventId) row.event_id = eventId;
  return row;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-outcomes.'));
try {
  const home = path.join(temp, 'home');
  const logPath = path.join(home, 'logs', 'agentsmd.jsonl');
  const outcomesPath = path.join(home, 'logs', 'agentsmd-outcomes.json');
  const rows = [
    block('2026-08-25T08:00:00.000Z', IDS.trueBlock, '-work-client-'),
    block('2026-08-25T08:01:00.000Z', IDS.falseBlock, '-work-client-'),
    block('2026-08-25T08:02:00.000Z', IDS.unmeasurable, '-work-client-'),
    block('2026-08-25T08:02:30.000Z', null, '-work-client-'),
    block('2026-08-25T08:03:00.000Z', IDS.self, '-work-agentsmd-fixture-'),
    block('2026-08-25T08:04:00.000Z', IDS.unknown, ''),
    { ...block('2026-08-25T08:05:00.000Z', IDS.qa, '-work-client-'), tag: 'qa' },
  ];
  write(logPath, jsonl(rows));

  test('blocking event list is bounded, field-scoped, and strips private telemetry', () => {
    const listed = listBlockingEvents({ logPath, outcomesPath, days: 30, now: NOW });
    assert.strictEqual(listed.length, 4);
    assert.deepStrictEqual(listed.map((item) => item.event_id), [
      IDS.trueBlock, IDS.falseBlock, IDS.unmeasurable, null,
    ]);
    assert.strictEqual(listed[3].reviewable, false);
    assert.strictEqual(JSON.stringify(listed).includes('PRIVATE'), false);
    assert.strictEqual(JSON.stringify(listed).includes('session_id'), false);
    assert.strictEqual(JSON.stringify(listed).includes('"project":'), false);
    const withSelf = listBlockingEvents({
      logPath, outcomesPath, days: 30, now: NOW, includeSelf: true,
    });
    assert.strictEqual(withSelf.length, 5);
    assert(withSelf.some((item) => item.event_id === IDS.self));
  });

  test('oversized telemetry event IDs are not surfaced or made reviewable', () => {
    const hostileLog = path.join(home, 'logs', 'oversized-event-id.jsonl');
    write(hostileLog, jsonl([
      block('2026-08-25T08:06:00.000Z',
        `evt-20260825T080600Z-107-${'1'.repeat(4096)}-1`, '-work-client-'),
    ]));
    const listed = listBlockingEvents({
      logPath: hostileLog, outcomesPath, days: 30, now: NOW,
    });
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].event_id, null);
    assert.strictEqual(listed[0].reviewable, false);
    assert(JSON.stringify(listed).length < 1024);
  });

  test('review ledger is private, schema-valid, idempotent, and replacement-explicit', () => {
    const base = { logPath, outcomesPath, days: 30, now: NOW };
    reviewOutcome({
      ...base,
      eventId: IDS.trueBlock,
      outcome: 'true-block',
      reason: 'policy-violation-confirmed',
      reviewedAt: '2026-08-25T09:00:00.000Z',
    });
    reviewOutcome({
      ...base,
      eventId: IDS.falseBlock,
      outcome: 'false-block',
      reason: 'benign-action-confirmed',
      reviewedAt: '2026-08-25T09:01:00.000Z',
    });
    reviewOutcome({
      ...base,
      eventId: IDS.unmeasurable,
      outcome: 'unmeasurable',
      reason: 'insufficient-context',
      reviewedAt: '2026-08-25T09:02:00.000Z',
    });
    const unchanged = reviewOutcome({
      ...base,
      eventId: IDS.trueBlock,
      outcome: 'true-block',
      reason: 'policy-violation-confirmed',
      reviewedAt: '2026-08-25T09:00:00.000Z',
    });
    assert.strictEqual(unchanged.changed, false);
    assert.throws(() => reviewOutcome({
      ...base,
      eventId: IDS.trueBlock,
      outcome: 'false-block',
      reason: 'benign-action-confirmed',
      reviewedAt: '2026-08-25T10:00:00.000Z',
    }), /--replace/u);
    const replaced = reviewOutcome({
      ...base,
      eventId: IDS.trueBlock,
      outcome: 'false-block',
      reason: 'benign-action-confirmed',
      reviewedAt: '2026-08-25T10:00:00.000Z',
      replace: true,
    });
    assert.strictEqual(replaced.changed, true);
    assert.strictEqual(replaced.revision, 2);

    const loaded = loadOutcomeLedger(outcomesPath);
    assert.strictEqual(loaded.state, 'measured');
    assert.strictEqual(validateOutcomeLedger(loaded.value).valid, true);
    assert.strictEqual(loaded.value.outcomes.length, 4);
    assert.strictEqual(fs.statSync(outcomesPath).mode & 0o777, 0o600);
    const listed = listBlockingEvents(base);
    assert.deepStrictEqual(
      listed.find((item) => item.event_id === IDS.trueBlock).review,
      {
        state: 'false-block',
        reason: 'benign-action-confirmed',
        reviewed_at: '2026-08-25T10:00:00.000Z',
        revision: 2,
      },
    );
    assert.strictEqual(
      listed.find((item) => item.event_id === null).review.state,
      'unmeasurable',
    );
  });

  test('summary uses only reviewed field true/false outcomes as the denominator', () => {
    const summary = summarizeReviewedOutcomes({ logPath, outcomesPath, days: 30, now: NOW });
    assert.deepStrictEqual(summary, {
      state: 'partial',
      blocking_events: 6,
      eligible_field_events: 4,
      reviewed_outcomes: 3,
      true_blocks: 0,
      confirmed_false_blocks: 2,
      unreviewed_events: 0,
      unmeasurable_events: 2,
      excluded_non_field_events: 2,
      rate_denominator: 2,
      false_block_rate: 1,
      outcomes_source: 'measured',
      window_days: 30,
      limit: '2 field event(s) are unmeasurable and excluded from the reviewed denominator.',
    });
  });

  test('missing labels, no opportunity, and invalid sidecars never render measured zero', () => {
    const missingPath = path.join(home, 'logs', 'missing-outcomes.json');
    const missing = summarizeReviewedOutcomes({ logPath, outcomesPath: missingPath, days: 30, now: NOW });
    assert.strictEqual(missing.state, 'unmeasured');
    assert.strictEqual(missing.rate_denominator, 0);
    assert.strictEqual(missing.false_block_rate, null);
    assert.strictEqual(missing.unreviewed_events, 3);
    assert.strictEqual(missing.unmeasurable_events, 1);

    const noOpportunityLog = path.join(temp, 'no-opportunity.jsonl');
    write(noOpportunityLog, jsonl([{ ts: '2026-08-25T08:00:00.000Z', event: 'observe', project: '-work-client-' }]));
    const none = summarizeReviewedOutcomes({
      logPath: noOpportunityLog, outcomesPath: missingPath, days: 30, now: NOW,
    });
    assert.strictEqual(none.state, 'no-opportunity');
    assert.strictEqual(none.false_block_rate, null);

    const malformed = path.join(home, 'logs', 'malformed-outcomes.json');
    write(malformed, '{not json\n');
    const invalid = summarizeReviewedOutcomes({ logPath, outcomesPath: malformed, days: 30, now: NOW });
    assert.strictEqual(invalid.state, 'invalid');
    assert.strictEqual(invalid.false_block_rate, null);

    const target = path.join(home, 'logs', 'target-outcomes.json');
    write(target, JSON.stringify({ schema_version: 1, kind: 'agentsmd-reviewed-outcomes', outcomes: [] }));
    const linked = path.join(home, 'logs', 'linked-outcomes.json');
    fs.symlinkSync(target, linked);
    assert.strictEqual(loadOutcomeLedger(linked).state, 'invalid');

    const oversized = path.join(home, 'logs', 'oversized-outcomes.json');
    write(oversized, 'x'.repeat(1048577));
    assert.strictEqual(loadOutcomeLedger(oversized).state, 'invalid');

    const identityDrift = path.join(home, 'logs', 'identity-drift.json');
    const driftedLedger = structuredClone(loadOutcomeLedger(outcomesPath).value);
    driftedLedger.outcomes[0].hook = 'different-hook';
    write(identityDrift, JSON.stringify(driftedLedger));
    assert.strictEqual(loadOutcomeLedger(identityDrift).state, 'invalid');

    const futureReview = path.join(home, 'logs', 'future-review.json');
    const futureLedger = structuredClone(loadOutcomeLedger(outcomesPath).value);
    futureLedger.outcomes.at(-1).reviewed_at = '2026-08-25T13:00:00.000Z';
    write(futureReview, JSON.stringify(futureLedger));
    const future = summarizeReviewedOutcomes({
      logPath, outcomesPath: futureReview, days: 30, now: NOW,
    });
    assert.strictEqual(future.state, 'invalid');
    assert.strictEqual(future.false_block_rate, null);
  });

  test('review refuses unknown IDs and invalid outcome/reason combinations', () => {
    const base = { logPath, outcomesPath, days: 30, now: NOW };
    assert.throws(() => reviewOutcome({
      ...base,
      eventId: 'evt-20260825T090000Z-999-1999-1',
      outcome: 'true-block',
      reason: 'policy-violation-confirmed',
      reviewedAt: '2026-08-25T09:00:00.000Z',
    }), /not a reviewable blocking event/u);
    assert.throws(() => reviewOutcome({
      ...base,
      eventId: IDS.falseBlock,
      outcome: 'false-block',
      reason: 'policy-violation-confirmed',
      reviewedAt: '2026-08-25T09:00:00.000Z',
      replace: true,
    }), /outcome\/reason/u);
  });

  test('fail-open causes are complete and mutually exclusive', () => {
    assert.deepStrictEqual(classifyFailOpenCauses({
      'memory-read': { total: 2, byReason: { 'no-transcript': 1, timeout: 1 } },
      'secrets-scan': { total: 3, byReason: { 'jq-missing': 1, 'invalid-json': 1, 'git-diff-failed': 1 } },
    }), {
      dependency_missing: 2,
      timeout: 1,
      parse_error: 1,
      other: 1,
    });
  });

  test('outcomes argv is strict and review replacement is explicit', () => {
    assert.deepStrictEqual(parseArgs(['list', '--days=30', '--json']), {
      command: 'list', days: 30, json: true, includeSelf: false,
    });
    const review = parseArgs([
      'review', `--event=${IDS.falseBlock}`, '--outcome=false-block',
      '--reason=benign-action-confirmed', '--reviewed-at=2026-08-25T09:00:00Z', '--replace',
    ]);
    assert.strictEqual(review.command, 'review');
    assert.strictEqual(review.replace, true);
    assert.match(parseArgs(['list', '--days=0']).error, /invalid --days/u);
    assert.match(parseArgs(['list', '--unknown']).error, /Unknown (?:argument|flag)/u);
    assert.match(parseArgs(['review', `--event=${IDS.falseBlock}`]).error, /outcome/u);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: false });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
