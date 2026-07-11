'use strict';
// audit.js — aggregate agentsmd's rule-hit telemetry (~/.codex/logs/agentsmd.jsonl)
// over a time window. The read side of the closed-loop data plane
// (ARCHITECTURE.md §4): spec rule → hook → jsonl → THIS → promote/demote signal.
// bySection is what scripts/rules.js cross-references against spec/hard-rules.json.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');

// Enforcement events = a rule actually fired (or was overridden). Lifecycle
// events (session banner, fail-open bookkeeping) are NOT rule activity and must
// not inflate the "is this rule earning its keep" signal.
const ENFORCEMENT_EVENTS = new Set(['block', 'deny', 'advisory', 'bypass']);
const MAX_DAYS = 100000000;
// Provenance tags whose rows are excluded from the ledger by default: a
// verification / smoke run against a real CODEX_HOME (AGENTSMD_TELEMETRY_TAG=test)
// must not skew promote/demote signals. --include-test opts them back in.
const TEST_TAGS = new Set(['test']);
// Blocking-deny family: events where a hook actually stopped the action (vs
// advising, or being overridden via bypass). denyByProjectClass counts only
// these — the real "did enforcement bite, and for whom" question.
const BLOCKING_EVENTS = new Set(['block', 'deny']);

// classifyProject — self-dogfood vs external, over the project slug rule-hits.sh
// writes (cwd with every non-[a-zA-Z0-9-] char → '-'). `self` = the slug's
// trailing segment is exactly `agentsmd` (this source repo); the (^|-) anchor
// keeps a downstream repo like '…-myagentsmd' classified external. Empty /
// (none) / null → unknown. Mirrors claudemd rule-hits-parse.js:classifyProject.
function classifyProject(project) {
  if (!project || project === '(none)') return 'unknown';
  return /(^|-)agentsmd$/.test(String(project)) ? 'self' : 'external';
}

// Read the live log AND its rotated segments. rule-hits.sh rotates
// agentsmd.jsonl → .1 → .2 at the size cap (default 5 MB); reading only the live
// file means a window whose hits landed in a rotated segment counts 0 — turning a
// BUSY period into a false "0-hit → demote" signal, the exact inverse of the
// truth, and worst precisely when telemetry is richest. Merge chronologically
// (oldest rotation → live) so windowing sees every row regardless of rotation.
function readRows(logPath) {
  const dir = path.dirname(logPath);
  const base = path.basename(logPath);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const segs = names
    .map((n) => {
      if (n === base) return { n, seq: -1 };                        // live file = newest
      const s = n.startsWith(base + '.') ? n.slice(base.length + 1) : '';
      return /^\d+$/.test(s) ? { n, seq: Number(s) } : null;        // .1/.2/… numeric rotations only
    })
    .filter(Boolean)
    .sort((a, b) => b.seq - a.seq);                                 // higher seq = older; live (-1) read last
  const rows = [];
  for (const { n } of segs) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return rows;
}

