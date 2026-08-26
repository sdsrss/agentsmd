'use strict';

const fs = require('fs');
const path = require('path');
const { BLOCKING_EVENTS, TEST_TAGS, classifyProject, readRows } = require('../audit');
const F = require('./fs-atomic');
const P = require('./paths');
const { validateSchema } = require('./task-contract');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'reviewed-outcomes.schema.json'), 'utf8'));
const MAX_OUTCOME_BYTES = 1024 * 1024;
const MAX_DAYS = 3650;
const EVENT_ID_RE = /^evt-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+-[0-9]+$/;
const REASON_BY_OUTCOME = {
  'true-block': new Set(['policy-violation-confirmed']),
  'false-block': new Set(['benign-action-confirmed']),
  unmeasurable: new Set(['insufficient-context', 'telemetry-incomplete']),
};

function isEventId(value) {
  const text = String(value || '');
  return text.length <= 96 && EVENT_ID_RE.test(text);
}

function emptyLedger() {
  return { schema_version: 1, kind: 'agentsmd-reviewed-outcomes', outcomes: [] };
}

function validateOutcomeLedger(value) {
  const errors = validateSchema(value, SCHEMA, SCHEMA);
  const revisions = new Map();
  const identities = new Map();
  if (value && Array.isArray(value.outcomes)) {
    for (const [index, record] of value.outcomes.entries()) {
      if (!record || typeof record !== 'object') continue;
      const allowed = REASON_BY_OUTCOME[record.outcome];
      if (allowed && !allowed.has(record.reason)) {
        errors.push(`$.outcomes[${index}]: invalid outcome/reason combination`);
      }
      const eventMs = Date.parse(record.event_ts);
      const reviewMs = Date.parse(record.reviewed_at);
      if (!Number.isFinite(eventMs) || !Number.isFinite(reviewMs) || reviewMs < eventMs) {
        errors.push(`$.outcomes[${index}].reviewed_at: must not precede event_ts`);
      }
      if (typeof record.event_id === 'string' && Number.isInteger(record.revision)) {
        const identity = JSON.stringify([
          record.event_ts, record.hook, record.event,
          record.spec_section, record.project_class,
        ]);
        const previousIdentity = identities.get(record.event_id);
        if (previousIdentity !== undefined && previousIdentity !== identity) {
          errors.push(`$.outcomes[${index}]: event identity differs from an earlier revision`);
        } else {
          identities.set(record.event_id, identity);
        }
        const expected = (revisions.get(record.event_id) || 0) + 1;
        if (record.revision !== expected) {
          errors.push(`$.outcomes[${index}].revision: expected ${expected} for this event`);
        }
        revisions.set(record.event_id, record.revision);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function loadOutcomeLedger(file = P.outcomesPath()) {
  const target = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: 'missing', path: target, value: emptyLedger(), snapshot: { present: false } };
    }
    return { state: 'unavailable', path: target, value: null, snapshot: null, error: error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTCOME_BYTES) {
    return { state: 'invalid', path: target, value: null, snapshot: null, error: 'expected a bounded regular non-symlink file' };
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) {
    return { state: 'invalid', path: target, value: null, snapshot: null, error: error.message };
  }
  const validation = validateOutcomeLedger(value);
  if (!validation.valid) {
    return { state: 'invalid', path: target, value: null, snapshot: null, error: validation.errors.join('\n') };
  }
  return { state: 'measured', path: target, value, snapshot: F.snapshotFile(target) };
}

function inWindowRows({ logPath = P.logPath(), days = 30, now = Date.now() } = {}) {
  const boundedDays = Number.isSafeInteger(days) && days > 0 && days <= MAX_DAYS ? days : 30;
  const cutoff = now - boundedDays * 86400000;
  return readRows(logPath).filter((row) => {
    if (!row || (row.tag != null && TEST_TAGS.has(String(row.tag)))) return false;
    const ts = Date.parse(row.ts);
    return Number.isFinite(ts) && ts >= cutoff && ts <= now && BLOCKING_EVENTS.has(row.event);
  });
}

function summarizedRows(options = {}) {
  const rows = inWindowRows(options);
  const idCounts = new Map();
  for (const row of rows) {
    if (isEventId(row.event_id)) {
      idCounts.set(row.event_id, (idCounts.get(row.event_id) || 0) + 1);
    }
  }
  return rows.map((row) => {
    const projectClass = classifyProject(row.project);
    const eventId = isEventId(row.event_id) ? row.event_id : null;
    return {
      event_id: eventId,
      ts: new Date(Date.parse(row.ts)).toISOString(),
      hook: String(row.hook || 'unknown').slice(0, 256),
      event: row.event,
      spec_section: String(row.spec_section || '(none)').slice(0, 256),
      project_class: projectClass,
      reviewable: Boolean(eventId && idCounts.get(eventId) === 1 && projectClass !== 'unknown'),
    };
  });
}

function listBlockingEvents(options = {}) {
  const includeSelf = options.includeSelf === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const loaded = loadOutcomeLedger(options.outcomesPath || P.outcomesPath());
  const latest = loaded.value ? latestRecords(loaded.value) : new Map();
  return summarizedRows({ ...options, now }).filter((event) => (
    event.project_class === 'external' || (includeSelf && event.project_class === 'self')
  )).map((event) => {
    let review = { state: 'unreviewed', reason: null, reviewed_at: null, revision: null };
    if (!event.reviewable) {
      review.state = 'unmeasurable';
    } else if (!['missing', 'measured'].includes(loaded.state)) {
      review.state = 'invalid';
    } else {
      const record = latest.get(event.event_id);
      if (record) {
        const reviewMs = Date.parse(record.reviewed_at);
        if (!identityMatches(record, event) || !Number.isFinite(reviewMs) || reviewMs > now) {
          review.state = 'invalid';
        } else {
          review = {
            state: record.outcome,
            reason: record.reason,
            reviewed_at: record.reviewed_at,
            revision: record.revision,
          };
        }
      }
    }
    return { ...event, review };
  });
}

function realDirectory(dir) {
  const stat = fs.lstatSync(dir);
  return stat.isDirectory() && !stat.isSymbolicLink()
    && fs.realpathSync(dir) === P.platformCanonicalPath(dir);
}

function ensureOutcomeDirectory(file) {
  const dir = path.dirname(path.resolve(file));
  try {
    if (!realDirectory(dir)) throw new Error(`${dir}: outcome directory must be a real non-symlink directory`);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    const parent = path.dirname(dir);
    if (!realDirectory(parent)) throw new Error(`${parent}: outcome parent must be a real non-symlink directory`);
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  }
  return dir;
}

function identityMatches(record, event) {
  return record.event_ts === event.ts
    && record.hook === event.hook
    && record.event === event.event
    && record.spec_section === event.spec_section
    && record.project_class === event.project_class;
}

function latestRecords(ledger) {
  const latest = new Map();
  for (const record of ledger.outcomes) latest.set(record.event_id, record);
  return latest;
}

function reviewOutcome(options = {}) {
  const eventId = String(options.eventId || '');
  if (!isEventId(eventId)) throw new Error('invalid --event ID');
  const outcome = String(options.outcome || '');
  const reason = String(options.reason || '');
  if (!REASON_BY_OUTCOME[outcome] || !REASON_BY_OUTCOME[outcome].has(reason)) {
    throw new Error('invalid outcome/reason combination');
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const reviewedMs = Date.parse(options.reviewedAt || new Date(now).toISOString());
  if (!Number.isFinite(reviewedMs) || reviewedMs > now) throw new Error('invalid --reviewed-at timestamp');
  const event = listBlockingEvents({ ...options, includeSelf: true })
    .find((entry) => entry.event_id === eventId && entry.reviewable);
  if (!event) throw new Error(`${eventId}: not a reviewable blocking event in the selected window`);
  if (reviewedMs < Date.parse(event.ts)) throw new Error('--reviewed-at must not precede the event');

  const outcomesPath = path.resolve(options.outcomesPath || P.outcomesPath());
  const loaded = loadOutcomeLedger(outcomesPath);
  if (!['missing', 'measured'].includes(loaded.state)) {
    throw new Error(`${outcomesPath}: cannot update ${loaded.state} outcome ledger`);
  }
  const ledger = loaded.value;
  const previous = latestRecords(ledger).get(eventId) || null;
  const reviewedAt = new Date(reviewedMs).toISOString();
  if (previous && previous.outcome === outcome && previous.reason === reason
    && previous.reviewed_at === reviewedAt && identityMatches(previous, event)) {
    return { changed: false, revision: previous.revision, path: outcomesPath };
  }
  if (previous && options.replace !== true) {
    throw new Error(`${eventId}: an outcome already exists; pass --replace to append a reviewed revision`);
  }
  const record = {
    event_id: eventId,
    event_ts: event.ts,
    hook: event.hook,
    event: event.event,
    spec_section: event.spec_section,
    project_class: event.project_class,
    outcome,
    reason,
    reviewed_at: reviewedAt,
    revision: previous ? previous.revision + 1 : 1,
  };
  const next = { ...ledger, outcomes: [...ledger.outcomes, record] };
  const validation = validateOutcomeLedger(next);
  if (!validation.valid) throw new Error(`invalid reviewed outcome ledger:\n${validation.errors.join('\n')}`);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_OUTCOME_BYTES) throw new Error('reviewed outcome ledger exceeds its size cap');
  ensureOutcomeDirectory(outcomesPath);
  F.writeFileAtomic(outcomesPath, text, {
    mode: 0o600,
    preserveMode: false,
    expectedSnapshot: loaded.snapshot,
  });
  return { changed: true, revision: record.revision, path: outcomesPath };
}

function summaryLimit({ state, denominator, unreviewed, unmeasurable }) {
  if (state === 'no-opportunity') return 'No field blocking event occurred in the selected window; no rate is inferred.';
  if (state === 'invalid') return 'Reviewed outcome input is invalid or does not match its telemetry event; no rate is reported.';
  if (denominator === 0) return 'No reviewed measurable field outcome exists; unreviewed and unmeasurable events are excluded from the denominator.';
  if (unreviewed && unmeasurable) return `${unreviewed} field event(s) are unreviewed and ${unmeasurable} are unmeasurable; both groups are excluded from the denominator.`;
  if (unreviewed) return `${unreviewed} field event(s) are unreviewed and excluded from the reviewed denominator.`;
  if (unmeasurable) return `${unmeasurable} field event(s) are unmeasurable and excluded from the reviewed denominator.`;
  return `Rate denominator contains ${denominator} reviewed field outcome(s); non-field events are excluded.`;
}

function summarizeReviewedOutcomes(options = {}) {
  const days = Number.isSafeInteger(options.days) && options.days > 0 && options.days <= MAX_DAYS
    ? options.days : 30;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const events = summarizedRows({ ...options, days, now });
  const field = events.filter((event) => event.project_class === 'external');
  const loaded = loadOutcomeLedger(options.outcomesPath || P.outcomesPath());
  let invalid = !['missing', 'measured'].includes(loaded.state);
  const latest = loaded.value ? latestRecords(loaded.value) : new Map();
  let reviewed = 0;
  let trueBlocks = 0;
  let falseBlocks = 0;
  let unreviewed = 0;
  let unmeasurable = 0;
  for (const event of field) {
    if (!event.reviewable) {
      unmeasurable += 1;
      continue;
    }
    const record = latest.get(event.event_id);
    if (!record) {
      unreviewed += 1;
      continue;
    }
    const reviewMs = Date.parse(record.reviewed_at);
    if (!identityMatches(record, event) || !Number.isFinite(reviewMs) || reviewMs > now) {
      invalid = true;
      unmeasurable += 1;
      continue;
    }
    reviewed += 1;
    if (record.outcome === 'true-block') trueBlocks += 1;
    else if (record.outcome === 'false-block') falseBlocks += 1;
    else unmeasurable += 1;
  }
  const denominator = trueBlocks + falseBlocks;
  let state;
  if (invalid) state = 'invalid';
  else if (field.length === 0) state = 'no-opportunity';
  else if (denominator === 0) state = 'unmeasured';
  else if (unreviewed > 0 || unmeasurable > 0) state = 'partial';
  else state = 'measured';
  return {
    state,
    blocking_events: events.length,
    eligible_field_events: field.length,
    reviewed_outcomes: reviewed,
    true_blocks: trueBlocks,
    confirmed_false_blocks: falseBlocks,
    unreviewed_events: unreviewed,
    unmeasurable_events: unmeasurable,
    excluded_non_field_events: events.length - field.length,
    rate_denominator: denominator,
    false_block_rate: state === 'invalid' || denominator === 0 ? null : falseBlocks / denominator,
    outcomes_source: loaded.state,
    window_days: days,
    limit: summaryLimit({ state, denominator, unreviewed, unmeasurable }),
  };
}

function classifyFailOpenCauses(byFailOpen = {}) {
  const result = { dependency_missing: 0, timeout: 0, parse_error: 0, other: 0 };
  for (const bucket of Object.values(byFailOpen || {})) {
    for (const [rawReason, count] of Object.entries((bucket && bucket.byReason) || {})) {
      const reason = String(rawReason).toLowerCase();
      const amount = Number.isSafeInteger(count) && count > 0 ? count : 0;
      if (/timeout|timed-out|deadline/u.test(reason)) result.timeout += amount;
      else if (/parse|malformed|invalid-json|invalid-payload|json-invalid/u.test(reason)) result.parse_error += amount;
      else if (/missing|not-found|unavailable|no-transcript|no-input|prerequisite/u.test(reason)) result.dependency_missing += amount;
      else result.other += amount;
    }
  }
  return result;
}

module.exports = {
  EVENT_ID_RE,
  MAX_OUTCOME_BYTES,
  classifyFailOpenCauses,
  listBlockingEvents,
  loadOutcomeLedger,
  reviewOutcome,
  summarizeReviewedOutcomes,
  validateOutcomeLedger,
};
