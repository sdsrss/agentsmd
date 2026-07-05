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

// Distinct cross-project sessions a window must hold before a live 0-hit rule can
// be called dilution. Below this, the window is too thin to distinguish "rule is
// dead weight" from "rule's trigger never arose" — so 0-hit rules read
// 'insufficient-exposure', not 'demote-candidate'. A deliberately conservative
// floor (the operator reviews anyway); tune with field data per OPERATOR §O2.
const MIN_EXPOSURE_SESSIONS = 5;

function rulesAudit({ days = 30, now = Date.now(), hardRulesPath = path.join(P.repoRoot(), 'spec', 'hard-rules.json'), logPath = P.logPath(), project = null } = {}) {
  const hr = JSON.parse(fs.readFileSync(hardRulesPath, 'utf8'));
  const liveSections = new Set(hr.live_sections || []);
  // Demote/active/self-enforced signals MUST be computed over ALL telemetry,
  // never narrowed by --project: a rule with plenty of cross-project hits but
  // zero in one particular project is not evidence of dilution — it just means
  // that project never happened to exercise it. --project is purely an
  // informational lens layered on top (see projectFilter/matchedSlugs below
  // and formatReport) — it must never change what "active" means.
  const a = audit({ days, now, logPath });
  // Filtered audit for the informational scoped lens ONLY: feeds matchedSlugs
  // (header) and the per-rule local-hits annotation. Never feeds rule signals.
  const scoped = project ? audit({ days, now, logPath, project }) : null;
  // With zero telemetry in the window, a 0-hit live rule is NOT dilution — there is
  // simply no data to judge it. Distinguish 'no-data' from 'demote-candidate' so the
  // governance surface never recommends demotion off an empty window (e.g. a fresh
  // or never-run install).
  const noData = a.inWindow === 0;
  // Exposure gate: telemetry exists but too FEW DISTINCT SESSIONS to judge a 0-hit
  // rule (its trigger may just never have arisen). Always from the UNSCOPED audit
  // `a` — never `scoped`, or the exposure verdict would leak --project scoping, the
  // exact class of bug the cross-project invariant here guards against.
  const lowExposure = !noData && a.sessionCount < MIN_EXPOSURE_SESSIONS;

  const rows = hr.rules.map((r) => {
    const enforced = r.enforcement === 'hook' || r.enforcement === 'both';
    const section = r.rule_hits_section || null;
    const bucket = section ? a.bySection[section] : null;
    const hits = bucket ? bucket.enforcement : 0;
    const live = section ? liveSections.has(section) : false;
    const policy = r.demote_policy || 'standard';
    let signal;
    if (enforced && section && live) {
      if (hits > 0) signal = 'active';
      else if (noData) signal = 'no-data';
      else if (lowExposure) signal = 'insufficient-exposure';
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
    return { id: r.id, scope: r.scope, enforcement: r.enforcement, section, hits, live, signal, policy, localHits, confidence: r.confidence, lastDemoteReview: r.last_demote_review };
  });

  // Cross-project count — always derived from the unfiltered audit above, so
  // it reads the same whether or not --project is set.
  const realProjects = (res) => Object.keys(res.byProject).filter((k) => k !== '(none)').length;
  const projectCount = realProjects(a);
  const projectFilter = project || null;
  const matchedSlugs = scoped ? realProjects(scoped) : projectCount;

  return {
    days,
    windowStartIso: a.windowStartIso,
    telemetryRows: a.inWindow,
    sessionCount: a.sessionCount,
    minExposureSessions: MIN_EXPOSURE_SESSIONS,
    lowExposure,
    projectFilter,
    projectCount,
    matchedSlugs,
    rules: rows,
    demoteCandidates: rows.filter((r) => r.signal === 'demote-candidate'),
    hookValueReview: rows.filter((r) => r.signal === 'hook-value-review'),
    insufficientExposure: rows.filter((r) => r.signal === 'insufficient-exposure'),
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
  L.push('');
  if (ra.telemetryRows === 0) {
    L.push('No telemetry in window yet. Demote/promote signals need field data —');
    L.push('install agentsmd live and let hooks fire before trusting these counts.');
    L.push('');
  } else if (ra.lowExposure) {
    L.push(`Only ${ra.sessionCount} distinct session(s) in window (< ${ra.minExposureSessions} needed to judge a 0-hit rule).`);
    L.push('0-hit live rules read "insufficient-exposure", not demote — a rule may simply');
    L.push('not have met its trigger yet. Let more sessions accrue before demoting.');
    L.push('');
  }
  L.push(ra.projectFilter ? 'hook-enforced rules (hits = cross-project; local = within filter):' : 'hook-enforced rules:');
  for (const r of ra.rules.filter((x) => x.enforcement === 'hook' || x.enforcement === 'both')) {
    const flag = r.signal === 'demote-candidate' ? '  ⚠ DEMOTE?'
      : (r.signal === 'hook-value-review' ? '  ⚠ HOOK-VALUE?' : '');
    const local = (ra.projectFilter && r.localHits !== null) ? `  local:${r.localHits}` : '';
    L.push(`  ${r.id.padEnd(24)} ${r.section || ''}  hits:${r.hits}  [${r.signal}]${flag}${local}`);
  }
  L.push('');
  L.push(`self-enforced (not mechanically measured): ${ra.selfEnforced.length} rules`);
  if (ra.demoteCandidates.length && ra.telemetryRows > 0) {
    L.push('');
    L.push(`⚠ ${ra.demoteCandidates.length} core hook-enforced rule(s) with 0 hits + sufficient exposure —`);
    L.push('  demote candidates (move core→extended; immutable §8 + extended-scope rules are excluded):');
    for (const r of ra.demoteCandidates) L.push(`    - ${r.id} (${r.section})`);
  }
  if (ra.hookValueReview.length && ra.telemetryRows > 0) {
    L.push('');
    L.push(`${ra.hookValueReview.length} extended-scope hook rule(s) with 0 hits — review whether the HOOK earns`);
    L.push('  its upkeep (already outside always-on core; not a core→extended demote):');
    for (const r of ra.hookValueReview) L.push(`    - ${r.id} (${r.section})`);
  }
  return L.join('\n');
}

if (require.main === module) {
  const parsed = parseDaysArg(process.argv.slice(2), 'agentsmd-rules');
  if (parsed.help) {
    console.log('Usage: agentsmd-rules [--days=N] [--project=SUBSTR]');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd rules: ${parsed.error}`);
    console.error('Usage: agentsmd-rules [--days=N] [--project=SUBSTR]');
    process.exit(1);
  }
  console.log(formatReport(rulesAudit({ days: parsed.days, project: parsed.project })));
}
module.exports = { rulesAudit, formatReport, MIN_EXPOSURE_SESSIONS };
