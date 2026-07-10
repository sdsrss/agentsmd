'use strict';
// analyze.test.js — the deterministic gather/write shell behind agentsmd-analyze:
// capped ignore-aware source map, and (Task 5) size-guarded conventions injection.
// Sandboxed via temp project dirs; touches no real repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

// Create a temp project with the given files, run fn(dir), always clean up.
const withProject = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-analyze-test.'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const { gather } = require('../analyze');

// ── gather ──────────────────────────────────────────────────────────────────
withProject({
  'package.json': JSON.stringify({ name: 'g' }),
  'src/a.js': 'const x=1', 'src/b.ts': 'export const y=2',
  'node_modules/dep/i.js': 'IGN', '.gitignore': 'secret/\n', 'secret/s.js': 'IGN',
}, (dir) => {
  const g = gather(dir);
  t('gather: returns detection + files', () => assert(g.detection.language && Array.isArray(g.files)));
  t('gather: includes source files', () => assert(g.files.some(f => f.path.endsWith('src/a.js'))));
  t('gather: excludes node_modules', () => assert(!g.files.some(f => f.path.includes('node_modules'))));
  t('gather: excludes .gitignore dirs', () => assert(!g.files.some(f => f.path.includes('secret/'))));
});

// ── gather: *.ext gitignore globs (Phase-2a M3) ─────────────────────────────
withProject({
  'package.json': JSON.stringify({ name: 'gext' }),
  '.gitignore': '*.gen.js\n',
  'foo.gen.js': 'GENERATED',
  'bar.js': 'const b=1',
}, (dir) => {
  const g = gather(dir);
  t('gather: honors *.ext gitignore globs — normal file included', () => assert(g.files.some(f => f.path.endsWith('bar.js'))));
  t('gather: honors *.ext gitignore globs — glob-matched file excluded', () => assert(!g.files.some(f => f.path.endsWith('foo.gen.js'))));
});

// ── writeConventions ────────────────────────────────────────────────────────
const { writeConventions } = require('../analyze');
const AM = require('../lib/agents-md');
withProject({ 'package.json': JSON.stringify({ name: 'w' }) }, (dir) => {
  require('../init').init({ projectRoot: dir }); // seed AGENTS.md
  const target = path.join(dir, 'AGENTS.md');
  writeConventions(dir, '## Conventions\n\n- prefer const\n- no default export\n');
  const body = fs.readFileSync(target, 'utf8');
  t('write: injects into conventions block', () => assert(body.includes('- prefer const') && body.includes(AM.CONVENTIONS_BEGIN)));
  t('write: leaves the facts block intact', () => assert(body.includes(AM.PROJECT_BEGIN) && body.includes('w')));
  t('write: idempotent when unchanged', () => {
    const a = fs.readFileSync(target, 'utf8');
    writeConventions(dir, '## Conventions\n\n- prefer const\n- no default export\n');
    assert.strictEqual(a, fs.readFileSync(target, 'utf8'));
  });
  t('write: refuses oversize conventions (no truncation)', () =>
    assert.throws(() => writeConventions(dir, '## Conventions\n\n' + 'x'.repeat(7 * 1024)), /exceeds|budget|size/i));
});

// ── writeConventions: 32 KiB whole-file refuse ──────────────────────────────
withProject({ 'package.json': JSON.stringify({ name: 'w2' }) }, (dir) => {
  const target = path.join(dir, 'AGENTS.md');
  // Seed AGENTS.md with ~31 KiB of pre-existing user prose, outside any sentinel block.
  const unit = 'These are human-authored project notes kept outside any agentsmd block. ';
  const prose = unit.repeat(Math.ceil(31 * 1024 / unit.length)).slice(0, 31 * 1024);
  fs.writeFileSync(target, `# Notes\n\n${prose}\n`);
  // Conventions body stays under the 6 KiB per-block budget on its own, but
  // combined with the existing prose the whole file crosses the ~32 KiB budget.
  const conventions = '## Conventions\n\n' + '- prefer const\n'.repeat(200);
  t('write: refuses oversize AGENTS.md total (no truncation)', () =>
    assert.throws(() => writeConventions(dir, conventions), /32 KiB|discovery budget|would be/));
});