function audit({ days = 30, now = Date.now(), logPath = P.logPath(), project = null, includeTest = false } = {}) {
  // Last-line guard: clamp days into a safe range so no caller can drive
  // `now - days*86400000` out of the valid Date range (→ RangeError at
  // new Date(cutoff).toISOString() below). The CLI parsers reject bad values up
  // front, but a programmatic caller with a looser parser (analyze --adoption)
  // must not be able to crash the shared aggregator — the bound belongs here.
  if (!Number.isSafeInteger(days) || days <= 0 || days > MAX_DAYS) days = 30;
  const rows = readRows(logPath);
  const cutoff = now - days * 86400000;
  const projNeedle = project ? String(project).toLowerCase() : null;
  const bySection = {}, byHook = {}, byEvent = {}, byProject = {};
  const byFailOpen = {}, denyByProjectClass = {};
  const sessions = new Set(); // distinct session_id in window — the exposure proxy
  let total = 0, enforcement = 0, unparseable = 0, excludedTest = 0;

  for (const r of rows) {
    // Drop tagged verification/sandbox rows from the ledger by default.
    if (!includeTest && r && r.tag != null && TEST_TAGS.has(String(r.tag))) { excludedTest++; continue; }
    const ts = Date.parse(r && r.ts);
    // Unparseable ts can't be windowed → count it separately, keep it OUT of the
    // aggregation (a single garbage-ts row must not sit permanently in-window,
    // inflating bySection counts and flipping the noData / exposure guards).
    if (Number.isNaN(ts)) { unparseable++; continue; }
    if (ts < cutoff || ts > now) continue;
    if (projNeedle !== null && !String((r && r.project) || '').toLowerCase().includes(projNeedle)) continue;
    total++;
    const sid = r && r.session_id;
    if (sid) sessions.add(String(sid));
    const sec = (r && r.spec_section) || '(none)';
    const ev = (r && r.event) || 'unknown';
    const hook = (r && r.hook) || 'unknown';
    const isEnf = ENFORCEMENT_EVENTS.has(ev);
    // Explicit opportunity observations take precedence over compatibility
    // inference. A legacy enforcement row with no observation for its
    // (section,session) still implies eligible+evaluated; a current bypass with
    // an explicit evaluated:false observation remains unevaluated.
    const hasExplicitOpportunity = r && (typeof r.eligible === 'boolean' || typeof r.evaluated === 'boolean');
    const isExplicitEvaluated = Boolean(r && r.evaluated === true);
    const isExplicitEligible = isExplicitEvaluated || Boolean(r && r.eligible === true);
    const isEvaluated = isEnf || isExplicitEvaluated;
    const isEligible = isEnf || isExplicitEligible;
    if (isEnf) enforcement++;

    bySection[sec] = bySection[sec] || {
      total: 0,
      enforcement: 0,
      eligibleObservations: 0,
      evaluatedObservations: 0,
      eligibleSessions: 0,
      evaluatedSessions: 0,
      events: {},
      _explicitOpportunitySessions: new Set(),
      _explicitEligibleSessions: new Set(),
      _explicitEvaluatedSessions: new Set(),
      _enforcementSessions: new Set(),
    };
    bySection[sec].total++;
    if (isEnf) bySection[sec].enforcement++;
    if (isEligible) {
      bySection[sec].eligibleObservations++;
    }
    if (isEvaluated) {
      bySection[sec].evaluatedObservations++;
    }
    if (sid) {
      const session = String(sid);
      if (hasExplicitOpportunity) bySection[sec]._explicitOpportunitySessions.add(session);
      if (isExplicitEligible) bySection[sec]._explicitEligibleSessions.add(session);
      if (isExplicitEvaluated) bySection[sec]._explicitEvaluatedSessions.add(session);
      if (isEnf) bySection[sec]._enforcementSessions.add(session);
    }
    bySection[sec].events[ev] = (bySection[sec].events[ev] || 0) + 1;

    byHook[hook] = (byHook[hook] || 0) + 1;
    byEvent[ev] = (byEvent[ev] || 0) + 1;

    const proj = (r && r.project) || '(none)';
    byProject[proj] = byProject[proj] || { total: 0, enforcement: 0, sections: {} };
    byProject[proj].total++;
    if (isEnf) {
      byProject[proj].enforcement++;
      if (sec !== '(none)') byProject[proj].sections[sec] = (byProject[proj].sections[sec] || 0) + 1;
    }

    // fail-open accountability: a silently-skipped hook (jq/prereq missing)
    // leaves a row but no enforcement — group by (hook, reason) so the loss is
    // visible, not indistinguishable from "the rule wasn't relevant".
    if (ev === 'fail-open') {
      byFailOpen[hook] = byFailOpen[hook] || { total: 0, byReason: {} };
      byFailOpen[hook].total++;
      const reason = (r.extra && r.extra.reason) || '(unspecified)';
      byFailOpen[hook].byReason[reason] = (byFailOpen[hook].byReason[reason] || 0) + 1;
    }
    // blocking denies split by project origin so agentsmd's own dogfood repo
    // can't be mistaken for downstream enforcement value.
    if (BLOCKING_EVENTS.has(ev)) {
      const cls = classifyProject(r.project);
      denyByProjectClass[hook] = denyByProjectClass[hook] || { total: 0, self: 0, external: 0, unknown: 0 };
      denyByProjectClass[hook].total++;
      denyByProjectClass[hook][cls]++;
    }
  }

  for (const bucket of Object.values(bySection)) {
    const eligible = new Set([...bucket._explicitEligibleSessions, ...bucket._enforcementSessions]);
    const evaluated = new Set(bucket._explicitEvaluatedSessions);
    for (const session of bucket._enforcementSessions) {
      if (!bucket._explicitOpportunitySessions.has(session)) evaluated.add(session);
    }
    bucket.eligibleSessions = eligible.size;
    bucket.evaluatedSessions = evaluated.size;
    delete bucket._explicitOpportunitySessions;
    delete bucket._explicitEligibleSessions;
    delete bucket._explicitEvaluatedSessions;
    delete bucket._enforcementSessions;
  }

  return {
    days,
    windowStartIso: new Date(cutoff).toISOString(),
    totalRows: rows.length,
    inWindow: total,
    enforcementEvents: enforcement,
    sessionCount: sessions.size,
    unparseableRows: unparseable,
    excludedTestRows: excludedTest,
    bySection, byHook, byEvent, byProject,
    byFailOpen, denyByProjectClass,
  };
}

