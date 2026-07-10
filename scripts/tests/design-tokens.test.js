'use strict';
// design-tokens.test.js — the deterministic token parser (D1 Phase 1). Proves it
// extracts :root + @theme custom properties, categorizes by name/value, dedupes
// last-wins, skips node_modules, and survives malformed CSS. Sandbox fixtures,
// disposed in finally (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const D = require('../lib/design-tokens');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-design-tokens-'));
const seed = (rel, c) => { const p = path.join(sb, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
try {
  // ── pure functions ─────────────────────────────────────────────────────────
  t('extractBlocks pulls :root and @theme bodies (space before brace, @theme inline)', () => {
    const bodies = D.extractBlocks(':root {\n --a: 1;\n}\n@theme inline {\n --b: 2;\n}');
    assert.strictEqual(bodies.length, 2);
    assert.ok(bodies[0].includes('--a: 1') && bodies[1].includes('--b: 2'));
  });
  t('parseDecls extracts --name: value, stripping /* comments */', () => {
    assert.deepStrictEqual(D.parseDecls('/* c */ --color-x: #fff; --y:  2rem ;'),
      [{ name: '--color-x', value: '#fff' }, { name: '--y', value: '2rem' }]);
  });
  t('categorize: name-prefix + shadcn bare names + value-sniff', () => {
    assert.strictEqual(D.categorize('--color-primary', '#3b82f6'), 'color');
    assert.strictEqual(D.categorize('--primary', 'oklch(0.6 0.2 20)'), 'color'); // shadcn bare name
    assert.strictEqual(D.categorize('--brand', '#fff'), 'color');                // value-sniff, non-color name
    assert.strictEqual(D.categorize('--space-1', '0.25rem'), 'spacing');
    assert.strictEqual(D.categorize('--font-sans', 'ui-sans-serif'), 'typography');
    assert.strictEqual(D.categorize('--radius', '0.5rem'), 'radius');
    assert.strictEqual(D.categorize('--shadow-sm', '0 1px 2px #0001'), 'shadow');
    assert.strictEqual(D.categorize('--z-modal', '50'), 'z-index');
    assert.strictEqual(D.categorize('--weird', 'blah'), 'other');
  });

  // ── integration over a sandbox ──────────────────────────────────────────────
  t('parseDesignTokens: extracts + categorizes + records sources from :root and @theme', () => {
    seed('src/app.css', ':root {\n  --color-primary: #3b82f6;\n  --space-1: 0.25rem;\n  --radius: 0.5rem;\n}');
    seed('src/theme.css', '@theme {\n  --color-accent: oklch(0.7 0.1 200);\n  --font-sans: ui-sans-serif;\n}');
    const r = D.parseDesignTokens(sb);
    assert.strictEqual(r.count, 5);
    assert.deepStrictEqual(r.categories, ['color', 'spacing', 'typography', 'radius']); // CATEGORY_ORDER, filtered
    assert.strictEqual(r.tokens.color.length, 2);
    assert.ok(r.tokens.color.some((x) => x.name === '--color-primary' && x.value === '#3b82f6'));
    assert.ok(r.sources.includes('src/app.css') && r.sources.includes('src/theme.css'));
  });
  t('parseDesignTokens: dedupes by name, last definition wins', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2-'));
    try {
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-primary: #111; }');
      fs.writeFileSync(path.join(s, 'b.css'), ':root { --color-primary: #222; }'); // b.css sorts after a.css → wins
      const r = D.parseDesignTokens(s);
      assert.strictEqual(r.count, 1);
      assert.strictEqual(r.tokens.color[0].value, '#222');
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('parseDesignTokens: no CSS custom properties → empty, count 0', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt3-'));
    try {
      fs.writeFileSync(path.join(s, 'plain.css'), 'body { color: red; }');
      const r = D.parseDesignTokens(s);
      assert.strictEqual(r.count, 0);
      assert.deepStrictEqual(r.categories, []);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('parseDesignTokens: skips node_modules; survives malformed (unclosed) CSS', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt4-'));
    try {
      fs.mkdirSync(path.join(s, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(s, 'node_modules', 'lib.css'), ':root { --color-x: #000; }'); // must be skipped
      fs.writeFileSync(path.join(s, 'broken.css'), ':root { --color-ok: #abc; /* unclosed');    // no closing } or */
      const r = D.parseDesignTokens(s);
      assert.ok(!(r.tokens.color || []).some((x) => x.name === '--color-x'), 'node_modules skipped');
      assert.ok(r.count >= 1 && r.tokens.color.some((x) => x.name === '--color-ok'), 'malformed block still parsed');
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('parseDesignTokens: non-Git fallback keeps simple dir and suffix ignores', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt-ignore-fallback-'));
    try {
      fs.writeFileSync(path.join(s, '.gitignore'), 'secret/\n*.gen.css\n');
      fs.mkdirSync(path.join(s, 'secret'), { recursive: true });
      fs.writeFileSync(path.join(s, 'secret', 'hidden.css'), ':root { --color-secret: #111; }');
      fs.writeFileSync(path.join(s, 'hidden.gen.css'), ':root { --color-generated: #222; }');
      fs.writeFileSync(path.join(s, 'visible.css'), ':root { --color-visible: #333; }');
      const r = D.parseDesignTokens(s);
      assert.deepStrictEqual(r.sources, ['visible.css']);
      assert.strictEqual(r.count, 1);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('parseDesignTokens: real Git ignore semantics honor anchors, nested rules, globs, and negation', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt-ignore-git-'));
    const put = (rel, body) => {
      const file = path.join(s, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };
    try {
      put('.gitignore', '/root-only.css\n*.gen.css\nignored/*\n!ignored/keep.css\n');
      put('root-only.css', ':root { --color-root-ignored: #111; }');
      put('nested/root-only.css', ':root { --color-nested-root: #222; }');
      put('nested/.gitignore', '*.tmp.css\n!keep.tmp.css\n');
      put('nested/drop.tmp.css', ':root { --color-nested-ignored: #333; }');
      put('nested/keep.tmp.css', ':root { --color-nested-kept: #444; }');
      put('nested/generated.gen.css', ':root { --color-glob-ignored: #555; }');
      put('ignored/drop.css', ':root { --color-dir-ignored: #666; }');
      put('ignored/keep.css', ':root { --color-negated-kept: #777; }');
      const result = require('child_process').spawnSync('git', ['init', '-q'], { cwd: s, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      const r = D.parseDesignTokens(s);
      assert(r.sources.includes(path.join('nested', 'root-only.css')), r.sources.join(', '));
      assert(r.sources.includes(path.join('nested', 'keep.tmp.css')), r.sources.join(', '));
      assert(r.sources.includes(path.join('ignored', 'keep.css')), r.sources.join(', '));
      for (const ignored of ['root-only.css', path.join('nested', 'drop.tmp.css'), path.join('nested', 'generated.gen.css'), path.join('ignored', 'drop.css')]) {
        assert(!r.sources.includes(ignored), `${ignored} leaked: ${r.sources.join(', ')}`);
      }
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('extractBlocks: a } inside a /* comment */ does not prematurely close the block (no silent token loss)', () => {
    const bodies = D.extractBlocks(':root { --a: 1; /* a } here */ --b: 2; }');
    assert.strictEqual(bodies.length, 1);
    assert.deepStrictEqual(D.parseDecls(bodies[0]).map((d) => d.name), ['--a', '--b']); // --b must survive the brace-in-comment
  });
  t('parseDesignTokens: a commented-out :root{} does not forge or override a live token', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt5-'));
    try {
      // live #111111 first, then an OLD value inside a comment — last-wins must NOT let the commented-out block win
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-primary: #111111; }\n/* old theme:\n:root { --color-primary: #999999; } */');
      const r = D.parseDesignTokens(s);
      assert.strictEqual(r.count, 1);
      assert.strictEqual(r.tokens.color[0].value, '#111111'); // commented-out #999999 must be ignored
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('extractBlocks: a selector string (:root[data-theme="x"]) still extracts; a } inside a string value does not break the boundary', () => {
    const bodies = D.extractBlocks(':root[data-theme="dark"] { --a: 1; --brace: "}"; --b: 2; }');
    assert.strictEqual(bodies.length, 1);
    const decls = D.parseDecls(bodies[0]);
    assert.deepStrictEqual(decls.map((d) => d.name), ['--a', '--brace', '--b']);
    assert.strictEqual(decls.find((d) => d.name === '--brace').value, '"}"'); // } inside the string value preserved
  });
  t('extractBlocks: a :root{...} literal inside a string value is NOT a block (no phantom token)', () => {
    const bodies = D.extractBlocks('.icon { content: ":root{--fake: 1}"; }');
    assert.strictEqual(bodies.length, 0); // the :root{ inside the string must not open a block
  });
  t('parseDecls: a ; inside url(...) or a quoted value does not truncate the value', () => {
    const decls = D.parseDecls('--icon: url("data:image/svg+xml;base64,AAA"); --sep: "; "; --y: 2;');
    const by = Object.fromEntries(decls.map((d) => [d.name, d.value]));
    assert.strictEqual(by['--icon'], 'url("data:image/svg+xml;base64,AAA")'); // full data URI, not cut at the first ;
    assert.strictEqual(by['--sep'], '"; "');
    assert.strictEqual(by['--y'], '2');
  });
  t('parseDecls: a /* */ inside a string value is preserved (comment-strip is string-aware)', () => {
    const decls = D.parseDecls('--note: "/* keep */"; --y: 2;');
    assert.strictEqual(decls.find((d) => d.name === '--note').value, '"/* keep */"');
  });
} finally {
  fs.rmSync(sb, { recursive: true, force: true }); // §8.V4
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
