'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const B = require('./lib/backup');
const F = require('./lib/fs-atomic');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const S = require('./lib/uninstalled-shims');
const A = require('./lib/release-artifact');
const { inspectPluginBundle, validateInstallManifest } = require('./status');
const LOCK = require('./lib/lifecycle-lock');
const J = require('./lib/lifecycle-journal');
const { parseStrict, printHelpAndExit } = require('./lib/argv');

const SHA256_RE = /^[a-f0-9]{64}$/;

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readManifestState() {
  let raw;
  try { raw = fs.readFileSync(P.manifestPath(), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      return { present: false, valid: false, manifest: null, error: null, descriptor: { present: false } };
    }
    return {
      present: true,
      valid: false,
      manifest: null,
      error: `manifest could not be read: ${error.message}`,
      descriptor: F.describePath(P.manifestPath()),
    };
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch {
    return {
      present: true,
      valid: false,
      manifest: null,
      error: 'manifest is not valid JSON',
      descriptor: F.describePath(P.manifestPath()),
    };
  }
  let error = validateInstallManifest(manifest);
  const descriptor = F.describePath(P.manifestPath());
  if (error === null && descriptor.type !== 'file') error = `manifest path has unsafe live type: ${descriptor.type}`;
  return {
    present: true,
    valid: error === null,
    manifest: error === null ? manifest : null,
    error,
    descriptor,
  };
}

function exactOwnershipError(manifest) {
  if (path.resolve(manifest.installDir || '') !== path.resolve(P.installDir())) {
    return 'manifest installDir does not match the active deploy path';
  }
  if (path.resolve(manifest.ownedArtifacts.deploy.path) !== path.resolve(P.installDir())) {
    return 'manifest deploy path does not match the active deploy path';
  }
  if (path.resolve(manifest.ownedArtifacts.extended.path) !== path.resolve(P.agentsExtendedMdPath())) {
    return 'manifest extended path does not match the active extended-spec path';
  }
  const names = new Set();
  for (const record of manifest.ownedArtifacts.skills) {
    if (path.basename(record.name) !== record.name || !record.name.startsWith('agentsmd-')) {
      return `manifest skill name is unsafe: ${record.name}`;
    }
    if (names.has(record.name)) return `manifest skill name is duplicated: ${record.name}`;
    names.add(record.name);
    if (path.resolve(record.path) !== path.resolve(path.join(P.codexSkillsDir(), record.name))) {
      return `manifest skill path does not match the active path: ${record.name}`;
    }
  }
  return null;
}

function inventoryDeploy(manifest, live, missing, mismatched, unexpected, blockers) {
  if (!Array.isArray(manifest.deployedFiles) || manifest.deployedFiles.length === 0) {
    blockers.push('manifest has no deployed file inventory');
    return;
  }
  const expected = new Map();
  for (const record of manifest.deployedFiles) {
    const relative = record && record.path;
    const absolute = path.resolve(P.installDir(), relative || '');
    const validType = record && (record.type === 'file' || record.type === 'symlink');
    const validHash = record && (record.type !== 'file' || SHA256_RE.test(record.sha256 || ''));
    const validTarget = record && (record.type !== 'symlink' || typeof record.target === 'string');
    if (!relative || expected.has(relative) || !validType || !validHash || !validTarget
        || absolute === path.resolve(P.installDir())
        || !absolute.startsWith(path.resolve(P.installDir()) + path.sep)) {
      blockers.push(`invalid deploy inventory record: ${relative || '(empty)'}`);
      continue;
    }
    expected.set(relative, record);
  }
  let actual = [];
  if (!live.present) actual = [];
  else if (live.type !== 'tree') {
    blockers.push(`deploy path has unsafe live type: ${live.type}`);
    return;
  } else {
    try { actual = F.treeEntries(P.installDir()).filter((entry) => entry.type !== 'dir'); }
    catch (error) { blockers.push(`cannot inventory deploy: ${error.message}`); return; }
  }
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  for (const [relative, record] of expected) {
    const entry = actualMap.get(relative);
    if (!entry) missing.push(`deploy:${relative}`);
    else if (entry.type !== record.type
      || (record.type === 'file' && entry.sha256 !== record.sha256)
      || (record.type === 'symlink' && entry.target !== record.target)) {
      mismatched.push(`deploy:${relative}`);
    }
  }
  for (const relative of actualMap.keys()) if (!expected.has(relative)) unexpected.push(`deploy:${relative}`);
  if (live.present && live.type === 'tree'
      && live.sha256 !== manifest.ownedArtifacts.deploy.sha256
      && missing.length === 0 && mismatched.length === 0 && unexpected.length === 0) {
    mismatched.push('deploy:tree-hash');
  }
}

function availableBackups() {
  try {
    return {
      entries: B.listBackups().map((backup) => ({
        id: backup.id,
        purpose: backup.purpose,
        scope: 'shared-files-only',
      })),
      error: null,
    };
  } catch (error) {
    return { entries: [], error: error.message };
  }
}

function planRepair() {
  const source = A.inspectReleaseArtifact(P.repoRoot());
  const plugin = inspectPluginBundle();
  const manifestState = readManifestState();
  const backups = availableBackups();
  const missing = [];
  const mismatched = [];
  const unexpected = [];
  const blockers = [];

  const liveInventory = {
    deploy: F.describePath(P.installDir()),
    extended: F.describePath(P.agentsExtendedMdPath()),
    skills: [],
  };
  const sharedFiles = [
    { name: 'hooks.json', path: P.hooksJsonPath(), live: F.describePath(P.hooksJsonPath()) },
    { name: 'config.toml', path: P.configTomlPath(), live: F.describePath(P.configTomlPath()) },
    { name: 'AGENTS.md', path: P.agentsMdPath(), live: F.describePath(P.agentsMdPath()) },
  ];
  for (const shared of sharedFiles) {
    if (shared.live.present && shared.live.type !== 'file') blockers.push(`shared path has unsafe live type: ${shared.name}:${shared.live.type}`);
  }
  const stateDescriptor = F.describePath(P.stateDir());
  const recoveryRootPath = path.join(P.stateDir(), 'repair-snapshots');
  const recoveryRoot = F.describePath(recoveryRootPath);
  if (stateDescriptor.present && stateDescriptor.type !== 'tree') blockers.push(`state path has unsafe live type: ${stateDescriptor.type}`);
  if (recoveryRoot.present && recoveryRoot.type !== 'tree') blockers.push(`repair snapshot path has unsafe live type: ${recoveryRoot.type}`);
  let ownedArtifacts = [];
  let classification;
  let applyAllowed = false;
  let recommendation;

  if (!manifestState.present) {
    const hooksRaw = F.readFileOptional(P.hooksJsonPath(), 'utf8') || '';
    const hooksLive = H.countAgentsmdHooks(hooksRaw) > 0;
    const specLive = AM.hasSpecBlock(F.readFileOptional(P.agentsMdPath(), 'utf8'));
    const exactShim = S.isExactUninstalledShimTree(P.installDir());
    const deployPresent = F.pathExists(P.installDir());
    const footprintUnprovable = blockers.length > 0 || hooksLive || specLive || F.pathExists(P.agentsExtendedMdPath()) || (deployPresent && !exactShim);
    classification = footprintUnprovable ? 'ownership-unprovable' : 'not-installed';
    if (classification === 'ownership-unprovable') {
      blockers.push('manifest is missing while an agentsmd runtime/shared footprint remains');
      recommendation = {
        code: 'inspect-manually',
        command: 'agentsmd repair --plan',
        reason: 'automatic repair cannot prove ownership without a valid manifest',
      };
    } else {
      recommendation = { code: 'install', command: 'agentsmd install', reason: 'no active standalone install was found' };
    }
  } else if (!manifestState.valid) {
    classification = 'ownership-unprovable';
    blockers.push(manifestState.error || 'manifest is invalid');
    recommendation = {
      code: 'inspect-manually',
      command: 'agentsmd repair --plan',
      reason: 'automatic repair cannot prove ownership from this manifest',
    };
  } else {
    const manifest = manifestState.manifest;
    const ownershipError = exactOwnershipError(manifest);
    if (ownershipError) blockers.push(ownershipError);
    ownedArtifacts = [
      { name: 'deploy', path: P.installDir(), expectedSha256: manifest.ownedArtifacts.deploy.sha256, live: liveInventory.deploy },
      { name: 'extended', path: P.agentsExtendedMdPath(), expectedSha256: manifest.ownedArtifacts.extended.sha256, live: liveInventory.extended },
    ];
    inventoryDeploy(manifest, liveInventory.deploy, missing, mismatched, unexpected, blockers);

    if (!liveInventory.extended.present) missing.push('extended:AGENTS-extended.md');
    else if (liveInventory.extended.type !== 'file') blockers.push(`extended path has unsafe live type: ${liveInventory.extended.type}`);
    else if (liveInventory.extended.sha256 !== manifest.ownedArtifacts.extended.sha256) mismatched.push('extended:AGENTS-extended.md');

    const manifestSkills = new Map(manifest.ownedArtifacts.skills.map((record) => [record.name, record]));
    for (const record of manifest.ownedArtifacts.skills) {
      const live = F.describePath(record.path);
      liveInventory.skills.push({ name: record.name, path: record.path, live });
      ownedArtifacts.push({ name: `skill:${record.name}`, path: record.path, expectedSha256: record.sha256, live });
      if (!live.present) missing.push(`skill:${record.name}`);
      else if (live.type !== 'tree') blockers.push(`skill path has unsafe live type: ${record.name}:${live.type}`);
      else if (live.sha256 !== record.sha256) mismatched.push(`skill:${record.name}`);
    }
    for (const sourceSkill of source.skills) {
      if (manifestSkills.has(sourceSkill.name)) continue;
      const target = path.join(P.codexSkillsDir(), sourceSkill.name);
      if (F.pathExists(target)) unexpected.push(`skill:${sourceSkill.name}`);
    }

    if (!source.complete) blockers.push(...source.errors.map((error) => `source artifact: ${error}`));
    if (blockers.length) classification = 'ownership-unprovable';
    else if (mismatched.length || unexpected.length) classification = 'owned-content-modified';
    else if (missing.length) {
      const matchingArtifact = manifest.version === source.version
        && manifest.ownedArtifacts.deploy.sha256 === source.deploySha256;
      if (matchingArtifact) {
        classification = 'owned-files-missing';
        applyAllowed = true;
      } else classification = 'matching-artifact-required';
    } else if (manifest.version !== source.version || manifest.ownedArtifacts.deploy.sha256 !== source.deploySha256) {
      classification = 'update-ready';
    } else classification = 'healthy';

    if (applyAllowed) recommendation = {
      code: 'confirm-repair',
      command: 'agentsmd repair --confirm=<planDigest>',
      reason: 'valid ownership exists and only manifest-recorded files or directories are missing',
    };
    else if (classification === 'healthy') recommendation = { code: 'none', command: null, reason: 'standalone owned artifacts are intact and current' };
    else if (classification === 'update-ready') recommendation = { code: 'update', command: 'agentsmd update', reason: 'owned artifacts are intact and can use the ordinary update path' };
    else if (classification === 'matching-artifact-required') recommendation = {
      code: 'use-matching-artifact',
      command: `run agentsmd repair --plan from @sdsrs/agentsmd@${manifest.version}`,
      reason: 'repair replaces the complete release tree, so its source version and deploy digest must match the ownership manifest',
    };
    else recommendation = {
      code: 'inspect-manually',
      command: 'agentsmd repair --plan',
      reason: 'automatic repair will not overwrite modified, unexpected, unsafe, or unprovable content',
    };
  }

  missing.sort();
  mismatched.sort();
  unexpected.sort();
  liveInventory.skills.sort((a, b) => a.name.localeCompare(b.name));
  ownedArtifacts.sort((a, b) => a.name.localeCompare(b.name));
  const preconditions = {
    manifest: manifestState.descriptor,
    source: { version: source.version, deploySha256: source.deploySha256 },
    ownedArtifacts,
    sharedFiles,
    recoveryRoot: { path: recoveryRootPath, live: recoveryRoot },
  };
  const planDigest = hashJson({ classification, applyAllowed, preconditions, missing, mismatched, unexpected, blockers });
  return {
    schemaVersion: 1,
    classification,
    applyAllowed,
    planDigest,
    manifest: {
      path: P.manifestPath(),
      present: manifestState.present,
      valid: manifestState.valid,
      version: manifestState.manifest ? manifestState.manifest.version : null,
      sha256: manifestState.descriptor.sha256 || null,
      error: manifestState.error,
    },
    liveInventory,
    missing,
    mismatched,
    unexpected,
    artifactCandidates: [
      source,
      {
        kind: 'plugin',
        root: plugin.root,
        available: plugin.detected,
        complete: plugin.complete,
        errors: plugin.errors,
      },
    ],
    backups: backups.entries,
    backupInventoryError: backups.error,
    blockers,
    recommendedAction: recommendation,
    preconditions,
  };
}

function copyFileWithMode(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

function copyTreeWithModes(source, target) {
  const entries = F.treeEntries(source);
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  for (const entry of entries) {
    if (entry.type === 'symlink') continue;
    fs.chmodSync(path.join(target, entry.path), entry.mode);
  }
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

function copyArtifact(source, target, descriptor) {
  if (!descriptor.present) return;
  if (descriptor.type === 'file') copyFileWithMode(source, target);
  else if (descriptor.type === 'tree') copyTreeWithModes(source, target);
  else throw new Error(`unsafe artifact type for recovery snapshot: ${descriptor.type}`);
  const copied = F.describePath(target);
  if (!F.sameDescriptor(copied, descriptor)) {
    throw new Error(`recovery snapshot verification failed for ${source}: expected ${JSON.stringify(descriptor)}, got ${JSON.stringify(copied)}`);
  }
}

function createRecoverySnapshot(plan, stamp) {
  const id = `${String(stamp).replace(/[^0-9A-Za-z._-]/g, '_')}-${plan.planDigest.slice(0, 16)}`;
  const state = P.stateDir();
  const snapshots = path.join(state, 'repair-snapshots');
  const root = path.join(snapshots, id);
  let createdSnapshotsDir = false;
  if (F.pathExists(root)) throw new Error(`repair recovery snapshot already exists: ${root}`);
  try {
    const stateStat = fs.lstatSync(state);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error(`unsafe state directory: ${state}`);
    if (F.pathExists(snapshots)) {
      const snapshotsStat = fs.lstatSync(snapshots);
      if (!snapshotsStat.isDirectory() || snapshotsStat.isSymbolicLink()) throw new Error(`unsafe repair snapshot directory: ${snapshots}`);
    } else {
      fs.mkdirSync(snapshots, { mode: 0o700 });
      createdSnapshotsDir = true;
    }
    fs.mkdirSync(root, { mode: 0o700 });
    const manifestTarget = path.join(root, 'manifest.json');
    copyArtifact(P.manifestPath(), manifestTarget, plan.preconditions.manifest);
    const sharedMetadata = [];
    for (const shared of plan.preconditions.sharedFiles) {
      const target = path.join(root, 'shared', shared.name);
      copyArtifact(shared.path, target, shared.live);
      sharedMetadata.push({
        name: shared.name,
        sourcePath: shared.path,
        snapshotPath: shared.live.present ? target : null,
        descriptor: shared.live,
      });
    }
    const metadata = [];
    for (const artifact of plan.preconditions.ownedArtifacts) {
      const safeName = artifact.name.replace(/[^0-9A-Za-z._-]/g, '_');
      const target = path.join(root, 'artifacts', safeName);
      copyArtifact(artifact.path, target, artifact.live);
      metadata.push({ name: artifact.name, sourcePath: artifact.path, snapshotPath: artifact.live.present ? target : null, descriptor: artifact.live });
    }
    F.writeFileAtomic(path.join(root, 'repair-snapshot.json'), JSON.stringify({
      schemaVersion: 1,
      purpose: 'pre-repair',
      capturedAt: stamp,
      planDigest: plan.planDigest,
      manifest: {
        sourcePath: P.manifestPath(),
        snapshotPath: manifestTarget,
        descriptor: plan.preconditions.manifest,
      },
      artifacts: metadata,
      sharedFiles: sharedMetadata,
    }, null, 2) + '\n');
    return root;
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    if (createdSnapshotsDir) { try { fs.rmdirSync(snapshots); } catch {} }
    throw new Error(`repair recovery snapshot failed: ${error.message}`);
  }
}

function applyRepair(planDigest, options = {}) {
  if (!SHA256_RE.test(String(planDigest || ''))) throw new Error('repair confirmation requires a valid plan digest');
  // R2-01: hold the lifecycle lock across plan re-verification, the recovery
  // snapshot, and the repair install. The inner install() re-acquires reentrantly
  // (same-process module singleton), so this is one continuous critical section.
  const lock = LOCK.acquire('repair');
  try {
    return applyRepairLocked(planDigest, options);
  } finally {
    LOCK.release(lock);
  }
}

function applyRepairLocked(planDigest, options) {
  // R2-03: recover a crashed predecessor BEFORE re-verifying the plan — a plan
  // computed against a crashed tree either matches the recovered state or
  // honestly fails the digest check below and asks for a re-plan.
  J.processPending();
  const plan = planRepair();
  if (plan.planDigest !== planDigest) throw new Error('repair plan changed; run agentsmd repair --plan again');
  if (!plan.applyAllowed) throw new Error(`repair apply is not allowed for classification '${plan.classification}'`);
  const stamp = options.nowIso || new Date().toISOString();
  const recoverySnapshot = createRecoverySnapshot(plan, stamp);
  try {
    const installFn = options.install || require('./install').install;
    const manifest = installFn(stamp, {
      repair: plan.preconditions,
      recoverySnapshot,
    });
    return {
      repaired: true,
      planDigest,
      classificationBefore: plan.classification,
      recoverySnapshot,
      installedVersion: manifest.version,
    };
  } catch (error) {
    error.message = `${error.message}; recovery snapshot retained at ${recoverySnapshot}`;
    throw error;
  }
}

const REPAIR_USAGE = [
  'Usage: agentsmd repair --plan',
  '       agentsmd repair --confirm=<planDigest>',
  '',
  'Inspect or repair a damaged manifest-owned standalone install.',
  '',
  'Options:',
  '  --plan                   Print a read-only JSON plan.',
  '  --confirm=<planDigest>   Apply the exact previously reviewed plan.',
  '  -h, --help               Show this help without changing any files.',
].join('\n');

if (require.main === module) {
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, REPAIR_USAGE);
  let parsed;
  try {
    parsed = parseStrict(argv, { bools: ['plan'], values: ['confirm'] });
    const planning = parsed.bools.has('plan');
    const confirming = Object.prototype.hasOwnProperty.call(parsed.values, 'confirm');
    if (planning === confirming) throw new Error('choose exactly one of --plan or --confirm=<planDigest>');
    if (confirming && !parsed.values.confirm) throw new Error('--confirm requires a non-empty plan digest');
    if (confirming && !SHA256_RE.test(parsed.values.confirm)) throw new Error('invalid --confirm plan digest');
  } catch (error) {
    console.error(`agentsmd repair: ${error.message}`);
    console.error(REPAIR_USAGE);
    process.exit(2);
  }
  try {
    const result = parsed.bools.has('plan') ? planRepair() : applyRepair(parsed.values.confirm);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`agentsmd repair failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { applyRepair, createRecoverySnapshot, planRepair, REPAIR_USAGE };
