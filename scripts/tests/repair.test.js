'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
  }
}

function clearModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, 'scripts') + path.sep)) delete require.cache[key];
  }
}

function withSandbox(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-repair-test.'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    clearModules();
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    clearModules();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function load() {
  return {
    install: require('../install').install,
    doctor: require('../doctor').doctor,
    repair: require('../repair'),
    F: require('../lib/fs-atomic'),
  };
}

function seedTenant(home) {
  const hooks = JSON.stringify({
    hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo tenant-hook' }] }] },
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(home, 'hooks.json'), hooks);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "tenant-model"\n');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# Tenant instructions\nKeep this text.\n');
  const skill = path.join(home, 'skills', 'tenant-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'tenant skill bytes\n');
}

function sharedBytes(home) {
  return ['hooks.json', 'config.toml', 'AGENTS.md'].map((name) => fs.readFileSync(path.join(home, name)));
}

function assertBuffersEqual(actual, expected) {
  assert.strictEqual(actual.length, expected.length);
  actual.forEach((value, index) => assert(value.equals(expected[index]), `buffer ${index} changed`));
}

withSandbox((home) => {
  seedTenant(home);
  const { install, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  const before = F.sha256Tree(home);
  const plan = repair.planRepair();
  const after = F.sha256Tree(home);

  test('repair plan is read-only for a healthy standalone install', () => {
    assert.strictEqual(plan.classification, 'healthy');
    assert.strictEqual(plan.applyAllowed, false);
    assert.strictEqual(before, after);
    assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  });
  test('repair plan labels shared-only backups without claiming deploy recovery', () => {
    assert(plan.backups.length >= 1);
    assert(plan.backups.every((backup) => backup.scope === 'shared-files-only'));
  });
});

withSandbox((home) => {
  const { install, doctor, repair } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.unlinkSync(path.join(home, 'AGENTS-extended.md'));
  fs.rmSync(path.join(home, 'skills', 'agentsmd-audit'), { recursive: true, force: true });
  const plan = repair.planRepair();

  test('missing manifest-owned extended and skill artifacts are repairable', () => {
    assert.strictEqual(plan.classification, 'owned-files-missing');
    assert(plan.missing.includes('extended:AGENTS-extended.md'));
    assert(plan.missing.includes('skill:agentsmd-audit'));
  });
  repair.applyRepair(plan.planDigest, { nowIso: '2026-07-14T01:30:00.000Z' });
  test('repair restores missing extended and skill artifacts', () => {
    assert(fs.existsSync(path.join(home, 'AGENTS-extended.md')));
    assert(fs.existsSync(path.join(home, 'skills', 'agentsmd-audit', 'SKILL.md')));
    assert.strictEqual(doctor().ok, true);
  });
});

withSandbox((home) => {
  seedTenant(home);
  const { install, doctor, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  const missing = path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh');
  fs.unlinkSync(missing);
  const tenantBefore = sharedBytes(home);
  const tenantSkillBefore = F.sha256Tree(path.join(home, 'skills', 'tenant-skill'));
  const plan = repair.planRepair();

  test('plan classifies a missing manifest-owned support file as repairable', () => {
    assert.strictEqual(plan.classification, 'owned-files-missing');
    assert.strictEqual(plan.applyAllowed, true);
    assert(plan.missing.includes('deploy:hooks/lib/hook-common.sh'));
    assert.strictEqual(plan.mismatched.length, 0);
    assert.strictEqual(plan.unexpected.length, 0);
  });

  const result = repair.applyRepair(plan.planDigest, { nowIso: '2026-07-14T01:00:00.000Z' });
  test('confirmed repair restores the missing support file and doctor becomes green', () => {
    assert.strictEqual(result.repaired, true);
    assert(fs.existsSync(missing));
    assert.strictEqual(doctor().ok, true);
  });
  test('confirmed repair preserves shared and foreign-skill bytes', () => {
    assertBuffersEqual(sharedBytes(home), tenantBefore);
    assert.strictEqual(F.sha256Tree(path.join(home, 'skills', 'tenant-skill')), tenantSkillBefore);
  });
  test('confirmed repair retains a full recovery snapshot', () => {
    assert(fs.existsSync(result.recoverySnapshot));
    const metadata = JSON.parse(fs.readFileSync(path.join(result.recoverySnapshot, 'repair-snapshot.json'), 'utf8'));
    assert.strictEqual(metadata.planDigest, plan.planDigest);
    assert(metadata.artifacts.some((artifact) => artifact.name === 'deploy'));
    assert.strictEqual(metadata.manifest.descriptor.type, 'file');
    assert.strictEqual(metadata.sharedFiles.length, 3);
    assert(metadata.sharedFiles.every((file) => file.descriptor.present && file.snapshotPath));
    assert(fs.existsSync(path.join(result.recoverySnapshot, 'manifest.json')));
    assert(fs.existsSync(path.join(result.recoverySnapshot, 'shared', 'hooks.json')));
  });
});

withSandbox((home) => {
  const { install, repair } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.unlinkSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  const manifestPath = path.join(home, '.agentsmd-state', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '4.1.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const plan = repair.planRepair();

  test('missing files require an artifact matching the manifest release identity', () => {
    assert.strictEqual(plan.classification, 'matching-artifact-required');
    assert.strictEqual(plan.applyAllowed, false);
    assert.strictEqual(plan.recommendedAction.code, 'use-matching-artifact');
    assert.match(plan.recommendedAction.command, /@sdsrs\/agentsmd@4\.1\.0/);
  });
});

withSandbox((home) => {
  const { install, repair } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.writeFileSync(path.join(home, 'agentsmd', 'unexpected.txt'), 'do not adopt\n');
  const plan = repair.planRepair();

  test('unexpected bytes inside the owned deploy block automatic repair', () => {
    assert.strictEqual(plan.classification, 'owned-content-modified');
    assert.strictEqual(plan.applyAllowed, false);
    assert(plan.unexpected.includes('deploy:unexpected.txt'));
    assert.throws(() => repair.applyRepair(plan.planDigest), /not allowed/);
    assert.strictEqual(fs.readFileSync(path.join(home, 'agentsmd', 'unexpected.txt'), 'utf8'), 'do not adopt\n');
  });
});

withSandbox((home) => {
  const { install, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.unlinkSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  const plan = repair.planRepair();
  const release = require('../lib/release-artifact');
  const originalStage = release.stageSources;
  const concurrent = '# concurrent managed replacement\n';
  release.stageSources = (...args) => {
    const staged = originalStage(...args);
    fs.writeFileSync(path.join(home, 'AGENTS.md'), concurrent);
    return staged;
  };
  let error;
  try { repair.applyRepair(plan.planDigest, { nowIso: '2026-07-14T01:45:00.000Z' }); }
  catch (caught) { error = caught; }
  finally { release.stageSources = originalStage; }

  test('shared-file changes during staging invalidate confirm and preserve concurrent bytes', () => {
    assert(error && /plan changed.*shared file/i.test(error.message));
    assert.strictEqual(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), concurrent);
    assert(!fs.existsSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh')));
    assert.strictEqual(F.describePath(path.join(home, '.agentsmd-state', 'manifest.json')).type, 'file');
  });
});

withSandbox((home) => {
  const { install, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.agentsmd-state', 'manifest.json'), '{ malformed');
  const before = F.sha256Tree(home);
  const plan = repair.planRepair();

  test('malformed manifest is classified separately and never auto-repaired', () => {
    assert.strictEqual(plan.classification, 'ownership-unprovable');
    assert.strictEqual(plan.manifest.valid, false);
    assert.match(plan.manifest.error, /not valid JSON/);
    assert.strictEqual(plan.applyAllowed, false);
    assert.strictEqual(F.sha256Tree(home), before);
  });
});

withSandbox((home) => {
  const { install, repair } = load();
  const uninstall = require('../uninstall').uninstall;
  install('2026-07-14T00:00:00.000Z');
  const installedAgents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  uninstall();
  fs.writeFileSync(path.join(home, 'AGENTS.md'), installedAgents);
  const plan = repair.planRepair();

  test('manifest-less sentinel footprint is not mistaken for an uninstalled shim state', () => {
    assert.strictEqual(plan.classification, 'ownership-unprovable');
    assert.strictEqual(plan.applyAllowed, false);
    assert(plan.blockers.some((blocker) => /manifest is missing/.test(blocker)));
  });
});

withSandbox((home) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-repair-outside.'));
  try {
    const { install, repair } = load();
    install('2026-07-14T00:00:00.000Z');
    fs.unlinkSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
    const plan = repair.planRepair();
    fs.symlinkSync(outside, path.join(home, '.agentsmd-state', 'repair-snapshots'), 'dir');

    test('repair refuses a symlinked recovery-snapshot root without writing outside CODEX_HOME', () => {
      assert.throws(() => repair.applyRepair(plan.planDigest), /plan changed|unsafe repair snapshot directory/);
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

withSandbox((home) => {
  const { install, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.unlinkSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  const plan = repair.planRepair();
  fs.writeFileSync(path.join(home, 'agentsmd', 'concurrent.txt'), 'new bytes\n');
  const before = F.sha256Tree(home);

  test('confirm refuses a stale plan digest before mutation', () => {
    assert.throws(() => repair.applyRepair(plan.planDigest), /plan changed|digest/i);
    assert.strictEqual(F.sha256Tree(home), before);
  });
});

withSandbox((home) => {
  const { install, repair } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.appendFileSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'), '\nmodified\n');
  const plan = repair.planRepair();

  test('modified owned bytes are reported but not automatically adopted', () => {
    assert.strictEqual(plan.classification, 'owned-content-modified');
    assert.strictEqual(plan.applyAllowed, false);
    assert(plan.mismatched.includes('deploy:hooks/lib/hook-common.sh'));
  });
});

withSandbox((home) => {
  const { install, doctor, repair, F } = load();
  install('2026-07-14T00:00:00.000Z');
  fs.unlinkSync(path.join(home, '.agentsmd-state', 'manifest.json'));
  const before = F.sha256Tree(home);
  const plan = repair.planRepair();

  test('manifest-less partial install requires manual recovery and remains unchanged', () => {
    assert.strictEqual(plan.classification, 'ownership-unprovable');
    assert.strictEqual(plan.applyAllowed, false);
    assert.strictEqual(F.sha256Tree(home), before);
  });
  test('doctor points a manifest-less partial install to repair planning, not blind install', () => {
    const check = doctor().checks.find((candidate) => candidate.name === 'install state consistent (manifest vs live hooks)');
    assert(check && check.ok === false);
    assert.match(check.detail, /agentsmd repair --plan/);
    assert.doesNotMatch(check.detail, /re-run install\.js/);
  });
});

withSandbox((home) => {
  const { install, repair, F } = load();
  const B = require('../lib/backup');
  install('2026-07-14T00:00:00.000Z');
  for (let index = 0; index < 6; index++) B.createBackup(`2026-07-13T0${index}:00:00.000Z`, 'pre-install');
  const backupsBefore = B.listBackups().map((backup) => backup.id);
  fs.unlinkSync(path.join(home, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  const plan = repair.planRepair();
  const deployBefore = F.sha256Tree(path.join(home, 'agentsmd'));
  const manifestBefore = fs.readFileSync(path.join(home, '.agentsmd-state', 'manifest.json'));
  const hooksBefore = fs.readFileSync(path.join(home, 'hooks.json'));
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(path.join(home, 'hooks.json'))) {
      throw new Error('injected repair commit failure');
    }
    return realRename(from, to);
  };
  let error;
  try { repair.applyRepair(plan.planDigest, { nowIso: '2026-07-14T02:00:00.000Z' }); }
  catch (caught) { error = caught; }
  finally { fs.renameSync = realRename; }

  test('an injected apply failure restores the damaged pre-repair lifecycle state', () => {
    assert(error && /injected repair commit failure/.test(error.message));
    assert.strictEqual(F.sha256Tree(path.join(home, 'agentsmd')), deployBefore);
    assert(fs.readFileSync(path.join(home, '.agentsmd-state', 'manifest.json')).equals(manifestBefore));
    assert(fs.readFileSync(path.join(home, 'hooks.json')).equals(hooksBefore));
    assert.deepStrictEqual(B.listBackups().map((backup) => backup.id), backupsBefore);
  });
});

const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-repair-cli.'));
const cli = cp.spawnSync(process.execPath, [path.join(ROOT, 'bin', 'agentsmd.js'), 'repair', '--help'], {
  env: { ...process.env, CODEX_HOME: cliHome },
  encoding: 'utf8',
});
try {
  test('repair CLI help is read-only and documents plan-bound confirmation', () => {
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /repair --plan/);
    assert.match(cli.stdout, /--confirm=<planDigest>/);
  });
} finally {
  fs.rmSync(cliHome, { recursive: true, force: true });
}

console.log(`\nrepair tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
