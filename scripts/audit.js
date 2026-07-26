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
// 'test' = fixture/sandbox suites; 'qa' = real-model QA harness sessions
// (conformance-eval / codex-blackbox). Both are agentsmd-generated, so neither
// may pose as field data in governance denominators (R6-04).
const TEST_TAGS = new Set(['test', 'qa']);
// Blocking-deny family: events where a hook actually stopped the action (vs
// advising, or being overridden via bypass). denyByProjectClass counts only
// these — the real "did enforcement bite, and for whom" question.
const BLOCKING_EVENTS = new Set(['block', 'deny']);
// Escape-hatch family: a bypassable rule that fired but was overridden by its
// inline token. Counted per section AND per distinct session so rules.js can
// tell systemic friction (many sessions bypassing once) from one stubborn
// session retrying the same override — the two demand opposite remedies.
const BYPASS_EVENTS = new Set(['bypass']);

// classifyProject — self-dogfood vs external, over the project slug rule-hits.sh
// writes (cwd with every non-[a-zA-Z0-9-] char → '-'). `self` = the slug contains
// an exact `agentsmd` path segment: the source repo itself AND every
// agentsmd-generated working dir (QA sandboxes like `…-agentsmd-conformance-…`,
// `…-agentsmd-blackbox-…`, session scratchpads under the repo path) — R6-04 found
// ~50 such slugs posing as "external" and inflating pilot/enforcement stats. The
// segment anchor (^|-)agentsmd(-|$) keeps a downstream repo like '…-myagentsmd'
// classified external. Empty / (none) / null → unknown. (Rows from harnesses are
// additionally qa-tagged going forward; this catches the untagged history.)
function classifyProject(project) {
  if (!project || project === '(none)') return 'unknown';
  return /(^|-)agentsmd(-|$)/.test(String(project)) ? 'self' : 'external';
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
      bypassSessions: 0,
      blockingSessions: 0,
      // Bypasses split by project origin, for the same reason denyByProjectClass
      // exists: agentsmd's own dogfood and QA sandboxes must not read as field
      // evidence (R6-04). An escape hatch used 29 times entirely inside the
      // source repo is a very different finding from one used downstream.
      bypassByClass: { self: 0, external: 0, unknown: 0 },
      events: {},
      _explicitOpportunitySessions: new Set(),
      _explicitEligibleSessions: new Set(),
      _explicitEvaluatedSessions: new Set(),
      _enforcementSessions: new Set(),
      _bypassSessions: new Set(),
      _blockingSessions: new Set(),
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
      if (BYPASS_EVENTS.has(ev)) bySection[sec]._bypassSessions.add(session);
      if (BLOCKING_EVENTS.has(ev)) bySection[sec]._blockingSessions.add(session);
    }
    if (BYPASS_EVENTS.has(ev)) bySection[sec].bypassByClass[classifyProject(r.project)]++;
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
    bucket.bypassSessions = bucket._bypassSessions.size;
    bucket.blockingSessions = bucket._blockingSessions.size;
    delete bucket._explicitOpportunitySessions;
    delete bucket._explicitEligibleSessions;
    delete bucket._explicitEvaluatedSessions;
    delete bucket._enforcementSessions;
    delete bucket._bypassSessions;
    delete bucket._blockingSessions;
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

// Trend (R6, 2026-07-25 audit): governance was a snapshot — every report answered
// "is this rule firing now", none answered "are the discipline numbers moving".
// Buckets are TIME slices, not spec versions: telemetry rows carry no
// spec_version, and stamping one is a hook hot-path change (an SLO run per
// OPERATOR §O9), so version attribution stays a named gap rather than a guess.
// Normalising per 100 sessions is what makes buckets comparable — raw counts
// track how busy the window was, not how disciplined it was.
const TREND_DEFAULT_BUCKETS = 3;
const TREND_MIN_BUCKETS = 2;
const TREND_MAX_BUCKETS = 12;

