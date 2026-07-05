'use strict';
// lesson-bypass-audit.test.js — the memory cite-recall join. A `suggest` telemetry
// row (memory-prompt-hint surfaced these files at ts T in session S) is matched to
// S's transcript; the hint is "applied" iff a NON-user transcript row at/after T
// names a suggested file (user rows hold the injected hint itself → excluded), else
// "bypassed"; no transcript for S → unmeasurable. cite-recall = applied/measurable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  lessonBypassAudit, wasApplied, sidFromFilename, indexTranscripts, formatReport,
} = require('../lesson-bypass-audit');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const at = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const SID_A = '019a0000-0000-7000-8000-000000000001'; // applied
const SID_B = '019a0000-0000-7000-8000-000000000002'; // bypassed
const SID_C = '019a0000-0000-7000-8000-000000000003'; // no transcript → unmeasurable

t('sidFromFilename extracts the trailing session UUID', () => {
  assert.strictEqual(sidFromFilename('/x/rollout-2026-07-01T00-00-00-' + SID_A + '.jsonl'), SID_A);
  assert.strictEqual(sidFromFilename('/x/not-a-session.jsonl'), null);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-bypass.'));
try {
  const sdir = path.join(tmp, 'sessions', '2026', '07', '01');
  fs.mkdirSync(sdir, { recursive: true });
  const exec = (ts, cmd) => ({ timestamp: ts, type: 'function_call', payload: { name: 'exec_command', arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) } });
  const userMsg = (ts, text) => ({ timestamp: ts, type: 'message', payload: { role: 'user', content: [{ type: 'input_text', text }] } });
  const writeTr = (sid, rows) => {
    const f = path.join(sdir, `rollout-2026-07-01T00-00-00-${sid}.jsonl`);
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(f, new Date(NOW - 86400000), new Date(NOW - 86400000));
    return f;
  };
  // A: the suggested file is read (non-user exec) AFTER the hint → applied.
  writeTr(SID_A, [exec(at(-86400000 + 60000), 'cat memory/auth.md')]);
  // B: file only appears BEFORE the hint (time-gated out) and in a USER row after
  //    (excluded) → bypassed.
  writeTr(SID_B, [exec(at(-86400000 - 60000), 'cat memory/billing.md'), userMsg(at(-86400000 + 60000), 'please read memory/billing.md')]);
  // C: no transcript written → unmeasurable.

  const log = path.join(tmp, 'agentsmd.jsonl');
  const suggest = (sid, ts, files) => ({ ts, hook: 'memory-prompt-hint', event: 'suggest', spec_section: '§7-memory-read', session_id: sid, extra: { count: files.length, suggested: files } });
  fs.writeFileSync(log, [
    suggest(SID_A, at(-86400000), ['memory/auth.md']),
    suggest(SID_B, at(-86400000), ['memory/billing.md']),
    suggest(SID_C, at(-86400000), ['memory/x.md']),
    { ts: at(-86400000), hook: 'memory-prompt-hint', event: 'hint', spec_section: '§7-memory-read', session_id: SID_A }, // non-suggest → ignored
    suggest('019a0000-0000-7000-8000-000000000009', at(-60 * 86400000), ['memory/old.md']), // out of 30d window
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const sessionsDir = path.join(tmp, 'sessions');

  t('indexTranscripts maps session UUID → transcript path', () => {
    const idx = indexTranscripts(sessionsDir, { days: 30, now: NOW });
    assert.strictEqual(idx.get(SID_A), path.join(sdir, `rollout-2026-07-01T00-00-00-${SID_A}.jsonl`));
    assert.ok(!idx.has(SID_C));
  });
  t('wasApplied: non-user row naming the file after ts → true', () => {
    assert.strictEqual(wasApplied(path.join(sdir, `rollout-2026-07-01T00-00-00-${SID_A}.jsonl`), ['memory/auth.md'], NOW - 86400000), true);
  });
  t('wasApplied: only a pre-ts mention + a post-ts USER-row mention → false', () => {
    assert.strictEqual(wasApplied(path.join(sdir, `rollout-2026-07-01T00-00-00-${SID_B}.jsonl`), ['memory/billing.md'], NOW - 86400000), false);
  });
  t('wasApplied: unreadable transcript → null (unmeasurable, not a throw)', () => {
    assert.strictEqual(wasApplied(path.join(tmp, 'nope.jsonl'), ['memory/x.md'], NOW), null);
  });

  const r = lessonBypassAudit({ logPath: log, sessionsDir, days: 30, now: NOW });
  t('counts only in-window suggest events (hint + out-of-window excluded)', () => {
    assert.strictEqual(r.suggestEvents, 3);
  });
  t('applied / bypassed / unmeasurable split', () => {
    assert.strictEqual(r.applied, 1);
    assert.strictEqual(r.bypassed, 1);
    assert.strictEqual(r.unmeasurable, 1);
  });
  t('cite-recall = applied / (applied + bypassed), unmeasurable excluded', () => {
    assert.strictEqual(r.measurable, 2);
    assert.strictEqual(r.citeRecall, 0.5);
  });
  t('report names cite-recall + the unmeasurable slice explicitly', () => {
    const rep = formatReport(r);
    assert.ok(/cite-recall/.test(rep));
    assert.ok(/50(\.0)?%/.test(rep), 'got:\n' + rep);
    assert.ok(/unmeasurable|missing transcript/i.test(rep));
  });
  t('empty log → zeroed result, citeRecall null (no divide-by-zero)', () => {
    const empty = path.join(tmp, 'empty.jsonl'); fs.writeFileSync(empty, '');
    const e = lessonBypassAudit({ logPath: empty, sessionsDir, days: 30, now: NOW });
    assert.strictEqual(e.suggestEvents, 0);
    assert.strictEqual(e.citeRecall, null);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
