'use strict';
// sparkline.test.js — pins the multi-window rule-usage trend: bucketing, the
// went-silent alarm (fired earlier, 0 in the newest bucket), test-tag / non-
// enforcement exclusion (shared hit definition with audit.js), zero-vs-tiny
// rendering, and cold-start honesty. Framework-free (standalone node script).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  sparkline, renderSpark, computeTrend, formatReport, formatMarkdown, parseArgs,
  DEFAULT_WINDOWS, MAX_WINDOWS,
} = require('../sparkline');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-06T00:00:00.000Z');
const DAY = 86400000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
// windows=4, bucketDays=7 → idx = 3 - floor(d/7): d∈[0,7)→3 (newest) … d∈[21,28)→0 (oldest); d≥28 dropped.
const row = (o) => JSON.stringify({
  ts: o.ts, hook: o.hook || 'h', event: o.event || 'block', project: o.project || '/p',
  session_id: o.sid || 's1', spec_section: o.sec, extra: o.extra || null, tag: o.tag,
});

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-spark-'));
const writeLog = (rows) => { const p = path.join(DIR, `log-${rows.length}-${Math.floor(rows[0] ? 1 : 0)}-${PASS + FAIL}.jsonl`); fs.writeFileSync(p, rows.join('\n') + '\n'); return p; };

// A fixture exercising every branch in one log.
const LOG = writeLog([
  // §X — went silent: fires in older buckets, nothing in the newest 7d.
  row({ sec: '§X', ts: ago(25) }), // idx0
  row({ sec: '§X', ts: ago(17) }), // idx1
  row({ sec: '§X', ts: ago(9) }),  // idx2
  row({ sec: '§X', ts: ago(2), tag: 'test' }), // idx3 but test-tagged → excluded by default
  // §Y — rising toward newest.
  row({ sec: '§Y', ts: ago(9) }),  // idx2
  row({ sec: '§Y', ts: ago(3) }),  // idx3
  row({ sec: '§Y', ts: ago(2) }),  // idx3
  row({ sec: '§Y', ts: ago(1) }),  // idx3
  // §Z — flat across all four buckets.
  row({ sec: '§Z', ts: ago(25) }), row({ sec: '§Z', ts: ago(17) }), row({ sec: '§Z', ts: ago(9) }), row({ sec: '§Z', ts: ago(3) }),
  // §W — non-enforcement events only → never a rule.
  row({ sec: '§W', ts: ago(3), event: 'context' }),
  row({ sec: '§W', ts: ago(3), event: 'suggest' }),
  row({ sec: '§W', ts: ago(3), event: 'observe', extra: { eligible: true, evaluated: true } }),
  // (none) — enforcement but no section → skipped.
  row({ sec: '', ts: ago(3), event: 'block' }),
  // §V — only out-of-window rows (future + too old) → absent.
  row({ sec: '§V', ts: ago(-5) }), row({ sec: '§V', ts: ago(40) }),
]);

const R = sparkline({ logPath: LOG, now: NOW, windows: 4, bucketDays: 7 });

t('bucketing places §X hits at idx 0/1/2 (test-tagged idx3 excluded)', () => {
  assert.deepStrictEqual(R.sections['§X'].counts, [1, 1, 1, 0]);
});
t('§X went silent (fired earlier, 0 in newest bucket) → flagged + falling', () => {
  assert.strictEqual(R.sections['§X'].wentSilent, true);
  assert.strictEqual(R.sections['§X'].trend, '↘');
  assert(R.silent.includes('§X'), 'silent list should carry §X');
});
t('went-silent sorts first', () => { assert.strictEqual(R.order[0], '§X'); });
t('§Y rising → ↗, not silent', () => {
  assert.deepStrictEqual(R.sections['§Y'].counts, [0, 0, 1, 3]);
  assert.strictEqual(R.sections['§Y'].trend, '↗');
  assert.strictEqual(R.sections['§Y'].wentSilent, false);
});
t('§Z flat → ≈', () => {
  assert.deepStrictEqual(R.sections['§Z'].counts, [1, 1, 1, 1]);
  assert.strictEqual(R.sections['§Z'].trend, '≈');
});
t('non-enforcement-only section (§W) never appears', () => { assert(!('§W' in R.sections)); });
t('missing spec_section is not a rule ((none) absent)', () => { assert(!('(none)' in R.sections) && !('' in R.sections)); });
t('future + too-old rows dropped (§V absent)', () => { assert(!('§V' in R.sections)); });
t('enforcementTotal counts only in-window enforcement hits', () => {
  // §X 3 + §Y 4 + §Z 4 = 11 (test-tagged, non-enf, (none), out-of-window all excluded).
  assert.strictEqual(R.enforcementTotal, 11);
  assert.strictEqual(R.excludedTestRows, 1);
});

t('--include-test folds the tagged row back into §X (no longer silent)', () => {
  const R2 = sparkline({ logPath: LOG, now: NOW, windows: 4, bucketDays: 7, includeTest: true });
  assert.deepStrictEqual(R2.sections['§X'].counts, [1, 1, 1, 1]);
  assert.strictEqual(R2.sections['§X'].wentSilent, false);
});

t('renderSpark: all-zero → floor row', () => { assert.strictEqual(renderSpark([0, 0, 0, 0]), '▁▁▁▁'); });
t('renderSpark: true zero (▁) is distinct from a tiny nonzero (≥▂)', () => {
  assert.strictEqual(renderSpark([0, 100]), '▁█');
  assert.strictEqual(renderSpark([1, 100]), '▂█'); // 1 rounds to level 0 but a nonzero bucket is never the floor
});
t('computeTrend: dormant [0,0,0,0] → ≈, not silent', () => {
  assert.deepStrictEqual(computeTrend([0, 0, 0, 0]), { trend: '≈', wentSilent: false, recent: 0, older: 0 });
});

