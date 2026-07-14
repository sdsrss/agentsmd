'use strict';
// install.js — transactional standalone installer for ~/.codex (honors
// $CODEX_HOME). All source trees are staged before the live deployment moves,
// so update can run from the deployed copy without deleting its own source.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const CT = require('./lib/config-toml');
const AM = require('./lib/agents-md');
const M = require('./lib/migrate');
const B = require('./lib/backup');
const F = require('./lib/fs-atomic');
const S = require('./lib/uninstalled-shims');
const R = require('./lib/release-artifact');
const PF = require('./lib/preflight');
const LOCK = require('./lib/lifecycle-lock');
const J = require('./lib/lifecycle-journal');
const crypto = require('crypto');
const { parseStrict, printHelpAndExit } = require('./lib/argv');

const readOrNull = (file) => F.readFileOptional(file, 'utf8');
const snapshotText = (snapshot) => snapshot.present ? snapshot.content.toString('utf8') : null;

function sameSnapshot(left, right) {
  return left.present === right.present
    && (!left.present || (left.mode === right.mode && left.content.equals(right.content)));
}

function transactionFile(transaction, file) {
  return transaction.files.find((record) => path.resolve(record.file) === path.resolve(file));
}

function markTransactionFile(transaction, file) {
  const record = transactionFile(transaction, file);
  if (record) record.after = F.snapshotFile(file);
}

function writeTracked(transaction, file, content, expectedSnapshot = null) {
  F.writeFileAtomic(file, content, expectedSnapshot ? { expectedSnapshot } : {});
  markTransactionFile(transaction, file);
}

function parsePriorManifest(snapshot = F.snapshotFile(P.manifestPath())) {
  const raw = snapshotText(snapshot);
  if (raw === null) return null;
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { throw new Error(`${P.manifestPath()} is not valid JSON; ownership cannot be verified`); }
  if (!manifest || manifest.name !== 'agentsmd') throw new Error(`ownership collision: ${P.manifestPath()} is not an agentsmd manifest`);
  return manifest;
}

function priorSkillRecord(manifest, name, target) {
  const records = manifest && manifest.ownedArtifacts && Array.isArray(manifest.ownedArtifacts.skills)
    ? manifest.ownedArtifacts.skills : [];
  return records.find((record) => record && record.name === name && path.resolve(record.path || '') === path.resolve(target)) || null;
}

function assertRepairArtifact(repair, target) {
  if (!repair || !Array.isArray(repair.ownedArtifacts)) return false;
  const record = repair.ownedArtifacts.find((candidate) => path.resolve(candidate.path) === path.resolve(target));
  if (!record) return false;
  const current = F.describePath(target);
  if (!F.sameDescriptor(current, record.live)) {
    const error = new Error(`repair plan changed for ${target}; refusing to overwrite newer state`);
    error.code = 'AGENTSMD_REPAIR_PLAN_CHANGED';
    throw error;
  }
  return true;
}

function assertRepairSharedFiles(repair) {
  if (!repair || !Array.isArray(repair.sharedFiles)) return;
  for (const record of repair.sharedFiles) {
    if (!F.sameDescriptor(F.describePath(record.path), record.live)) {
      throw new Error(`repair plan changed for shared file ${record.path}; refusing to mutate`);
    }
  }
}

function verifyOwnedSkill(manifest, name, target, repair = null) {
  const repairAuthorized = assertRepairArtifact(repair, target);
  if (!F.pathExists(target)) return;
  const record = priorSkillRecord(manifest, name, target);
  if (record) {
    let actual;
    try { actual = F.sha256Tree(target); } catch {}
    if (record.sha256 === actual || repairAuthorized) return;
    throw new Error(`ownership collision: installed skill ${name} differs from manifest hash`);
  }
  throw new Error(`ownership collision: ${target} exists but is not owned by this agentsmd manifest`);
}

