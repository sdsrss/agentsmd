'use strict';
// audit.test.js — proves the closed-loop read side: audit() aggregates rule-hit
// telemetry correctly (window filtering, enforcement vs lifecycle events) and
// rulesAudit() derives the right promote/demote signals against hard-rules.json.
// Synthetic telemetry + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { audit, parseDaysArg, formatReport, classifyProject, readRows, trend, formatTrend } = require('../audit');
const { rulesAudit } = require('../rules');
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const RULE_HITS = path.join(__dirname, '..', '..', 'hooks', 'lib', 'rule-hits.sh');

// session_id present + spread across ≥5 distinct in-window sessions so exposure
// is sufficient for the demote/hook-value/deterrence signal branches to engage
// (a thinner window would read 'insufficient-exposure' — covered separately).
const rows = [
  { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'session-a' },
  { ts: day(2), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'session-b' },
  { ts: day(3), hook: 'banned-vocab', event: 'block', spec_section: '§10-V', session_id: 'session-c' },
  { ts: day(1), hook: 'pre-bash-safety', event: 'advisory', spec_section: '§8-unknown-script', session_id: 'session-d' },
  { ts: day(1), hook: 'session-start', event: 'context', spec_section: null, session_id: 'session-e' },     // lifecycle, NOT enforcement
  { ts: day(1), hook: 'pre-bash-safety', event: 'bypass', spec_section: '§8-rm-rf-var', session_id: 'session-a' }, // bypass = rule fired
  { ts: day(40), hook: 'ship-baseline', event: 'block', spec_section: '§E3-ship-baseline', session_id: 'session-f' }, // OUT of 30d window
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-audit-test.'));
try {
  const log = path.join(tmp, 'agentsmd.jsonl');
  fs.writeFileSync(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const a = audit({ days: 30, now: NOW, logPath: log });
  t('window excludes rows older than N days', () => assert.strictEqual(a.inWindow, 6));
  t('sessionCount = distinct in-window session_id (exposure proxy)', () => assert.strictEqual(a.sessionCount, 5));
  t('§8-rm-rf-var aggregates block+block+bypass = 3', () => { assert.strictEqual(a.bySection['§8-rm-rf-var'].total, 3); assert.strictEqual(a.bySection['§8-rm-rf-var'].enforcement, 3); });
  t('context (lifecycle) not counted as enforcement', () => assert.strictEqual(a.enforcementEvents, 5));
  t('byHook tallies pre-bash-safety = 4', () => assert.strictEqual(a.byHook['pre-bash-safety'], 4));
  t('malformed lines are skipped, not fatal', () => { fs.appendFileSync(log, 'not json\n'); assert.strictEqual(audit({ days: 30, now: NOW, logPath: log }).inWindow, 6); });
  t('readRows merges rotated segments (.1/.2) → a busy window is not a false 0-hit', () => {
    // rule-hits.sh rotates agentsmd.jsonl → .1 → .2 at the size cap. Hits that
    // landed in a rotated segment must still count, else the demote signal inverts.
    const rotDir = fs.mkdtempSync(path.join(tmp, 'rot.'));
    const rlog = path.join(rotDir, 'agentsmd.jsonl');
    fs.writeFileSync(rlog, JSON.stringify({ ts: day(1), hook: 'h', event: 'block', spec_section: '§8-secrets', session_id: 's-live' }) + '\n');
    fs.writeFileSync(rlog + '.1', JSON.stringify({ ts: day(2), hook: 'h', event: 'block', spec_section: '§8-secrets', session_id: 's-rot1' }) + '\n');
    fs.writeFileSync(rlog + '.2', JSON.stringify({ ts: day(3), hook: 'h', event: 'block', spec_section: '§8-secrets', session_id: 's-rot2' }) + '\n');
    const r = audit({ days: 30, now: NOW, logPath: rlog });
    assert.strictEqual(r.bySection['§8-secrets'].enforcement, 3, 'rotated hits must count');
    assert.strictEqual(r.sessionCount, 3, 'rotated sessions must count toward exposure');
  });
  t('rule-hits serializes rotation + append: every concurrent attempt is retained with empty stderr', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'concurrent-home.'));
    const logDir = path.join(home, 'logs');
    const concurrentLog = path.join(logDir, 'agentsmd.jsonl');
    fs.mkdirSync(logDir, { recursive: true });
    const padding = 'x'.repeat(8192);
    const seed = JSON.stringify({ ts: day(1), hook: 'seed', event: 'context', spec_section: null, extra: { padding } }) + '\n';
    fs.writeFileSync(concurrentLog, seed.repeat(140)); // > 1 MiB: first writer must rotate.
    const attempted = 96;
    const script = `
      i=1
      while [ "$i" -le "$ATTEMPTED" ]; do
        bash -c 'source "$1"; rule_hits_append concurrent observe null "§test-concurrent" "$2"' _ "$RULE_HITS" "concurrent-$i" &
        i=$((i + 1))
      done
      wait
    `;
    const run = cp.spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        CODEX_HOME: home,
        AGENTSMD_LOG_MAX_MB: '1',
        AGENTSMD_LOG_LOCK_ATTEMPTS: '500',
        ATTEMPTED: String(attempted),
        RULE_HITS,
      },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, `writers exited ${run.status}: ${run.stderr}`);
    assert.strictEqual(run.stderr, '', `concurrent writers emitted stderr: ${run.stderr}`);
    const retained = readRows(concurrentLog).filter((r) => /^concurrent-/.test(String(r.session_id))).length;
    assert.strictEqual(retained, attempted, `retained ${retained}/${attempted} attempted rows`);
  });
  t('rule_hits_observe writes eligibility/evaluation separately from enforcement', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'observe-home.'));
    const script = 'source "$1"; rule_hits_observe gate "§test-observe" session-observe true true "{\\"clean\\":true}"';
    const run = cp.spawnSync('bash', ['-c', script, '_', RULE_HITS], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    const written = readRows(path.join(home, 'logs', 'agentsmd.jsonl'));
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].event, 'observe');
    assert.strictEqual(written[0].eligible, true);
    assert.strictEqual(written[0].evaluated, true);
  });
  t('rule-hits lock contention fails open with no row and no stderr', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'locked-home.'));
    const logDir = path.join(home, 'logs');
    const lockedLog = path.join(logDir, 'agentsmd.jsonl');
    const lockDir = lockedLog + '.lock';
    fs.mkdirSync(lockDir, { recursive: true });
    const lease = `${Math.floor(Date.now() / 1000)} ${process.pid} active-test\n`;
    fs.writeFileSync(path.join(lockDir, 'lease'), lease);
    const script = 'source "$1"; rule_hits_append locked block null "§locked" session-locked';
    const run = cp.spawnSync('bash', ['-c', script, '_', RULE_HITS], {
      env: { ...process.env, CODEX_HOME: home, AGENTSMD_LOG_LOCK_ATTEMPTS: '1' },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    assert.strictEqual(fs.existsSync(lockedLog), false, 'contention must not write outside the lock');
    assert.strictEqual(fs.readFileSync(path.join(lockDir, 'lease'), 'utf8'), lease, 'active lease must not be replaced');
  });
  t('rule-hits atomically recovers an expired lock owned by a dead process', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'stale-lock-home.'));
    const logDir = path.join(home, 'logs');
    const staleLog = path.join(logDir, 'agentsmd.jsonl');
    const lockDir = staleLog + '.lock';
    fs.mkdirSync(lockDir, { recursive: true });
    const expired = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(path.join(lockDir, 'lease'), `${expired} 999999 stale-test\n`);
    const script = 'source "$1"; rule_hits_append recovered block null "§recovered" session-recovered';
    const run = cp.spawnSync('bash', ['-c', script, '_', RULE_HITS], {
      env: { ...process.env, CODEX_HOME: home, AGENTSMD_LOG_LOCK_ATTEMPTS: '20' },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    const written = readRows(staleLog);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].session_id, 'session-recovered');
    assert.strictEqual(fs.existsSync(lockDir), false, 'writer releases the recovered lock');
    assert.strictEqual(fs.existsSync(lockDir + '.reap'), false, 'reaper gate is released');
    assert.deepStrictEqual(fs.readdirSync(logDir).filter((n) => n.includes('.stale.')), [], 'quarantine is disposed');
  });
  t('rule-hits recovery requires both expiry and a dead owner', () => {
    const cases = [
      { name: 'fresh-dead', epoch: Math.floor(Date.now() / 1000), pid: 999999 },
      { name: 'expired-live', epoch: Math.floor(Date.now() / 1000) - 60, pid: process.pid },
    ];
    for (const c of cases) {
      const home = fs.mkdtempSync(path.join(tmp, `${c.name}-home.`));
      const logDir = path.join(home, 'logs');
      const log = path.join(logDir, 'agentsmd.jsonl');
      const lockDir = log + '.lock';
      fs.mkdirSync(lockDir, { recursive: true });
      const lease = `${c.epoch} ${c.pid} ${c.name}\n`;
      fs.writeFileSync(path.join(lockDir, 'lease'), lease);
      const run = cp.spawnSync('bash', ['-c', 'source "$1"; rule_hits_append held block null "§held" session-held', '_', RULE_HITS], {
        env: { ...process.env, CODEX_HOME: home, AGENTSMD_LOG_LOCK_ATTEMPTS: '1' }, encoding: 'utf8',
      });
      assert.strictEqual(run.status, 0, `${c.name}: ${run.stderr}`);
      assert.strictEqual(run.stderr, '', c.name);
      assert.strictEqual(fs.existsSync(log), false, `${c.name}: must fail open without appending`);
      assert.strictEqual(fs.readFileSync(path.join(lockDir, 'lease'), 'utf8'), lease, `${c.name}: lease replaced`);
    }
  });
  t('concurrent writers recover one stale generation without stealing the new owner', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'stale-concurrent-home.'));
    const logDir = path.join(home, 'logs');
    const log = path.join(logDir, 'agentsmd.jsonl');
    const lockDir = log + '.lock';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lease'), `${Math.floor(Date.now() / 1000) - 60} 999999 stale-concurrent\n`);
    const attempted = 32;
    const script = `
      i=1
      while [ "$i" -le "$ATTEMPTED" ]; do
        bash -c 'source "$1"; rule_hits_append recovered observe null "§stale-concurrent" "$2"' _ "$RULE_HITS" "stale-concurrent-$i" &
        i=$((i + 1))
      done
      wait
    `;
    const run = cp.spawnSync('bash', ['-c', script], {
      env: { ...process.env, CODEX_HOME: home, AGENTSMD_LOG_LOCK_ATTEMPTS: '500', ATTEMPTED: String(attempted), RULE_HITS },
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    const retained = readRows(log).filter((r) => /^stale-concurrent-/.test(String(r.session_id))).length;
    assert.strictEqual(retained, attempted, `retained ${retained}/${attempted} after stale recovery`);
    assert.deepStrictEqual(fs.readdirSync(logDir).filter((n) => n.includes('.lock') || n.includes('.stale.')), []);
  });
  t('a later write sweeps the quarantine orphan a dead reaper left behind (D#79)', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'orphan-sweep-home.'));
    const logDir = path.join(home, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, 'agentsmd.jsonl');
    // Simulate a reaper killed between its rename and its rmdir: quarantine
    // dir still holding the dead lock's lease/pid and the reap claim.
    const orphan = path.join(logDir, 'agentsmd.jsonl.lock.stale.12345.678.1700000000');
    fs.mkdirSync(path.join(orphan, 'reap'), { recursive: true });
    fs.writeFileSync(path.join(orphan, 'lease'), '1700000000 999999 dead-reaper\n');
    fs.writeFileSync(path.join(orphan, 'pid'), '999999\n');
    const run = cp.spawnSync('bash', ['-c', 'source "$1"; rule_hits_append healer observe null "§orphan-sweep" session-healer', '_', RULE_HITS], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stderr, '');
    assert.strictEqual(readRows(log).length, 1, 'the healing write itself lands');
    assert.strictEqual(fs.existsSync(orphan), false, 'orphan quarantine disposed by the next write');
    assert.deepStrictEqual(fs.readdirSync(logDir).filter((n) => n.includes('.stale.')), []);
  });
  t('quarantine disposal refuses paths outside the .lock.stale. namespace', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'dispose-guard-home.'));
    const victim = path.join(home, 'not-a-quarantine');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'lease'), 'precious\n');
    const run = cp.spawnSync('bash', ['-c', 'source "$1"; rule_hits_dispose_quarantine "$2"; echo "rc=$?"', '_', RULE_HITS, victim], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.match(run.stdout, /rc=1/, 'guard rejects the path');
    assert.strictEqual(fs.readFileSync(path.join(victim, 'lease'), 'utf8'), 'precious\n', 'non-quarantine content untouched');
  });
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
  t('test-tagged rows excluded by default; includeTest keeps them', () => {
    const tagged = path.join(tmp, 'tagged.jsonl');
    fs.writeFileSync(tagged, [
      { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'real-session' },
      { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'verify-session', tag: 'test' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const def = audit({ days: 30, now: NOW, logPath: tagged });
    assert.strictEqual(def.inWindow, 1, 'tagged row excluded from window');
    assert.strictEqual(def.excludedTestRows, 1);
    assert.strictEqual(def.bySection['§8-rm-rf-var'].enforcement, 1, 'tagged hit not counted');
    assert.strictEqual(def.sessionCount, 1, 'tagged session not counted toward exposure');
    const inc = audit({ days: 30, now: NOW, logPath: tagged, includeTest: true });
    assert.strictEqual(inc.inWindow, 2, 'includeTest keeps the tagged row');
    assert.strictEqual(inc.excludedTestRows, 0);
  });
  t('unparseable-ts rows counted separately, kept OUT of window + aggregation', () => {
    const bad = path.join(tmp, 'badts.jsonl');
    fs.writeFileSync(bad, [
      { ts: 'not-a-date', hook: 'h', event: 'block', spec_section: 'garbage', session_id: 'sx' },
      { ts: day(1), hook: 'h', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'sy' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const a2 = audit({ days: 30, now: NOW, logPath: bad });
    assert.strictEqual(a2.unparseableRows, 1);
    assert.strictEqual(a2.inWindow, 1, 'only the valid-ts row is in window');
    assert.ok(!('garbage' in a2.bySection), 'unparseable-ts row must not pollute bySection');
  });
  t('parseDaysArg accepts --include-test', () => {
    const p = parseDaysArg(['--include-test']);
    assert.strictEqual(p.includeTest, true);
    assert.strictEqual(p.days, 30);
  });
  t('rulesAudit --include-test includes test-tagged telemetry in governance signals', () => {
    const tagged = path.join(tmp, 'rules-include-test.jsonl');
    fs.writeFileSync(tagged, JSON.stringify({
      ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var',
      session_id: 'tagged-session', project: 'tagged-project', tag: 'test',
    }) + '\n');
    const without = rulesAudit({ days: 30, now: NOW, logPath: tagged });
    const withTest = rulesAudit({ days: 30, now: NOW, logPath: tagged, includeTest: true });
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: tagged, project: 'tagged', includeTest: true });
    const hits = (r) => r.rules.find((x) => x.section === '§8-rm-rf-var').hits;
    assert.strictEqual(hits(without), 0);
    assert.strictEqual(hits(withTest), 1);
    assert.strictEqual(scoped.rules.find((x) => x.section === '§8-rm-rf-var').localHits, 1);
  });
  t('audit() clamps an out-of-range days (no RangeError for programmatic callers)', () => {
    let a;
    assert.doesNotThrow(() => { a = audit({ days: 1e30, now: NOW, logPath: log }); });
    assert.strictEqual(a.days, 30, 'clamped to default');
    assert.ok(a.windowStartIso, 'toISOString did not throw');
  });

  // --- Phase 3: byProject aggregation -------------------------------------
  const projRows = path.join(tmp, 'projects.jsonl');
  fs.writeFileSync(projRows, [
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var', project: '-home-user-alpha' },
    { ts: day(1), hook: 'banned-vocab',    event: 'block',    spec_section: '§10-V',        project: '-home-user-alpha' },
    { ts: day(1), hook: 'session-start',   event: 'context',  spec_section: null,           project: '-home-user-alpha' }, // lifecycle, not enforcement
    { ts: day(2), hook: 'banned-vocab',    event: 'advisory', spec_section: '§10-V',        project: '-home-user-beta' },
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var' },                              // no project → (none)
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var', project: '-home-user-gamma' },
    { ts: day(2), hook: 'pre-bash-safety', event: 'block',    spec_section: '§8-rm-rf-var', project: '-home-user-gamma' }, // same section twice → sections count must accumulate to 2
    { ts: day(1), hook: 'pre-bash-safety', event: 'advisory', spec_section: null,           project: '-home-user-gamma' }, // ENFORCEMENT event with NO section: must bump total/enforcement but the `sec !== '(none)'` guard must keep it OUT of sections
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
  t('byProject: gamma null-section ENFORCEMENT row bumps total/enforcement but is excluded from sections (isolates the sec !== "(none)" guard, unlike the lifecycle-event row above)', () => {
    assert.strictEqual(ap.byProject['-home-user-gamma'].total, 3);
    assert.strictEqual(ap.byProject['-home-user-gamma'].enforcement, 3);
    assert.ok(!('(none)' in ap.byProject['-home-user-gamma'].sections));
  });
  t('byProject: gamma sections accumulates a repeated section hit to 2, not 1', () => {
    assert.strictEqual(ap.byProject['-home-user-gamma'].sections['§8-rm-rf-var'], 2);
  });

  // --- Phase 3: --project filter + parser ---------------------------------
  const apAlpha = audit({ days: 30, now: NOW, logPath: projRows, project: 'ALPHA' });
  t('audit --project filters rows by case-insensitive substring', () => {
    assert.deepStrictEqual(Object.keys(apAlpha.byProject), ['-home-user-alpha']);
    assert.strictEqual(apAlpha.inWindow, 3);
  });
  t('audit --project with no match yields empty aggregates', () => {
    const none = audit({ days: 30, now: NOW, logPath: projRows, project: 'zzz' });
    assert.strictEqual(none.inWindow, 0);
    assert.deepStrictEqual(none.byProject, {});
    assert.deepStrictEqual(none.bySection, {});
  });
  t('parseDaysArg returns project on --project=', () => {
    assert.strictEqual(parseDaysArg(['--project=foo']).project, 'foo');
  });
  t('parseDaysArg: absent --project → project null', () => {
    assert.strictEqual(parseDaysArg(['--days=7']).project, null);
  });
  t('parseDaysArg rejects empty --project=', () => {
    assert.strictEqual(parseDaysArg(['--project=']).error, 'invalid --project value: (empty)');
  });
  t('parseDaysArg rejects duplicate --project', () => {
    assert.strictEqual(parseDaysArg(['--project=a', '--project=b']).error, 'duplicate option: --project');
  });
  t('parseDaysArg accepts --days and --project together', () => {
    const p = parseDaysArg(['--days=7', '--project=x']);
    assert.strictEqual(p.days, 7);
    assert.strictEqual(p.project, 'x');
  });

  // --- Phase 3: audit report block + CLI ----------------------------------
  t('audit report includes a by-project block with enforcement/total', () => {
    const rep = formatReport(audit({ days: 30, now: NOW, logPath: projRows }));
    assert.ok(/by project \(enforcement \/ total\):/.test(rep), 'missing by-project header');
    assert.ok(/-home-user-alpha\s+2 \/ +3\b/.test(rep), 'missing alpha line; got:\n' + rep);
  });
  t('audit report by-project line has no trailing whitespace when a project has zero enforcement hits (trimEnd guard)', () => {
    const lifecycleOnlyRows = path.join(tmp, 'lifecycle-only.jsonl');
    fs.writeFileSync(lifecycleOnlyRows, [
      { ts: day(1), hook: 'session-start', event: 'context', spec_section: null, project: '-home-user-lifecycle-only' },
      { ts: day(2), hook: 'session-start', event: 'context', spec_section: null, project: '-home-user-lifecycle-only' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const a = audit({ days: 30, now: NOW, logPath: lifecycleOnlyRows });
    assert.strictEqual(a.byProject['-home-user-lifecycle-only'].total, 2);
    assert.strictEqual(a.byProject['-home-user-lifecycle-only'].enforcement, 0);
    assert.deepStrictEqual(a.byProject['-home-user-lifecycle-only'].sections, {});

    const rep = formatReport(a);
    const projLine = rep.split('\n').find((l) => l.includes('-home-user-lifecycle-only'));
    assert.ok(projLine, 'missing lifecycle-only project line; got:\n' + rep);
    assert.strictEqual(projLine, projLine.trimEnd(), 'project line has trailing whitespace: ' + JSON.stringify(projLine));
    assert.ok(!/ +$/m.test(rep), 'report has a line with trailing whitespace:\n' + rep);
  });
  t('audit CLI accepts --project, exits 0, and filters the by-project block to just that project', () => {
    // Fresh, independently-rooted sandbox (NOT the outer `tmp`): CODEX_HOME →
    // P.logPath() resolves to <cliHome>/logs/agentsmd.jsonl, which must exist
    // for this test to be discriminating. (The outer `tmp` fixtures above are
    // written directly under `tmp`, not under `tmp/logs/`, so pointing the CLI
    // at `tmp` would read an empty/absent log and the by-project header would
    // print regardless of whether --project filtering actually happened.)
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-cli-proj.'));
    try {
      fs.mkdirSync(path.join(cliHome, 'logs'), { recursive: true });
      const cliLog = path.join(cliHome, 'logs', 'agentsmd.jsonl');
      // CLI uses real Date.now() for its window (no `now` override available
      // from the outside) — use real "yesterday", not the fixed NOW/day() fixture helpers.
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      fs.writeFileSync(cliLog, [
        { ts: yesterday, hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', project: '-home-user-alpha-project' },
        { ts: yesterday, hook: 'banned-vocab',    event: 'block', spec_section: '§10-V',        project: '-home-user-beta-project' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');

      const out = cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--project=alpha'],
        { env: { ...process.env, CODEX_HOME: cliHome }, encoding: 'utf8' }); // throws on non-zero exit → no throw here proves exit 0
      assert.ok(/by project/.test(out), 'missing by-project header; got:\n' + out);
      assert.ok(/-home-user-alpha-project/.test(out), 'missing alpha project line; got:\n' + out);
      assert.ok(!/beta-project/.test(out), 'beta project leaked into --project=alpha filtered output; got:\n' + out);
    } finally {
      fs.rmSync(cliHome, { recursive: true, force: true });
    }
  });
  t('audit CLI rejects empty --project=', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--project='],
        { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /invalid --project value: \(empty\)/.test(String(e.stderr))
    );
  });

  // --- Phase 3: rules.js project scope ------------------------------------
  const { formatReport: rulesFormat } = require('../rules');
  const raProj = rulesAudit({ days: 30, now: NOW, logPath: projRows });
  t('rulesAudit reports projectCount (distinct real projects, (none) excluded)', () => {
    assert.strictEqual(raProj.projectCount, 3);
    assert.strictEqual(raProj.projectFilter, null);
  });
  t('rulesAudit --project sets projectFilter + matchedSlugs, but keeps telemetryRows/projectCount cross-project', () => {
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    assert.strictEqual(scoped.projectFilter, 'alpha');
    assert.strictEqual(scoped.matchedSlugs, 1); // only the alpha slug matches the substring filter
    assert.strictEqual(scoped.telemetryRows, 8); // cross-project total (all 8 fixture rows), NOT narrowed to alpha's 3
    assert.strictEqual(scoped.projectCount, 3); // cross-project count (alpha/beta/gamma), unchanged by scoping
  });
  t('rules report: spans-N by default, informational-lens note w/ matched-slug count when scoped', () => {
    assert.ok(/telemetry spans 3 project\(s\)/.test(rulesFormat(raProj)));
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    const rep = rulesFormat(scoped);
    assert.ok(/scoped to project filter 'alpha' \(1 slug\(s\)\)/.test(rep), 'missing scoped header w/ matched-slug count; got:\n' + rep);
    assert.ok(/demote signals remain cross-project/.test(rep));
  });
  t('rules demote semantics unchanged under project scoping (regression, alpha)', () => {
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    const r = scoped.rules.find((x) => x.section === '§8-rm-rf-var');
    assert(r && r.signal === 'active', 'got ' + (r && r.signal));
  });
  t('rules demote signal stays cross-project when scoped to a project with ZERO hits on that rule (regression, beta) — the bug this fix closes', () => {
    // -home-user-beta has no §8-rm-rf-var row at all (only a §10-V advisory) —
    // if rulesAudit wrongly narrowed the signal-computing audit to --project,
    // §8-rm-rf-var would read 0 hits here and flag as demote-candidate even
    // though it fires plenty cross-project (alpha + (none) + gamma×2 = 4 hits).
    const scopedBeta = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'beta' });
    const r = scopedBeta.rules.find((x) => x.section === '§8-rm-rf-var');
    assert(r && r.signal === 'active', 'got ' + (r && r.signal) + ' — signal leaked project scoping');
    assert.ok(!scopedBeta.demoteCandidates.some((x) => x.section === '§8-rm-rf-var'), '§8-rm-rf-var wrongly flagged as demote-candidate when scoped to beta');
    assert.strictEqual(scopedBeta.matchedSlugs, 1); // just the beta slug matches
  });
  t('rules CLI accepts --project and scopes the governance header to exactly one matched slug', () => {
    // Mirrors the Task 3 audit-CLI discriminating fix (agentsmd-cli-proj /
    // cliHome): a fresh, independently-rooted CODEX_HOME with its own logs/
    // dir, seeded with enforcement rows for TWO distinct projects. This fails
    // if --project forwarding is dropped anywhere: a fully-dropped forward
    // (rulesAudit never receives `project`) prints the default "telemetry
    // spans …" line instead of a scoped line at all; a forward that reaches
    // rulesAudit but not its internal audit() call would still scope-print
    // but show "(2 slug(s))" since both projects would remain in byProject.
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-rules-cli-proj.'));
    try {
      fs.mkdirSync(path.join(cliHome, 'logs'), { recursive: true });
      const cliLog = path.join(cliHome, 'logs', 'agentsmd.jsonl');
      // CLI uses real Date.now() for its window (no `now` override available
      // from the outside) — use real "yesterday", not the fixed NOW/day() fixture helpers.
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      fs.writeFileSync(cliLog, [
        { ts: yesterday, hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', project: '-home-user-alpha-project' },
        { ts: yesterday, hook: 'banned-vocab',    event: 'block', spec_section: '§10-V',        project: '-home-user-beta-project' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');

      const out = cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--project=alpha'],
        { env: { ...process.env, CODEX_HOME: cliHome }, encoding: 'utf8' }); // throws on non-zero exit → no throw here proves exit 0
      assert.ok(/governance/.test(out), 'missing governance header; got:\n' + out);
      assert.ok(/scoped to project filter 'alpha' \(1 slug\(s\)\)/.test(out), 'missing scoped header w/ exactly 1 slug; got:\n' + out);
    } finally {
      fs.rmSync(cliHome, { recursive: true, force: true });
    }
  });

  // --- A-rich: per-rule local-hits annotation ---
  t('rulesAudit: localHits null when unscoped', () => {
    const r = raProj.rules.find((x) => x.section === '§8-rm-rf-var');
    assert.strictEqual(r.localHits, null);
  });
  t('rulesAudit --project: localHits = enforcement within filter, hits stays cross-project', () => {
    const scopedAlpha = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    const r8 = scopedAlpha.rules.find((x) => x.section === '§8-rm-rf-var');
    assert.strictEqual(r8.hits, 4, 'global hits unchanged');   // cross-project
    assert.strictEqual(r8.localHits, 1, 'alpha-local §8 hits'); // within filter
    assert.strictEqual(r8.signal, 'active', 'verdict unchanged');
    const rV = scopedAlpha.rules.find((x) => x.section === '§10-V');
    assert.strictEqual(rV.localHits, 1);
  });
  t('rules report shows local:<n> only when scoped', () => {
    const scopedAlpha = rulesFormat(rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' }));
    assert.ok(/§8-rm-rf-var\b.*\blocal:1\b/.test(scopedAlpha), 'missing local:1; got:\n' + scopedAlpha);
    assert.ok(/hits = cross-project; local = within filter/.test(scopedAlpha));
    assert.ok(!/local:/.test(rulesFormat(raProj)), 'unscoped report must not show local:');
  });
  t('rulesAudit unscoped: matchedSlugs falls back to projectCount', () => {
    assert.strictEqual(raProj.matchedSlugs, raProj.projectCount);
  });
  t('rulesAudit --project: self-enforced (null-section) rule has localHits null', () => {
    const scopedAlpha = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    const selfRule = scopedAlpha.rules.find((x) => x.enforcement === 'self');
    assert.ok(selfRule, 'expected a self-enforced rule in the manifest');
    assert.strictEqual(selfRule.section, null);
    assert.strictEqual(selfRule.localHits, null);
  });

  const ra = rulesAudit({ days: 30, now: NOW, logPath: log });
  const opportunityLog = path.join(tmp, 'rule-opportunities.jsonl');
  const opportunityRules = path.join(tmp, 'rule-opportunities.json');
  const opportunityRows = [];
  for (let i = 1; i <= 5; i++) {
    opportunityRows.push({
      ts: day(i), hook: 'gate', event: 'observe', spec_section: '§evaluated-clean',
      session_id: `clean-${i}`, eligible: true, evaluated: true,
    });
    opportunityRows.push({
      ts: day(i), hook: 'gate', event: 'observe', spec_section: '§eligible-unevaluated',
      session_id: `unevaluated-${i}`, eligible: true, evaluated: false,
    });
  }
  opportunityRows.push({
    ts: day(1), hook: 'gate', event: 'block', spec_section: '§active-rule',
    session_id: 'active-1',
  });
  opportunityRows.push(
    { ts: day(1), hook: 'gate', event: 'observe', spec_section: '§bypassed-rule', session_id: 'bypass-1', eligible: true, evaluated: false },
    { ts: day(1), hook: 'gate', event: 'bypass', spec_section: '§bypassed-rule', session_id: 'bypass-1' },
  );
  for (let i = 1; i <= 5; i++) {
    // R5-01/M-05: a scan that ran but found no rule-triggering shape (e.g. a last
    // message with no value claim) records an explicit eligible:false row — the
    // scan is visible, yet contributes nothing to the opportunity denominator.
    opportunityRows.push({
      ts: day(i), hook: 'gate', event: 'observe', spec_section: '§ineligible-scan',
      session_id: `ineligible-${i}`, eligible: false, evaluated: false,
    });
    opportunityRows.push({
      ts: day(i), hook: 'gate', event: 'observe', spec_section: '§proxy-rule',
      session_id: `proxy-${i}`, eligible: true, evaluated: true,
    });
  }
  fs.writeFileSync(opportunityLog, opportunityRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(opportunityRules, JSON.stringify({
    live_sections: ['§no-opportunity', '§evaluated-clean', '§eligible-unevaluated', '§active-rule', '§bypassed-rule', '§ineligible-scan', '§proxy-rule'],
    rules: [
      { id: 'no-opportunity', scope: 'core', enforcement: 'hook', rule_hits_section: '§no-opportunity' },
      { id: 'evaluated-clean', scope: 'core', enforcement: 'hook', rule_hits_section: '§evaluated-clean' },
      { id: 'eligible-unevaluated', scope: 'core', enforcement: 'hook', rule_hits_section: '§eligible-unevaluated' },
      { id: 'active-rule', scope: 'core', enforcement: 'hook', rule_hits_section: '§active-rule' },
      { id: 'bypassed-rule', scope: 'core', enforcement: 'hook', rule_hits_section: '§bypassed-rule' },
      { id: 'ineligible-scan', scope: 'core', enforcement: 'hook', rule_hits_section: '§ineligible-scan' },
      { id: 'proxy-rule', scope: 'core', enforcement: 'hook', rule_hits_section: '§proxy-rule', demote_policy: 'proxy' },
    ],
  }));
  const opportunityAudit = audit({ days: 30, now: NOW, logPath: opportunityLog });
  const opportunityGovernance = rulesAudit({
    days: 30, now: NOW, logPath: opportunityLog, hardRulesPath: opportunityRules,
  });
  t('audit: observe rows expose per-rule eligible/evaluated session denominators without enforcement hits', () => {
    const clean = opportunityAudit.bySection['§evaluated-clean'];
    assert.strictEqual(clean.enforcement, 0);
    assert.strictEqual(clean.eligibleSessions, 5);
    assert.strictEqual(clean.evaluatedSessions, 5);
  });
  t('rules: unrelated sessions do not demote a rule with no opportunity', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'no-opportunity');
    assert.strictEqual(r.eligibleSessions, 0);
    assert.strictEqual(r.evaluatedSessions, 0);
    assert.strictEqual(r.signal, 'no-opportunity');
  });
  t('rules: five evaluated-clean opportunities can support demotion', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'evaluated-clean');
    assert.strictEqual(r.eligibleSessions, 5);
    assert.strictEqual(r.evaluatedSessions, 5);
    assert.strictEqual(r.hits, 0);
    assert.strictEqual(r.signal, 'demote-candidate');
  });
  t('rules: eligible but unevaluated opportunities cannot support demotion', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'eligible-unevaluated');
    assert.strictEqual(r.eligibleSessions, 5);
    assert.strictEqual(r.evaluatedSessions, 0);
    assert.strictEqual(r.hits, 0);
    assert.strictEqual(r.signal, 'insufficient-evaluation');
  });
  t('rules: enforcement remains an active signal and implies an evaluated opportunity for legacy rows', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'active-rule');
    assert.strictEqual(r.eligibleSessions, 1);
    assert.strictEqual(r.evaluatedSessions, 1);
    assert.strictEqual(r.hits, 1);
    assert.strictEqual(r.signal, 'active');
  });
  t('rules: explicit unevaluated observation overrides legacy inference for a same-session bypass', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'bypassed-rule');
    assert.strictEqual(r.eligibleSessions, 1);
    assert.strictEqual(r.evaluatedSessions, 0);
    assert.strictEqual(r.hits, 1);
    assert.strictEqual(r.signal, 'active');
  });
  t('rules: explicit eligible:false scan rows never enter the opportunity denominator', () => {
    const b = opportunityAudit.bySection['§ineligible-scan'];
    assert.strictEqual(b.total, 5, 'the scans themselves stay visible');
    assert.strictEqual(b.eligibleSessions, 0);
    assert.strictEqual(b.evaluatedSessions, 0);
    const r = opportunityGovernance.rules.find((x) => x.id === 'ineligible-scan');
    assert.strictEqual(r.signal, 'no-opportunity');
    assert(!opportunityGovernance.demoteCandidates.some((x) => x.id === 'ineligible-scan'));
  });
  t('rules: proxy-policy rule with full exposure and 0 hits routes to hook-value-review, never demote', () => {
    const r = opportunityGovernance.rules.find((x) => x.id === 'proxy-rule');
    assert.strictEqual(r.eligibleSessions, 5);
    assert.strictEqual(r.evaluatedSessions, 5);
    assert.strictEqual(r.hits, 0);
    assert.strictEqual(r.signal, 'hook-value-review');
    assert(!opportunityGovernance.demoteCandidates.some((x) => x.id === 'proxy-rule'), 'proxy metric must never be a demote-candidate');
    assert(opportunityGovernance.hookValueReview.some((x) => x.id === 'proxy-rule'));
  });
  t('rules: §8-rm-rf-var is active (has enforcement hits)', () => { const r = ra.rules.find((x) => x.section === '§8-rm-rf-var'); assert(r && r.signal === 'active', 'got ' + (r && r.signal)); });
  t('rules: extended-scope §E3-ship-baseline with no opportunity is not reviewed from unrelated sessions', () => {
    const r = ra.rules.find((x) => x.id === '§E3-ship-baseline');
    assert(r && r.signal === 'no-opportunity', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§E3-ship-baseline'), 'extended rule must not be a core demote-candidate');
    assert(!ra.hookValueReview.some((x) => x.id === '§E3-ship-baseline'));
  });
  t('rules: immutable §8.V4 with no opportunity is no-opportunity (never dilution)', () => {
    const r = ra.rules.find((x) => x.id === '§8.V4-sandbox-disposal');
    assert(r && r.signal === 'no-opportunity', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§8.V4-sandbox-disposal'), '§8 immutable rule must never be a demote-candidate');
  });
  t('rules: a core standard-policy live rule with unrelated global sessions has no opportunity', () => {
    const r = ra.rules.find((x) => x.id === '§10-four-section-order');
    assert(r && r.signal === 'no-opportunity', 'got ' + (r && r.signal));
  });
  // Iron Law #2 gained a Stop observer (roadmap C4) so it is now enforcement 'both' +
  // live, but demote_policy 'deterrence' keeps it out of demote-candidates: 0 hits means
  // no unanchored fix claim arose (discipline working), not dilution — a foundational
  // Iron Law stays core regardless of hit count.
  t('rules: Iron Law #2 without a rule-specific opportunity is no-opportunity, never a demote-candidate', () => {
    const r = ra.rules.find((x) => x.id === '§6-iron-law-2');
    assert(r && r.signal === 'no-opportunity', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§6-iron-law-2'), 'a foundational Iron Law must never be a demote-candidate');
  });
  t('rules: a still-self-enforced Iron Law (#1) is labeled self-enforced', () => { const r = ra.rules.find((x) => x.id === '§6-iron-law-1'); assert(r && r.signal === 'self-enforced', 'got ' + (r && r.signal)); });
  t('rules: overlapping subclauses inherit governance instead of duplicating demote signals', () => {
    for (const id of ['§6-bugfix-anchor', '§8-env-key-commit']) {
      const r = ra.rules.find((x) => x.id === id);
      assert(r && r.signal === 'inherited', `${id} got ${r && r.signal}`);
      assert(r.governanceParent, `${id} lacks a governance parent`);
      assert(!ra.demoteCandidates.some((x) => x.id === id), `${id} duplicated a demote candidate`);
    }
  });
  t('rules: demoteCandidates only include hook-enforced rules', () => assert(ra.demoteCandidates.every((r) => r.enforcement === 'hook' || r.enforcement === 'both')));
  // Thin window: another rule's activity is not opportunity for a 0-hit rule.
  const thin = path.join(tmp, 'thin.jsonl');
  fs.writeFileSync(thin, [
    { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'only-one-session' },
    { ts: day(2), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'only-one-session' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const raThin = rulesAudit({ days: 30, now: NOW, logPath: thin });
  t('rules: thin window → unrelated 0-hit live rule = no-opportunity, no demotes', () => {
    assert.strictEqual(raThin.sessionCount, 1);
    assert.strictEqual(raThin.lowExposure, false);
    assert.strictEqual(raThin.demoteCandidates.length, 0, 'no demote off thin exposure');
    const r = raThin.rules.find((x) => x.id === '§10-four-section-order');
    assert(r && r.signal === 'no-opportunity', 'got ' + (r && r.signal));
    const r8 = raThin.rules.find((x) => x.id === '§8-rm-rf-var');
    assert(r8 && r8.signal === 'active', 'active despite thin window: got ' + (r8 && r8.signal));
  });

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

  // E4 review cadence — a governance-CADENCE signal (is review being run?), orthogonal
  // to the hit-based demote signals: a rule can be 'active' yet due for review. The
  // cadence comes from the manifest governance block, never the --days query window,
  // and a null review on a freshly-added rule is pending-first-review, NOT overdue.
  t('rules: real manifest — every rule carries an explicit review status', () => {
    const allowed = new Set(['fresh', 'pending-first-review', 'review-due']);
    assert.ok(ra.rules.every((r) => allowed.has(r.reviewStatus)), 'unknown reviewStatus present');
    assert.ok(ra.reviewCadenceDays > 0, 'cadence must come from the governance block');
    const { fresh, pendingFirstReview, reviewDue } = ra.reviewSummary;
    assert.strictEqual(fresh + pendingFirstReview + reviewDue, ra.rules.length, 'statuses must partition the manifest');
    assert.ok(ra.nextReviewDueIso, 'next due date must be computable from the data');
  });
  const cadenceFix = path.join(tmp, 'cadence-rules.json');
  fs.writeFileSync(cadenceFix, JSON.stringify({
    live_sections: [],
    governance: { review_cadence_days: 28 },
    rules: [
      { id: 'r-recent', scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(90), last_demote_review: day(5) },   // reviewed within cadence → fresh
      { id: 'r-old',    scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(90), last_demote_review: day(60) },  // review older than cadence → due
      { id: 'r-new',    scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(3),  last_demote_review: null },     // null but just added → pending, not overdue
      { id: 'r-null',   scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(90), last_demote_review: null },     // null past cadence → due
      { id: 'r-bad',    scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(90), last_demote_review: 'not-a-date' }, // unparseable → due (safer)
    ],
  }));
  const raCadence = rulesAudit({ days: 7, now: NOW, logPath: empty, hardRulesPath: cadenceFix });
  t('rules: review-due = past-cadence + aged-null + unparseable; fresh review and fresh null stay out', () => {
    const ids = raCadence.reviewDue.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, ['r-bad', 'r-null', 'r-old']);
    assert.strictEqual(raCadence.rules.find((x) => x.id === 'r-recent').reviewStatus, 'fresh');
    assert.strictEqual(raCadence.rules.find((x) => x.id === 'r-new').reviewStatus, 'pending-first-review');
    assert.strictEqual(raCadence.reviewCadenceDays, 28, 'cadence from governance block, not --days=7');
  });
  t('rules: enforcement:external routes to external-audit (declared enum, no rule uses it yet)', () => {
    // `external` is a documented enforcement value (manifest _doc: self | hook |
    // external | both) that no rule currently carries, so the branch shipped
    // unexercised. Deleting it would silently reclassify a future external rule
    // as self-enforced; covering it costs one fixture.
    const extFix = path.join(tmp, 'external-rules.json');
    fs.writeFileSync(extFix, JSON.stringify({
      live_sections: [],
      governance: { review_cadence_days: 28 },
      rules: [
        { id: 'r-ext', scope: 'core', enforcement: 'external', rule_hits_section: null, added_at: day(2), last_demote_review: day(2) },
        { id: 'r-self', scope: 'core', enforcement: 'self', rule_hits_section: null, added_at: day(2), last_demote_review: day(2) },
      ],
    }));
    const ra = rulesAudit({ days: 30, now: NOW, logPath: empty, hardRulesPath: extFix });
    assert.strictEqual(ra.rules.find((r) => r.id === 'r-ext').signal, 'external-audit');
    assert.strictEqual(ra.rules.find((r) => r.id === 'r-self').signal, 'self-enforced');
  });
  t('rules and doctor read the SAME cadence classifier over one fixture (no hand-mirrored copy)', () => {
    // The two surfaces answered "is this review current?" with two copies of the
    // predicate and diverged once (v4.19.1 unparseable-stamp fix). They now share
    // lib/governance-review; this asserts the WIRING, not just the pure function.
    const GOV = require('../lib/governance-review');
    const { classifyGovernanceReview: doctorClassify } = require('../doctor');
    const hr = JSON.parse(fs.readFileSync(cadenceFix, 'utf8'));
    const shared = GOV.classifyGovernanceReview(hr, NOW);
    assert.deepStrictEqual(
      raCadence.reviewDue.map((s) => s.id).sort(),
      shared.overdue.slice().sort(),
      'rules.js review-due set must equal the shared classifier'
    );
    assert.deepStrictEqual(
      doctorClassify(hr, NOW).overdue.slice().sort(),
      shared.overdue.slice().sort(),
      'doctor must consume the same classifier'
    );
    for (const row of shared.rows) {
      assert.strictEqual(
        raCadence.rules.find((x) => x.id === row.id).reviewStatus,
        row.status,
        `per-rule status drift on ${row.id}`
      );
    }
    assert.strictEqual(raCadence.reviewCadenceDays, shared.cadenceDays);
  });
  t('rules formatReport renders the review-cadence block with the due id', () => {
    const rep = rulesFormat(raCadence);
    assert.ok(/review cadence 28d/.test(rep), 'missing cadence summary:\n' + rep);
    assert.ok(/due for a demote-review/.test(rep), 'missing review-due block:\n' + rep);
    assert.ok(/r-old \(/.test(rep), 'should list the due rule id');
  });

  t('audit CLI rejects invalid --days instead of silently using default', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=abc'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /invalid --days value: abc/.test(String(e.stderr))
    );
  });
  t('audit CLI rejects oversized --days instead of throwing a RangeError', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=999999999999999999999999999999'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /invalid --days value: 999999999999999999999999999999/.test(String(e.stderr)) && !/RangeError/.test(String(e.stderr))
    );
  });
  t('audit CLI rejects duplicate --days instead of silently taking the last value', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'audit.js'), '--days=7', '--days=30'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /duplicate option: --days/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects unknown options instead of silently using default', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--wat'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /unknown option: --wat/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects oversized --days instead of throwing a RangeError', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--days=999999999999999999999999999999'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /invalid --days value: 999999999999999999999999999999/.test(String(e.stderr)) && !/RangeError/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects duplicate --days instead of silently taking the last value', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--days=7', '--days=30'], { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /duplicate option: --days/.test(String(e.stderr))
    );
  });
  t('rules CLI rejects empty --project=', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--project='],
        { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /invalid --project value: \(empty\)/.test(String(e.stderr))
    );
  });
  t('rules CLI --include-test is documented and includes tagged telemetry end-to-end', () => {
    const cliHome = path.join(tmp, 'rules-include-test-home');
    fs.mkdirSync(path.join(cliHome, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(cliHome, 'logs', 'agentsmd.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), hook: 'pre-bash-safety', event: 'block',
      spec_section: '§8-rm-rf-var', session_id: 'tagged-cli', tag: 'test',
    }) + '\n');
    const script = path.join(__dirname, '..', 'rules.js');
    const dispatcher = path.join(__dirname, '..', '..', 'bin', 'agentsmd.js');
    const help = cp.execFileSync('node', [script, '--help'], { encoding: 'utf8' });
    const topHelp = cp.execFileSync('node', [dispatcher, '--help'], { encoding: 'utf8' });
    const out = cp.execFileSync('node', [script, '--include-test'], {
      env: { ...process.env, CODEX_HOME: cliHome }, encoding: 'utf8',
    });
    assert.match(help, /--include-test/);
    assert.match(topHelp, /rules \[--days=N\] \[--project=S\] \[--include-test\]/);
    assert.match(out, /§8-rm-rf-var\s+hits:1\b/);
  });

  // --- Adopt from claudemd: byFailOpen + denyByProjectClass (A1) -----------
  // fail-open = silently-skipped enforcement (jq/prereq missing): it leaves a
  // row but has no enforcement effect, so exit code never reveals it.
  // denyByProjectClass splits blocking denies into self-dogfood vs external so
  // agentsmd's OWN repo traffic can't inflate apparent downstream enforcement.
  const obsRows = path.join(tmp, 'observability.jsonl');
  fs.writeFileSync(obsRows, [
    { ts: day(1), hook: 'banned-vocab',    event: 'fail-open', spec_section: '§hooks-fail-open', extra: { reason: 'jq-missing' }, project: '-home-dev-agentsmd' },
    { ts: day(2), hook: 'banned-vocab',    event: 'fail-open', spec_section: '§hooks-fail-open', extra: { reason: 'jq-missing' }, project: '-home-dev-agentsmd' },
    { ts: day(1), hook: 'pre-bash-safety', event: 'fail-open', spec_section: '§hooks-fail-open', extra: { reason: 'not-a-repo' }, project: '-home-user-app' },
    { ts: day(1), hook: 'memory-read',     event: 'fail-open', spec_section: '§hooks-fail-open' },                                                                 // no extra.reason → (unspecified)
    { ts: day(1), hook: 'banned-vocab',    event: 'block',     spec_section: '§10-V',            project: '-mnt-data-ssd-dev-projects-agentsmd' },                 // self (trailing -agentsmd)
    { ts: day(1), hook: 'banned-vocab',    event: 'block',     spec_section: '§10-V',            project: '-home-user-app' },                                      // external
    { ts: day(2), hook: 'banned-vocab',    event: 'block',     spec_section: '§10-V',            project: '-home-user-myagentsmd' },                               // external, NOT self (guards the (^|-) anchor)
    { ts: day(1), hook: 'pre-bash-safety', event: 'block',     spec_section: '§8-rm-rf-var' },                                                                     // no project → unknown
    { ts: day(1), hook: 'banned-vocab',    event: 'advisory',  spec_section: '§10-V',            project: '-home-user-app' },                                      // advisory ≠ blocking deny → excluded
    { ts: day(1), hook: 'banned-vocab',    event: 'bypass',    spec_section: '§10-V',            project: '-home-user-app' },                                      // bypass ≠ blocking deny → excluded
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ao = audit({ days: 30, now: NOW, logPath: obsRows });

  t('byFailOpen groups fail-open rows by (hook, reason)', () => {
    assert.strictEqual(ao.byFailOpen['banned-vocab'].total, 2);
    assert.strictEqual(ao.byFailOpen['banned-vocab'].byReason['jq-missing'], 2);
    assert.strictEqual(ao.byFailOpen['pre-bash-safety'].total, 1);
    assert.strictEqual(ao.byFailOpen['pre-bash-safety'].byReason['not-a-repo'], 1);
  });
  t('byFailOpen: missing extra.reason → (unspecified)', () => {
    assert.strictEqual(ao.byFailOpen['memory-read'].byReason['(unspecified)'], 1);
  });
  t('byFailOpen keyed by hook, counts only fail-open (banned-vocab has 4 non-fail-open rows too)', () => {
    assert.strictEqual(ao.byFailOpen['banned-vocab'].total, 2);
    assert.ok(!('§10-V' in ao.byFailOpen));
  });
  t('denyByProjectClass splits blocking denies self/external/unknown; advisory+bypass excluded', () => {
    const bv = ao.denyByProjectClass['banned-vocab'];
    assert.strictEqual(bv.total, 3);    // 3 block rows only (advisory + bypass excluded)
    assert.strictEqual(bv.self, 1);     // trailing -agentsmd
    assert.strictEqual(bv.external, 2); // -home-user-app + -home-user-myagentsmd
    assert.strictEqual(bv.unknown, 0);
  });
  t('denyByProjectClass: row without a project → unknown', () => {
    const pb = ao.denyByProjectClass['pre-bash-safety'];
    assert.strictEqual(pb.total, 1);
    assert.strictEqual(pb.unknown, 1);
    assert.strictEqual(pb.self, 0);
    assert.strictEqual(pb.external, 0);
  });
  t('classifyProject: agentsmd path segment = self (repo + QA sandboxes); -myagentsmd = external; empty/(none)/null = unknown', () => {
    assert.strictEqual(classifyProject('-mnt-data-ssd-dev-projects-agentsmd'), 'self');
    assert.strictEqual(classifyProject('agentsmd'), 'self');
    // R6-04: agentsmd-generated working dirs are self, not external field data
    assert.strictEqual(classifyProject('-home-sds--claude-tmp-agentsmd-conformance-XYZ-case-auth-hard-tidy'), 'self');
    assert.strictEqual(classifyProject('-home-sds--claude-tmp-agentsmd-blackbox-XYZ-proj'), 'self');
    assert.strictEqual(classifyProject('-mnt-data-ssd-dev-projects-agentsmd-qa-loop-4-1'), 'self');
    assert.strictEqual(classifyProject('-home-user-myagentsmd'), 'external');
    assert.strictEqual(classifyProject('-home-user-app'), 'external');
    assert.strictEqual(classifyProject(''), 'unknown');
    assert.strictEqual(classifyProject('(none)'), 'unknown');
    assert.strictEqual(classifyProject(null), 'unknown');
  });
  t('audit report includes fail-open + deny-by-class blocks, no trailing whitespace', () => {
    const rep = formatReport(ao);
    assert.ok(/fail-open events \(silent enforcement loss\) by hook:/.test(rep), 'missing fail-open header; got:\n' + rep);
    assert.ok(/banned-vocab\s+2\s+jq-missing:2/.test(rep), 'missing fail-open banned-vocab line; got:\n' + rep);
    assert.ok(/blocking denies by project class/.test(rep), 'missing deny-class header; got:\n' + rep);
    assert.ok(/banned-vocab\s+3\s+ext:2 self:1/.test(rep), 'missing deny-class banned-vocab line; got:\n' + rep);
    assert.ok(!/ +$/m.test(rep), 'report has a line with trailing whitespace:\n' + rep);
  });
  // --- R6: trend (2026-07-25 audit) ---------------------------------------
  {
    const tl = path.join(tmp, 'trend.jsonl');
    const row = (d, ev, sess) => ({ ts: day(d), hook: 'h', event: ev, spec_section: '§8-rm-rf-var', session_id: sess, project: '-home-user-app' });
    fs.writeFileSync(tl, [
      // older 10d bucket: 2 sessions, 1 block
      row(25, 'block', 'old-1'), row(24, 'context', 'old-2'),
      // newest 10d bucket: 1 session, 2 blocks + 2 bypasses + a fail-open
      row(2, 'block', 'new-1'), row(2, 'block', 'new-1'),
      row(2, 'bypass', 'new-1'), row(2, 'bypass', 'new-1'),
      { ts: day(2), hook: 'banned-vocab', event: 'fail-open', spec_section: null, session_id: 'new-1', extra: { reason: 'jq-missing' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const tr = trend({ days: 30, buckets: 3, now: NOW, logPath: tl });

    t('R6: buckets run oldest → newest and tile the window', () => {
      assert.strictEqual(tr.rows.length, 3);
      assert.strictEqual(tr.bucketDays, 10);
      const ends = tr.rows.map((r) => r.endIso);
      assert.deepStrictEqual([...ends].sort(), ends, 'buckets must be chronological');
    });
    t('R6: rates are per 100 sessions, so a busy window is not read as indiscipline', () => {
      const newest = tr.rows[2];
      assert.strictEqual(newest.sessions, 1);
      assert.strictEqual(newest.blocks, 2);
      assert.strictEqual(newest.bypasses, 2);
      assert.strictEqual(newest.enforcement, 4, 'block+block+bypass+bypass');
      assert.strictEqual(newest.enforcementPer100Sessions, 400);
      assert.strictEqual(newest.failOpens, 1);
      assert.ok(Math.abs(newest.bypassRate - 0.5) < 1e-9);
    });
    t('R6: an empty bucket yields null rates, never a fabricated 0%', () => {
      const mid = tr.rows[1];
      assert.strictEqual(mid.sessions, 0);
      assert.strictEqual(mid.enforcementPer100Sessions, null);
      assert.strictEqual(mid.bypassRate, null, '0 decisions is not a 0% bypass rate');
      assert.ok(/—/.test(formatTrend(tr)), 'empty bucket must print as — not 0');
    });
    t('R6: --trend is rejected by commands that do not implement it', () => {
      assert.strictEqual(parseDaysArg(['--trend'], 'agentsmd-rules').error, 'unknown option: --trend');
      assert.strictEqual(parseDaysArg(['--trend'], 'agentsmd-audit', { allowTrend: true }).trend, 3);
      assert.strictEqual(parseDaysArg(['--trend=4'], 'agentsmd-audit', { allowTrend: true }).trend, 4);
      assert.ok(/invalid --trend value/.test(parseDaysArg(['--trend=99'], 'agentsmd-audit', { allowTrend: true }).error), 'bucket ceiling unenforced');
      assert.ok(/invalid --trend value/.test(parseDaysArg(['--trend=x'], 'agentsmd-audit', { allowTrend: true }).error));
      assert.ok(/duplicate option: --trend/.test(parseDaysArg(['--trend', '--trend=3'], 'agentsmd-audit', { allowTrend: true }).error));
    });
    t('R6: trend report has no trailing whitespace and states the version-attribution gap', () => {
      const rep = formatTrend(tr);
      assert.ok(!/ +$/m.test(rep), 'trailing whitespace:\n' + rep);
      assert.ok(/no spec_version/.test(rep), 'the known gap must be stated, not implied');
    });
  }

  // --- R1: bypass governance (2026-07-25 audit) ---------------------------
  // The escape-hatch blind spot: §7-memory-read ran 29 bypasses vs 27 blocks
  // through two governance reviews without any surface reporting it.
  {
    const bp = path.join(tmp, 'bypass.jsonl');
    const mk = (ev, sess) => ({ ts: day(1), hook: 'memory-read-check', event: ev, spec_section: '§7-memory-read', session_id: sess, project: '-home-user-app' });
    fs.writeFileSync(bp, [
      mk('block', 's1'), mk('block', 's2'),
      mk('bypass', 's1'), mk('bypass', 's1'), mk('bypass', 's1'), mk('bypass', 's3'),
      // advisory must NOT dilute the rate: it has no escape hatch to use.
      { ts: day(1), hook: 'memory-read-check', event: 'advisory', spec_section: '§7-memory-read', session_id: 's4', project: '-home-user-app' },
      // a different rule's blocks must not leak into this rule's denominator
      { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 's5', project: '-home-user-app' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rb = rulesAudit({ days: 30, now: NOW, logPath: bp });
    const mem = rb.rules.find((r) => r.id === '§7-memory-read');
    const rmrf = rb.rules.find((r) => r.id === '§8-rm-rf-var');

    t('R1: bypass rate = bypass/(block+bypass), advisories excluded', () => {
      assert.strictEqual(mem.blocks, 2);
      assert.strictEqual(mem.bypasses, 4);
      assert.strictEqual(mem.bypassDecisions, 6, 'advisory must not enter the denominator');
      assert.ok(Math.abs(mem.bypassRate - 4 / 6) < 1e-9);
    });
    t('R1: distinct bypass sessions separate systemic friction from one stuck loop', () => {
      assert.strictEqual(mem.bypassSessions, 2, '4 overrides but only s1+s3 → concentrated');
      assert.strictEqual(mem.blockingSessions, 2);
    });
    t('R1: overrides confined to agentsmd itself read as dogfood, not field evasion', () => {
      // The R6-04 mistake, one layer up: the live 30d window has 35 bypasses and
      // ZERO from an external project — a finding about the operator's own
      // development days, not about downstream users routing around a gate.
      const own = path.join(tmp, 'bypass-self.jsonl');
      const mkSelf = (ev, sess) => ({ ts: day(1), hook: 'memory-read-check', event: ev, spec_section: '§7-memory-read', session_id: sess, project: '-mnt-dev-projects-agentsmd' });
      fs.writeFileSync(own, [mkSelf('block', 's1'), mkSelf('block', 's2'), mkSelf('bypass', 's1'), mkSelf('bypass', 's1'), mkSelf('bypass', 's2')]
        .map((r) => JSON.stringify(r)).join('\n') + '\n');
      const rs = rulesAudit({ days: 30, now: NOW, logPath: own });
      const m = rs.rules.find((r) => r.id === '§7-memory-read');
      assert.deepStrictEqual(m.bypassByClass, { self: 3, external: 0, unknown: 0 });
      assert.strictEqual(m.bypassSignal, 'bypass-review-self-only');
      assert.strictEqual(rs.bypassReview.length, 0, 'self-only must not claim field evidence');
      assert.strictEqual(rs.bypassReviewSelfOnly.length, 1);
      const rep = rulesFormat(rs);
      assert.ok(/dogfood, not field evidence/.test(rep), 'origin caveat missing; got:\n' + rep);
      assert.ok(!/ +$/m.test(rep));
    });
    t('R1: over-threshold bypassable rule raises bypass-review, not a verdict', () => {
      assert.strictEqual(mem.bypassSignal, 'bypass-review');
      assert.strictEqual(mem.bypassByClass.external, 4, 'fixture project is external → real field signal');
      assert.ok(rb.bypassReview.some((r) => r.id === '§7-memory-read'));
      const rep = rulesFormat(rb);
      assert.ok(/bypass governance \(escape-hatch usage/.test(rep), 'missing bypass section; got:\n' + rep);
      assert.ok(/§7-memory-read\s+\[allow-unread-memory\]\s+block:\s*2\s+bypass:\s*4\s+rate:\s*67%/.test(rep), 'missing bypass row; got:\n' + rep);
      assert.ok(/OVER-FIRES/.test(rep) && /HABITUAL/.test(rep), 'both readings must be offered, not one verdict');
      assert.ok(!/ +$/m.test(rep), 'bypass section introduced trailing whitespace');
    });
    t('R1: a non-bypassable rule is n/a — it has no escape hatch to govern', () => {
      assert.strictEqual(rmrf.bypassable, false);
      assert.strictEqual(rmrf.bypassSignal, 'n/a');
      assert.ok(!rb.bypassRows.some((r) => r.id === '§8-rm-rf-var'));
    });
    t('R1: below the decision floor a rate is withheld (1-of-1 is 100% and means nothing)', () => {
      const thin = path.join(tmp, 'bypass-thin.jsonl');
      fs.writeFileSync(thin, [mk('block', 's1'), mk('bypass', 's2')].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const rt = rulesAudit({ days: 30, now: NOW, logPath: thin });
      const m = rt.rules.find((r) => r.id === '§7-memory-read');
      assert.strictEqual(m.bypassDecisions, 2);
      assert.strictEqual(m.bypassSignal, 'insufficient-bypass-data');
      assert.strictEqual(rt.bypassReview.length, 0, 'no review prompt off 2 decisions');
    });
    t('R1: a bypassable rule that never fired reads no-bypass-data, not 0% compliance', () => {
      const none = path.join(tmp, 'bypass-none.jsonl');
      fs.writeFileSync(none, JSON.stringify({ ts: day(1), hook: 'h', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'sz' }) + '\n');
      const rn = rulesAudit({ days: 30, now: NOW, logPath: none });
      assert.strictEqual(rn.rules.find((r) => r.id === '§7-memory-read').bypassSignal, 'no-bypass-data');
    });
    t('R1: --project stays an informational lens — bypass signals remain cross-project', () => {
      const scoped = rulesAudit({ days: 30, now: NOW, logPath: bp, project: 'nonexistent-project' });
      const m = scoped.rules.find((r) => r.id === '§7-memory-read');
      assert.strictEqual(m.bypasses, 4, 'a project filter must not shrink the governance denominator');
      assert.strictEqual(m.bypassSignal, 'bypass-review');
    });
  }

  t('audit report: healthy empty fail-open state prints a reassuring line', () => {
    const clean = path.join(tmp, 'clean.jsonl');
    fs.writeFileSync(clean, [
      { ts: day(1), hook: 'banned-vocab', event: 'block', spec_section: '§10-V', project: '-home-user-app' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const a = audit({ days: 30, now: NOW, logPath: clean });
    assert.deepStrictEqual(a.byFailOpen, {});
    assert.ok(/none in window — no silently-skipped enforcement/.test(formatReport(a)));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
