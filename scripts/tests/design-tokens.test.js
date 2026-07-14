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
  t('extractBlocks pulls :root and @theme blocks with selectors (space before brace, @theme inline normalized)', () => {
    const blocks = D.extractBlocks(':root {\n --a: 1;\n}\n@theme inline {\n --b: 2;\n}');
    assert.strictEqual(blocks.length, 2);
    assert.ok(blocks[0].body.includes('--a: 1') && blocks[1].body.includes('--b: 2'));
    assert.strictEqual(blocks[0].selector, ':root');
    assert.strictEqual(blocks[1].selector, '@theme'); // option words (inline/static) don't change which tokens exist
  });
  t('extractBlocks keeps a :root attribute guard as a distinct selector (provenance)', () => {
    const blocks = D.extractBlocks(':root[data-theme="dark"] { --a: 1; }');
    assert.strictEqual(blocks[0].selector, ':root[data-theme="dark"]');
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
  // ── R4-01 order/provenance corpus: the walk order is NOT CSS import order ────
  t('cross-file same-selector conflict → ambiguous, no guessed value, provenance on every candidate', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2-'));
    try {
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-primary: #111; }');
      fs.writeFileSync(path.join(s, 'b.css'), ':root { --color-primary: #222; }'); // import order unknown → no winner
      const r = D.parseDesignTokens(s);
      assert.strictEqual(r.count, 1);
      const tok = r.tokens.color[0];
      assert.strictEqual(tok.status, 'ambiguous');
      assert.strictEqual(tok.value, null, 'must not guess an effective value');
      assert.strictEqual(r.ambiguousCount, 1);
      assert.deepStrictEqual(tok.definitions.map((d) => [d.value, d.source, d.selector]).sort(),
        [['#111', 'a.css', ':root'], ['#222', 'b.css', ':root']]);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('cross-file conflict verdict is walk-order independent (the old last-wins bug inverted)', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2b-'));
    try {
      // Same corpus with the file names swapped: alphabetical walk order reverses,
      // the verdict (and candidate set) must not.
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-primary: #222; }');
      fs.writeFileSync(path.join(s, 'b.css'), ':root { --color-primary: #111; }');
      const tok = D.parseDesignTokens(s).tokens.color[0];
      assert.strictEqual(tok.status, 'ambiguous');
      assert.strictEqual(tok.value, null);
      assert.deepStrictEqual(tok.definitions.map((d) => d.value).sort(), ['#111', '#222']);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('same-file same-selector duplicate → CSS source order is real: last declaration wins, order evidence kept', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2c-'));
    try {
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-primary: #111; }\n:root { --color-primary: #222; }');
      const tok = D.parseDesignTokens(s).tokens.color[0];
      assert.strictEqual(tok.status, 'ok');
      assert.strictEqual(tok.value, '#222');
      assert.strictEqual(tok.resolution, 'source-order');
      assert.deepStrictEqual(tok.definitions.map((d) => d.order), [0, 1]);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('differing values under DIFFERENT selectors → contextual (theming, not conflict): per-context values', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2d-'));
    try {
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --color-bg: #fff; }\n:root[data-theme="dark"] { --color-bg: #000; }');
      const tok = D.parseDesignTokens(s).tokens.color[0];
      assert.strictEqual(tok.status, 'contextual');
      assert.strictEqual(tok.value, null, 'no single effective value across contexts');
      assert.deepStrictEqual(tok.contexts.map((c) => [c.selector, c.value]).sort(),
        [[':root', '#fff'], [':root[data-theme="dark"]', '#000']]);
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
  t('same value everywhere (cross-file, cross-selector-kind) → plain ok value, not a conflict', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt2e-'));
    try {
      fs.writeFileSync(path.join(s, 'a.css'), ':root { --radius: 0.5rem; }');
      fs.writeFileSync(path.join(s, 'b.css'), '@theme { --radius: 0.5rem; }');
      const tok = D.parseDesignTokens(s).tokens.radius[0];
      assert.strictEqual(tok.status, 'ok');
      assert.strictEqual(tok.value, '0.5rem');
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
  // ── symlink safety (H-06): never follow a link out of the project root ───────
  t('parseDesignTokens: .css symlinks escaping the root are not token sources; a real file still is', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.css'), ':root { --color-leaked: #666; }');
      fs.writeFileSync(path.join(s, 'real.css'), ':root { --color-real: #111; }');
      fs.symlinkSync(path.join(outside, 'secret.css'), path.join(s, 'leak.css'));  // file symlink out of root
      fs.symlinkSync(outside, path.join(s, 'linkdir'));                            // directory symlink out of root
      fs.symlinkSync(path.join(s, 'real.css'), path.join(s, 'alias.css'));         // symlink aliasing a file inside root
      fs.symlinkSync(path.join(outside, 'missing.css'), path.join(s, 'broken.css')); // broken symlink → must not crash
      const r = D.parseDesignTokens(s);
      assert.ok(!(r.tokens.color || []).some((x) => x.name === '--color-leaked'), 'outside token must not leak in');
      assert.ok(r.tokens.color.some((x) => x.name === '--color-real'), 'control regular .css still parsed');
      assert.deepStrictEqual(r.sources, ['real.css'], 'only the real file is a source: ' + r.sources.join(', '));
    } finally { fs.rmSync(s, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });
  t('extractBlocks: a } inside a /* comment */ does not prematurely close the block (no silent token loss)', () => {
    const blocks = D.extractBlocks(':root { --a: 1; /* a } here */ --b: 2; }');
    assert.strictEqual(blocks.length, 1);
    assert.deepStrictEqual(D.parseDecls(blocks[0].body).map((d) => d.name), ['--a', '--b']); // --b must survive the brace-in-comment
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
    const blocks = D.extractBlocks(':root[data-theme="dark"] { --a: 1; --brace: "}"; --b: 2; }');
    assert.strictEqual(blocks.length, 1);
    const decls = D.parseDecls(blocks[0].body);
    assert.deepStrictEqual(decls.map((d) => d.name), ['--a', '--brace', '--b']);
    assert.strictEqual(decls.find((d) => d.name === '--brace').value, '"}"'); // } inside the string value preserved
  });
  t('extractBlocks: a :root{...} literal inside a string value is NOT a block (no phantom token)', () => {
    const blocks = D.extractBlocks('.icon { content: ":root{--fake: 1}"; }');
    assert.strictEqual(blocks.length, 0); // the :root{ inside the string must not open a block
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
  t('findCssFiles: one oversize CSS is skipped, later CSS still scanned, cap disclosed (R4-05)', () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-dt-big-'));
    try {
      fs.writeFileSync(path.join(s, 'aaa-huge.css'), `:root { --pad: ${'x'.repeat(450 * 1024)}; }`); // > 400 KiB budget, sorts first
      fs.writeFileSync(path.join(s, 'small.css'), ':root { --color-live: #123; }');
      const r = D.parseDesignTokens(s);
      assert.deepStrictEqual(r.sources, ['small.css'], 'the small file after the oversize one must still be scanned');
      assert.ok(r.tokens.color.some((x) => x.name === '--color-live'));
      assert.strictEqual(r.truncated, true, 'the skip must be disclosed');
    } finally { fs.rmSync(s, { recursive: true, force: true }); }
  });
} finally {
  fs.rmSync(sb, { recursive: true, force: true }); // §8.V4
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