function verifyOwnedExtended(manifest, target, repair = null) {
  const repairAuthorized = assertRepairArtifact(repair, target);
  if (!F.pathExists(target)) return;
  const record = manifest && manifest.ownedArtifacts && manifest.ownedArtifacts.extended;
  if (record && path.resolve(record.path || '') === path.resolve(target)) {
    let actual;
    try { actual = F.sha256File(target); } catch {}
    if (record.sha256 === actual || repairAuthorized) return;
    throw new Error('ownership collision: AGENTS-extended.md differs from manifest hash');
  }
  if (manifest && !manifest.ownedArtifacts && manifest.extendedMdAddedByUs === true) {
    const deployed = readOrNull(path.join(P.installSpecDir(), 'AGENTS-extended.md'));
    const current = readOrNull(target);
    if (deployed !== null && current === deployed) return;
  }
  throw new Error('ownership collision: AGENTS-extended.md exists without an exact agentsmd manifest record');
}

function verifyOwnedDeploy(manifest, target, repair = null) {
  const repairAuthorized = assertRepairArtifact(repair, target);
  if (!F.pathExists(target)) return;
  const record = manifest && manifest.ownedArtifacts && manifest.ownedArtifacts.deploy;
  if (record && path.resolve(record.path || '') === path.resolve(target)) {
    let actual;
    try { actual = F.sha256Tree(target); } catch {}
    if (actual === record.sha256 || repairAuthorized) return;
    throw new Error('ownership collision: deploy tree differs from manifest hash');
  }
  // Uninstall intentionally leaves a fixed no-op shim tree for commands cached
  // by the current Codex session. Reinstall may replace only that exact tree;
  // any added, missing, modified, non-executable, or symlinked entry remains a
  // foreign ownership collision.
  if (!manifest && S.isExactUninstalledShimTree(target)) return;
  throw new Error(`ownership collision: deploy directory ${target} exists without an exact agentsmd manifest record`);
}

function migrateLegacyAgentsmdManifest(manifest, stamp) {
  if (!manifest || manifest.ownedArtifacts) return { manifest, backup: null };
  if (path.resolve(manifest.installDir || '') !== path.resolve(P.installDir())) {
    throw new Error('ownership collision: legacy agentsmd manifest does not name the active deploy directory');
  }
  const backup = path.join(
    P.codexHome(),
    `.agentsmd-legacy-backup-${String(stamp).replace(/[^0-9A-Za-z._-]/g, '_')}-${process.pid}`
  );
  if (F.pathExists(backup)) throw new Error(`ownership collision: legacy backup path already exists: ${backup}`);
  fs.mkdirSync(backup, { mode: 0o700 });

  const ownedArtifacts = { deploy: null, extended: null, skills: [] };
  if (F.pathExists(P.installDir())) {
    fs.cpSync(P.installDir(), path.join(backup, 'deploy'), { recursive: true });
    ownedArtifacts.deploy = { path: P.installDir(), sha256: F.sha256Tree(P.installDir()) };
  }
  if (manifest.extendedMdAddedByUs === true && F.pathExists(P.agentsExtendedMdPath())) {
    fs.copyFileSync(P.agentsExtendedMdPath(), path.join(backup, 'AGENTS-extended.md'));
    ownedArtifacts.extended = { path: P.agentsExtendedMdPath(), sha256: F.sha256File(P.agentsExtendedMdPath()) };
  }
  const skillBackup = path.join(backup, 'skills');
  for (const name of Array.isArray(manifest.installedSkills) ? manifest.installedSkills : []) {
    if (typeof name !== 'string' || path.basename(name) !== name || !name.startsWith('agentsmd-')) {
      throw new Error('ownership collision: legacy agentsmd manifest contains an invalid skill name');
    }
    const target = path.join(P.codexSkillsDir(), name);
    if (!F.pathExists(target)) continue;
    fs.mkdirSync(skillBackup, { recursive: true });
    fs.cpSync(target, path.join(skillBackup, name), { recursive: true });
    ownedArtifacts.skills.push({ name, path: target, sha256: F.sha256Tree(target) });
  }
  F.writeFileAtomic(path.join(backup, 'migration-manifest.json'), JSON.stringify({
    sourceManifest: manifest,
    capturedAt: stamp,
    ownedArtifacts,
  }, null, 2) + '\n');
  return { manifest: { ...manifest, ownedArtifacts }, backup };
}

