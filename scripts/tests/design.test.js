'use strict';
// design.test.js — `agentsmd design` (D1 Phase 2). Proves the end-to-end command:
// detect frontend → parse tokens → render a facts-only DESIGN.md + AGENTS.md
// pointer, consent-gated (preview writes nothing; --write commits), idempotent
// re-run (preserves user content outside the sentinels), budget-refusal (never a
// silent truncation), and non-frontend no-op. Sandbox fixtures, disposed inline.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const DZ = require('../design');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

// A frontend project fixture (react + tailwind + a CSS file). Returns the sandbox dir.
function frontendFixture({ css = ':root {\n --color-primary: #3b82f6;\n --space-1: 0.25rem;\n --radius: 0.5rem;\n}', agentsMd = null } = {}) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-design-'));
  fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'fe-app', dependencies: { react: '^18', tailwindcss: '^4' } }));
  fs.mkdirSync(path.join(sb, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'src', 'app.css'), css);
  if (agentsMd !== null) fs.writeFileSync(path.join(sb, 'AGENTS.md'), agentsMd);
  return sb;
}

t('designReport detects the frontend stack + parses tokens', () => {
  const sb = frontendFixture();
  try {
    const r = DZ.designReport(sb);
    assert.ok(r.frontend && r.frontend.framework === 'React');
    assert.ok(r.frontend.uiLibs.includes('Tailwind'));
    assert.strictEqual(r.tokens.count, 3);
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('renderDesignMd is facts-only: category headings + name:value, stack + source line', () => {
  const sb = frontendFixture();
  try {
    const body = DZ.renderDesignMd(DZ.designReport(sb));
    assert.ok(/# Design tokens/.test(body));
    assert.ok(/Stack: React \+ Tailwind/.test(body));
    assert.ok(/## Colors/.test(body) && body.includes('--color-primary') && body.includes('#3b82f6'));
    assert.ok(/## Radii/.test(body));
    assert.ok(/src\/app\.css/.test(body));
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('preview (default) writes NOTHING; --write creates DESIGN.md block + AGENTS.md pointer', () => {
  const sb = frontendFixture({ agentsMd: '# Project\n\nSome user notes.\n' });
  try {
    const prev = DZ.writeDesign(sb, { commit: false });
    assert.strictEqual(prev.action, 'preview');
    assert.ok(!fs.existsSync(path.join(sb, 'DESIGN.md')), 'preview must not write DESIGN.md');

    const res = DZ.writeDesign(sb, { commit: true });
    assert.strictEqual(res.action, 'written');
    const design = fs.readFileSync(path.join(sb, 'DESIGN.md'), 'utf8');
    assert.ok(design.includes('<!-- agentsmd:design BEGIN -->') && design.includes('<!-- agentsmd:design END -->'));
    assert.ok(design.includes('--color-primary'));
    const agents = fs.readFileSync(path.join(sb, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('<!-- agentsmd:design-pointer BEGIN -->') && /DESIGN\.md/.test(agents));
    assert.ok(agents.includes('Some user notes.'), 'user content outside the pointer block preserved');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('re-run is idempotent: updates the block in place, preserves user content outside', () => {
  const sb = frontendFixture({ agentsMd: '# Project\n' });
  try {
    DZ.writeDesign(sb, { commit: true });
    const designPath = path.join(sb, 'DESIGN.md');
    fs.writeFileSync(designPath, fs.readFileSync(designPath, 'utf8') + '\n## My hand-written notes\nkeep me\n'); // user prose OUTSIDE the block
    fs.writeFileSync(path.join(sb, 'src', 'app.css'), ':root { --color-primary: #ff0000; }');                  // token changes
    const res = DZ.writeDesign(sb, { commit: true });
    assert.strictEqual(res.designUpdated, true);
    const design = fs.readFileSync(designPath, 'utf8');
    assert.ok(design.includes('--color-primary') && design.includes('#ff0000'), 'block refreshed');
    assert.ok(design.includes('keep me'), 'user content outside the block preserved');
    assert.strictEqual((design.match(/agentsmd:design BEGIN/g) || []).length, 1, 'exactly one managed block (no dup)');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t("no AGENTS.md → DESIGN.md still written, pointer skipped (creating AGENTS.md is init's job)", () => {
  const sb = frontendFixture(); // no AGENTS.md
  try {
    const res = DZ.writeDesign(sb, { commit: true });
    assert.strictEqual(res.pointerAdded, false);
    assert.ok(fs.existsSync(path.join(sb, 'DESIGN.md')));
    assert.ok(!fs.existsSync(path.join(sb, 'AGENTS.md')), 'must not create AGENTS.md');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('non-frontend project → skip no-op (writes nothing)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-design-be-'));
  try {
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ name: 'be', dependencies: { express: '^4' } }));
    const res = DZ.writeDesign(sb, { commit: true });
    assert.strictEqual(res.action, 'skip');
    assert.ok(!fs.existsSync(path.join(sb, 'DESIGN.md')));
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('no tokens found → honest note that points at tailwind.config.js', () => {
  const sb = frontendFixture({ css: 'body { color: red; }' }); // no --vars; Tailwind dep present
  try {
    const body = DZ.renderDesignMd(DZ.designReport(sb));
    assert.ok(/No .*tokens were found/i.test(body));
    assert.ok(/tailwind\.config\.js/.test(body), 'Tailwind v3 hint');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('renderDesignMd: a truncated scan with 0 tokens still discloses the cap (honest no-tokens note)', () => {
  const report = {
    frontend: { framework: 'React', metaFramework: null, uiLibs: ['Tailwind'] },
    tokens: { tokens: {}, categories: [], count: 0, sources: [], files: [], truncated: true },
  };
  const body = DZ.renderDesignMd(report);
  assert.ok(/No .*tokens were found/i.test(body), 'still says none found');
  assert.ok(/not read|incomplete|cap/i.test(body), 'discloses the scan was truncated, so "none found" is not a false all-clear');
});

t('renderDesignMd: a truncated scan WITH tokens also discloses the cap', () => {
  const report = {
    frontend: { framework: 'React', metaFramework: null, uiLibs: [] },
    tokens: { tokens: { color: [{ name: '--color-a', value: '#111' }] }, categories: ['color'], count: 1, sources: ['a.css'], files: ['a.css'], truncated: true },
  };
  const body = DZ.renderDesignMd(report);
  assert.ok(/--color-a/.test(body) && /not read|incomplete|cap/i.test(body));
});

t('renderDesignMd: a non-frontend report returns a safe note, does not throw (direct-caller guard)', () => {
  const body = DZ.renderDesignMd({ frontend: null, tokens: null });
  assert.ok(/not a frontend project/i.test(body));
});

t('budget refusal: a token block over the cap throws (never a silent truncation)', () => {
  let css = ':root {\n';
  for (let i = 0; i < 600; i++) css += `  --color-x${i}: #abcdef;\n`;
  css += '}';
  const sb = frontendFixture({ css });
  try {
    assert.throws(() => DZ.writeDesign(sb, { commit: false }), /exceeds \d+B budget/);
    assert.ok(!fs.existsSync(path.join(sb, 'DESIGN.md')));
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('CLI: preview exits 0 + writes nothing; --write exits 0 + creates files; bad flag exits 2', () => {
  const script = path.join(__dirname, '..', 'design.js');
  const sb = frontendFixture({ agentsMd: '# P\n' });
  try {
    const prev = cp.spawnSync(process.execPath, [script], { cwd: sb, encoding: 'utf8' });
    assert.strictEqual(prev.status, 0);
    assert.ok(!fs.existsSync(path.join(sb, 'DESIGN.md')), 'CLI preview writes nothing');
    const wrote = cp.spawnSync(process.execPath, [script, '--write'], { cwd: sb, encoding: 'utf8' });
    assert.strictEqual(wrote.status, 0);
    assert.ok(fs.existsSync(path.join(sb, 'DESIGN.md')));
    assert.strictEqual(cp.spawnSync(process.execPath, [script, '--nope'], { cwd: sb }).status, 2);
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
