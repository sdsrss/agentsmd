'use strict';
// rules.js — the promote/demote governance surface (claudemd's /claudemd-rules
// equivalent). Cross-references spec/hard-rules.json against audit bySection
// telemetry to answer: which always-on rules earn their core residence, and
// which are pure attention dilution (hook-enforced yet never firing)?
// This is the "let data decide the always-on layer" mechanism from
// docs/agentsmd.txt — the reason the whole machine exists.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const GOV = require('./lib/governance-review');
const { audit, parseDaysArg } = require('./audit');

// Distinct evaluated sessions for THIS RULE that a window must hold before a live
// 0-hit rule can be called dilution. Global session volume is not an opportunity
// denominator: a session that never attempted git commit says nothing about the
// value of the commit secret gate.
const MIN_EXPOSURE_SESSIONS = 5; // rule-specific eligible/evaluated sessions

// Bypass governance (R1, 2026-07-25 audit). Hit counts alone cannot see an
// escape hatch being used more often than the rule bites: through two full
// governance reviews §7-memory-read sat at 29 bypasses vs 27 blocks and
// §E3-ship-baseline at 6 vs 4, and neither surfaced anywhere. A high rate has
// two opposite readings — the rule over-fires (friction: narrow the trigger) or
// it is being habitually evaded (review the overrides) — so this emits a REVIEW
// prompt, never a verdict. Distinct-session spread is what discriminates them:
// many sessions bypassing once = systemic; one session bypassing repeatedly = a
// single stuck loop.
const BYPASS_REVIEW_RATE = 0.30;
// Blocking+bypass decisions a rule needs before its rate means anything. 1-of-1
// is 100% and says nothing; the floor keeps a single override off the report.
const MIN_BYPASS_DECISIONS = 5;