function swapDirectory(staged, target, transaction, backupPath = null) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = backupPath || `${target}.agentsmd-old-${process.pid}-${transaction.swaps.length}`;
  const existed = F.pathExists(target);
  if (existed) fs.renameSync(target, backup);
  try {
    if (staged) fs.renameSync(staged, target);
  } catch (error) {
    if (existed) fs.renameSync(backup, target);
    throw error;
  }
  transaction.swaps.push({
    target,
    backup: existed ? backup : null,
    afterHash: staged ? F.sha256Tree(target) : null,
    afterPresent: !!staged,
    keepBackup: false,
  });
}

function rollback(transaction) {
  const errors = [];
  for (const record of [...transaction.files].reverse()) {
    try {
      const current = F.snapshotFile(record.file);
      if (sameSnapshot(current, record.before)) continue;
      if (record.after && sameSnapshot(current, record.after)) F.restoreFile(record.file, record.before);
      else errors.push(`rollback conflict ${record.file}: changed concurrently; preserved current bytes`);
    } catch (error) { errors.push(`${record.file}: ${error.message}`); }
  }
  for (const swap of [...transaction.swaps].reverse()) {
    try {
      const present = F.pathExists(swap.target);
      let matches = present === swap.afterPresent;
      if (matches && present) {
        try { matches = F.sha256Tree(swap.target) === swap.afterHash; } catch { matches = false; }
      }
      if (!matches) {
        swap.keepBackup = true;
        errors.push(`rollback conflict ${swap.target}: changed concurrently; preserved current tree`);
        continue;
      }
      fs.rmSync(swap.target, { recursive: true, force: true });
      if (swap.backup) fs.renameSync(swap.backup, swap.target);
    } catch (error) { errors.push(`${swap.target}: ${error.message}`); }
  }
  for (const snapshot of [...transaction.directories].reverse()) {
    try {
      const present = F.pathExists(snapshot.target);
      let matches = present === snapshot.afterPresent;
      if (matches && present) {
        try { matches = F.sha256Tree(snapshot.target) === snapshot.afterHash; } catch { matches = false; }
      }
      if (!matches) {
        errors.push(`rollback conflict ${snapshot.target}: changed concurrently; preserved current tree`);
        continue;
      }
      fs.rmSync(snapshot.target, { recursive: true, force: true });
      if (snapshot.present) fs.cpSync(snapshot.backup, snapshot.target, { recursive: true });
    } catch (error) { errors.push(`${snapshot.target}: ${error.message}`); }
  }
  return errors;
}