// ── conventions taxonomy: anchor stamping (Task 1) ──────────────────────────
const { stampConventionAnchors, anchorFor, DIMENSIONS } = require('../lib/conventions-taxonomy');
{
  const input = [
    '## Conventions',
    '',
    '### Naming',
    '- camelCase for variables',
    '',
    '### Made-up Section',
    '- something not in the taxonomy',
    '',
    '#### Error handling',
    '- always wrap awaits in try/catch',
  ].join('\n');
  const stamped = stampConventionAnchors(input);
  t('stamp: recognized heading gets its stable anchor', () => assert(stamped.includes('### Naming (@conv-naming)')));
  t('stamp: recognized heading at a different ATX level also gets its anchor', () => assert(stamped.includes('#### Error handling (@conv-error-handling)')));
  t('stamp: unrecognized heading left untouched', () => assert(stamped.includes('### Made-up Section') && !stamped.includes('Made-up Section (@conv')));
  t('stamp: non-heading lines untouched', () => assert(stamped.includes('- camelCase for variables')));
  t('stamp: idempotent — re-stamping already-stamped text is byte-stable', () => assert.strictEqual(stampConventionAnchors(stamped), stamped));
  t('stamp: idempotent even when the original heading has trailing whitespace', () => {
    const once = stampConventionAnchors('### Naming  \n- camelCase');
    assert.strictEqual(stampConventionAnchors(once), once);
  });
  t('stamp: anchorFor covers every declared dimension slug', () => {
    for (const d of DIMENSIONS) assert.strictEqual(anchorFor(d.heading), d.slug, d.heading);
  });
}

