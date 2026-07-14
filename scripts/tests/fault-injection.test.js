'use strict';
// fault-injection.test.js — R2-04 (audit H-03/H-04): the process-level fault
// matrix, run TWICE CONSECUTIVELY per point in the SAME home (round 2 injects
// the same fault again after round 1 healed — recovery-after-recovery), which
// is the Gate-C acceptance: full matrix passes two consecutive rounds with no
// unexpected stage/old/lock/journal residue and doctor green at the end.
//
// Three fault families:
//   SIGKILL   AGENTSMD_TEST_CRASH_AT=<point>        (crash path → journal +
//             next-entry recovery heal the tree; 5 install + 4 uninstall points)
//   errno     AGENTSMD_TEST_FAULT_AT=<point>:<CODE> (error path → the
//             in-process rollback heals the tree immediately; ENOSPC + EACCES)
//   real fs   a genuinely read-only skills dir makes the skill-swap rename
//             fail with a REAL EACCES (no injection involved)
// All in mkdtemp sandboxes (§8.V3), disposed on exit (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { PASS++; console.log('  ok   ' + n); },
  (e) => { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); }
);

const SCRIPTS = path.join(__dirname, '..');
const SANDBOXES = [];
const sandbox = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `agentsmd-fault-${name}-`));
  SANDBOXES.push(d);
  return d;
};
const run = (script, args, env) => cp.spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });

// Fingerprint of everything EXCEPT .agentsmd-state: the pre-operation backup
// under .agentsmd-state/backups is created before the transaction and kept on
// purpose (recovery evidence), so "rollback restored the home" means every
// OTHER byte is identical — exactly the artifacts a fault could corrupt.
function fingerprint(root) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      if (dir === root && e.name === '.agentsmd-state') continue;
      const full = path.join(dir, e.name);
      h.update(path.relative(root, full));
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { h.update(String(fs.statSync(full).mode)); h.update(fs.readFileSync(full)); }
      else if (e.isSymbolicLink()) h.update(fs.readlinkSync(full));
    }
  };
  walk(root);
  return h.digest('hex');
}

// No unexpected stage / old / lock / journal residue (the Gate-C wording).
// Archived journal evidence (.stale-) and preserved backups are EXPECTED.
function assertNoResidue(home, label) {
  const bad = [];
  const scan = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (/\.agentsmd-(stage|uninstall-stage)-/.test(e.name)) bad.push(full);
      if (e.name.includes('.agentsmd-old-')) bad.push(full);
      if (e.name === '.agentsmd-lifecycle-lock') bad.push(full);
      if (e.name === '.agentsmd-lifecycle-journal.json') bad.push(full);
      if (e.isDirectory() && !e.name.includes('quarantine')) scan(full);
    }
  };
  scan(home);
  assert.deepStrictEqual(bad, [], `${label}: unexpected residue: ${bad.join(', ')}`);
}