function cleanupTransaction(transaction, stageRoot) {
  for (const swap of transaction.swaps) if (swap.backup && !swap.keepBackup) {
    try { fs.rmSync(swap.backup, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
}

function install(nowIso, options = {}) {
  // R1-03: prerequisites gate BEFORE any mutation — including the staging dir,
  // which lives inside $CODEX_HOME. A missing prerequisite without the explicit
  // --degraded opt-in must leave every byte of $CODEX_HOME untouched. The check
  // also runs BEFORE the lifecycle lock, so a preflight refusal creates nothing.
  const preflight = PF.checkPrerequisites();
  if (!preflight.ok && options.degraded !== true) {
    throw new Error(PF.refusalMessage(preflight.missing));
  }
  // R2-01: one writer per $CODEX_HOME. Reentrant when repair --confirm drives
  // this install in-process (LOCK is a module singleton).
  const lock = LOCK.acquire(options.repair ? 'repair' : 'install');
  try {
    return installCore(nowIso, options, preflight, lock.owner.txid);
  } finally {
    LOCK.release(lock);
  }
}

function installCore(nowIso, options, preflight, txid) {
  // R2-03: we hold the lifecycle lock, so a journal on disk here is the record
  // of a CRASHED predecessor. Recover it FIRST — roll it forward when every
  // forward source survives on disk, else roll it back — and only then run this
  // fresh operation on the coherent result. A non-recoverable state (foreign
  // concurrent change, or both directions missing sources) throws fail-closed
  // with the journal preserved; `doctor` explains the verdict.
  const recoveredJournal = J.processPending();
  const repo = P.repoRoot();
  const stamp = nowIso || new Date().toISOString();
  const stageRoot = path.join(P.codexHome(), `.agentsmd-stage-${process.pid}-${Date.now()}`);
  F.ensurePrivateDir(stageRoot);
  let transaction = null;

  try {
    assertRepairSharedFiles(options.repair);
    const existingHooks = readOrNull(P.hooksJsonPath());
    if (existingHooks !== null && existingHooks.trim() !== '' && !H.parseHooksConfig(existingHooks)) {
      throw new Error(`${P.hooksJsonPath()} exists but is not valid JSON — agentsmd will not overwrite it. Fix or remove it, then re-run install.`);
    }
    const priorManifestBaseline = F.snapshotFile(P.manifestPath());
    if (options.repair && !F.sameDescriptor(F.describePath(P.manifestPath()), options.repair.manifest)) {
      throw new Error('repair plan changed for the ownership manifest; refusing to mutate');
    }
    let priorManifest = parsePriorManifest(priorManifestBaseline);
    const legacyAgentsmd = options.repair
      ? { manifest: priorManifest, backup: null }
      : migrateLegacyAgentsmdManifest(priorManifest, stamp);
    priorManifest = legacyAgentsmd.manifest;
    const stagedDeploy = R.stageSources(repo, stageRoot);
    if (options.repair && F.sha256Tree(stagedDeploy) !== options.repair.source.deploySha256) {
      throw new Error('repair source artifact changed after planning; refusing to mutate');
    }
    assertRepairSharedFiles(options.repair);
    const stagedSkillsDir = path.join(stageRoot, 'user-skills');
    fs.mkdirSync(stagedSkillsDir, { recursive: true });
    const skillNames = fs.readdirSync(path.join(stagedDeploy, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('agentsmd-'))
      .map((entry) => entry.name)
      .sort();

    verifyOwnedDeploy(priorManifest, P.installDir(), options.repair);
    const extendedBaseline = F.snapshotFile(P.agentsExtendedMdPath());
    verifyOwnedExtended(priorManifest, P.agentsExtendedMdPath(), options.repair);
    for (const name of skillNames) {
      const target = path.join(P.codexSkillsDir(), name);
      verifyOwnedSkill(priorManifest, name, target, options.repair);
      fs.cpSync(path.join(stagedDeploy, 'skills', name), path.join(stagedSkillsDir, name), { recursive: true });
    }
    const priorNames = priorManifest && priorManifest.ownedArtifacts && Array.isArray(priorManifest.ownedArtifacts.skills)
      ? priorManifest.ownedArtifacts.skills.map((record) => record.name)
      : (priorManifest && Array.isArray(priorManifest.installedSkills) ? priorManifest.installedSkills : []);
    const staleSkillNames = [...new Set(priorNames)].filter((name) => name.startsWith('agentsmd-') && !skillNames.includes(name));
    for (const name of staleSkillNames) verifyOwnedSkill(priorManifest, name, path.join(P.codexSkillsDir(), name), options.repair);

    const backupInfo = options.repair ? null : B.createBackup(stamp, 'pre-install');
    if (!options.repair) B.pruneBackups();

    const legacy = options.repair ? { files: [], directories: [] } : M.legacyArtifacts();
    transaction = {
      files: [
        P.hooksJsonPath(), P.configTomlPath(), P.agentsMdPath(),
        P.agentsExtendedMdPath(), P.manifestPath(), ...legacy.files,
      ].map((file) => ({ file, before: F.snapshotFile(file), after: null })),
      directories: [],
      swaps: [],
    };
    const legacyBackupRoot = path.join(stageRoot, 'legacy-rollback');
    for (const [index, target] of legacy.directories.entries()) {
      const present = F.pathExists(target);
      const backup = path.join(legacyBackupRoot, String(index));
      if (present) fs.cpSync(target, backup, { recursive: true });
      transaction.directories.push({ target, backup, present, afterPresent: present, afterHash: present ? F.sha256Tree(target) : null });
    }

    // Legacy migration remains marker-scoped. It runs only after every new artifact
    // collision has been validated, so a foreign collision is a zero-mutation abort.
    const migratedFromCodexmd = options.repair ? {
      detected: false, hooksRemoved: 0, agentsBlockRemoved: false,
      skillsRemoved: 0, installDirRemoved: false, stateDirRemoved: false,
      ownershipConflicts: [],
    } : M.removeLegacyCodexmd();
    const migratedTelemetry = options.repair ? { migrated: 0 } : M.migrateLegacyTelemetry();
    for (const record of transaction.files) record.after = F.snapshotFile(record.file);
    for (const record of transaction.directories) {
      record.afterPresent = F.pathExists(record.target);
      record.afterHash = record.afterPresent ? F.sha256Tree(record.target) : null;
    }

    const hooksBaseline = F.snapshotFile(P.hooksJsonPath());
    const configBaseline = F.snapshotFile(P.configTomlPath());
    const agentsBaseline = F.snapshotFile(P.agentsMdPath());
    assertRepairSharedFiles(options.repair);
    const hooksDir = P.installHooksDir();
    const managed = H.buildManagedConfig(hooksDir, path.join(stagedDeploy, 'hooks', 'hooks.json'));
    const mergedHooks = H.mergeAgentsmdHooks(snapshotText(hooksBaseline), managed);
    const cfg = CT.ensureCodexHooksFlag(snapshotText(configBaseline));
    const statusLine = CT.ensureTuiStatusLine(cfg.content);
    const specText = fs.readFileSync(path.join(stagedDeploy, 'spec', 'AGENTS.md'), 'utf8');
    const am = AM.injectSpecBlock(snapshotText(agentsBaseline), specText);
    const extendedSrc = fs.readFileSync(path.join(stagedDeploy, 'spec', 'AGENTS-extended.md'), 'utf8');
    const packageInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(stagedDeploy, 'package.json'), 'utf8')); } catch { return {}; } })();

    const ownedSkills = skillNames.map((name) => ({
      name,
      path: path.join(P.codexSkillsDir(), name),
      sha256: F.sha256Tree(path.join(stagedSkillsDir, name)),
    }));
    const manifest = {
      name: 'agentsmd',
      version: packageInfo.version || null,
      surfaceProtocolVersion: 1,
      installedAt: stamp,
      backup: options.repair ? (priorManifest.backup || null) : (backupInfo ? backupInfo.id : null),
      installDir: P.installDir(),
      hooksDir,
      hookCount: H.countAgentsmdHooks(mergedHooks),
      installedSkills: skillNames,
      ownedArtifacts: {
        deploy: { path: P.installDir(), sha256: F.sha256Tree(stagedDeploy) },
        extended: { path: P.agentsExtendedMdPath(), sha256: F.sha256File(path.join(stagedDeploy, 'spec', 'AGENTS-extended.md')) },
        skills: ownedSkills,
      },
      deployedFiles: F.treeEntries(stagedDeploy).filter((entry) => entry.type !== 'dir'),
      configFlag: cfg.reason,
      configFlagAddedByUs: cfg.changed,
      statusLine: statusLine.reason,
      statusLineAddedByUs: statusLine.changed,
      agentsBlockUpdated: am.updated === true,
      extendedMd: fs.existsSync(P.agentsExtendedMdPath()) ? 'refreshed' : 'created',
      extendedMdAddedByUs: true,
      migratedFromCodexmd: migratedFromCodexmd.detected ? migratedFromCodexmd : null,
      migratedTelemetryRows: migratedTelemetry.migrated,
      legacyArtifactBackup: legacyAgentsmd.backup,
      // R1-03: honest enforcement state. false only on an explicit --degraded
      // install with prerequisites still missing; a later healthy update heals it.
      enforcement: preflight.ok,
      missingPrerequisites: preflight.missing.map((m) => m.name),
      ...(options.repair ? {
        operation: 'repair',
        repairedAt: stamp,
        recoverySnapshot: options.recoverySnapshot,
      } : {}),
    };

    if (recoveredJournal) manifest.recoveredJournal = recoveredJournal;
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

    // R2-02: plan the ENTIRE commit phase with deterministic before/after
    // fingerprints, persist the merged shared-file contents next to the staged
    // trees, and write the durable journal BEFORE the first live mutation. From
    // here on, any termination point is adjudicable from disk alone.
    const sha256Text = (content) => crypto.createHash('sha256').update(content).digest('hex');
    const plannedSwaps = [];
    const planSwap = (staged, target) => {
      const beforePresent = F.pathExists(target);
      plannedSwaps.push({
        kind: 'swap', target, staged,
        backupPath: `${target}.agentsmd-old-${process.pid}-${plannedSwaps.length}`,
        beforePresent, beforeSha256Tree: beforePresent ? F.sha256Tree(target) : null,
        afterPresent: !!staged, afterSha256Tree: staged ? F.sha256Tree(staged) : null,
      });
    };
    planSwap(stagedDeploy, P.installDir());
    for (const name of skillNames) planSwap(path.join(stagedSkillsDir, name), path.join(P.codexSkillsDir(), name));
    for (const name of staleSkillNames) if (F.pathExists(path.join(P.codexSkillsDir(), name))) planSwap(null, path.join(P.codexSkillsDir(), name));

    const plannedDir = path.join(stageRoot, 'planned');
    F.ensurePrivateDir(plannedDir);
    const plannedWrites = [];
    const planWrite = (target, content, baseline) => {
      const plannedFile = path.join(plannedDir, path.basename(target));
      fs.writeFileSync(plannedFile, content, { mode: 0o600 });
      plannedWrites.push({
        kind: 'write', target, plannedFile,
        beforePresent: baseline.present === true,
        beforeSha256: baseline.present ? sha256Text(baseline.content) : null,
        // Inline contents (R2-03) make both recovery directions independent of
        // stage-dir survival; these shared files are small by construction.
        beforeContentB64: baseline.present ? Buffer.from(baseline.content).toString('base64') : null,
        afterSha256: sha256Text(content),
        afterContentB64: Buffer.from(content).toString('base64'),
      });
    };
    planWrite(P.hooksJsonPath(), mergedHooks, hooksBaseline);
    if (cfg.changed || statusLine.changed) planWrite(P.configTomlPath(), statusLine.content, configBaseline);
    planWrite(P.agentsMdPath(), am.content, agentsBaseline);
    planWrite(P.agentsExtendedMdPath(), extendedSrc, extendedBaseline);
    planWrite(P.manifestPath(), manifestJson, priorManifestBaseline);

    const journal = J.begin({
      txid, action: options.repair ? 'repair' : 'install',
      backupId: manifest.backup, stageRoot, plannedDir,
      steps: [...plannedSwaps, ...plannedWrites],
    });
    J.maybeCrash('after-journal');

    // Commit directories first; all hook commands already point at the final path.
    verifyOwnedDeploy(priorManifest, P.installDir(), options.repair);
    for (const [index, plan] of plannedSwaps.entries()) {
      if (plan.target !== P.installDir()) {
        verifyOwnedSkill(priorManifest, path.basename(plan.target), plan.target, options.repair);
      }
      swapDirectory(plan.staged, plan.target, transaction, plan.backupPath);
      if (index === 0) J.maybeCrash('mid-swaps');
    }
    J.maybeCrash('after-swaps');

    writeTracked(transaction, P.hooksJsonPath(), mergedHooks, hooksBaseline);
    J.maybeCrash('mid-writes');
    if (cfg.changed || statusLine.changed) writeTracked(transaction, P.configTomlPath(), statusLine.content, configBaseline);
    writeTracked(transaction, P.agentsMdPath(), am.content, agentsBaseline);
    writeTracked(transaction, P.agentsExtendedMdPath(), extendedSrc, extendedBaseline);
    F.ensurePrivateDir(P.stateDir());
    writeTracked(transaction, P.manifestPath(), manifestJson, priorManifestBaseline);
    tightenPrivateArtifacts();
    J.maybeCrash('before-cleanup');

    J.advance(journal, 'cleanup');
    cleanupTransaction(transaction, stageRoot);
    J.complete();
    return manifest;
  } catch (error) {
    const rollbackErrors = transaction ? rollback(transaction) : [];
    cleanupTransaction(transaction || { swaps: [] }, stageRoot);
    // In-process rollback fully restored the pre-transaction state → the
    // journal has nothing left to describe. Any rollback conflict keeps it as
    // evidence for doctor/recovery.
    if (rollbackErrors.length === 0) { try { J.complete(); } catch { /* keep evidence on failure */ } }
    if (rollbackErrors.length) error.message += `; rollback errors: ${rollbackErrors.join('; ')}`;
    throw error;
  }
}

