'use strict';
// uninstall.js — remove agentsmd from ~/.codex, touching ONLY agentsmd's own
// footprint. OMX (or any other tenant) entries in hooks.json / AGENTS.md are
// left byte-for-byte. Per §5 the config.toml hooks flag is LEFT enabled
// (removing it could break OMX's or the user's own hooks).

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const M = require('./lib/migrate');
const B = require('./lib/backup');
const F = require('./lib/fs-atomic');
const S = require('./lib/uninstalled-shims');
const { parseStrict, printHelpAndExit } = require('./lib/argv');

const readOrNull = (file) => F.readFileOptional(file, 'utf8');

function validateOwnership(manifest) {
  const ownership = { deploy: null, extended: null, skills: [] };
  if (manifest && manifest.name !== 'agentsmd') throw new Error('ownership collision: install manifest identity is not agentsmd');
  const owned = manifest && manifest.ownedArtifacts;
  if (!owned) {
    const legacyFootprint = F.pathExists(P.installDir())
      || F.pathExists(P.agentsExtendedMdPath())
      || (manifest && Array.isArray(manifest.installedSkills)
        && manifest.installedSkills.some((name) => F.pathExists(path.join(P.codexSkillsDir(), name))));
    if (legacyFootprint) throw new Error('ownership collision: legacy manifest has no artifact hashes; uninstall made no changes');
    return ownership;
  }

  const deploy = owned.deploy;
  if (F.pathExists(P.installDir())) {
    if (!deploy || path.resolve(deploy.path || '') !== path.resolve(P.installDir())) {
      throw new Error('ownership collision: deploy directory has no exact manifest record');
    }
    let actual = null;
    try { actual = F.sha256Tree(P.installDir()); } catch {}
    if (actual !== deploy.sha256) throw new Error('ownership collision: deploy tree differs from manifest hash');
    ownership.deploy = { target: P.installDir(), sha256: deploy.sha256 };
  }

  const extended = owned.extended;
  if (F.pathExists(P.agentsExtendedMdPath())) {
    if (!extended || path.resolve(extended.path || '') !== path.resolve(P.agentsExtendedMdPath())) {
      throw new Error('ownership collision: AGENTS-extended.md has no exact manifest record');
    }
    const snapshot = F.snapshotFile(P.agentsExtendedMdPath());
    const actual = snapshot.present ? crypto.createHash('sha256').update(snapshot.content).digest('hex') : null;
    if (actual !== extended.sha256) throw new Error('ownership collision: AGENTS-extended.md differs from manifest hash');
    ownership.extended = { target: P.agentsExtendedMdPath(), sha256: extended.sha256, snapshot };
  }

  if (!Array.isArray(owned.skills)) throw new Error('ownership collision: manifest skill inventory is invalid');
  for (const record of owned.skills) {
    if (!record || typeof record.name !== 'string' || path.basename(record.name) !== record.name || !record.name.startsWith('agentsmd-')) {
      throw new Error('ownership collision: manifest contains an invalid skill record');
    }
    const target = path.join(P.codexSkillsDir(), record.name);
    if (path.resolve(record.path || '') !== path.resolve(target)) throw new Error(`ownership collision: skill path mismatch for ${record.name}`);
    if (!F.pathExists(target)) continue;
    let actual = null;
    try { actual = F.sha256Tree(target); } catch {}
    if (actual !== record.sha256) throw new Error(`ownership collision: installed skill ${record.name} differs from manifest hash`);
    ownership.skills.push({ target, sha256: record.sha256, name: record.name });
  }
  return ownership;
}

function ownedStateFiles(manifest) {
  if (!manifest) return [];
  const state = P.stateDir();
  const ownedName = /^(?:pending-advisories-.+|session-start-.+\.ref|tmp-baseline-.+\.txt|unvalidated-.+\.flag|mem-audit-.+\.stamp|session-summary-.+\.json|arbitration-cache\.json)$/;
  const files = [P.manifestPath()];
  let entries = [];
  try { entries = fs.readdirSync(state, { withFileTypes: true }); }
  catch (error) { if (error && error.code === 'ENOENT') return files; throw error; }
  for (const entry of entries) {
    if (entry.isFile() && ownedName.test(entry.name)) files.push(path.join(state, entry.name));
  }
  return files;
}

