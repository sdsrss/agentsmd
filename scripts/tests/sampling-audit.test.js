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
  parseArgs, extractToolEvents, toolCallText, scanPreflight, scanPlanBeforeExecute, sessionClass,
  CALIBRATION_KEYS,
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
t('scanOrder: a clearly structured report missing one required section is flagged', () => {
  assert.strictEqual(scanOrder('Done: a\nNot done: b\nFailed: c'), true);
});
t('scanOrder: a Done-only structured report is incomplete', () => {
  assert.strictEqual(scanOrder('Done: shipped the fix.'), true);
});
t('parseArgs rejects an unsafe --limit integer instead of disabling the cap downstream', () => {
  const raw = '999999999999999999999999999999';
  assert.strictEqual(parseArgs([`--limit=${raw}`]).error, `invalid --limit value: ${raw}`);
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
    asst('Done: fixed the crash (12/12 tests passed).\nNot done: none\nFailed: none\nUncertain: none'), // clean
    asst('Another comprehensive audit here.'),           // scope wording, not a value claim
  ], day(2));
  mk('2026/07/03/rollout-future.jsonl', [
    user('future'), asst('This significantly improves a future result.'),
  ], day(-1));
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
  t('samplingAudit excludes transcripts whose mtime is after now', () => {
    assert.strictEqual(r.transcripts, 2, 'the future-dated transcript is excluded');
  });
  t('samplingAudit counts assistant turns scanned', () => {
    assert.strictEqual(r.turns, 4);
  });
  t('samplingAudit §10-V: 1 violating turn in 1 transcript', () => {
    assert.strictEqual(r.byRule['§10-V'].hits, 1);
    assert.strictEqual(r.byRule['§10-V'].transcriptsAffected, 1);
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
      const rows = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      const enforced = new Set(rows.filter((row) => row.event === 'advisory').map((row) => row.spec_section));
      return { vocab: enforced.has('§10-V'), order: enforced.has('§10-four-section-order') };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  // --- R2 calibration detectors (2026-07-25 audit) ------------------------
  // Fixtures encode the exact traps found by hand-checking real transcripts:
  // the two write-latency streams, and subagent-emitted patch events.
  {
    const meta = (cwd) => JSON.stringify({ timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { session_id: 's', cwd } });
    const call = (name, args, ptype = 'function_call') => JSON.stringify({ timestamp: '2026-07-01T00:00:01Z', type: 'response_item', payload: { type: ptype, name, arguments: args } });
    const patchEvt = JSON.stringify({ timestamp: '2026-07-01T00:00:00.500Z', type: 'event_msg', payload: { type: 'patch_apply_end', changes: { '/repo/a.js': {}, '/repo/b.js': {} } } });
    const mkT = (dir, lines) => { const p = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(p, lines.join('\n') + '\n'); return p; };

    t('R2: toolCallText unwraps {cmd}, {command:[…]}, bare input, and raw fallback', () => {
      assert.strictEqual(toolCallText({ arguments: '{"cmd":"git status --short"}' }), 'git status --short');
      assert.strictEqual(toolCallText({ arguments: '{"command":["bash","-lc","git status"]}' }), 'bash -lc git status');
      assert.strictEqual(toolCallText({ input: 'await tools.exec({cmd:"ls"})' }), 'await tools.exec({cmd:"ls"})');
      assert.strictEqual(toolCallText({ arguments: 'not json at all' }), 'not json at all');
    });

    t('R2: an event_msg patch (other stream / subagent) never becomes this session\'s mutation', () => {
      // THE BUG THIS PINS: event_msg rows are appended live while response_item
      // rows land later, so mixing them put a completed patch BEFORE the shell
      // calls that really preceded it — and an orchestrator's subagent patches
      // were scored against the parent, which never touched a file.
      const d = fs.mkdtempSync(path.join(tmp, 'cal-stream.'));
      const f = mkT(d, [meta('/repo'), patchEvt, call('exec_command', '{"cmd":"git status --short"}')]);
      const ev = extractToolEvents(f);
      assert.deepStrictEqual(ev.map((e) => e.kind), ['shell'], 'only response_item rows may order the sequence');
      assert.strictEqual(scanPreflight(ev).eligible, false, 'no own mutation → not eligible');
    });

    t('R2: preflight — git status before the first patch passes, without it fails', () => {
      const good = mkT(fs.mkdtempSync(path.join(tmp, 'cal-pre-ok.')), [
        meta('/repo'), call('exec_command', '{"cmd":"git status --short"}'),
        call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
      ]);
      const bad = mkT(fs.mkdtempSync(path.join(tmp, 'cal-pre-bad.')), [
        meta('/repo'), call('exec_command', '{"cmd":"ls -la"}'),
        call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
      ]);
      assert.deepStrictEqual(scanPreflight(extractToolEvents(good)), { eligible: true, violation: false });
      assert.deepStrictEqual(scanPreflight(extractToolEvents(bad)), { eligible: true, violation: true });
    });

    t('R2: a git status AFTER the patch does not retro-satisfy preflight', () => {
      const f = mkT(fs.mkdtempSync(path.join(tmp, 'cal-pre-late.')), [
        meta('/repo'), call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
        call('exec_command', '{"cmd":"git status"}'),
      ]);
      assert.strictEqual(scanPreflight(extractToolEvents(f)).violation, true);
    });

    t('R2: a patch sent through exec (apply_patch heredoc) counts as a mutation', () => {
      const f = mkT(fs.mkdtempSync(path.join(tmp, 'cal-exec-patch.')), [
        meta('/repo'), call('exec', 'const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: notes.md\\n+hi\\n*** End Patch")', 'custom_tool_call'),
      ]);
      const ev = extractToolEvents(f);
      assert.deepStrictEqual(ev.map((e) => e.kind), ['mutation'], 'patch shape must win over tool identity');
    });

    t('R2: plan-before-execute is eligible only on an L2+-shaped session', () => {
      const small = mkT(fs.mkdtempSync(path.join(tmp, 'cal-plan-small.')), [
        meta('/repo'), call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
      ]);
      const big = mkT(fs.mkdtempSync(path.join(tmp, 'cal-plan-big.')), [
        meta('/repo'), call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n*** Update File: b.js\\n+x\\n*** End Patch"'),
      ]);
      assert.strictEqual(scanPlanBeforeExecute(extractToolEvents(small)).eligible, false, '1 file → not L2+ shaped');
      assert.deepStrictEqual(scanPlanBeforeExecute(extractToolEvents(big)), { eligible: true, violation: true });
    });

    t('R2: update_plan before the first mutation clears plan-before-execute', () => {
      const f = mkT(fs.mkdtempSync(path.join(tmp, 'cal-plan-ok.')), [
        meta('/repo'), call('update_plan', '{"plan":[{"step":"do it","status":"in_progress"}]}'),
        call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n*** Update File: b.js\\n+x\\n*** End Patch"'),
      ]);
      assert.deepStrictEqual(scanPlanBeforeExecute(extractToolEvents(f)), { eligible: true, violation: false });
    });

    t('R2: sessionClass fences agentsmd-owned sandboxes from field data', () => {
      const mk = (cwd) => sessionClass(mkT(fs.mkdtempSync(path.join(tmp, 'cal-cls.')), [meta(cwd)]));
      assert.strictEqual(mk('/home/u/.claude/tmp/agentsmd-conformance.p7HQEt/case-auth-hard-tidy'), 'self');
      assert.strictEqual(mk('/mnt/dev/projects/agentsmd'), 'self');
      assert.strictEqual(mk('/home/u/projects/downstream-app'), 'external');
      assert.strictEqual(sessionClass(mkT(fs.mkdtempSync(path.join(tmp, 'cal-nometa.')), [call('exec_command', '{"cmd":"ls"}')])), 'unknown');
    });

    t('R2: samplingAudit reports calibration with its denominator and class split', () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'cal-run.'));
      fs.writeFileSync(path.join(dir, 'a.jsonl'), [
        meta('/home/u/projects/downstream-app'), call('exec_command', '{"cmd":"ls"}'),
        call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
      ].join('\n') + '\n');
      fs.writeFileSync(path.join(dir, 'b.jsonl'), [
        meta('/tmp/agentsmd-conformance.X/case-y'), call('exec_command', '{"cmd":"git status"}'),
        call('apply_patch', '"*** Begin Patch\\n*** Update File: a.js\\n+x\\n*** End Patch"'),
      ].join('\n') + '\n');
      // `now` must sit safely AFTER the fixtures' mtime: walkTranscripts drops
      // files stamped later than `now`, and sub-millisecond mtime precision can
      // put a just-written file past a bare Date.now() — a real flake, seen once.
      const r = samplingAudit({ sessionsDir: dir, days: 3650, now: Date.now() + 3600000 });
      const pre = r.byCalibration['§9-preflight'];
      assert.strictEqual(pre.eligible, 2);
      assert.strictEqual(pre.violations, 1);
      assert.deepStrictEqual(pre.byClass.external, { eligible: 1, violations: 1 });
      assert.deepStrictEqual(pre.byClass.self, { eligible: 1, violations: 0 });
      assert.strictEqual(r.calibration, true);
      const rep = require('../sampling-audit').formatReport(r);
      assert.ok(/CALIBRATION/.test(rep) && /NOT a governance signal/.test(rep), 'must be labelled non-authoritative');
      assert.ok(/external-only/.test(rep), 'field-data column missing');
      assert.ok(!/ +$/m.test(rep), 'calibration section has trailing whitespace');
    });

    t('R2: calibration keys are disjoint from the graded §10 keys', () => {
      assert.deepStrictEqual(CALIBRATION_KEYS.filter((k) => RULE_KEYS.includes(k)), []);
    });
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