// ── conventions taxonomy: wired into writeConventions (Task 1) ─────────────
withProject({ 'package.json': JSON.stringify({ name: 'wdim' }) }, (dir) => {
  require('../init').init({ projectRoot: dir });
  writeConventions(dir, '## Conventions\n\n### Naming\n- camelCase for variables\n\n### Error handling\n- wrap awaits in try/catch\n');
  const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('write: stamps anchors on recognized dimension headings', () => assert(body.includes('### Naming (@conv-naming)') && body.includes('### Error handling (@conv-error-handling)')));
  t('write: citation notice directs a trailing HTML comment, not inline prose', () => assert(body.includes('@conv-<dim>') && body.includes('HTML comment') && body.includes('<!-- adopted-conventions:')));
  t('write: repeated writeConventions on the same input is byte-stable', () => {
    const a = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    writeConventions(dir, '## Conventions\n\n### Naming\n- camelCase for variables\n\n### Error handling\n- wrap awaits in try/catch\n');
    assert.strictEqual(a, fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'));
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'wdimbig' }) }, (dir) => {
  require('../init').init({ projectRoot: dir });
  // All 8 taxonomy dimensions, each with a heading + two short bullets — proves
  // the anchor suffixes themselves (~20-24B each) don't tip a realistic full
  // block over the 6 KiB budget.
  const sections = DIMENSIONS.map((d) => `### ${d.heading}\n- one convention\n- another convention`).join('\n\n');
  writeConventions(dir, `## Conventions\n\n${sections}\n`); // must not throw
  const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('write: anchored full-taxonomy block still respects the 6 KiB budget', () => {
    for (const d of DIMENSIONS) assert(body.includes(`(@conv-${d.slug})`));
  });
});

// ── analyze --adoption (Task 3) ─────────────────────────────────────────────
const { adoptionReport, formatAdoptionReport, parseArgs } = require('../analyze');
{
  const cp = require('child_process');
  const ADOPT_NOW = Date.parse('2026-07-05T12:00:00.000Z');
  const adoptDay = (n) => new Date(ADOPT_NOW - n * 86400000).toISOString();

  withProject({ 'package.json': JSON.stringify({ name: 'adopt' }) }, (dir) => {
    require('../init').init({ projectRoot: dir });
    writeConventions(dir, '## Conventions\n\n### Naming\n- camelCase\n\n### Comment style\n- explain why, not what\n');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-adopt-log.'));
    const logPath = path.join(logDir, 'agentsmd.jsonl');
    // adoptionReport's default (no --project) scope auto-derives the project
    // slug from `dir` itself, via the same tr/replace encoding
    // hooks/lib/rule-hits.sh stamps on every row — tag "this project"'s rows
    // with that same slug so the documented no-args default finds them.
    const slug = dir.replace(/[^a-zA-Z0-9-]/g, '-');
    try {
      const rows = [
        { ts: adoptDay(1), hook: 'convention-cite', event: 'cite', spec_section: '@conv-naming', project: slug },
        { ts: adoptDay(2), hook: 'convention-cite', event: 'cite', spec_section: '@conv-naming', project: slug },
        { ts: adoptDay(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', project: slug },
        // A different project's cite of the OTHER dimension — must never leak
        // into this project's default-scoped (no --project) report, but must
        // be found when a caller explicitly overrides the scope to reach it.
        { ts: adoptDay(1), hook: 'convention-cite', event: 'cite', spec_section: '@conv-comments', project: 'explicit-scope-marker' },
      ];
      fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const r = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath });
      t('adoption: default scope auto-derives to this project — cited anchor shows its cite count', () => {
        const naming = r.dimensions.find((d) => d.anchor === '@conv-naming');
        assert.strictEqual(naming.cites, 2);
        assert.strictEqual(naming.signal, 'active');
      });
      t('adoption: never-cited known anchor is a 0-cite prune candidate (another project citing it does not count)', () => {
        const comments = r.dimensions.find((d) => d.anchor === '@conv-comments');
        assert.strictEqual(comments.cites, 0);
        assert.strictEqual(comments.signal, 'prune-candidate');
      });
      t('adoption: §* rows never surface in the dimensions list', () => {
        assert.ok(!r.dimensions.some((d) => d.anchor.startsWith('§')));
      });
      t('adoption: pruneCandidates lists exactly the 0-cite anchors', () => {
        assert.deepStrictEqual(r.pruneCandidates.map((d) => d.anchor), ['@conv-comments']);
      });
      t('adoption: report text includes counts and the prune flag', () => {
        const text = formatAdoptionReport(r);
        assert.ok(/@conv-naming: 2 cites/.test(text));
        assert.ok(/@conv-comments: 0 cites — prune candidate/.test(text));
      });

      const scoped = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath, project: 'explicit-scope-marker' });
      t('adoption: explicit --project overrides the auto-scope default', () => {
        assert.strictEqual(scoped.dimensions.find((d) => d.anchor === '@conv-comments').cites, 1);
      });

      const scopedOut = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath, project: 'nonexistent-project-slug' });
      t('adoption: --project matching no rows reads as no-data, not a false prune-candidate', () => {
        const naming = scopedOut.dimensions.find((d) => d.anchor === '@conv-naming');
        assert.strictEqual(naming.cites, 0);
        assert.strictEqual(naming.signal, 'no-data');
      });

      const emptyLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-adopt-empty.'));
      const emptyLog = path.join(emptyLogDir, 'agentsmd.jsonl');
      fs.writeFileSync(emptyLog, '');
      try {
        const empty = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath: emptyLog });
        t('adoption: empty telemetry window → no-data, never prune-candidate', () => {
          assert.strictEqual(empty.dimensions.find((d) => d.anchor === '@conv-naming').signal, 'no-data');
          assert.strictEqual(empty.pruneCandidates.length, 0);
        });
      } finally { fs.rmSync(emptyLogDir, { recursive: true, force: true }); }
    } finally { fs.rmSync(logDir, { recursive: true, force: true }); }
  });

  // ── adoption: cold-start honesty against a shared, non-empty telemetry log ─
  // Regression test for the design §7 cold-start false-positive: the production
  // CLI path calls audit() with no --project, against the REAL shared
  // ~/.codex/logs/agentsmd.jsonl — non-empty after ANY agentsmd usage anywhere,
  // by any project. A freshly-distilled project whose own @conv-* anchors
  // haven't been cited yet must still read no-data — never a false
  // prune-candidate — even when the shared log is full of another project's
  // rows, including a same-named @conv-naming cite that must not leak across
  // projects and masquerade as this project's adoption.
  withProject({ 'package.json': JSON.stringify({ name: 'coldstart' }) }, (dir) => {
    require('../init').init({ projectRoot: dir });
    writeConventions(dir, '## Conventions\n\n### Naming\n- camelCase\n\n### Comment style\n- explain why, not what\n');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-coldstart-log.'));
    const logPath = path.join(logDir, 'agentsmd.jsonl');
    try {
      const rows = [
        { ts: adoptDay(1), hook: 'convention-cite', event: 'cite', spec_section: '@conv-naming', project: 'some-other-project' },
        { ts: adoptDay(1), hook: 'pre-bash-safety', event: 'block', spec_section: '§8-rm-rf-var', project: 'some-other-project' },
      ];
      fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const r = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath });
      t("adoption: shared non-empty log holding only another project's rows still reads no-data for this project", () => {
        assert.strictEqual(r.noData, true, 'noData: ' + JSON.stringify(r));
        assert.ok(r.dimensions.every((d) => d.signal === 'no-data'), JSON.stringify(r.dimensions));
        assert.strictEqual(r.pruneCandidates.length, 0);
      });
    } finally { fs.rmSync(logDir, { recursive: true, force: true }); }
  });

  withProject({ 'package.json': JSON.stringify({ name: 'noconv' }) }, (dir) => {
    require('../init').init({ projectRoot: dir });
    const r = adoptionReport({ root: dir, days: 30, now: ADOPT_NOW, logPath: path.join(dir, 'agentsmd.jsonl') });
    t('adoption: project with no @conv-* anchors yet reports an empty dimensions list', () => assert.deepStrictEqual(r.dimensions, []));
    t('adoption: report text names AGENTS.md when there is nothing to report', () => assert(/run agentsmd-analyze first/.test(formatAdoptionReport(r))));
  });

  // ── parseArgs: --adoption / --days / --project ──────────────────────────
  t('parseArgs: --adoption sets mode', () => assert.strictEqual(parseArgs(['--adoption']).mode, 'adoption'));
  t('parseArgs: --adoption --days=7 --project=foo', () => {
    const o = parseArgs(['--adoption', '--days=7', '--project=foo']);
    assert.strictEqual(o.days, 7);
    assert.strictEqual(o.project, 'foo');
  });
  t('parseArgs: --adoption defaults days to 30, project to null', () => {
    const o = parseArgs(['--adoption']);
    assert.strictEqual(o.days, 30);
    assert.strictEqual(o.project, null);
  });
  t('parseArgs: rejects multiple explicit modes', () => {
    const msg = 'choose only one mode: --gather, --write, or --adoption';
    assert.strictEqual(parseArgs(['--adoption', '--gather']).error, msg);
    assert.strictEqual(parseArgs(['--write', '--adoption']).error, msg);
    assert.strictEqual(parseArgs(['--gather', '--gather']).error, msg);
  });
  t('parseArgs: rejects invalid --days value', () => assert.strictEqual(parseArgs(['--adoption', '--days=abc']).error, 'invalid --days value: abc'));
  t('parseArgs: rejects oversized --days (mirrors audit/rules bound; no RangeError downstream)', () => {
    const big = '999999999999999999999999999999';
    assert.strictEqual(parseArgs(['--adoption', `--days=${big}`]).error, `invalid --days value: ${big}`);
  });
  t('parseArgs: rejects empty --project=', () => assert.strictEqual(parseArgs(['--adoption', '--project=']).error, 'invalid --project value: (empty)'));
  t('parseArgs: rejects duplicate --days instead of silently taking the last value', () =>
    assert.strictEqual(parseArgs(['--adoption', '--days=7', '--days=30']).error, 'duplicate option: --days'));
  t('parseArgs: rejects duplicate --project instead of silently taking the last value', () =>
    assert.strictEqual(parseArgs(['--adoption', '--project=a', '--project=b']).error, 'duplicate option: --project'));
  t('parseArgs: rejects duplicate --from instead of silently taking the last value', () =>
    assert.strictEqual(parseArgs(['--write', '--from', 'a.md', '--from', 'b.md']).error, 'duplicate option: --from'));
  t('parseArgs: --from cannot consume a following option as its value', () =>
    assert.strictEqual(parseArgs(['--write', '--from', '--adoption']).error, '--from requires a file path value'));
  t('parseArgs: --from without a following value is rejected at the option', () =>
    assert.strictEqual(parseArgs(['--write', '--from']).error, '--from requires a file path value'));
  t('parseArgs: rejects adoption-only filters outside --adoption', () => {
    assert.strictEqual(parseArgs(['--days=7']).error, '--days and --project require --adoption');
    assert.strictEqual(parseArgs(['--gather', '--project=foo']).error, '--days and --project require --adoption');
    assert.strictEqual(parseArgs(['--write', '--from', 'x.md', '--days=7']).error, '--days and --project require --adoption');
  });
  t('parseArgs: rejects --from outside --write', () => {
    assert.strictEqual(parseArgs(['--from', 'x.md']).error, '--from requires --write');
    assert.strictEqual(parseArgs(['--adoption', '--from', 'x.md']).error, '--from requires --write');
  });
  t('adoptionReport does not throw on a huge days (audit() clamps it)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-adopt-clamp.'));
    try {
      require('../init').init({ projectRoot: cwd });
      writeConventions(cwd, '## Conventions\n\n### Naming\n- camelCase\n');
      assert.doesNotThrow(() => adoptionReport({ root: cwd, days: 1e30, now: ADOPT_NOW, logPath: path.join(cwd, 'nolog.jsonl') }));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── CLI end-to-end ────────────────────────────────────────────────────────
  t('analyze CLI --adoption runs end-to-end and exits 0', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-adopt-cli.'));
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-adopt-cli-home.'));
    try {
      require('../init').init({ projectRoot: cwd });
      writeConventions(cwd, '## Conventions\n\n### Naming\n- camelCase\n');
      fs.mkdirSync(path.join(cliHome, 'logs'), { recursive: true });
      const out = cp.execFileSync('node', [path.join(__dirname, '..', 'analyze.js'), '--adoption'],
        { cwd, env: { ...process.env, CODEX_HOME: cliHome }, encoding: 'utf8' });
      assert.ok(/@conv-naming: 0 cites/.test(out), 'missing naming line; got:\n' + out);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(cliHome, { recursive: true, force: true });
    }
  });
  t('analyze CLI rejects adoption-only filters in gather mode', () => {
    const r = cp.spawnSync('node', [path.join(__dirname, '..', 'analyze.js'), '--days=7'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes('--days and --project require --adoption'), r.stderr);
  });
  t('analyze CLI rejects multiple explicit modes', () => {
    const r = cp.spawnSync('node', [path.join(__dirname, '..', 'analyze.js'), '--adoption', '--gather'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes('choose only one mode'), r.stderr);
  });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
