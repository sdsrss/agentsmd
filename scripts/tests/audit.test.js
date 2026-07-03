'use strict';
// audit.test.js — proves the closed-loop read side: audit() aggregates rule-hit
// telemetry correctly (window filtering, enforcement vs lifecycle events) and
// rulesAudit() derives the right promote/demote signals against hard-rules.json.
// Synthetic telemetry + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { audit } = require('../audit');
const { rulesAudit } = require('../rules');
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();

const rows = [
  { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var' },
  { ts: day(2), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var' },
  { ts: day(3), hook: 'banned-vocab', event: 'block', spec_section: '§10-V' },
  { ts: day(1), hook: 'pre-bash-safety', event: 'advisory', spec_section: '§8-unknown-script' },
  { ts: day(1), hook: 'session-start', event: 'context', spec_section: null },     // lifecycle, NOT enforcement
  { ts: day(1), hook: 'pre-bash-safety', event: 'bypass', spec_section: '§8-rm-rf-var' }, // bypass = rule fired
  { ts: day(40), hook: 'ship-baseline', event: 'block', spec_section: '§E3-ship-baseline' }, // OUT of 30d window
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-audit-test.'));
try {
  const log = path.join(tmp, 'agentsmd.jsonl');
  fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const a = audit({ days: 30, now: NOW, logPath: log });
  t('window excludes rows older than N days', () => assert.strictEqual(a.inWindow, 6));
  t('§8-rm-rf-var aggregates block+block+bypass = 3', () => { assert.strictEqual(a.bySection['§8-rm-rf-var'].total, 3); assert.strictEqual(a.bySection['§8-rm-rf-var'].enforcement, 3); });
  t('context (lifecycle) not counted as enforcement', () => assert.strictEqual(a.enforcementEvents, 5));
  t('byHook tallies pre-bash-safety = 4', () => assert.strictEqual(a.byHook['pre-bash-safety'], 4));
  t('malformed lines are skipped, not fatal', () => { fs.appendFileSync(log, 'not json\n'); assert.strictEqual(audit({ days: 30, now: NOW, logPath: log }).inWindow, 6); });
  t('window includes the exact cutoff and excludes future rows', () => {
    const boundary = path.join(tmp, 'boundary.jsonl');
    fs.writeFileSync(boundary, [
      { ts: new Date(NOW - 30 * 86400000 - 1).toISOString(), hook: 'h', event: 'block', spec_section: 'before-cutoff' },
      { ts: new Date(NOW - 30 * 86400000).toISOString(), hook: 'h', event: 'block', spec_section: 'at-cutoff' },
      { ts: new Date(NOW).toISOString(), hook: 'h', event: 'block', spec_section: 'now' },
      { ts: new Date(NOW + 86400000).toISOString(), hook: 'h', event: 'block', spec_section: 'future' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const b = audit({ days: 30, now: NOW, logPath: boundary });
    assert.deepStrictEqual(Object.keys(b.bySection).sort(), ['at-cutoff', 'now']);
  });

  // --- Phase 3: byProject aggregation -------------------------------------
  const projRows = path.join(tmp, 'projects.jsonl');
  fs.writeFileSync(projRows, [
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var', project: '-home-user-alpha' },
    { ts: day(1), hook: 'banned-vocab',    event: 'block',    spec_section: '§10-V',        project: '-home-user-alpha' },
    { ts: day(1), hook: 'session-start',   event: 'context',  spec_section: null,           project: '-home-user-alpha' }, // lifecycle, not enforcement
    { ts: day(2), hook: 'banned-vocab',    event: 'advisory', spec_section: '§10-V',        project: '-home-user-beta' },
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var' },                              // no project → (none)
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ap = audit({ days: 30, now: NOW, logPath: projRows });

  t('byProject: alpha = 3 total / 2 enforcement (context not enforcement)', () => {
    assert.strictEqual(ap.byProject['-home-user-alpha'].total, 3);
    assert.strictEqual(ap.byProject['-home-user-alpha'].enforcement, 2);
  });
  t('byProject: alpha.sections counts enforcement per named section', () => {
    assert.deepStrictEqual(ap.byProject['-home-user-alpha'].sections, { '§8-rm-rf-var': 1, '§10-V': 1 });
  });
  t('byProject: null-section lifecycle row excluded from sections breakdown', () => {
    assert.ok(!('(none)' in ap.byProject['-home-user-alpha'].sections));
  });
  t('byProject: row without a project bucketed under (none)', () => {
    assert.strictEqual(ap.byProject['(none)'].total, 1);
    assert.strictEqual(ap.byProject['(none)'].enforcement, 1);
  });
  t('byProject: beta advisory counts as enforcement', () => {
    assert.strictEqual(ap.byProject['-home-user-beta'].enforcement, 1);
    assert.deepStrictEqual(ap.byProject['-home-user-beta'].sections, { '§10-V': 1 });
  });

  const ra = rulesAudit({ days: 30, now: NOW, logPath: log });
  t('rules: §8-rm-rf-var is active (has enforcement hits)', () => { const r = ra.rules.find((x) => x.section === '§8-rm-rf-var'); assert(r && r.signal === 'active', 'got ' + (r && r.signal)); });
  t('rules: hook-enforced §E3-ship-baseline with 0 in-window hits = demote-candidate', () => { const r = ra.rules.find((x) => x.id === '§E3-ship-baseline'); assert(r && r.signal === 'demote-candidate', 'got ' + (r && r.signal)); });
  t('rules: self-enforced Iron Law #2 labeled self-enforced (never a demote-candidate)', () => { const r = ra.rules.find((x) => x.id === '§6-iron-law-2'); assert(r && r.signal === 'self-enforced', 'got ' + (r && r.signal)); });
  t('rules: demoteCandidates only include hook-enforced rules', () => assert(ra.demoteCandidates.every((r) => r.enforcement === 'hook' || r.enforcement === 'both')));

  // Empty window: a 0-hit live rule must read as 'no-data', never 'demote-candidate'
  // (an empty window is not evidence of dilution).
  const empty = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const raEmpty = rulesAudit({ days: 30, now: NOW, logPath: empty });
  t('rules: zero telemetry → live hook rules are no-data, not demote-candidate', () => {
    assert.strictEqual(raEmpty.demoteCandidates.length, 0, 'demote off an empty window');
    const r = raEmpty.rules.find((x) => x.id === '§8-rm-rf-var');
    assert(r && r.signal === 'no-data', 'got ' + (r && r.signal));
  });

  t('audit CLI rejects invalid --days instead of silently using default', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=abc'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /invalid --days value: abc/.test(String(e.stderr))
    );
  });
  t('audit CLI rejects oversized --days instead of throwing a RangeError', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=999999999999999999999999999999'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /invalid --days value: 999999999999999999999999999999/.test(String(e.stderr)) && !/RangeError/.test(String(e.stderr))
    );
  });
  t('audit CLI rejects duplicate --days instead of silently taking the last value', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=7', '--days=30'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /duplicate option: --days/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects unknown options instead of silently using default', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--wat'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /unknown option: --wat/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects oversized --days instead of throwing a RangeError', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--days=999999999999999999999999999999'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /invalid --days value: 999999999999999999999999999999/.test(String(e.stderr)) && !/RangeError/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects duplicate --days instead of silently taking the last value', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--days=7', '--days=30'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /duplicate option: --days/.test(String(e.stderr))
    );
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
