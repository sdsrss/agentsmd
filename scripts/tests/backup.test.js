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
const cp = require('child_process');

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

  t('default restore selects the newest pre-install backup, not a newer pre-uninstall backup', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-purpose-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'before-install');
      const installBackup = B.createBackup('2026-07-06T00:00:00.000Z', 'pre-install');
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'installed');
      const uninstallBackup = B.createBackup('2026-07-06T01:00:00.000Z', 'pre-uninstall');
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'after-uninstall');
      const plan = B.planRestore(null);
      assert.strictEqual(plan.id, installBackup.id);
      assert.strictEqual(B.listBackups()[0].id, uninstallBackup.id);
      B.restoreBackup();
      assert.strictEqual(fs.readFileSync(path.join(SB, 'hooks.json'), 'utf8'), 'before-install');
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('restore rejects a declared-present snapshot file that is missing', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-corrupt-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'before');
      const backup = B.createBackup('corrupt', 'pre-install');
      fs.unlinkSync(path.join(backup.dir, 'hooks.json'));
      assert.throws(() => B.planRestore(backup.id), /declared-present.*hooks\.json|hooks\.json.*missing/i);
      assert.throws(() => B.restoreBackup(backup.id), /declared-present.*hooks\.json|hooks\.json.*missing/i);
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('legacy snapshots without purpose/state metadata are selected only when their derived footprint matches current install state', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-legacy-state-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), '{"hooks":{}}');
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), '# tenant\n');
      const safe = B.createBackup('legacy-safe', 'pre-install');
      fs.writeFileSync(path.join(SB, 'hooks.json'), JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `bash "${path.join(SB, 'agentsmd', 'hooks', 'stop.sh')}"` }] }] },
      }));
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), '# >>> agentsmd >>>\nspec\n# <<< agentsmd <<<\n');
      const unsafe = B.createBackup('legacy-unsafe', 'pre-install');
      for (const backup of [safe, unsafe]) {
        const manifestPath = path.join(backup.dir, 'backup-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete manifest.purpose;
        delete manifest.agentsmdSharedState;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      }
      assert.strictEqual(B.planRestore().id, safe.id);
      assert.throws(() => B.planRestore(unsafe.id), /unsafe restore.*partial install/i);
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('restore rolls back the first shared file when writing the second file fails', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-restore-rollback-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'backup-hooks');
      fs.writeFileSync(path.join(SB, 'config.toml'), 'backup-config');
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), 'backup-agents');
      const backup = B.createBackup('rollback', 'pre-install');
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'live-hooks');
      fs.writeFileSync(path.join(SB, 'config.toml'), 'live-config');
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), 'live-agents');
      let writes = 0;
      const write = (file, content, options) => {
        writes++;
        if (writes === 2) throw new Error('injected second-file failure');
        B.writeFileAtomic(file, content, options);
      };
      assert.throws(() => B.restoreBackup(backup.id, { write }), /injected second-file failure/);
      assert.strictEqual(fs.readFileSync(path.join(SB, 'hooks.json'), 'utf8'), 'live-hooks');
      assert.strictEqual(fs.readFileSync(path.join(SB, 'config.toml'), 'utf8'), 'live-config');
      assert.strictEqual(fs.readFileSync(path.join(SB, 'AGENTS.md'), 'utf8'), 'live-agents');
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  for (const targetName of ['hooks.json', 'config.toml', 'AGENTS.md']) {
    t(`restore refuses a concurrent ${targetName} change immediately before its write`, () => {
      const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-restore-cas-'));
      process.env.CODEX_HOME = SB;
      try {
        const names = ['hooks.json', 'config.toml', 'AGENTS.md'];
        for (const name of names) fs.writeFileSync(path.join(SB, name), `backup-${name}`);
        const backup = B.createBackup(`cas-${targetName}`, 'pre-install');
        for (const name of names) fs.writeFileSync(path.join(SB, name), `live-${name}`);

        const write = (file, content, options) => {
          if (path.basename(file) === targetName) fs.writeFileSync(file, `concurrent-${targetName}`);
          B.writeFileAtomic(file, content, options);
        };
        assert.throws(
          () => B.restoreBackup(backup.id, { write }),
          /concurrent change detected.*refusing to overwrite newer bytes/i
        );
        for (const name of names) {
          const expected = name === targetName ? `concurrent-${targetName}` : `live-${name}`;
          assert.strictEqual(fs.readFileSync(path.join(SB, name), 'utf8'), expected, name);
        }
      } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
    });
  }

  t('restore CLI reports filesystem failures without a Node stack trace or partial write', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-restore-cli-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'backup-hooks');
      fs.writeFileSync(path.join(SB, 'config.toml'), 'backup-config');
      fs.writeFileSync(path.join(SB, 'AGENTS.md'), 'backup-agents');
      const backup = B.createBackup('cli-error', 'pre-install');
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'live-hooks');
      fs.unlinkSync(path.join(SB, 'config.toml'));
      fs.mkdirSync(path.join(SB, 'config.toml'));
      const run = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'restore.js'), `--id=${backup.id}`, '--confirm'], {
        env: { ...process.env, CODEX_HOME: SB }, encoding: 'utf8',
      });
      assert.strictEqual(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /^agentsmd restore: /);
      assert(!/\n\s+at\s/.test(run.stderr), run.stderr);
      assert.strictEqual(fs.readFileSync(path.join(SB, 'hooks.json'), 'utf8'), 'live-hooks');
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('createBackup removes a new partial snapshot when a later source read fails', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-create-cleanup-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'hooks-first');
      fs.mkdirSync(path.join(SB, 'config.toml'));
      assert.throws(() => B.createBackup('partial-read', 'pre-install'), /EISDIR|directory/i);
      assert(!fs.existsSync(path.join(B.backupsDir(), 'partial-read')), 'partial backup directory survived');
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('createBackup removes a new partial snapshot when a later snapshot write fails', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-create-write-cleanup-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.writeFileSync(path.join(SB, 'hooks.json'), 'hooks-first');
      fs.writeFileSync(path.join(SB, 'config.toml'), 'config-second');
      let writes = 0;
      const write = (file, content, options) => {
        writes++;
        if (writes === 2) throw new Error('injected backup write failure');
        B.writeFileAtomic(file, content, options);
      };
      assert.throws(() => B.createBackup('partial-write', 'pre-install', { write }), /injected backup write failure/);
      assert(!fs.existsSync(path.join(B.backupsDir(), 'partial-write')), 'partial backup directory survived');
    } finally { process.env.CODEX_HOME = SANDBOX; fs.rmSync(SB, { recursive: true, force: true }); }
  });

  t('listBackups returns [] only for ENOENT and propagates other filesystem errors', () => {
    const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-backup-list-error-'));
    process.env.CODEX_HOME = SB;
    try {
      fs.mkdirSync(path.join(SB, '.agentsmd-state'), { recursive: true });
      fs.writeFileSync(B.backupsDir(), 'not a directory');
      assert.throws(() => B.listBackups(), /ENOTDIR|not a directory/i);
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
