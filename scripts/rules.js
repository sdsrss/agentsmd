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
const { audit } = require('./audit');

function rulesAudit({ days = 30, now = Date.now(), hardRulesPath = path.join(P.repoRoot(), 'spec', 'hard-rules.json'), logPath = P.logPath() } = {}) {
  const hr = JSON.parse(fs.readFileSync(hardRulesPath, 'utf8'));
  const liveSections = new Set(hr.live_sections || []);
  const a = audit({ days, now, logPath });

  const rows = hr.rules.map((r) => {
    const enforced = r.enforcement === 'hook' || r.enforcement === 'both';
    const section = r.rule_hits_section || null;
    const bucket = section ? a.bySection[section] : null;
    const hits = bucket ? bucket.enforcement : 0;
    const live = section ? liveSections.has(section) : false;
    let signal;
    if (enforced && section && live) signal = hits > 0 ? 'active' : 'demote-candidate';
    else if (enforced && section && !live) signal = 'hook-planned'; // hook not built yet → 0 hits is expected, not dilution
    else if (r.enforcement === 'external') signal = 'external-audit';
    else signal = 'self-enforced';
    return { id: r.id, scope: r.scope, enforcement: r.enforcement, section, hits, live, signal, confidence: r.confidence, lastDemoteReview: r.last_demote_review };
  });

  return {
    days,
    windowStartIso: a.windowStartIso,
    telemetryRows: a.inWindow,
    rules: rows,
    demoteCandidates: rows.filter((r) => r.signal === 'demote-candidate'),
    active: rows.filter((r) => r.signal === 'active'),
    selfEnforced: rows.filter((r) => r.signal === 'self-enforced'),
  };
}

function formatReport(ra) {
  const L = [];
  L.push(`codexmd rules governance — last ${ra.days}d · ${ra.telemetryRows} telemetry rows`);
  L.push('');
  if (ra.telemetryRows === 0) {
    L.push('No telemetry in window yet. Demote/promote signals need field data —');
    L.push('install codexmd live and let hooks fire before trusting these counts.');
    L.push('');
  }
  L.push('hook-enforced rules:');
  for (const r of ra.rules.filter((x) => x.enforcement === 'hook' || x.enforcement === 'both')) {
    const flag = r.signal === 'demote-candidate' ? '  ⚠ DEMOTE?' : '';
    L.push(`  ${r.id.padEnd(24)} ${r.section || ''}  hits:${r.hits}  [${r.signal}]${flag}`);
  }
  L.push('');
  L.push(`self-enforced (not mechanically measured): ${ra.selfEnforced.length} rules`);
  if (ra.demoteCandidates.length && ra.telemetryRows > 0) {
    L.push('');
    L.push(`⚠ ${ra.demoteCandidates.length} hook-enforced rule(s) had 0 enforcement hits this window —`);
    L.push('  candidates for demotion (a rule nobody triggers is always-on dilution):');
    for (const r of ra.demoteCandidates) L.push(`    - ${r.id} (${r.section})`);
  }
  return L.join('\n');
}

if (require.main === module) {
  const daysArg = process.argv.find((a) => /^--days=\d+$/.test(a));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
  console.log(formatReport(rulesAudit({ days })));
}
module.exports = { rulesAudit, formatReport };