// Telemetry rows and state refs carry project path slugs; both surfaces treat
// them as private. Hooks create new files under umask 077 — this pass tightens
// artifacts that predate that rule (audit 2026-07-13, M-02: live agentsmd.jsonl
// was 0664). Best-effort: a chmod failure must never fail an install; doctor
// reports whatever stays wide. Only agentsmd-owned paths are touched — the
// shared logs/ directory mode is the platform's choice and is left alone.
function tightenPrivateArtifacts() {
  const tightenFile = (file) => { try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ } };
  const tightenTree = (dir) => {
    let entries;
    try { fs.chmodSync(dir, 0o700); entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) tightenTree(full);
      else if (entry.isFile()) tightenFile(full);
    }
  };
  tightenTree(P.stateDir());
  for (const suffix of ['', '.1', '.2']) {
    const file = `${P.logPath()}${suffix}`;
    if (fs.existsSync(file)) tightenFile(file);
  }
}

function installUsage(command = 'install') {
  return [
  `Usage: agentsmd ${command} [--json] [--degraded]`,
  '',
  'Install or update agentsmd in $CODEX_HOME.',
  '',
  'Prerequisites (jq, node >= 18) are checked BEFORE any file changes; a miss',
  'aborts with zero mutation.',
  '',
  'Options:',
  '  --json       Print the full install manifest as JSON.',
  '  --degraded   Explicitly allow installing with missing prerequisites.',
  '               Hooks FAIL OPEN (no §8 enforcement); the manifest records',
  '               enforcement:false and status/doctor warn until a healthy',
  `               \`agentsmd update\`. Env equivalent: AGENTSMD_ALLOW_DEGRADED=1.`,
  '  -h, --help   Show this help without changing any files.',
  ].join('\n');
}

