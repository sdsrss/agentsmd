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
const { audit, parseDaysArg } = require('./audit');

// Distinct evaluated sessions for THIS RULE that a window must hold before a live
// 0-hit rule can be called dilution. Global session volume is not an opportunity
// denominator: a session that never attempted git commit says nothing about the
// value of the commit secret gate.
const MIN_EXPOSURE_SESSIONS = 5; // rule-specific eligible/evaluated sessions

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
    let signal;
    if (enforced && section && live) {
      if (hits > 0) signal = 'active';
      else if (noData) signal = 'no-data';
      else if (eligibleSessions === 0) signal = 'no-opportunity';
      else if (eligibleSessions < MIN_EXPOSURE_SESSIONS) signal = 'insufficient-opportunity';
      else if (evaluatedSessions < MIN_EXPOSURE_SESSIONS) signal = 'insufficient-evaluation';
      else if (policy === 'deterrence') signal = 'deterrence-ok'; // immutable §8: 0 hits = hazard never arose, not dilution
      else if (r.scope === 'extended') signal = 'hook-value-review'; // already bottom tier — nowhere to demote to
      else signal = 'demote-candidate'; // core + standard policy + enough exposure + 0 hits
    } else if (enforced && section && !live) signal = 'hook-planned'; // hook not built yet → 0 hits is expected, not dilution
    else if (r.enforcement === 'external') signal = 'external-audit';
    else signal = 'self-enforced';
    // localHits: this rule's enforcement hits WITHIN the --project filter.
    // Informational only — null when unscoped or the rule has no section.
    const scopedBucket = (scoped && section) ? scoped.bySection[section] : null;
    const localHits = (scoped && section) ? (scopedBucket ? scopedBucket.enforcement : 0) : null;
    return {
      id: r.id, scope: r.scope, enforcement: r.enforcement, section, hits,
      eligibleSessions, evaluatedSessions, eligibleObservations, evaluatedObservations,
      live, signal, policy, localHits, confidence: r.confidence,
      lastDemoteReview: r.last_demote_review,
    };
  });

  // Cross-project count — always derived from the unfiltered audit above, so
  // it reads the same whether or not --project is set.
  const realProjects = (res) => Object.keys(res.byProject).filter((k) => k !== '(none)').length;
  const projectCount = realProjects(a);
  const projectFilter = project || null;
  const matchedSlugs = scoped ? realProjects(scoped) : projectCount;

  // Stale demote-reviews: a rule whose last_demote_review is null (never reviewed)
  // or older than the window. A review-CADENCE signal (is governance being run at
  // all?), orthogonal to the hit-based demote signals above — a rule can be 'active'
  // yet overdue for a human review. Same now/days window the audit used. An
  // unparseable date is treated as stale (safer than silently passing).
  const reviewCutoffMs = now - days * 86400 * 1000;
  const staleReviews = hr.rules
    .filter((r) => {
      const d = r.last_demote_review;
      if (!d) return true;
      const ts = new Date(d).getTime();
      return !Number.isFinite(ts) || ts < reviewCutoffMs;
    })
    .map((r) => ({ id: r.id, lastDemoteReview: r.last_demote_review || null }));

  return {
    days,
    windowStartIso: a.windowStartIso,
    telemetryRows: a.inWindow,
    sessionCount: a.sessionCount,
    minExposureSessions: MIN_EXPOSURE_SESSIONS,
    lowExposure: rows.some((r) => r.signal === 'insufficient-opportunity' || r.signal === 'insufficient-evaluation'),
    projectFilter,
    projectCount,
    matchedSlugs,
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
    staleReviews,
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
    L.push(`  ${r.id.padEnd(24)} ${r.section || ''}  hits:${r.hits}  eligible:${r.eligibleSessions}  evaluated:${r.evaluatedSessions}  [${r.signal}]${flag}${local}`);
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
    L.push(`${ra.hookValueReview.length} extended-scope hook rule(s) with 0 hits — review whether the HOOK earns`);
    L.push('  its upkeep (already outside always-on core; not a core→extended demote):');
    for (const r of ra.hookValueReview) L.push(`    - ${r.id} (${r.section})`);
  }
  if (ra.staleReviews.length) {
    const never = ra.staleReviews.filter((s) => !s.lastDemoteReview);
    L.push('');
    L.push(`${ra.staleReviews.length} rule(s) overdue for a demote-review (never reviewed, or last review > ${ra.days}d):`);
    if (never.length === ra.staleReviews.length) {
      L.push('  all have last_demote_review: null — expected pre-deployment; stamp one after each governance review.');
    } else {
      for (const s of ra.staleReviews) L.push(`    - ${s.id} (${s.lastDemoteReview || 'never reviewed'})`);
    }
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
    process.exit(1);
  }
  console.log(formatReport(rulesAudit({ days: parsed.days, project: parsed.project, includeTest: parsed.includeTest })));
}
module.exports = { rulesAudit, formatReport, MIN_EXPOSURE_SESSIONS };
