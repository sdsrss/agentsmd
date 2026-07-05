'use strict';
// sparkline.js — multi-window rule-usage TREND over the telemetry JSONL. audit.js
// answers "how many hits this window"; a single point-count hides a rule that WAS
// firing and silently STOPPED — a regressed / mis-wired hook still carries a
// healthy lifetime total, so the point-count looks fine. This buckets each
// spec_section's enforcement hits across N equal windows and shows the shape
// (↗ rising, ↘ falling, ≈ flat) plus a went-silent flag: fired earlier in the
// window, zero in the most recent bucket — the earliest cheap signal that a live
// rule stopped emitting. Pure log math (ARCHITECTURE.md §4 read side); reuses
// audit.js's hit definition so the trend and the point-counts agree on what a
// "hit" is. Advisory only — sparse windows are noisy. Markdown mode emits a
// CHANGELOG-ready block.

const P = require('./lib/paths');
const { readRows, ENFORCEMENT_EVENTS, TEST_TAGS } = require('./audit');

const BLOCKS = '▁▂▃▄▅▆▇█';            // 8 levels, low → high
const DEFAULT_WINDOWS = 6;
const DEFAULT_BUCKET_DAYS = 7;
const MAX_WINDOWS = 52;               // a year of weekly buckets — caps arg abuse
const MAX_BUCKET_DAYS = 365;

// renderSpark — counts[] → a fixed-width block sparkline scaled to the row's OWN
// max, so a fall reads regardless of magnitude. A true zero is the floor block; a
// tiny nonzero is lifted to at least level 1, so "went to zero" stays visible.
function renderSpark(counts) {
  const max = counts.reduce((m, c) => (c > m ? c : m), 0);
  if (max === 0) return BLOCKS[0].repeat(counts.length);
  return counts.map((c) => {
    if (c === 0) return BLOCKS[0];
    const lvl = Math.round((c / max) * (BLOCKS.length - 1));
    return BLOCKS[lvl < 1 ? 1 : lvl];
  }).join('');
}

// computeTrend — recent half vs older half → arrow; plus wentSilent (fired earlier
// in the window, zero in the newest bucket) = the sharp "just stopped" signal.
function computeTrend(counts) {
  const n = counts.length;
  const mid = Math.floor(n / 2);
  const older = counts.slice(0, mid).reduce((a, b) => a + b, 0);
  const recent = counts.slice(mid).reduce((a, b) => a + b, 0);
  const earlier = counts.slice(0, n - 1).reduce((a, b) => a + b, 0);
  const last = counts[n - 1] || 0;
  const wentSilent = earlier > 0 && last === 0;
  let trend;
  if (older === 0 && recent === 0) trend = '≈';
  else if (older === 0) trend = '↗';
  else {
    const ratio = recent / older;
    trend = ratio > 1.15 ? '↗' : ratio < 0.85 ? '↘' : '≈';
  }
  return { trend, wentSilent, recent, older };
}

function sparkline({ logPath = P.logPath(), windows = DEFAULT_WINDOWS, bucketDays = DEFAULT_BUCKET_DAYS, now = Date.now(), includeTest = false } = {}) {
  if (!Number.isSafeInteger(windows) || windows < 2 || windows > MAX_WINDOWS) windows = DEFAULT_WINDOWS;
  if (!Number.isSafeInteger(bucketDays) || bucketDays < 1 || bucketDays > MAX_BUCKET_DAYS) bucketDays = DEFAULT_BUCKET_DAYS;
  const bucketMs = bucketDays * 86400000;
  const cutoff = now - windows * bucketMs;
  const rows = readRows(logPath);
  const sections = {};
  const sessions = new Set();
  let enforcementTotal = 0, excludedTest = 0, unparseable = 0;

  for (const r of rows) {
    // Same exclusions audit.js applies, so trend and point-counts agree.
    if (!includeTest && r && r.tag != null && TEST_TAGS.has(String(r.tag))) { excludedTest++; continue; }
    if (!r || !ENFORCEMENT_EVENTS.has(r.event)) continue;   // trend tracks rule ACTIVITY only
    const sec = r.spec_section;
    if (!sec || sec === '(none)') continue;                 // a hit with no rule is not a rule
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) { unparseable++; continue; }
    if (ts < cutoff || ts > now) continue;
    const fromEnd = Math.floor((now - ts) / bucketMs);      // 0 = newest bucket
    const idx = windows - 1 - fromEnd;                      // 0 = oldest column, windows-1 = newest
    if (idx < 0 || idx >= windows) continue;
    if (!sections[sec]) sections[sec] = { counts: new Array(windows).fill(0), total: 0 };
    sections[sec].counts[idx]++;
    sections[sec].total++;
    enforcementTotal++;
    if (r.session_id) sessions.add(String(r.session_id));
  }

  for (const sec of Object.keys(sections)) {
    const s = sections[sec];
    Object.assign(s, computeTrend(s.counts));
    s.spark = renderSpark(s.counts);
  }
  // went-silent first (the alarm), then by in-window total desc.
  const order = Object.keys(sections).sort((a, b) => {
    const A = sections[a], B = sections[b];
    if (A.wentSilent !== B.wentSilent) return A.wentSilent ? -1 : 1;
    return B.total - A.total;
  });

  return {
    windows, bucketDays, totalDays: windows * bucketDays,
    windowStartIso: new Date(cutoff).toISOString(),
    generatedIso: new Date(now).toISOString(),
    enforcementTotal, sessionCount: sessions.size,
    excludedTestRows: excludedTest, unparseableRows: unparseable,
    sections, order,
    silent: order.filter((s) => sections[s].wentSilent),
  };
}