function rulesAudit({ days = 30, now = Date.now(), hardRulesPath = path.join(P.repoRoot(), 'spec', 'hard-rules.json'), logPath = P.logPath(), project = null, includeTest = false } = {}) {
  const hr = JSON.parse(fs.readFileSync(hardRulesPath, 'utf8'));
  const liveSections = new Set(hr.live_sections || []);
  // Demote/active/self-enforced signals MUST be computed over ALL telemetry,
  // never narrowed by --project: a rule with plenty of cross-project hits but
  // zero in one particular project is not evidence of dilution — it just means
  // that project never happened to exercise it. --project is purely an
  // informational lens layered on top (see projectFilter/matchedSlugs below
  // and formatReport) — it must never change what "active" means.
  const a = audit({ days, now, logPath, includeTest });
  // Filtered audit for the informational scoped lens ONLY: feeds matchedSlugs
  // (header) and the per-rule local-hits annotation. Never feeds rule signals.
  const scoped = project ? audit({ days, now, logPath, project, includeTest }) : null;
  // With zero telemetry in the window, a 0-hit live rule is NOT dilution — there is
  // simply no data to judge it. Distinguish 'no-data' from 'demote-candidate' so the
  // governance surface never recommends demotion off an empty window (e.g. a fresh
  // or never-run install).
  const noData = a.inWindow === 0;
  const rows = hr.rules.map((r) => {
    const enforced = r.enforcement === 'hook' || r.enforcement === 'both';
    const section = r.rule_hits_section || null;
    const bucket = section ? a.bySection[section] : null;
    const hits = bucket ? bucket.enforcement : 0;
    const eligibleSessions = bucket ? bucket.eligibleSessions : 0;
    const evaluatedSessions = bucket ? bucket.evaluatedSessions : 0;
    const eligibleObservations = bucket ? bucket.eligibleObservations : 0;
    const evaluatedObservations = bucket ? bucket.evaluatedObservations : 0;
    const live = section ? liveSections.has(section) : false;
    const policy = r.demote_policy || 'standard';
    const governanceParent = r.governance_parent || null;
    let signal;
    if (governanceParent) signal = 'inherited';
    else if (enforced && section && live) {
      if (hits > 0) signal = 'active';
      else if (noData) signal = 'no-data';
      else if (eligibleSessions === 0) signal = 'no-opportunity';
      else if (eligibleSessions < MIN_EXPOSURE_SESSIONS) signal = 'insufficient-opportunity';
      else if (evaluatedSessions < MIN_EXPOSURE_SESSIONS) signal = 'insufficient-evaluation';
      else if (policy === 'deterrence') signal = 'deterrence-ok'; // immutable §8: 0 hits = hazard never arose, not dilution
      else if (policy === 'proxy') signal = 'hook-value-review'; // proxy metric: 0 hits judges the HOOK's worth, never the rule's core residence
      else if (r.scope === 'extended') signal = 'hook-value-review'; // already bottom tier — nowhere to demote to
      else signal = 'demote-candidate'; // core + standard policy + enough exposure + 0 hits
    } else if (enforced && section && !live) signal = 'hook-planned'; // hook not built yet → 0 hits is expected, not dilution
    else if (r.enforcement === 'external') signal = 'external-audit';
    else signal = 'self-enforced';
    // Bypass rate: overrides / (blocks + overrides). Advisories are excluded —
    // an advisory cannot be bypassed, so counting it would dilute the ratio of
    // the decisions that actually had an escape hatch. Computed off the section
    // bucket, so a rule sharing a bucket by design (§10-V) reads the merged
    // signal it is already governed by.
    const evs = (bucket && bucket.events) || {};
    const blocks = (evs.block || 0) + (evs.deny || 0);
    const bypasses = evs.bypass || 0;
    const bypassDecisions = blocks + bypasses;
    const bypassable = r.bypassable === true;
    const bypassRate = bypassDecisions > 0 ? bypasses / bypassDecisions : null;
    const bypassByClass = (bucket && bucket.bypassByClass) || { self: 0, external: 0, unknown: 0 };
    let bypassSignal;
    if (!bypassable) bypassSignal = 'n/a';                                   // no escape hatch to govern
    else if (bypassDecisions === 0) bypassSignal = 'no-bypass-data';         // rule never fired in window
    else if (bypassDecisions < MIN_BYPASS_DECISIONS) bypassSignal = 'insufficient-bypass-data';
    else if (bypassRate >= BYPASS_REVIEW_RATE) {
      // Origin decides which review this is. Overrides confined to agentsmd's own
      // repo and QA sandboxes are dogfood — often the very session that built the
      // hook — and carry no field evidence, so they must not read as downstream
      // evasion (the R6-04 mistake, repeated one layer up).
      bypassSignal = bypassByClass.external > 0 ? 'bypass-review' : 'bypass-review-self-only';
    } else bypassSignal = 'bypass-ok';
    // localHits: this rule's enforcement hits WITHIN the --project filter.
    // Informational only — null when unscoped or the rule has no section.
    const scopedBucket = (scoped && section) ? scoped.bySection[section] : null;
    const localHits = (scoped && section) ? (scopedBucket ? scopedBucket.enforcement : 0) : null;
    return {
      id: r.id, scope: r.scope, enforcement: r.enforcement, section, hits,
      eligibleSessions, evaluatedSessions, eligibleObservations, evaluatedObservations,
      live, signal, policy, governanceParent, localHits, confidence: r.confidence,
      lastDemoteReview: r.last_demote_review,
      bypassable, bypassToken: r.bypass_token || null,
      blocks, bypasses, bypassDecisions, bypassRate, bypassSignal, bypassByClass,
      bypassSessions: bucket ? (bucket.bypassSessions || 0) : 0,
      blockingSessions: bucket ? (bucket.blockingSessions || 0) : 0,
    };
  });

  // Cross-project count — always derived from the unfiltered audit above, so
  // it reads the same whether or not --project is set.
  const realProjects = (res) => Object.keys(res.byProject).filter((k) => k !== '(none)').length;
  const projectCount = realProjects(a);
  const projectFilter = project || null;
  const matchedSlugs = scoped ? realProjects(scoped) : projectCount;

  // Review cadence: a governance-CADENCE signal (is review being run at all?),
  // orthogonal to the hit-based demote signals above — a rule can be 'active' yet
  // due for a human review. The cadence comes from the manifest's governance
  // block, NOT the --days audit window (tying staleness to the query window made
  // `--days=7` mark everything overdue). Statuses:
  //   fresh                — last_demote_review within cadence
  //   pending-first-review — never reviewed, but added_at is within cadence
  //                          (a rule born yesterday is not overdue)
  //   review-due           — review (or, when never reviewed, added_at) older
  //                          than cadence; unparseable dates land here (safer)
  // Shared classifier — doctor consumes the same function, so the two surfaces
  // cannot disagree on due/not-due (they did once; see lib/governance-review.js).
  const governance = GOV.classifyGovernanceReview(hr, now);
  const cadenceDays = governance.cadenceDays;
  const reviewRows = governance.rows.map((r) => ({
    id: r.id,
    reviewStatus: r.status,
    dueAtMs: r.dueAtMs,
    lastDemoteReview: r.lastDemoteReview,
  }));
  const reviewStatusById = new Map(reviewRows.map((r) => [r.id, r.reviewStatus]));
  for (const row of rows) row.reviewStatus = reviewStatusById.get(row.id);
  const reviewDue = reviewRows.filter((r) => r.reviewStatus === 'review-due');
  const nextReviewDueMs = reviewRows.length ? Math.min(...reviewRows.map((r) => r.dueAtMs)) : null;

  return {
    reviewCadenceDays: cadenceDays,
    reviewSummary: {
      fresh: reviewRows.filter((r) => r.reviewStatus === 'fresh').length,
      pendingFirstReview: reviewRows.filter((r) => r.reviewStatus === 'pending-first-review').length,
      reviewDue: reviewDue.length,
    },
    reviewDue,
    nextReviewDueIso: nextReviewDueMs === null ? null : new Date(nextReviewDueMs).toISOString().slice(0, 10),
    days,
    windowStartIso: a.windowStartIso,
    telemetryRows: a.inWindow,
    sessionCount: a.sessionCount,
    minExposureSessions: MIN_EXPOSURE_SESSIONS,
    lowExposure: rows.some((r) => r.signal === 'insufficient-opportunity' || r.signal === 'insufficient-evaluation'),
    projectFilter,
    projectCount,
    matchedSlugs,
    bypassReviewRate: BYPASS_REVIEW_RATE,
    minBypassDecisions: MIN_BYPASS_DECISIONS,
    bypassRows: rows.filter((r) => r.bypassable),
    bypassReview: rows.filter((r) => r.bypassSignal === 'bypass-review'),
    bypassReviewSelfOnly: rows.filter((r) => r.bypassSignal === 'bypass-review-self-only'),
    rules: rows,
    demoteCandidates: rows.filter((r) => r.signal === 'demote-candidate'),
    hookValueReview: rows.filter((r) => r.signal === 'hook-value-review'),
    noOpportunity: rows.filter((r) => r.signal === 'no-opportunity'),
    insufficientExposure: rows.filter((r) => r.signal === 'insufficient-opportunity' || r.signal === 'insufficient-evaluation'),
    insufficientOpportunity: rows.filter((r) => r.signal === 'insufficient-opportunity'),
    insufficientEvaluation: rows.filter((r) => r.signal === 'insufficient-evaluation'),
    deterrenceOk: rows.filter((r) => r.signal === 'deterrence-ok'),
    active: rows.filter((r) => r.signal === 'active'),
    selfEnforced: rows.filter((r) => r.signal === 'self-enforced'),
  };
}

