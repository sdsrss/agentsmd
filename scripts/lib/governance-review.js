'use strict';
// governance-review.js — the ONE demote-review cadence classifier.
//
// `agentsmd rules` (operator report) and `agentsmd doctor` (health gate) both
// answer "is this rule's review current?". They used to answer it with two
// hand-mirrored copies of the predicate, and those copies diverged once: doctor
// fell back to added_at whenever last_demote_review was UNPARSEABLE while rules
// fell back only when it was ABSENT, so a corrupted stamp read fresh in doctor
// and due in rules (fixed in v4.19.1). One implementation, two consumers.
//
// Statuses:
//   fresh                — last_demote_review within cadence
//   pending-first-review — never reviewed, added_at within cadence (a rule born
//                          yesterday is not overdue)
//   review-due           — review (or, when never reviewed, added_at) older than
//                          cadence; a present-but-unparseable stamp lands here
//                          (safer direction: an unreadable stamp is not evidence
//                          that a review happened)

const DEFAULT_CADENCE_DAYS = 28;
const DAY_MS = 86400000;

function cadenceDaysOf(hr) {
  return (hr && hr.governance && hr.governance.review_cadence_days) || DEFAULT_CADENCE_DAYS;
}

function parseTs(value) {
  if (!value) return NaN;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : NaN;
}

// → { status, dueAtMs }. `dueAtMs` is when the rule next falls due; for an
// already-due rule it is `nowMs`, so a caller reporting "next due" never points
// at a date in the past.
function classifyRule(rule, cadenceMs, nowMs) {
  const reviewedTs = parseTs(rule.last_demote_review);
  if (Number.isFinite(reviewedTs)) {
    return {
      status: nowMs - reviewedTs <= cadenceMs ? 'fresh' : 'review-due',
      dueAtMs: reviewedTs + cadenceMs,
    };
  }
  const addedTs = parseTs(rule.added_at);
  if (!rule.last_demote_review && Number.isFinite(addedTs) && nowMs - addedTs <= cadenceMs) {
    return { status: 'pending-first-review', dueAtMs: addedTs + cadenceMs };
  }
  return { status: 'review-due', dueAtMs: nowMs };
}

function classifyGovernanceReview(hr, nowMs) {
  const cadenceDays = cadenceDaysOf(hr);
  const cadenceMs = cadenceDays * DAY_MS;
  const rules = (hr && hr.rules) || [];
  const rows = rules.map((r) => ({
    id: r.id,
    lastDemoteReview: r.last_demote_review || null,
    ...classifyRule(r, cadenceMs, nowMs),
  }));
  const overdue = rows.filter((r) => r.status === 'review-due').map((r) => r.id);
  const nextDueMs = rows.length ? Math.min(...rows.map((r) => r.dueAtMs)) : null;
  return {
    ok: overdue.length === 0,
    overdue,
    rows,
    total: rows.length,
    cadenceDays,
    nextDueMs,
    nextDueIso: nextDueMs === null ? null : new Date(nextDueMs).toISOString().slice(0, 10),
  };
}

module.exports = { classifyGovernanceReview, classifyRule, cadenceDaysOf, DEFAULT_CADENCE_DAYS };