function formatReport(r) {
  const lines = [];
  lines.push(`agentsmd sparkline — ${r.windows} × ${r.bucketDays}d windows (through ${r.generatedIso.slice(0, 10)})`);
  lines.push(`enforcement events: ${r.enforcementTotal} across ${r.sessionCount} sessions · oldest bucket starts ${r.windowStartIso.slice(0, 10)}`);
  const skips = [];
  if (r.excludedTestRows) skips.push(`${r.excludedTestRows} test-tagged (excluded; --include-test to keep)`);
  if (r.unparseableRows) skips.push(`${r.unparseableRows} unparseable-ts`);
  if (skips.length) lines.push(`skipped: ${skips.join(' · ')}`);
  lines.push('');
  if (!r.order.length) {
    lines.push('(no enforcement telemetry in this window — nothing to trend yet)');
    return lines.join('\n');
  }
  lines.push('spec_section                trend  spark(old→new)   recent/older');
  for (const sec of r.order) {
    const s = r.sections[sec];
    const tag = s.wentSilent ? ' SILENT' : '';
    lines.push(`  ${sec.padEnd(26)} ${s.trend}${s.wentSilent ? '⚠' : ' '}  ${s.spark.padEnd(r.windows)}   ${s.recent}/${s.older}${tag}`);
  }
  lines.push('');
  if (r.silent.length) {
    lines.push(`⚠ went silent (fired earlier, 0 in the latest ${r.bucketDays}d): ${r.silent.join(', ')}`);
    lines.push('  → check the emitting hook is still wired + building — a regressed hook keeps its lifetime total.');
  } else {
    lines.push('no rule went silent this window — every section that fired earlier still fires.');
  }
  lines.push('Trend = recent half vs older half; advisory only (sparse windows are noisy).');
  return lines.join('\n');
}

function formatMarkdown(r) {
  const lines = [];
  lines.push(`### agentsmd rule-usage trend — ${r.windows} × ${r.bucketDays}d windows (through ${r.generatedIso.slice(0, 10)})`);
  lines.push('');
  lines.push(`Enforcement events: **${r.enforcementTotal}** across ${r.sessionCount} sessions. Sparkline oldest→newest; trend = recent half vs older half.`);
  lines.push('');
  if (!r.order.length) {
    lines.push('_No enforcement telemetry in this window — nothing to trend yet._');
    return lines.join('\n');
  }
  if (r.silent.length) {
    lines.push(`> ⚠ **Went silent** (fired earlier, 0 in the latest ${r.bucketDays}d — check the hook is still wired): ${r.silent.map((s) => '`' + s + '`').join(', ')}`);
    lines.push('');
  }
  lines.push('| section | trend | sparkline | recent / older | total |');
  lines.push('|---|:--:|---|--:|--:|');
  for (const sec of r.order) {
    const s = r.sections[sec];
    const tr = s.wentSilent ? `${s.trend} ⚠` : s.trend;
    lines.push(`| \`${sec}\` | ${tr} | \`${s.spark}\` | ${s.recent} / ${s.older} | ${s.total} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  let windows = DEFAULT_WINDOWS, bucketDays = DEFAULT_BUCKET_DAYS, markdown = false, includeTest = false;
  let sawW = false, sawB = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--markdown' || arg === '--md') { markdown = true; continue; }
    if (arg === '--include-test') { includeTest = true; continue; }
    let m;
    if ((m = arg.match(/^--windows=(.+)$/))) {
      if (sawW) return { error: 'duplicate option: --windows' };
      sawW = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) return { error: `invalid --windows value: ${m[1]}` };
      windows = Number(m[1]);
      if (!Number.isSafeInteger(windows) || windows < 2 || windows > MAX_WINDOWS) return { error: `--windows out of range (2..${MAX_WINDOWS}): ${m[1]}` };
      continue;
    }
    if ((m = arg.match(/^--bucket-days=(.+)$/))) {
      if (sawB) return { error: 'duplicate option: --bucket-days' };
      sawB = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) return { error: `invalid --bucket-days value: ${m[1]}` };
      bucketDays = Number(m[1]);
      if (!Number.isSafeInteger(bucketDays) || bucketDays < 1 || bucketDays > MAX_BUCKET_DAYS) return { error: `--bucket-days out of range (1..${MAX_BUCKET_DAYS}): ${m[1]}` };
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }
  return { windows, bucketDays, markdown, includeTest };
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  const usage = 'Usage: agentsmd-sparkline [--windows=N] [--bucket-days=D] [--markdown] [--include-test]';
  if (parsed.help) { console.log(usage); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd sparkline: ${parsed.error}`); console.error(usage); process.exit(1); }
  const r = sparkline({ windows: parsed.windows, bucketDays: parsed.bucketDays, includeTest: parsed.includeTest });
  console.log(parsed.markdown ? formatMarkdown(r) : formatReport(r));
}

module.exports = {
  sparkline, renderSpark, computeTrend, formatReport, formatMarkdown, parseArgs,
  BLOCKS, DEFAULT_WINDOWS, DEFAULT_BUCKET_DAYS, MAX_WINDOWS, MAX_BUCKET_DAYS,
};
