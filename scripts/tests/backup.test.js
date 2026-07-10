'use strict';
// backup.test.js — round-trip + rotation for scripts/lib/backup.js and the restore
// CLI. Proves the safety net: a snapshot taken before a mutation restores the exact
// prior bytes (recovering from a logically-wrong merge), rotation keeps the newest N,
// a file absent at backup time is never deleted on restore, and the CLI is dry-run
// until --confirm. Sandboxed CODEX_HOME (never touches the live ~/.codex).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-'));
process.env.CODEX_HOME = SANDBOX;
const B = require('../lib/backup');
const seed = (rel, c) => { const p = path.join(SANDBOX, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const read = (rel) => fs.readFileSync(path.join(SANDBOX, rel), 'utf8');

try {
  // ── round-trip: backup → bad merge → restore returns prior bytes ────────────
  seed('hooks.json', '{"tenant":"omx","v":1}');
  seed('config.toml', '[features]\nhooks = true\n');
  seed('AGENTS.md', '# tenant A block\n');
  const b1 = B.createBackup('2026-07-06T00:00:00.000Z');

  t('createBackup snapshots the present shared files + a manifest', () => {
    assert.deepStrictEqual(b1.files.sort(), ['AGENTS.md', 'config.toml', 'hooks.json']);
    assert.strictEqual(b1.skipped.length, 0);
    assert.ok(fs.existsSync(path.join(b1.dir, 'hooks.json')));
    assert.ok(fs.existsSync(path.join(b1.dir, 'backup-manifest.json')));
    assert.strictEqual(b1.id, '2026-07-06T00_00_00.000Z'); // stamp sanitized for the FS
  });

  t('backup snapshots and state directories are owner-only', () => {
    assert.strictEqual(fs.statSync(B.backupsDir()).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(b1.dir).mode & 0o777, 0o700);
    for (const name of [...b1.files, 'backup-manifest.json']) {
      assert.strictEqual(fs.statSync(path.join(b1.dir, name)).mode & 0o777, 0o600, name);
    }
  });

  t('restore returns the exact pre-mutation bytes after a merge dropped a tenant', () => {
    fs.writeFileSync(path.join(SANDBOX, 'hooks.json'), '{"agentsmd":"only — tenant dropped!"}');
    fs.writeFileSync(path.join(SANDBOX, 'AGENTS.md'), '# clobbered\n');
    const res = B.restoreBackup(b1.id);
    assert.deepStrictEqual(res.restored.sort(), ['AGENTS.md', 'config.toml', 'hooks.json']);
    assert.strictEqual(read('hooks.json'), '{"tenant":"omx","v":1}');
    assert.strictEqual(read('AGENTS.md'), '# tenant A block\n');
  });

  t('atomic restore reinstates the snapshotted file mode', () => {
    const hooks = path.join(SANDBOX, 'hooks.json');
    fs.chmodSync(hooks, 0o640);
    const b = B.createBackup('mode-fixture');
    fs.chmodSync(hooks, 0o666);
    B.restoreBackup(b.id);
    assert.strictEqual(fs.statSync(hooks).mode & 0o777, 0o640);
  });

  t('planRestore is a pure preview — it never writes', () => {
    fs.writeFileSync(path.join(SANDBOX, 'hooks.json'), 'MUTATED');
    const plan = B.planRestore(b1.id);
    assert.deepStrictEqual(plan.willRestore.sort(), ['AGENTS.md', 'config.toml', 'hooks.json']);
    assert.strictEqual(read('hooks.json'), 'MUTATED');
  });

  // ── a file absent at backup time is LEFT ALONE on restore (never deleted) ────
  t('absent-at-backup file is skipped; restore leaves a later-added tenant file', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup2-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'orig');           // only hooks.json exists
      const b = B.createBackup('s1');
      assert.deepStrictEqual(b.files, ['hooks.json']);
      assert.deepStrictEqual(b.skipped.sort(), ['AGENTS.md', 'config.toml']);
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), 'tenant-added-later'); // created AFTER backup
      const res = B.restoreBackup(b.id);
      assert.deepStrictEqual(res.restored, ['hooks.json']);
      assert.ok(res.left.includes('AGENTS.md') && res.left.includes('config.toml'));
      assert.strictEqual(fs.readFileSync(path.join(SB, 'AGENTS.md'), 'utf8'), 'tenant-added-later'); // survives
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  // ── rotation: keep the newest N ─────────────────────────────────────────────
  t('pruneBackups keeps the newest N and deletes older', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup3-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'x');
      for (let i = 1; i <= 7; i++) B.createBackup('stamp-' + String(i).padStart(2, '0'));
      assert.strictEqual(B.listBackups().length, 7);
      const removed = B.pruneBackups(5);
      assert.strictEqual(removed.length, 2);
      const remaining = B.listBackups().map((b) => b.id);
      assert.strictEqual(remaining.length, 5);
      assert.ok(!remaining.includes('stamp-01') && !remaining.includes('stamp-02'), 'oldest 2 gone: ' + remaining.join(','));
      assert.ok(remaining.includes('stamp-07'));
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('listBackups on a missing dir returns [] (no throw); planRestore throws clearly', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup4-'));
    process.env.CODEX_HOME = SB;
    try {
      assert.deepStrictEqual(B.listBackups(), []);
      assert.throws(() => B.planRestore(null), /no backups/);
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  // ── restore CLI: dry-run previews, --confirm writes ─────────────────────────
  t('restore CLI is dry-run without --confirm; --confirm writes the snapshot back', () => {
    const R = require('../restore');
    fs.writeFileSync(path.join(SANDBOX, 'hooks.json'), 'DIRTY');
    assert.strictEqual(R.main([]), 0);
    assert.strictEqual(read('hooks.json'), 'DIRTY');                    // dry-run: no write
    assert.strictEqual(R.main(['--confirm']), 0);
    assert.strictEqual(read('hooks.json'), '{"tenant":"omx","v":1}');   // restored (newest = b1)
  });

  t('restore CLI rejects unknown options with exit 2', () => {
    const R = require('../restore');
    assert.strictEqual(R.main(['--bogus']), 2);
  });
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true }); // §8.V4 sandbox disposal
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