// Per-message advisory queues are directories (pending-advisories[-<key>].d), so
// the file sweep above never touches them; enumerate them separately so uninstall
// removes the queue rather than orphaning it and leaving stateDir non-empty.
function ownedStateDirs(manifest) {
  if (!manifest) return [];
  const state = P.stateDir();
  const ownedDir = /^pending-advisories(?:-.+)?\.d$/;
  const dirs = [];
  let entries = [];
  try { entries = fs.readdirSync(state, { withFileTypes: true }); }
  catch (error) { if (error && error.code === 'ENOENT') return dirs; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory() && ownedDir.test(entry.name)) dirs.push(path.join(state, entry.name));
  }
  return dirs;
}

function sameSnapshot(left, right) {
  return left.present === right.present
    && (!left.present || (left.mode === right.mode && left.content.equals(right.content)));
}

function createTransaction(stageRoot, files) {
  const unique = [...new Set(files.map((file) => path.resolve(file)))];
  return {
    stageRoot,
    files: unique.map((file) => ({ file, before: F.snapshotFile(file), after: null })),
    swaps: [],
    directorySnapshots: [],
    keepStage: false,
  };
}

function transactionFile(transaction, file) {
  const absolute = path.resolve(file);
  let record = transaction.files.find((candidate) => candidate.file === absolute);
  if (!record) {
    record = { file: absolute, before: F.snapshotFile(absolute), after: null };
    transaction.files.push(record);
  }
  return record;
}

function mutateFile(transaction, file, action) {
  const record = transactionFile(transaction, file);
  action();
  record.after = F.snapshotFile(record.file);
}

function quarantineDirectory(transaction, target, expectedHash, label) {
  if (!F.pathExists(target)) return null;
  let actual = null;
  try { actual = F.sha256Tree(target); } catch {}
  if (actual !== expectedHash) throw new Error(`ownership collision: ${label} changed before quarantine`);
  const backup = path.join(transaction.stageRoot, 'quarantine', String(transaction.swaps.length));
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.renameSync(target, backup);
  const record = { target, backup, afterPresent: false, afterHash: null, keepBackup: false };
  transaction.swaps.push(record);
  return record;
}

function markDirectoryAfter(record) {
  record.afterPresent = F.pathExists(record.target);
  record.afterHash = record.afterPresent ? F.sha256Tree(record.target) : null;
}

function snapshotDirectories(transaction, targets) {
  const root = path.join(transaction.stageRoot, 'legacy-snapshots');
  for (const target of targets) {
    const present = F.pathExists(target);
    const backup = path.join(root, String(transaction.directorySnapshots.length));
    if (present) fs.cpSync(target, backup, { recursive: true });
    transaction.directorySnapshots.push({
      target,
      backup,
      present,
      beforeHash: present ? F.sha256Tree(target) : null,
      afterPresent: present,
      afterHash: present ? F.sha256Tree(target) : null,
    });
  }
}

function markDirectorySnapshotsAfter(transaction) {
  for (const record of transaction.directorySnapshots) {
    record.afterPresent = F.pathExists(record.target);
    record.afterHash = record.afterPresent ? F.sha256Tree(record.target) : null;
  }
}

function rollback(transaction) {
  const errors = [];
  for (const record of [...transaction.files].reverse()) {
    if (!record.after) continue;
    try {
      const current = F.snapshotFile(record.file);
      if (sameSnapshot(current, record.before)) continue;
      if (sameSnapshot(current, record.after)) F.restoreFile(record.file, record.before);
      else errors.push(`rollback conflict ${record.file}: changed concurrently; preserved current bytes`);
    } catch (error) { errors.push(`${record.file}: ${error.message}`); }
  }
  for (const record of [...transaction.swaps].reverse()) {
    try {
      const present = F.pathExists(record.target);
      let matches = present === record.afterPresent;
      if (matches && present) matches = F.sha256Tree(record.target) === record.afterHash;
      if (!matches) {
        record.keepBackup = true;
        transaction.keepStage = true;
        errors.push(`rollback conflict ${record.target}: changed concurrently; original retained at ${record.backup}`);
        continue;
      }
      fs.rmSync(record.target, { recursive: true, force: true });
      fs.renameSync(record.backup, record.target);
    } catch (error) { errors.push(`${record.target}: ${error.message}`); }
  }
  for (const record of [...transaction.directorySnapshots].reverse()) {
    try {
      const present = F.pathExists(record.target);
      let matches = present === record.afterPresent;
      if (matches && present) matches = F.sha256Tree(record.target) === record.afterHash;
      if (!matches) {
        errors.push(`rollback conflict ${record.target}: changed concurrently; preserved current tree`);
        continue;
      }
      if (record.present === record.afterPresent && record.beforeHash === record.afterHash) continue;
      fs.rmSync(record.target, { recursive: true, force: true });
      if (record.present) fs.cpSync(record.backup, record.target, { recursive: true });
    } catch (error) { errors.push(`${record.target}: ${error.message}`); }
  }
  return errors;
}