function formatReport(a) {
  const lines = [];
  lines.push(`agentsmd audit — last ${a.days}d (since ${a.windowStartIso})`);
  lines.push(`rows: ${a.inWindow} in window / ${a.totalRows} total · enforcement events: ${a.enforcementEvents} · sessions: ${a.sessionCount}`);
  const skips = [];
  if (a.excludedTestRows) skips.push(`${a.excludedTestRows} test-tagged (excluded; --include-test to keep)`);
  if (a.unparseableRows) skips.push(`${a.unparseableRows} unparseable-ts (excluded from window)`);
  if (skips.length) lines.push(`skipped: ${skips.join(' · ')}`);
  lines.push('');
  lines.push('by spec_section (enforcement / evaluated sessions / eligible sessions / total rows):');
  const secs = Object.keys(a.bySection).sort((x, y) => a.bySection[y].enforcement - a.bySection[x].enforcement);
  if (!secs.length) lines.push('  (no telemetry yet — hooks have not fired in this window)');
  for (const s of secs) {
    const b = a.bySection[s];
    const evs = Object.entries(b.events).map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push(`  ${s.padEnd(26)} ${String(b.enforcement).padStart(4)} / ${String(b.evaluatedSessions).padStart(4)} / ${String(b.eligibleSessions).padStart(4)} / ${String(b.total).padStart(4)}   ${evs}`);
  }
  lines.push('');
  lines.push('by project (enforcement / total):');
  const projs = Object.keys(a.byProject).sort((x, y) => a.byProject[y].enforcement - a.byProject[x].enforcement);
  if (!projs.length) lines.push('  (no telemetry yet — hooks have not fired in this window)');
  for (const p of projs) {
    const b = a.byProject[p];
    const label = p.length > 26 ? '…' + p.slice(-25) : p;
    const projSecs = Object.entries(b.sections).sort((x, y) => y[1] - x[1]);
    const top = projSecs.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    const more = projSecs.length > 3 ? ` +${projSecs.length - 3} more` : '';
    lines.push(`  ${label.padEnd(28)} ${String(b.enforcement).padStart(4)} / ${String(b.total).padStart(4)}   ${top}${more}`.trimEnd());
  }
  lines.push('');
  lines.push('fail-open events (silent enforcement loss) by hook:');
  const foHooks = Object.keys(a.byFailOpen).sort((x, y) => a.byFailOpen[y].total - a.byFailOpen[x].total);
  if (!foHooks.length) {
    lines.push('  none in window — no silently-skipped enforcement');
  } else {
    for (const h of foHooks) {
      const b = a.byFailOpen[h];
      const reasons = Object.entries(b.byReason).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ');
      lines.push(`  ${h.padEnd(26)} ${String(b.total).padStart(4)}   ${reasons}`);
    }
  }
  lines.push('');
  lines.push('blocking denies by project class (external = downstream value / self = dogfood):');
  const dcHooks = Object.keys(a.denyByProjectClass).sort((x, y) => a.denyByProjectClass[y].total - a.denyByProjectClass[x].total);
  if (!dcHooks.length) {
    lines.push('  (no blocking denies in window)');
  } else {
    for (const h of dcHooks) {
      const b = a.denyByProjectClass[h];
      const parts = [`ext:${b.external}`, `self:${b.self}`];
      if (b.unknown) parts.push(`unk:${b.unknown}`);
      lines.push(`  ${h.padEnd(26)} ${String(b.total).padStart(4)}   ${parts.join(' ')}`);
    }
  }
  return lines.join('\n');
}

function parseDaysArg(argv, commandName = 'agentsmd-audit') {
  let days = 30;
  let project = null;
  let includeTest = false;
  let sawDays = false;
  let sawProject = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true, days };
    if (arg === '--include-test') { includeTest = true; continue; }
    const p = arg.match(/^--project=(.*)$/);
    if (p) {
      if (sawProject) return { error: 'duplicate option: --project', days };
      sawProject = true;
      if (p[1] === '') return { error: 'invalid --project value: (empty)', days };
      project = p[1];
      continue;
    }
    const m = arg.match(/^--days=(.+)$/);
    if (m) {
      if (sawDays) return { error: 'duplicate option: --days', days };
      sawDays = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) {
        return { error: `invalid --days value: ${m[1]}`, days };
      }
      days = Number(m[1]);
      if (!Number.isSafeInteger(days) || days > MAX_DAYS) {
        return { error: `invalid --days value: ${m[1]}`, days: 30 };
      }
      continue;
    }
    return { error: `unknown option: ${arg}`, days };
  }
  return { days, project, includeTest, usage: `Usage: ${commandName} [--days=N] [--project=SUBSTR] [--include-test]` };
}

if (require.main === module) {
  const parsed = parseDaysArg(process.argv.slice(2));
  if (parsed.help) {
    console.log('Usage: agentsmd-audit [--days=N] [--project=SUBSTR] [--include-test]');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd audit: ${parsed.error}`);
    console.error('Usage: agentsmd-audit [--days=N] [--project=SUBSTR] [--include-test]');
    process.exit(2);
  }
  console.log(formatReport(audit({ days: parsed.days, project: parsed.project, includeTest: parsed.includeTest })));
}
module.exports = { audit, formatReport, parseDaysArg, readRows, classifyProject, ENFORCEMENT_EVENTS, BLOCKING_EVENTS, MAX_DAYS, TEST_TAGS };
