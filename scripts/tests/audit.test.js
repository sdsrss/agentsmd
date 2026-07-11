'use strict';
// audit.test.js — proves the closed-loop read side: audit() aggregates rule-hit
// telemetry correctly (window filtering, enforcement vs lifecycle events) and
// rulesAudit() derives the right promote/demote signals against hard-rules.json.
// Synthetic telemetry + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { audit, parseDaysArg, formatReport, classifyProject, readRows } = require('../audit');
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
  fs.writeFileSync(opportunityLog, opportunityRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(opportunityRules, JSON.stringify({
    live_sections: ['§no-opportunity', '§evaluated-clean', '§eligible-unevaluated', '§active-rule', '§bypassed-rule'],
    rules: [
      { id: 'no-opportunity', scope: 'core', enforcement: 'hook', rule_hits_section: '§no-opportunity' },
      { id: 'evaluated-clean', scope: 'core', enforcement: 'hook', rule_hits_section: '§evaluated-clean' },
      { id: 'eligible-unevaluated', scope: 'core', enforcement: 'hook', rule_hits_section: '§eligible-unevaluated' },
      { id: 'active-rule', scope: 'core', enforcement: 'hook', rule_hits_section: '§active-rule' },
      { id: 'bypassed-rule', scope: 'core', enforcement: 'hook', rule_hits_section: '§bypassed-rule' },
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

  // E4 staleReviews — review-CADENCE signal (is governance being run?), orthogonal
  // to the hit-based demote signals: a rule can be 'active' yet overdue for review.
  t('rules: real manifest — every rule is stale (all last_demote_review null pre-deployment)', () => {
    assert.strictEqual(ra.staleReviews.length, ra.rules.length, 'all rules stale when none reviewed');
    assert.ok(ra.staleReviews.every((s) => s.lastDemoteReview === null), 'every stale entry carries its (null) review date');
  });
  const staleFix = path.join(tmp, 'stale-rules.json');
  fs.writeFileSync(staleFix, JSON.stringify({
    live_sections: [],
    rules: [
      { id: 'r-recent', scope: 'core', enforcement: 'self', rule_hits_section: null, last_demote_review: day(5) },   // within window → fresh
      { id: 'r-old',    scope: 'core', enforcement: 'self', rule_hits_section: null, last_demote_review: day(60) },  // before cutoff → stale
      { id: 'r-null',   scope: 'core', enforcement: 'self', rule_hits_section: null, last_demote_review: null },     // never reviewed → stale
      { id: 'r-bad',    scope: 'core', enforcement: 'self', rule_hits_section: null, last_demote_review: 'not-a-date' }, // unparseable → stale
    ],
  }));
  const raStale = rulesAudit({ days: 30, now: NOW, logPath: empty, hardRulesPath: staleFix });
  t('rules: staleReviews = null + overdue + unparseable; a within-window review is fresh', () => {
    const ids = raStale.staleReviews.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, ['r-bad', 'r-null', 'r-old']);
  });
  t('rules formatReport renders the stale-review cadence block with the overdue id', () => {
    const rep = rulesFormat(raStale);
    assert.ok(/overdue for a demote-review/.test(rep), 'missing stale-review block:\n' + rep);
    assert.ok(/r-old \(/.test(rep), 'should list the overdue rule id');
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
  t('classifyProject: trailing -agentsmd = self; -myagentsmd = external; empty/(none)/null = unknown', () => {
    assert.strictEqual(classifyProject('-mnt-data-ssd-dev-projects-agentsmd'), 'self');
    assert.strictEqual(classifyProject('agentsmd'), 'self');
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