function cleanupTransaction(transaction) {
  if (transaction.keepStage) return null;
  try { fs.rmSync(transaction.stageRoot, { recursive: true, force: true }); return null; }
  catch (error) { return `quarantine cleanup retained at ${transaction.stageRoot}: ${error.message}`; }
}

function uninstall() {
  // 0. Pre-flight abort on an unparseable shared hooks.json (mirror of install's
  //    step-0). It may hold other tenants' hooks we can't see; removeMarkedHooks
  //    would silently no-op on it and ORPHAN agentsmd's own entries while claiming
  //    success. Fail loudly so the user fixes it and gets a clean, full uninstall,
  //    rather than a half-done one that reports done. Nothing has been touched yet.
  const beforeHooksSnapshot = F.snapshotFile(P.hooksJsonPath());
  const beforeHooks = beforeHooksSnapshot.present ? beforeHooksSnapshot.content.toString('utf8') : null;
  if (beforeHooks !== null && beforeHooks.trim() !== '' && !H.parseHooksConfig(beforeHooks)) {
    throw new Error(`${P.hooksJsonPath()} exists but is not valid JSON — agentsmd will not edit it blind (it may hold other tenants' hooks). Fix or remove it, then re-run uninstall.`);
  }

  let manifest = null;
  const manifestSnapshot = F.snapshotFile(P.manifestPath());
  const manifestRaw = manifestSnapshot.present ? manifestSnapshot.content.toString('utf8') : null;
  if (manifestRaw !== null) {
    try { manifest = JSON.parse(manifestRaw); }
    catch { throw new Error(`${P.manifestPath()} manifest is not valid JSON; ownership cannot be verified, so uninstall made no changes`); }
  }
  const ownership = validateOwnership(manifest);
  const result = {
    hooksRemoved: 0,
    hooksJsonDeleted: false,
    agentsBlockRemoved: false,
    extendedMdRemoved: false,
    flagLeftEnabled: true,
    ownershipConflicts: [],
  };

  // 0a. Best-effort pre-mutation backup of the shared files (mirror of install
  //     step 0a) so a logically-wrong removal is recoverable via `agentsmd restore`
  //     and a crash mid-uninstall leaves the snapshot behind (the state dir — where
  //     backups live — is only deleted on successful completion below). Never blocks
  //     the uninstall: a backup failure must not stop the user removing agentsmd.
  if (manifest) {
    try {
      const backup = B.createBackup(new Date().toISOString(), 'pre-uninstall');
      B.pruneBackups();
      result.backup = backup.id;
    } catch (error) {
      result.backupWarning = `pre-uninstall backup failed: ${error.message}`;
    }
  }
  const beforeAgentsSnapshot = F.snapshotFile(P.agentsMdPath());
  const beforeAgents = beforeAgentsSnapshot.present ? beforeAgentsSnapshot.content.toString('utf8') : null;
  const hooksRemoval = beforeHooks === null ? null : H.removeAgentsmdHooks(beforeHooks);
  const agentsRemoval = beforeAgents === null ? null : AM.removeSpecBlock(beforeAgents);
  const stateFiles = ownedStateFiles(manifest);
  const stateDirs = ownedStateDirs(manifest);
  const legacy = M.legacyArtifacts();
  const stageRoot = path.join(P.codexHome(), `.agentsmd-uninstall-stage-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  let transaction = null;

  try {
    transaction = createTransaction(stageRoot, [
      P.hooksJsonPath(), P.agentsMdPath(), P.agentsExtendedMdPath(),
      ...stateFiles, ...legacy.files,
    ]);
    snapshotDirectories(transaction, [...legacy.directories, ...stateDirs]);
    // 1. Shared files are marker-scoped and tracked byte-for-byte for rollback.
    if (hooksRemoval && hooksRemoval.removed > 0) {
      result.hooksRemoved = hooksRemoval.removed;
      if (hooksRemoval.nextContent === null) {
        mutateFile(transaction, P.hooksJsonPath(), () => F.unlinkFileIfUnchanged(P.hooksJsonPath(), beforeHooksSnapshot));
        result.hooksJsonDeleted = true;
      } else {
        mutateFile(transaction, P.hooksJsonPath(), () => F.writeFileAtomic(P.hooksJsonPath(), hooksRemoval.nextContent, { expectedSnapshot: beforeHooksSnapshot }));
      }
    }
    if (agentsRemoval && agentsRemoval.changed) {
      result.agentsBlockRemoved = true;
      if (agentsRemoval.content.trim() === '') mutateFile(transaction, P.agentsMdPath(), () => F.unlinkFileIfUnchanged(P.agentsMdPath(), beforeAgentsSnapshot));
      else mutateFile(transaction, P.agentsMdPath(), () => F.writeFileAtomic(P.agentsMdPath(), agentsRemoval.content, { expectedSnapshot: beforeAgentsSnapshot }));
    }

    if (ownership.extended) {
      mutateFile(transaction, P.agentsExtendedMdPath(), () => F.unlinkFileIfUnchanged(P.agentsExtendedMdPath(), ownership.extended.snapshot));
      result.extendedMdRemoved = true;
    }

    // 2. Quarantine owned directories instead of deleting them in place. They
    //    remain recoverable until every later uninstall phase succeeds.
    result.skillsRemoved = 0;
    for (const record of ownership.skills) {
      quarantineDirectory(transaction, record.target, record.sha256, `installed skill ${record.name}`);
      result.skillsRemoved++;
    }
    const deploySwap = ownership.deploy
      ? quarantineDirectory(transaction, ownership.deploy.target, ownership.deploy.sha256, 'deploy tree')
      : null;

    // 3. Remove only manifest/session files; backups and unknown state survive.
    for (const file of stateFiles) {
      if (F.pathExists(file)) {
        const expected = path.resolve(file) === path.resolve(P.manifestPath()) ? manifestSnapshot : transactionFile(transaction, file).before;
        mutateFile(transaction, file, () => F.unlinkFileIfUnchanged(file, expected));
      }
    }
    // Remove owned advisory-queue directories (snapshotted above for rollback;
    // markDirectorySnapshotsAfter records their absence) so the state dir can empty.
    for (const dir of stateDirs) {
      if (F.pathExists(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }

    try { fs.rmdirSync(P.stateDir()); result.stateDirRemoved = true; }
    catch (error) {
      if (!error || (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT')) throw error;
      result.stateDirRemoved = error.code === 'ENOENT';
    }

    // 4. Current-session compatibility shims are part of the deploy swap.
    if (deploySwap) {
      try { result.compatibilityShimsWritten = S.writeUninstalledHookShims(); }
      finally { markDirectoryAfter(deploySwap); }
    } else result.compatibilityShimsWritten = 0;

    // 5. Legacy cleanup is inside the same transaction boundary.
    try { result.legacyCodexmdRemoved = M.removeLegacyCodexmd(); }
    finally {
      for (const file of legacy.files) transactionFile(transaction, file).after = F.snapshotFile(file);
      markDirectorySnapshotsAfter(transaction);
    }

    const cleanupWarning = cleanupTransaction(transaction);
    if (cleanupWarning) result.cleanupWarnings = [cleanupWarning];
    return result;
  } catch (error) {
    const rollbackErrors = transaction ? rollback(transaction) : [];
    if (transaction) {
      const cleanupWarning = cleanupTransaction(transaction);
      if (cleanupWarning) rollbackErrors.push(cleanupWarning);
    } else {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    }
    if (rollbackErrors.length) error.message += `; ${rollbackErrors.join('; ')}`;
    throw error;
  }
}

const UNINSTALL_USAGE = [
  'Usage: agentsmd uninstall',
  '',
  "Remove agentsmd's owned entries while preserving other tenants.",
  '',
  'Options:',
  '  -h, --help   Show this help without changing any files.',
].join('\n');

if (require.main === module) {
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, UNINSTALL_USAGE);
  try { parseStrict(argv); }
  catch (error) {
    console.error(`agentsmd uninstall: ${error.message}`);
    console.error(UNINSTALL_USAGE);
    process.exit(2);
  }
  try {
    const result = uninstall();
    if (result.backupWarning) console.error(`agentsmd uninstall warning: ${result.backupWarning}`);
    console.log('agentsmd uninstalled:\n' + JSON.stringify(result, null, 2));
  } catch (e) { console.error('agentsmd uninstall failed:', e.message); process.exit(1); }
}
module.exports = { uninstall, UNINSTALL_USAGE };