t('computeTrend: constant activity is flat for every supported window count', () => {
  for (let windows = 2; windows <= MAX_WINDOWS; windows++) {
    assert.strictEqual(computeTrend(new Array(windows).fill(3)).trend, '≈', `windows=${windows}`);
  }
});

for (const [counts, trend, wentSilent] of [
  [[0, 0, 0], '≈', false],
  [[0, 1, 1], '↗', false],
  [[1, 0, 0], '↘', true],
  [[10, 8, 8], '↘', false],
  [[10, 9, 8], '≈', false],
  [[10, 12, 12], '↗', false],
  [[100, 114, 115], '≈', false],
  [[100, 115, 115], '≈', false],
  [[100, 115, 116], '↗', false],
  [[100, 84, 85], '↘', false],
  [[100, 85, 85], '≈', false],
  [[100, 85, 86], '≈', false],
]) t(`computeTrend: odd windows ${counts} use equal-time rates`, () => {
  const result = computeTrend(counts);
  assert.strictEqual(result.trend, trend);
  assert.strictEqual(result.wentSilent, wentSilent);
  assert.strictEqual(result.older, counts[0]);
  assert.strictEqual(result.recent, counts[1] + counts[2]);
});

t('computeTrend: 15% threshold boundaries hold for all odd and even lengths', () => {
  for (let windows = 2; windows <= MAX_WINDOWS; windows++) {
    const mid = Math.floor(windows / 2);
    for (const [recent, expected] of [[84, '↘'], [85, '≈'], [86, '≈'], [114, '≈'], [115, '≈'], [116, '↗']]) {
      const counts = new Array(mid).fill(100).concat(new Array(windows - mid).fill(recent));
      assert.strictEqual(computeTrend(counts).trend, expected, `windows=${windows}, recent rate=${recent}`);
    }
  }
});

for (const windows of [3, 5, 7]) t(`sparkline: ${windows} equal buckets retain totals and report a flat rate`, () => {
  assert.strictEqual(parseArgs([`--windows=${windows}`]).windows, windows);
  const logPath = writeLog(Array.from({ length: windows }, (_, i) => row({ sec: '§flat', ts: ago(i + 0.5) })));
  const report = sparkline({ logPath, now: NOW, windows, bucketDays: 1 });
  const section = report.sections['§flat'];
  assert.deepStrictEqual(section.counts, new Array(windows).fill(1));
  assert.strictEqual(report.enforcementTotal, windows);
  assert.strictEqual(section.trend, '≈');
  assert.strictEqual(section.older, Math.floor(windows / 2));
  assert.strictEqual(section.recent, Math.ceil(windows / 2));
  for (const output of [formatReport(report), formatMarkdown(report)]) {
    assert.match(output, /average hits per bucket/);
    assert.match(output, /counts remain totals/);
    assert(output.includes('≈'));
  }
});

t('sparkline: exact boundaries and malformed/QA rows keep their existing treatment', () => {
  const logPath = writeLog([
    row({ sec: '§bounds', ts: ago(0) }), row({ sec: '§bounds', ts: ago(1) }),
    row({ sec: '§bounds', ts: ago(2) }), row({ sec: '§bounds', ts: ago(3) }),
    row({ sec: '§bounds', ts: ago(-1) }), row({ sec: '§bounds', ts: ago(0.5), tag: 'qa' }),
    row({ sec: '§bounds', ts: 'invalid-date' }), 'malformed JSON',
  ]);
  const report = sparkline({ logPath, now: NOW, windows: 3, bucketDays: 1 });
  assert.deepStrictEqual(report.sections['§bounds'].counts, [1, 1, 1]);
  assert.strictEqual(report.enforcementTotal, 3);
  assert.strictEqual(report.excludedTestRows, 1);
  assert.strictEqual(report.unparseableRows, 1);
});

t('formatReport lists sections + went-silent callout', () => {
  const s = formatReport(R);
  assert(s.includes('§X'), 'names §X');
  assert(/went silent/i.test(s), 'has the went-silent callout');
});
t('formatMarkdown emits a table + silent blockquote', () => {
  const md = formatMarkdown(R);
  assert(md.includes('| section | trend |'), 'markdown table header');
  assert(md.includes('`§X`'), 'code-spanned section');
  assert(/> ⚠ \*\*Went silent\*\*/.test(md), 'went-silent blockquote');
});

t('cold start: empty log → honest "nothing to trend"', () => {
  const empty = sparkline({ logPath: path.join(DIR, 'does-not-exist.jsonl'), now: NOW });
  assert.strictEqual(empty.order.length, 0);
  assert(/nothing to trend/i.test(formatReport(empty)));
  assert(/nothing to trend/i.test(formatMarkdown(empty)));
});

t('parseArgs: knobs + markdown', () => {
  assert.deepStrictEqual(parseArgs(['--windows=8', '--bucket-days=1', '--markdown']), { windows: 8, bucketDays: 1, markdown: true, includeTest: false });
});
t('parseArgs: defaults', () => {
  const p = parseArgs([]);
  assert.strictEqual(p.windows, DEFAULT_WINDOWS); assert.strictEqual(p.markdown, false);
});
t('parseArgs: windows below range rejected', () => { assert(parseArgs(['--windows=1']).error); });
t('parseArgs: windows above cap rejected', () => { assert(parseArgs([`--windows=${MAX_WINDOWS + 1}`]).error); });
t('parseArgs: unknown option rejected', () => { assert(parseArgs(['--bogus']).error); });
t('parseArgs: help', () => { assert.strictEqual(parseArgs(['-h']).help, true); });

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* best-effort sandbox disposal (§8.V4) */ }

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