function formatReport(ra) {
  const L = [];
  L.push(`agentsmd rules governance — last ${ra.days}d · ${ra.telemetryRows} telemetry rows · ${ra.sessionCount} session(s)`);
  if (ra.projectFilter) {
    L.push(`scoped to project filter '${ra.projectFilter}' (${ra.matchedSlugs} slug(s)) — informational lens; demote signals remain cross-project.`);
  } else {
    L.push(`telemetry spans ${ra.projectCount} project(s).`);
  }
  L.push('Governance denominators are rule-specific eligible/evaluated sessions; global sessions are informational only.');
  L.push('');
  if (ra.telemetryRows === 0) {
    L.push('No telemetry in window yet. Demote/promote signals need field data —');
    L.push('install agentsmd live and let hooks fire before trusting these counts.');
    L.push('');
  }
  L.push(ra.projectFilter ? 'hook-enforced rules (hits = cross-project; local = within filter):' : 'hook-enforced rules:');
  for (const r of ra.rules.filter((x) => x.enforcement === 'hook' || x.enforcement === 'both')) {
    const flag = r.signal === 'demote-candidate' ? '  ⚠ DEMOTE?'
      : (r.signal === 'hook-value-review' ? '  ⚠ HOOK-VALUE?' : '');
    const local = (ra.projectFilter && r.localHits !== null) ? `  local:${r.localHits}` : '';
    const inherited = r.governanceParent ? ` → ${r.governanceParent}` : '';
    L.push(`  ${r.id.padEnd(24)} ${r.section || ''}  hits:${r.hits}  eligible:${r.eligibleSessions}  evaluated:${r.evaluatedSessions}  [${r.signal}${inherited}]${flag}${local}`);
  }
  L.push('');
  // Bypass governance — cross-project like every other governance signal
  // (--project stays an informational lens and never narrows it).
  L.push('bypass governance (escape-hatch usage; cross-project, never narrowed by --project):');
  if (!ra.bypassRows.length) {
    L.push('  (no bypassable rules in the manifest)');
  } else {
    for (const r of ra.bypassRows) {
      const rate = r.bypassRate === null ? '   —' : `${String(Math.round(r.bypassRate * 100)).padStart(3)}%`;
      const flag = r.bypassSignal === 'bypass-review' ? '  ⚠ REVIEW' : (r.bypassSignal === 'bypass-review-self-only' ? '  · self-only' : '');
      const spread = r.bypasses ? `  sessions:${r.bypassSessions}  ext:${r.bypassByClass.external}/self:${r.bypassByClass.self}` : '';
      L.push(`  ${r.id.padEnd(24)} ${(r.bypassToken || '').padEnd(22)} block:${String(r.blocks).padStart(3)}  bypass:${String(r.bypasses).padStart(3)}  rate:${rate}  [${r.bypassSignal}]${flag}${spread}`);
    }
  }
  if ((ra.bypassReview.length || ra.bypassReviewSelfOnly.length) && ra.telemetryRows > 0) {
    const n = ra.bypassReview.length + ra.bypassReviewSelfOnly.length;
    L.push('');
    L.push(`⚠ ${n} bypassable rule(s) overridden in ≥${Math.round(ra.bypassReviewRate * 100)}% of their blocking decisions`);
    L.push(`  (min ${ra.minBypassDecisions} decisions). Two opposite readings — decide which, with evidence:`);
    L.push('    a) the rule OVER-FIRES → narrow its trigger (the block is friction, not protection)');
    L.push('    b) the override is HABITUAL → the gate is being routed around; review the cases');
    L.push('  bypass-sessions discriminates: spread across many = (a) systemic; concentrated = (b) a stuck loop.');
    L.push('  Record the verdict in spec/governance-log.json like any keep/demote adjudication.');
    for (const r of ra.bypassReview) {
      L.push(`    - ${r.id} (${r.section}) ${r.bypasses}/${r.bypassDecisions} overridden across ${r.bypassSessions} session(s), ${r.bypassByClass.external} from external project(s)`);
    }
    for (const r of ra.bypassReviewSelfOnly) {
      L.push(`    - ${r.id} (${r.section}) ${r.bypasses}/${r.bypassDecisions} overridden — ALL from agentsmd's own repo/sandboxes,`);
      L.push('      so this is dogfood, not field evidence: often the session that built the hook.');
      L.push('      Adjudicate as no-field-data and re-review once external sessions exist.');
    }
  }
  L.push('');
  L.push(`self-enforced (not mechanically measured): ${ra.selfEnforced.length} rules`);
  if (ra.noOpportunity.length) {
    L.push(`${ra.noOpportunity.length} live hook rule(s) had no recorded opportunity; unrelated sessions are not demotion evidence.`);
  }
  if (ra.insufficientExposure.length) {
    L.push(`${ra.insufficientExposure.length} live hook rule(s) had fewer than ${ra.minExposureSessions} evaluated opportunities; no demotion signal emitted.`);
  }
  if (ra.demoteCandidates.length && ra.telemetryRows > 0) {
    L.push('');
    L.push(`⚠ ${ra.demoteCandidates.length} core hook-enforced rule(s) with 0 hits + sufficient evaluated opportunities —`);
    L.push('  demote candidates (move core→extended; immutable §8 + extended-scope rules are excluded):');
    for (const r of ra.demoteCandidates) L.push(`    - ${r.id} (${r.section})`);
  }
  if (ra.hookValueReview.length && ra.telemetryRows > 0) {
    L.push('');
    L.push(`${ra.hookValueReview.length} hook rule(s) with 0 hits outside the demote path (extended scope or proxy`);
    L.push('  metric) — review whether the HOOK earns its upkeep (not a core→extended demote):');
    for (const r of ra.hookValueReview) L.push(`    - ${r.id} (${r.section}, ${r.policy === 'proxy' ? 'proxy metric' : 'extended scope'})`);
  }
  L.push('');
  L.push(`review cadence ${ra.reviewCadenceDays}d: fresh:${ra.reviewSummary.fresh} · pending-first-review:${ra.reviewSummary.pendingFirstReview} · review-due:${ra.reviewSummary.reviewDue} · next review due ${ra.nextReviewDueIso}`);
  if (ra.reviewDue.length) {
    L.push(`${ra.reviewDue.length} rule(s) due for a demote-review (stamp last_demote_review + append spec/governance-log.json after reviewing):`);
    for (const s of ra.reviewDue) L.push(`    - ${s.id} (${s.lastDemoteReview || 'never reviewed'})`);
  }
  return L.join('\n');
}

if (require.main === module) {
  const parsed = parseDaysArg(process.argv.slice(2), 'agentsmd-rules');
  if (parsed.help) {
    console.log('Usage: agentsmd-rules [--days=N] [--project=SUBSTR] [--include-test]');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd rules: ${parsed.error}`);
    console.error('Usage: agentsmd-rules [--days=N] [--project=SUBSTR] [--include-test]');
    process.exit(2);
  }
  console.log(formatReport(rulesAudit({ days: parsed.days, project: parsed.project, includeTest: parsed.includeTest })));
}
module.exports = { rulesAudit, formatReport, MIN_EXPOSURE_SESSIONS, BYPASS_REVIEW_RATE, MIN_BYPASS_DECISIONS };
