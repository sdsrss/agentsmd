'use strict';
// lint-argv.test.js — the argv-antipattern gate (E5). Asserts the real tree is
// clean (0 hits) AND the detector has teeth: a synthetic tree with each antipattern
// + an unvalidated main block trips it, while an `// argv-lint:allow` line and files
// under tests/ are correctly ignored. A green result means "no antipatterns", not
// "vacuous scan". Sandbox via mkdtempSync, disposed in finally (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const L = require('../lint-argv');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

t('real repo: 0 argv antipatterns across bin + scripts/', () => {
  const hits = L.scan();
  assert.strictEqual(hits.length, 0, 'expected clean; hits:\n' + JSON.stringify(hits, null, 2));
});

t('synthetic tree: each antipattern + unvalidated main block is caught; allow + tests/ ignored', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-lintargv-'));
  try {
    fs.mkdirSync(path.join(sb, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'scripts', 'tests'), { recursive: true });
    const w = (rel, c) => fs.writeFileSync(path.join(sb, rel), c);
    w('bin/cli.js', "'use strict';\nconst x = args.includes('--foo');\n");
    w('scripts/a.js', "'use strict';\nconst v = argv.find(a => a.startsWith('--bar'));\n");
    w('scripts/b.js', "'use strict';\nconst i = args.indexOf('--baz');\n");
    w('scripts/c.js', "'use strict';\nif (require.main === module) { doStuff(); }\n"); // no parser → part B
    w('scripts/d.js', "'use strict';\nconst k = argv.findIndex(a => a.startsWith('--qux'));\n"); // findIndex → widened scan A
    w('scripts/e.js', "'use strict';\nconst sep = line.includes('--- END ---');\n"); // a --- separator, NOT a flag → must be ignored
    w('scripts/ok.js', "'use strict';\nconst y = x.includes('--ok'); // argv-lint:allow\n"); // suppressed
    w('scripts/tests/t.js', "'use strict';\nconst z = out.includes('--flag');\n"); // tests/ → skipped
    const hits = L.scan({ root: sb });
    const byFile = (f) => hits.filter((h) => h.file === f);
    assert.ok(byFile('bin/cli.js').some((h) => h.pattern === 'includes(--flag)'), 'includes caught');
    assert.ok(byFile('scripts/a.js').some((h) => h.pattern.startsWith('find')), 'find/startsWith caught');
    assert.ok(byFile('scripts/b.js').some((h) => h.pattern === 'indexOf(--flag)'), 'indexOf caught');
    assert.ok(byFile('scripts/c.js').some((h) => h.pattern === 'main-block-without-argv-validation'), 'unvalidated main block caught');
    assert.ok(byFile('scripts/d.js').some((h) => h.pattern.startsWith('find')), 'findIndex caught (widened from find)');
    assert.strictEqual(byFile('scripts/e.js').length, 0, 'a --- separator (not a flag) is not flagged (FP fix)');
    assert.strictEqual(byFile('scripts/ok.js').length, 0, 'argv-lint:allow suppresses');
    assert.strictEqual(byFile('scripts/tests/t.js').length, 0, 'tests/ excluded');
    assert.ok(hits.length >= 5, 'at least the five real antipatterns');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

t('CLI: clean repo exits 0; unknown flag exits 2', () => {
  const script = path.join(__dirname, '..', 'lint-argv.js');
  assert.strictEqual(cp.spawnSync(process.execPath, [script]).status, 0);
  assert.strictEqual(cp.spawnSync(process.execPath, [script, '--nope']).status, 2);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
