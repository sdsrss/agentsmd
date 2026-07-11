'use strict';
// lesson-bypass-audit.js — does the agent ACT on the memory the hint surfaced, or
// bypass it? memory-prompt-hint.sh records a `suggest` event (session_id, ts, and
// extra.suggested = the memory/*.md files it surfaced). This joins each suggest row
// to that session's transcript and asks: after the hint, did a NON-user row name a
// suggested file? → applied; else → bypassed; no transcript → unmeasurable.
//
// cite-recall = applied / (applied + bypassed). §7 "read the suggested memory" is
// HARD but leaves no direct telemetry — the hint firing (count) says nothing about
// follow-through. This supplies the missing denominator (surfaced-but-ignored),
// with the unmeasurable slice surfaced separately so the number stays honest.
//
// Non-user rows only: the injected hint itself lives in the user-turn context, so
// matching there would score every hint "applied". Same signal memory-read-check.sh
// uses (non-user transcript entries = the cheap evidence of consultation).

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const { readRows } = require('./audit');
const { walkTranscripts, defaultSessionsDir } = require('./sampling-audit');

const MAX_DAYS = 100000000;

// Codex session transcripts are named rollout-<ts>-<uuid>.jsonl and the <uuid> is
// the session_id the hooks stamp on telemetry — the join key.
function sidFromFilename(p) {
  const m = path.basename(String(p)).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

function indexTranscripts(sessionsDir, opts) {
  const map = new Map();
  let files;
  try { files = walkTranscripts(sessionsDir, opts); } catch { return map; }
  for (const f of files) { const sid = sidFromFilename(f); if (sid && !map.has(sid)) map.set(sid, f); }
  return map;
}

// true = a suggested file is named by a non-user row at/after sinceMs; false = not;
// null = transcript unreadable (unmeasurable, never counted as a bypass).
function wasApplied(transcriptPath, suggested, sinceMs) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const bases = (suggested || []).map((s) => path.basename(String(s))).filter(Boolean);
  if (!bases.length) return false;
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o && o.payload != null ? o.payload : o;
    const role = p && (p.role || p.author);
    if (role === 'user' || o.type === 'user_message' || o.type === 'input_text') continue; // hint lives here
    const ts = Date.parse(o && o.timestamp);
    if (!Number.isNaN(ts) && ts < sinceMs) continue; // only what happened after the hint
    for (const b of bases) if (ln.includes(b)) return true;
  }
  return false;
}

function lessonBypassAudit({ logPath = P.logPath(), sessionsDir = defaultSessionsDir(), days = 30, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(days) || days <= 0 || days > MAX_DAYS) days = 30;
  const cutoff = now - days * 86400000;
  const result = { days, suggestEvents: 0, applied: 0, bypassed: 0, unmeasurable: 0, measurable: 0, citeRecall: null };
  const rows = readRows(logPath);
  const idx = indexTranscripts(sessionsDir, { days, now });
  for (const r of rows) {
    if (!r || r.event !== 'suggest') continue;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts) || ts < cutoff || ts > now) continue;
    const suggested = r.extra && Array.isArray(r.extra.suggested) ? r.extra.suggested : [];
    if (!suggested.length) continue;
    result.suggestEvents++;
    const tpath = r.session_id ? idx.get(String(r.session_id)) : null;
    if (!tpath) { result.unmeasurable++; continue; }
    const applied = wasApplied(tpath, suggested, ts);
    if (applied === null) { result.unmeasurable++; continue; }
    if (applied) result.applied++; else result.bypassed++;
  }
  result.measurable = result.applied + result.bypassed;
  result.citeRecall = result.measurable ? result.applied / result.measurable : null;
  return result;
}

function formatReport(r) {
  const lines = [];
  lines.push(`agentsmd lesson-bypass-audit — last ${r.days}d (memory-hint cite-recall)`);
  lines.push(`suggest events: ${r.suggestEvents} · measurable: ${r.measurable} · unmeasurable (missing transcript): ${r.unmeasurable}`);
  lines.push('');
  if (!r.measurable) {
    lines.push('cite-recall: n/a (no suggest event could be joined to a transcript this window)');
  } else {
    const pct = (r.citeRecall * 100).toFixed(1);
    lines.push(`applied: ${r.applied} · bypassed: ${r.bypassed}`);
    lines.push(`cite-recall: ${r.applied}/${r.measurable} = ${pct}%   (surfaced memory the session then engaged)`);
  }
  lines.push('');
  lines.push('Low recall = the §7 "read the suggested memory" hint is firing but being bypassed');
  lines.push('(uncited memory decays). The unmeasurable slice is shown so the % is not overclaimed.');
  return lines.join('\n');
}

function parseArgs(argv) {
  let days = 30, sawDays = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    const m = arg.match(/^--days=(.+)$/);
    if (m) {
      if (sawDays) return { error: 'duplicate option: --days' };
      sawDays = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) return { error: `invalid --days value: ${m[1]}` };
      days = Number(m[1]);
      if (!Number.isSafeInteger(days) || days > MAX_DAYS) return { error: `invalid --days value: ${m[1]}` };
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }
  return { days };
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  const usage = 'Usage: agentsmd-lesson-bypass-audit [--days=N]';
  if (parsed.help) { console.log(usage); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd lesson-bypass-audit: ${parsed.error}`); console.error(usage); process.exit(2); }
  console.log(formatReport(lessonBypassAudit({ days: parsed.days })));
}

module.exports = {
  lessonBypassAudit, wasApplied, sidFromFilename, indexTranscripts, formatReport, parseArgs, MAX_DAYS,
};