function trend({ days = 90, buckets = TREND_DEFAULT_BUCKETS, now = Date.now(), logPath = P.logPath(), project = null, includeTest = false } = {}) {
  if (!Number.isSafeInteger(days) || days <= 0 || days > MAX_DAYS) days = 90;
  if (!Number.isSafeInteger(buckets) || buckets < TREND_MIN_BUCKETS) buckets = TREND_DEFAULT_BUCKETS;
  if (buckets > TREND_MAX_BUCKETS) buckets = TREND_MAX_BUCKETS;
  const bucketDays = Math.max(1, Math.floor(days / buckets));
  const rows = [];
  // Oldest → newest so the eye reads left-to-right as time. Each slice is an
  // independent audit() over its own sub-window: one tested aggregator, no
  // second counting path that could disagree with the main report.
  for (let i = buckets - 1; i >= 0; i--) {
    const end = now - i * bucketDays * 86400000;
    const a = audit({ days: bucketDays, now: end, logPath, project, includeTest });
    let blocks = 0, bypasses = 0, failOpens = 0;
    for (const b of Object.values(a.bySection)) {
      blocks += (b.events.block || 0) + (b.events.deny || 0);
      bypasses += b.events.bypass || 0;
    }
    for (const h of Object.values(a.byFailOpen)) failOpens += h.total;
    const per100 = (n) => (a.sessionCount ? Math.round((n / a.sessionCount) * 1000) / 10 : null);
    rows.push({
      endIso: new Date(end).toISOString().slice(0, 10),
      startIso: a.windowStartIso.slice(0, 10),
      days: bucketDays,
      sessions: a.sessionCount,
      rows: a.inWindow,
      enforcement: a.enforcementEvents,
      blocks, bypasses, failOpens,
      enforcementPer100Sessions: per100(a.enforcementEvents),
      failOpensPer100Sessions: per100(failOpens),
      bypassRate: (blocks + bypasses) > 0 ? bypasses / (blocks + bypasses) : null,
    });
  }
  return { days, buckets, bucketDays, rows };
}

function formatTrend(tr) {
  const L = [];
  L.push(`trend — ${tr.buckets} × ${tr.bucketDays}d buckets (oldest → newest), normalised per 100 sessions:`);
  L.push('window-end   sessions   enf/100   blocks   bypass   bypass-rate   fail-open/100');
  for (const r of tr.rows) {
    const n = (v, unit = '') => (v === null ? '   —' : `${v}${unit}`);
    L.push(`  ${r.endIso}   ${String(r.sessions).padStart(6)}   ${String(n(r.enforcementPer100Sessions)).padStart(7)}   ${String(r.blocks).padStart(6)}   ${String(r.bypasses).padStart(6)}   ${String(r.bypassRate === null ? '—' : Math.round(r.bypassRate * 100) + '%').padStart(11)}   ${String(n(r.failOpensPer100Sessions)).padStart(13)}`);
  }
  L.push('Buckets are time slices; telemetry carries no spec_version, so a release boundary');
  L.push('inside a bucket is invisible. Movement is a review prompt, never a verdict.');
  return L.join('\n');
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

// allowTrend is opt-in per command: audit implements --trend, rules does not, and
// a flag a command cannot honor must fail loudly rather than be parsed and dropped.
function parseDaysArg(argv, commandName = 'agentsmd-audit', { allowTrend = false } = {}) {
  let days = 30;
  let project = null;
  let includeTest = false;
  let trend = 0;
  let sawDays = false;
  let sawProject = false;
  let sawTrend = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true, days };
    if (arg === '--include-test') { includeTest = true; continue; }
    if (allowTrend && (arg === '--trend' || arg.startsWith('--trend='))) {
      if (sawTrend) return { error: 'duplicate option: --trend', days };
      sawTrend = true;
      if (arg === '--trend') { trend = TREND_DEFAULT_BUCKETS; continue; }
      const v = arg.slice('--trend='.length);
      if (!/^[1-9][0-9]*$/.test(v) || Number(v) < TREND_MIN_BUCKETS || Number(v) > TREND_MAX_BUCKETS) {
        return { error: `invalid --trend value: ${v} (expected ${TREND_MIN_BUCKETS}-${TREND_MAX_BUCKETS} buckets)`, days };
      }
      trend = Number(v);
      continue;
    }
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
  return { days, project, includeTest, trend, usage: `Usage: ${commandName} [--days=N] [--project=SUBSTR] [--include-test]${allowTrend ? ' [--trend[=BUCKETS]]' : ''}` };
}

if (require.main === module) {
  const USAGE = 'Usage: agentsmd-audit [--days=N] [--project=SUBSTR] [--include-test] [--trend[=BUCKETS]]';
  const parsed = parseDaysArg(process.argv.slice(2), 'agentsmd-audit', { allowTrend: true });
  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd audit: ${parsed.error}`);
    console.error(USAGE);
    process.exit(2);
  }
  console.log(formatReport(audit({ days: parsed.days, project: parsed.project, includeTest: parsed.includeTest })));
  if (parsed.trend) {
    console.log('');
    console.log(formatTrend(trend({ days: parsed.days, buckets: parsed.trend, project: parsed.project, includeTest: parsed.includeTest })));
  }
}
module.exports = {
  audit, formatReport, parseDaysArg, readRows, classifyProject, trend, formatTrend,
  ENFORCEMENT_EVENTS, BLOCKING_EVENTS, BYPASS_EVENTS, MAX_DAYS, TEST_TAGS,
  TREND_DEFAULT_BUCKETS, TREND_MIN_BUCKETS, TREND_MAX_BUCKETS,
};