const INSTALL_USAGE = installUsage();

if (require.main === module) {
  const command = process.env.AGENTSMD_CLI_COMMAND === 'update' ? 'update' : 'install';
  const usage = installUsage(command);
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let parsed;
  try { parsed = parseStrict(argv, { bools: ['json', 'degraded'] }); }
  catch (error) {
    console.error(`agentsmd ${command}: ${error.message}`);
    console.error(usage);
    process.exit(2);
  }
  try {
    const manifest = install(null, { degraded: PF.degradedOptIn(parsed.bools) });
    if (parsed.bools.has('json')) console.log(JSON.stringify(manifest, null, 2));
    else console.log(`agentsmd installed: v${manifest.version || 'unknown'}, ${manifest.hookCount} hooks, ${manifest.installedSkills.length} skills (backup ${manifest.backup})`);
    if (manifest.enforcement === false) {
      console.error(`WARNING: degraded install — missing: ${manifest.missingPrerequisites.join(', ')}. Hooks FAIL OPEN (no §8 enforcement). Install the prerequisites and run \`agentsmd update\` to restore enforcement.`);
    }
  } catch (error) { console.error(`agentsmd ${command} failed:`, error.message); process.exit(1); }
}

module.exports = { install, installUsage, INSTALL_USAGE };
