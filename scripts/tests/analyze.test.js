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
  t('write: includes the citation-instruction notice', () => assert(body.includes('@conv-<dim>')));
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

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
