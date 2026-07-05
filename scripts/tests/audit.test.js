'use strict';
// audit.test.js — proves the closed-loop read side: audit() aggregates rule-hit
// telemetry correctly (window filtering, enforcement vs lifecycle events) and
// rulesAudit() derives the right promote/demote signals against hard-rules.json.
// Synthetic telemetry + fixed `now` → deterministic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { audit, parseDaysArg, formatReport, classifyProject } = require('../audit');
const { rulesAudit } = require('../rules');
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();

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
  t('rules: §8-rm-rf-var is active (has enforcement hits)', () => { const r = ra.rules.find((x) => x.section === '§8-rm-rf-var'); assert(r && r.signal === 'active', 'got ' + (r && r.signal)); });
  t('rules: extended-scope §E3-ship-baseline w/ 0 hits = hook-value-review, not demote (nowhere to demote to)', () => {
    const r = ra.rules.find((x) => x.id === '§E3-ship-baseline');
    assert(r && r.signal === 'hook-value-review', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§E3-ship-baseline'), 'extended rule must not be a core demote-candidate');
    assert(ra.hookValueReview.some((x) => x.id === '§E3-ship-baseline'));
  });
  t('rules: immutable §8.V4 w/ 0 hits + sufficient exposure = deterrence-ok (never dilution)', () => {
    const r = ra.rules.find((x) => x.id === '§8.V4-sandbox-disposal');
    assert(r && r.signal === 'deterrence-ok', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§8.V4-sandbox-disposal'), '§8 immutable rule must never be a demote-candidate');
  });
  t('rules: a core standard-policy live rule w/ 0 hits + exposure IS a demote-candidate', () => {
    const r = ra.rules.find((x) => x.id === '§10-four-section-order');
    assert(r && r.signal === 'demote-candidate', 'got ' + (r && r.signal));
  });
  // Iron Law #2 gained a Stop observer (roadmap C4) so it is now enforcement 'both' +
  // live, but demote_policy 'deterrence' keeps it out of demote-candidates: 0 hits means
  // no unanchored fix claim arose (discipline working), not dilution — a foundational
  // Iron Law stays core regardless of hit count.
  t('rules: Iron Law #2 live via C4 observer = deterrence-ok, never a demote-candidate', () => {
    const r = ra.rules.find((x) => x.id === '§6-iron-law-2');
    assert(r && r.signal === 'deterrence-ok', 'got ' + (r && r.signal));
    assert(!ra.demoteCandidates.some((x) => x.id === '§6-iron-law-2'), 'a foundational Iron Law must never be a demote-candidate');
  });
  t('rules: a still-self-enforced Iron Law (#1) is labeled self-enforced', () => { const r = ra.rules.find((x) => x.id === '§6-iron-law-1'); assert(r && r.signal === 'self-enforced', 'got ' + (r && r.signal)); });
  t('rules: demoteCandidates only include hook-enforced rules', () => assert(ra.demoteCandidates.every((r) => r.enforcement === 'hook' || r.enforcement === 'both')));
  // Thin window: telemetry present but < MIN_EXPOSURE_SESSIONS distinct sessions →
  // a 0-hit live rule reads 'insufficient-exposure' (can't judge dilution yet), and
  // nothing is demoted. A rule WITH hits still reads 'active' (exposure gates 0-hit only).
  const thin = path.join(tmp, 'thin.jsonl');
  fs.writeFileSync(thin, [
    { ts: day(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'only-one-session' },
    { ts: day(2), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', session_id: 'only-one-session' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const raThin = rulesAudit({ days: 30, now: NOW, logPath: thin });
  t('rules: thin window → 0-hit live rule = insufficient-exposure, no demotes', () => {
    assert.strictEqual(raThin.sessionCount, 1);
    assert.strictEqual(raThin.lowExposure, true);
    assert.strictEqual(raThin.demoteCandidates.length, 0, 'no demote off thin exposure');
    const r = raThin.rules.find((x) => x.id === '§10-four-section-order');
    assert(r && r.signal === 'insufficient-exposure', 'got ' + (r && r.signal));
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
  t('rules CLI rejects empty --project=', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'rules.js'), '--project='],
        { env: { ...process.env, CODEX_HOME: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 1 && /invalid --project value: \(empty\)/.test(String(e.stderr))
    );
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
