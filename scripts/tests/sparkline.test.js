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
