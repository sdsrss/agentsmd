'use strict';
// audit.js — aggregate agentsmd's rule-hit telemetry (~/.codex/logs/agentsmd.jsonl)
// over a time window. The read side of the closed-loop data plane
// (ARCHITECTURE.md §4): spec rule → hook → jsonl → THIS → promote/demote signal.
// bySection is what scripts/rules.js cross-references against spec/hard-rules.json.

const fs = require('fs');
const P = require('./lib/paths');

// Enforcement events = a rule actually fired (or was overridden). Lifecycle
// events (session banner, fail-open bookkeeping) are NOT rule activity and must
// not inflate the "is this rule earning its keep" signal.
const ENFORCEMENT_EVENTS = new Set(['block', 'deny', 'advisory', 'bypass']);
const MAX_DAYS = 100000000;

function readRows(logPath) {
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return rows;
}

function audit({ days = 30, now = Date.now(), logPath = P.logPath(), project = null } = {}) {
  const rows = readRows(logPath);
  const cutoff = now - days * 86400000;
  const projNeedle = project ? String(project).toLowerCase() : null;
  const bySection = {}, byHook = {}, byEvent = {}, byProject = {};
  let total = 0, enforcement = 0;

  for (const r of rows) {
    const ts = Date.parse(r && r.ts);
    if (!Number.isNaN(ts) && (ts < cutoff || ts > now)) continue; // unparseable ts → keep (can't window it out)
    if (projNeedle !== null && !String((r && r.project) || '').toLowerCase().includes(projNeedle)) continue;
    total++;
    const sec = (r && r.spec_section) || '(none)';
    const ev = (r && r.event) || 'unknown';
    const hook = (r && r.hook) || 'unknown';
    const isEnf = ENFORCEMENT_EVENTS.has(ev);
    if (isEnf) enforcement++;

    bySection[sec] = bySection[sec] || { total: 0, enforcement: 0, events: {} };
    bySection[sec].total++;
    if (isEnf) bySection[sec].enforcement++;
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
  }

  return {
    days,
    windowStartIso: new Date(cutoff).toISOString(),
    totalRows: rows.length,
    inWindow: total,
    enforcementEvents: enforcement,
    bySection, byHook, byEvent, byProject,
  };
}

function formatReport(a) {
  const lines = [];
  lines.push(`agentsmd audit — last ${a.days}d (since ${a.windowStartIso})`);
  lines.push(`rows: ${a.inWindow} in window / ${a.totalRows} total · enforcement events: ${a.enforcementEvents}`);
  lines.push('');
  lines.push('by spec_section (enforcement / total):');
  const secs = Object.keys(a.bySection).sort((x, y) => a.bySection[y].enforcement - a.bySection[x].enforcement);
  if (!secs.length) lines.push('  (no telemetry yet — hooks have not fired in this window)');
  for (const s of secs) {
    const b = a.bySection[s];
    const evs = Object.entries(b.events).map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push(`  ${s.padEnd(26)} ${String(b.enforcement).padStart(4)} / ${String(b.total).padStart(4)}   ${evs}`);
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
  return lines.join('\n');
}

function parseDaysArg(argv, commandName = 'agentsmd-audit') {
  let days = 30;
  let project = null;
  let sawDays = false;
  let sawProject = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true, days };
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
  return { days, project, usage: `Usage: ${commandName} [--days=N] [--project=SUBSTR]` };
}

if (require.main === module) {
  const parsed = parseDaysArg(process.argv.slice(2));
  if (parsed.help) {
    console.log('Usage: agentsmd-audit [--days=N] [--project=SUBSTR]');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd audit: ${parsed.error}`);
    console.error('Usage: agentsmd-audit [--days=N] [--project=SUBSTR]');
    process.exit(1);
  }
  console.log(formatReport(audit({ days: parsed.days, project: parsed.project })));
}
module.exports = { audit, formatReport, parseDaysArg, readRows, ENFORCEMENT_EVENTS, MAX_DAYS };
