'use strict';
// audit.test.js — proves the closed-loop read side: audit() aggregates rule-hit
// telemetry correctly (window filtering, enforcement vs lifecycle events) and
// rulesAudit() derives the right promote/demote signals against hard-rules.json.
// Synthetic telemetry + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { audit, parseDaysArg, formatReport } = require('../audit');
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
      (e) => e.status === 1 && /invalid --project value: \(empty\)/.test(String(e.stderr))
    );
  });

  // --- Phase 3: rules.js project scope ------------------------------------
  const { formatReport: rulesFormat } = require('../rules');
  const raProj = rulesAudit({ days: 30, now: NOW, logPath: projRows });
  t('rulesAudit reports projectCount (distinct real projects, (none) excluded)', () => {
    assert.strictEqual(raProj.projectCount, 3);
    assert.strictEqual(raProj.projectFilter, null);
  });
  t('rulesAudit --project scopes telemetry + sets projectFilter', () => {
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    assert.strictEqual(scoped.projectFilter, 'alpha');
    assert.strictEqual(scoped.telemetryRows, 3);
    assert.strictEqual(scoped.projectCount, 1);
  });
  t('rules report: spans-N by default, informational-lens note when scoped', () => {
    assert.ok(/telemetry spans 3 project\(s\)/.test(rulesFormat(raProj)));
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    assert.ok(/informational lens; demote signals remain cross-project/.test(rulesFormat(scoped)));
  });
  t('rules demote semantics unchanged under project scoping (regression)', () => {
    const scoped = rulesAudit({ days: 30, now: NOW, logPath: projRows, project: 'alpha' });
    const r = scoped.rules.find((x) => x.section === '§8-rm-rf-var');
    assert(r && r.signal === 'active', 'got ' + (r && r.signal));
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
