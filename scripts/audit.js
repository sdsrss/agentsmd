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

function audit({ days = 30, now = Date.now(), logPath = P.logPath() } = {}) {
  const rows = readRows(logPath);
  const cutoff = now - days * 86400000;
  const bySection = {}, byHook = {}, byEvent = {};
  let total = 0, enforcement = 0, parsedTs = 0;

  for (const r of rows) {
    const ts = Date.parse(r && r.ts);
    if (!Number.isNaN(ts)) { parsedTs++; if (ts < cutoff) continue; }
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
  }

  return {
    days,
    windowStartIso: new Date(cutoff).toISOString(),
    totalRows: rows.length,
    inWindow: total,
    enforcementEvents: enforcement,
    bySection, byHook, byEvent,
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
  return lines.join('\n');
}

if (require.main === module) {
  const daysArg = process.argv.find((a) => /^--days=\d+$/.test(a));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
  console.log(formatReport(audit({ days })));
}
module.exports = { audit, formatReport, readRows, ENFORCEMENT_EVENTS };
