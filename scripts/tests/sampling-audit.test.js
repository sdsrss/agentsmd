'use strict';
// sampling-audit.test.js — the retrospective scanner must (a) aggregate self-
// enforced-rule violations across historical Codex transcripts and (b) return the
// SAME verdict as the live Stop hook (transcript-structure-scan.sh) on identical
// text — the drift safeguard that keeps "measured rate" honest. Synthetic
// fixtures + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const {
  samplingAudit, scanVocab, scanOrder, loadVocabPatterns, extractAssistantTurns, RULE_KEYS,
} = require('../sampling-audit');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const PATTERNS = path.join(__dirname, '..', '..', 'hooks', 'banned-vocab.patterns');
const HOOK = path.join(__dirname, '..', '..', 'hooks', 'transcript-structure-scan.sh');
const VOCAB = loadVocabPatterns(PATTERNS);

// --- unit: the two scanners mirror the live hook's detection ----------------
t('loadVocabPatterns skips comments/blanks, keeps regex lines', () => {
  assert.ok(VOCAB.length >= 10);
  assert.ok(VOCAB.includes('\\bsignificantly\\b'));
  assert.ok(!VOCAB.some((p) => p.startsWith('#')));
});
t('scanVocab flags an unquantified claim, passes a quantified one', () => {
  assert.ok(scanVocab('This significantly improves parse time.', VOCAB));
  assert.strictEqual(scanVocab('Parse p99 580ms->140ms (12/12 tests).', VOCAB), null);
});
t('scanVocab strips fenced code before matching (parity with the hook)', () => {
  assert.strictEqual(scanVocab('Done (12/12).\n```\nconst w = "significantly";\n```', VOCAB), null);
});
t('scanVocab matches a 中文 banned term', () => {
  assert.ok(scanVocab('这次改动显著提升了解析速度。', VOCAB));
});
t('scanOrder: correct Done→Not done→Failed→Uncertain order is clean', () => {
  assert.strictEqual(scanOrder('Done: a\nNot done: b\nFailed: c\nUncertain: d'), false);
});
t('scanOrder: out-of-order four-section report is flagged', () => {
  assert.strictEqual(scanOrder('Not done: a\nDone: b\nFailed: c\nUncertain: d'), true);
});
t('scanOrder: fewer than 2 trailing markers is not judged (not clearly a report)', () => {
  assert.strictEqual(scanOrder('Done: shipped the fix.'), false);
});

// --- unit: transcript extraction + window aggregation -----------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-sampling.'));
try {
  // Two synthetic Codex transcripts under sessions/YYYY/MM/DD/.
  const day = (n) => new Date(NOW - n * 86400000);
  const sdir = path.join(tmp, 'sessions');
  const mk = (rel, rows, mtime) => {
    const f = path.join(sdir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(f, mtime, mtime);
    return f;
  };
  const asst = (text) => ({ type: 'message', payload: { role: 'assistant', content: [{ type: 'output_text', text }] } });
  const user = (text) => ({ type: 'message', payload: { role: 'user', content: [{ type: 'input_text', text }] } });

  mk('2026/07/01/rollout-a.jsonl', [
    user('fix it'),
    asst('This significantly improves things.'),      // §10-V
    asst('Not done: a\nDone: b\nFailed: c\nUncertain: d'), // order violation
  ], day(1));
  mk('2026/06/30/rollout-b.jsonl', [
    user('again'),
    asst('Done: fixed the crash (12/12 tests passed).'), // clean
    asst('Another comprehensive rewrite here.'),         // §10-V ("comprehensive")
  ], day(2));
  mk('2026/01/01/rollout-old.jsonl', [
    user('old'), asst('significantly better, trust me'),  // OUT of 30d window
  ], day(120));

  t('extractAssistantTurns pulls only assistant messages', () => {
    const turns = extractAssistantTurns(path.join(sdir, '2026/07/01/rollout-a.jsonl'));
    assert.strictEqual(turns.length, 2);
    assert.ok(turns[0].includes('significantly'));
  });

  const r = samplingAudit({ sessionsDir: sdir, days: 30, now: NOW });
  t('samplingAudit windows out transcripts older than N days', () => {
    assert.strictEqual(r.transcripts, 2, 'the 120d-old transcript is excluded');
  });
  t('samplingAudit counts assistant turns scanned', () => {
    assert.strictEqual(r.turns, 4);
  });
  t('samplingAudit §10-V: 2 violating turns across 2 transcripts', () => {
    assert.strictEqual(r.byRule['§10-V'].hits, 2);
    assert.strictEqual(r.byRule['§10-V'].transcriptsAffected, 2);
  });
  t('samplingAudit §10-four-section-order: 1 violating turn in 1 transcript', () => {
    assert.strictEqual(r.byRule['§10-four-section-order'].hits, 1);
    assert.strictEqual(r.byRule['§10-four-section-order'].transcriptsAffected, 1);
  });
  t('samplingAudit: missing sessions dir → empty result, not a throw', () => {
    const empty = samplingAudit({ sessionsDir: path.join(tmp, 'nope'), days: 30, now: NOW });
    assert.strictEqual(empty.transcripts, 0);
    assert.strictEqual(empty.turns, 0);
    for (const k of RULE_KEYS) assert.strictEqual(empty.byRule[k].hits, 0);
  });

  // --- DRIFT SAFEGUARD: JS scanner verdict == live bash hook verdict --------
  // Feed each text to transcript-structure-scan.sh in a sandboxed CODEX_HOME and
  // read which spec_sections it records; assert the JS scanners agree.
  function bashVerdict(text) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-parity.'));
    try {
      const tr = path.join(home, 't.jsonl');
      fs.writeFileSync(tr, JSON.stringify(asst(text)) + '\n');
      const ev = JSON.stringify({ session_id: 'parity', transcript_path: tr, hook_event_name: 'Stop' });
      cp.execFileSync('bash', [HOOK], { input: ev, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') }, stdio: ['pipe', 'ignore', 'ignore'] });
      const log = path.join(home, '.codex', 'logs', 'agentsmd.jsonl');
      const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      return { vocab: /"spec_section":"§10-V"/.test(rows), order: /"spec_section":"§10-four-section-order"/.test(rows) };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  const parityCases = [
    'This significantly improves the parser.',
    'Done: fixed crash (12/12 tests passed).',
    'Not done: a\nDone: b\nFailed: c\nUncertain: d',
    '这次改动显著提升了性能。',
    'Done: quantified p99 580ms->140ms, nothing banned here.',
  ];
  for (const text of parityCases) {
    t('parity JS↔hook: ' + JSON.stringify(text.slice(0, 32)), () => {
      const bash = bashVerdict(text);
      assert.strictEqual(!!scanVocab(text, VOCAB), bash.vocab, 'vocab verdict differs from hook');
      assert.strictEqual(scanOrder(text), bash.order, 'order verdict differs from hook');
    });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
