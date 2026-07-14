'use strict';
// version-cascade-check.test.js — the free-text version-drift gate (E2). Asserts
// the real repo is clean (no stale same-major token in prose) AND the detector
// has teeth: a synthetic tree with a stale token is caught, a current-minor token
// and a missing file are handled, and the intentional-token allowlist is
// load-bearing (README's example --ref v2.2.1 is present yet suppressed).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const V = require('../version-cascade-check');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

// ── pure helpers ────────────────────────────────────────────────────────────
t('toMinor collapses to v<major>.<minor> (v-prefixed and bare); junk → null', () => {
  assert.strictEqual(V.toMinor('v2.13.0'), 'v2.13');
  assert.strictEqual(V.toMinor('2.13.0'), 'v2.13');
  assert.strictEqual(V.toMinor('v2.2.1'), 'v2.2');
  assert.strictEqual(V.toMinor('nope'), null);
});
t('majorTokenRe matches current-major v-tokens only (not other majors / bare / glued)', () => {
  const re = () => V.majorTokenRe('v9.9.9');
  assert.deepStrictEqual('see v9.8.0 and v9.9.1'.match(re()), ['v9.8.0', 'v9.9.1']);
  assert.strictEqual('v8.1.0 and 9.9.0'.match(re()), null); // wrong major; bare 9.9.0 has no v
  assert.deepStrictEqual('libv9.1.0 and v9.2.0'.match(re()), ['v9.2.0']); // glued-to-word-char token not matched (leading boundary)
});

// ── real tree is clean, and the allowlist is load-bearing ───────────────────
t('real repo: 0 offenders (prose has no stale same-major version token)', () => {
  const r = V.runVersionCascadeCheck();
  assert.ok(r.ok, 'expected clean; offenders:\n' + JSON.stringify(r.offenders, null, 2));
  assert.deepStrictEqual(r.filesChecked, ['README.md', 'README.zh-CN.md']);
});
t('allowlist is load-bearing: README ships the historical rename version v2.0.0, suppressed', () => {
  // The old --ref v2.2.1 example left the README in v4.6.0 (the default ref is
  // now self-pinned, so a pin example is redundant); v2.0.0 (the codexmd →
  // agentsmd rename note) remains and keeps the allowlist exercised.
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('v2.0.0'), 'README should still carry the rename version');
  assert.ok(V.INTENTIONAL_TOKENS.has('v2.0.0'), 'and it must be allowlisted');
  assert.ok(!V.INTENTIONAL_TOKENS.has('v2.2.1'), 'dropped example must not linger in the allowlist');
});

// ── detector teeth: synthetic tree ──────────────────────────────────────────
t('synthetic: a stale same-major token is caught; current-minor + allowlisted pass', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-vcascade-'));
  try {
    fs.mkdirSync(path.join(sb, 'spec'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'spec', 'hard-rules.json'), JSON.stringify({ spec_version: 'v9.9.9' }));
    fs.writeFileSync(path.join(sb, 'README.md'), 'current is v9.9.5 (fine)\nbut v9.8.0 is stale\n');
    fs.writeFileSync(path.join(sb, 'README.zh-CN.md'), '当前版本 v9.9.9\n');
    const r = V.runVersionCascadeCheck({ root: sb });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.offenders.length, 1, JSON.stringify(r.offenders));
    assert.strictEqual(r.offenders[0].file, 'README.md');
    assert.strictEqual(r.offenders[0].line, 2);
    assert.strictEqual(r.offenders[0].found, 'v9.8.0');
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});
t('synthetic: a missing scanned file is an offender (<file missing>)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-vcascade2-'));
  try {
    fs.mkdirSync(path.join(sb, 'spec'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'spec', 'hard-rules.json'), JSON.stringify({ spec_version: 'v9.9.9' }));
    fs.writeFileSync(path.join(sb, 'README.md'), 'clean v9.9.9\n'); // README.zh-CN.md absent
    const r = V.runVersionCascadeCheck({ root: sb });
    assert.strictEqual(r.ok, false);
    const miss = r.offenders.find((o) => o.file === 'README.zh-CN.md');
    assert.ok(miss && miss.context === '<file missing>', JSON.stringify(r.offenders));
  } finally { fs.rmSync(sb, { recursive: true, force: true }); }
});

// ── CLI contract ────────────────────────────────────────────────────────────
t('CLI: clean repo exits 0; --json prints structured result; bad flag exits 2', () => {
  const script = path.join(__dirname, '..', 'version-cascade-check.js');
  const out = cp.execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' });
  assert.ok(JSON.parse(out).ok === true);
  const bad = cp.spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