function doctorGreen(home, label) {
  const r = cp.spawnSync(process.execPath, ['-e',
    `const d=require(${JSON.stringify(path.join(SCRIPTS, 'doctor.js'))}).doctor();console.log(JSON.stringify({ok:d.ok,bad:d.checks.filter(c=>!c.ok)}))`],
    { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.ok, `${label}: doctor red: ${JSON.stringify(out.bad)}`);
}

(async () => {

const INSTALL_KILLS = ['after-journal', 'mid-swaps', 'after-swaps', 'mid-writes', 'before-cleanup'];
const UNINSTALL_KILLS = ['u-after-journal', 'u-mid-files', 'u-after-quarantine', 'u-before-cleanup'];

for (const point of INSTALL_KILLS) {
  await t(`matrix[SIGKILL install ${point}] x2 consecutive rounds: crash → heal → crash → heal, residue-free, doctor green`, () => {
    const home = sandbox(`k-${point}`);
    for (let round = 1; round <= 2; round++) {
      const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: point });
      assert.strictEqual(crashed.signal, 'SIGKILL', `round ${round}: must crash at ${point}`);
      const healed = run('install.js', [], { CODEX_HOME: home });
      assert.strictEqual(healed.status, 0, `round ${round}: heal failed: ${healed.stderr}`);
      assertNoResidue(home, `round ${round}`);
    }
    doctorGreen(home, point);
  });
}

for (const point of UNINSTALL_KILLS) {
  await t(`matrix[SIGKILL uninstall ${point}] x2 consecutive rounds (reinstall between): residue-free, complete removal`, () => {
    const home = sandbox(`k-${point}`);
    for (let round = 1; round <= 2; round++) {
      assert.strictEqual(run('install.js', [], { CODEX_HOME: home }).status, 0, `round ${round}: seed install`);
      const crashed = run('uninstall.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: point });
      assert.strictEqual(crashed.signal, 'SIGKILL', `round ${round}: must crash at ${point}`);
      const healed = run('uninstall.js', [], { CODEX_HOME: home });
      assert.strictEqual(healed.status, 0, `round ${round}: uninstall heal failed: ${healed.stderr}`);
      assertNoResidue(home, `round ${round}`);
      assert.ok(!fs.existsSync(path.join(home, '.agentsmd-state', 'manifest.json')), `round ${round}: manifest gone`);
    }
  });
}

const ERRNO_MATRIX = [];
for (const point of ['after-journal', 'mid-swaps', 'mid-writes']) {
  for (const code of ['ENOSPC', 'EACCES']) ERRNO_MATRIX.push([point, code]);
}

for (const [point, code] of ERRNO_MATRIX) {
  await t(`matrix[errno ${code} at ${point}] x2 rounds: in-process rollback restores byte-identical home, then clean install succeeds`, () => {
    const home = sandbox(`e-${point}-${code}`);
    // Pre-create the shared skills/ dir: install mkdirs it as a swap parent and
    // rollback rightly never deletes a SHARED directory (other plugins write
    // there), so it must exist on both sides of the fingerprint.
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    const before = fingerprint(home);
    for (let round = 1; round <= 2; round++) {
      const failed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_FAULT_AT: `${point}:${code}` });
      assert.strictEqual(failed.status, 1, `round ${round}: fault must fail the install`);
      assert.ok(failed.stderr.includes(code), `round ${round}: error names the errno: ${failed.stderr}`);
      assert.strictEqual(fingerprint(home), before, `round ${round}: rollback must leave the home byte-identical`);
      assertNoResidue(home, `round ${round}`);
    }
    const clean = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(clean.status, 0, clean.stderr);
    doctorGreen(home, `${point}:${code}`);
  });
}

await t('real permission fault: read-only skills dir → genuine EACCES mid-commit → rollback byte-identical; restored perms → install green', () => {
  const home = sandbox('perm');
  const skills = path.join(home, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.chmodSync(skills, 0o555);
  const before = fingerprint(home);
  try {
    const failed = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(failed.status, 1, `real EACCES must fail the install: ${failed.stdout}`);
    assert.ok(/EACCES|permission denied/i.test(failed.stderr), failed.stderr);
    assert.strictEqual(fingerprint(home), before, 'rollback byte-identical under a real fs fault');
    assertNoResidue(home, 'real-perm');
  } finally { fs.chmodSync(skills, 0o755); }
  const clean = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(clean.status, 0, clean.stderr);
  doctorGreen(home, 'real-perm');
});

await t('fs-atomic.fsyncDir: callable on real dirs, silent on refusal targets', () => {
  const F = require('../lib/fs-atomic');
  const home = sandbox('fsync');
  assert.strictEqual(F.fsyncDir(home), undefined);
  assert.strictEqual(F.fsyncDir(path.join(home, 'nope-does-not-exist')), undefined, 'missing dir must not throw');
});

for (const d of SANDBOXES) fs.rmSync(d, { recursive: true, force: true }); // §8.V4

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);

})();
