'use strict';
// backup.js — pre-mutation snapshots of the 3 SHARED multi-tenant files agentsmd
// touches (hooks.json / config.toml / AGENTS.md). Atomic-write (install.js) already
// makes a merge crash-safe; this makes it REVERSIBLE — if a merge is logically wrong
// (drops a tenant, mis-parses), the prior bytes are recoverable. Timestamped +
// rotated (keep N). All state lives under .agentsmd-state/backups/ (agentsmd's own
// dir), never in a shared/foreign file.
//
// Restore overwrites only files that were PRESENT at backup time (returns their prior
// bytes); a file that was ABSENT then is LEFT ALONE, never deleted — a full-file
// delete could nuke a tenant that started using the file after the install. To remove
// agentsmd's OWN entries, `uninstall` is the marker-scoped, multi-tenant-safe tool.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const F = require('./fs-atomic');
const H = require('./codex-hooks');
const AM = require('./agents-md');

// The shared multi-tenant files, by stable key → path resolver.
const SHARED_FILES = { 'hooks.json': P.hooksJsonPath, 'config.toml': P.configTomlPath, 'AGENTS.md': P.agentsMdPath };
const DEFAULT_KEEP = 5;

function backupsDir() { return path.join(P.stateDir(), 'backups'); }

function agentsmdSharedState(hooksContent, agentsMdContent) {
  const hooksPresent = H.countAgentsmdHooks(hooksContent || '') > 0;
  const specPresent = AM.hasSpecBlock(agentsMdContent);
  if (hooksPresent && specPresent) return 'present';
  if (!hooksPresent && !specPresent) return 'absent';
  return 'partial';
}

function currentAgentsmdInstallState() {
  let raw;
  try { raw = fs.readFileSync(P.manifestPath(), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return 'absent';
    throw new Error(`cannot determine current agentsmd install state: ${error.message}`);
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { throw new Error(`cannot determine current agentsmd install state: manifest is invalid JSON (${error.message})`); }
  if (!manifest || manifest.name !== 'agentsmd') throw new Error('cannot determine current agentsmd install state: manifest identity is not agentsmd');
  return 'present';
}

// Atomic write (mirror of install.js writeFile) — a torn restore of a shared file
// would corrupt other tenants too.
const writeFileAtomic = F.writeFileAtomic;

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; }
  catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

// createBackup(stamp) — snapshot the current shared files into a new timestamped dir.
// `stamp` is caller-supplied (install passes its nowIso) so the id is deterministic +
// testable; sanitized for the filesystem. A backup-manifest.json records which files
// were present, so restore knows a file was absent (leave it) vs present (restore it).
// Returns { id, dir, purpose, files:[present names], skipped:[absent names] }.
function createBackup(stamp, purpose = 'pre-install', { write = writeFileAtomic } = {}) {
  if (purpose !== 'pre-install' && purpose !== 'pre-uninstall') throw new Error(`invalid backup purpose: ${purpose}`);
  const id = String(stamp || new Date().toISOString()).replace(/[^0-9A-Za-z._-]/g, '_');
  const dir = path.join(backupsDir(), id);
  F.ensurePrivateDir(P.stateDir());
  F.ensurePrivateDir(backupsDir());
  if (F.pathExists(dir)) {
    const existing = { id, dir };
    const manifest = readBackupManifest(existing);
    if (manifest.purpose !== purpose) throw new Error(`backup id collision: '${id}' already exists with purpose '${manifest.purpose || 'unknown'}'`);
    const files = Object.keys(SHARED_FILES).filter((name) => manifest.files[name].present);
    const skipped = Object.keys(SHARED_FILES).filter((name) => !manifest.files[name].present);
    return { id, dir, purpose, agentsmdSharedState: manifest.agentsmdSharedState, files, skipped };
  }
  try {
    F.ensurePrivateDir(dir);
    const files = [], skipped = [], meta = {}, captured = {};
    for (const [name, resolve] of Object.entries(SHARED_FILES)) {
      let content = null;
      const source = resolve();
      try { content = fs.readFileSync(source, 'utf8'); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        content = null;
      }
      captured[name] = content;
      if (content === null) { skipped.push(name); meta[name] = { present: false }; continue; }
      write(path.join(dir, name), content);
      files.push(name);
      meta[name] = { present: true, mode: fs.statSync(source).mode & 0o777 };
    }
    const sharedState = agentsmdSharedState(captured['hooks.json'], captured['AGENTS.md']);
    write(path.join(dir, 'backup-manifest.json'), JSON.stringify({
      id,
      stamp: String(stamp || ''),
      purpose,
      agentsmdSharedState: sharedState,
      files: meta,
    }, null, 2) + '\n');
    return { id, dir, purpose, agentsmdSharedState: sharedState, files, skipped };
  } catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`backup creation failed for '${id}': ${error.message}`);
  }
}

function readBackupManifest(backup, strict = true) {
  let raw;
  try { raw = fs.readFileSync(path.join(backup.dir, 'backup-manifest.json'), 'utf8'); }
  catch (error) {
    if (!strict && error && error.code === 'ENOENT') return null;
    throw new Error(`backup '${backup.id}' manifest is missing or invalid: ${error.message}`);
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) {
    if (!strict) return null;
    throw new Error(`backup '${backup.id}' manifest is missing or invalid: ${error.message}`);
  }
  if (!manifest || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    if (!strict) return null;
    throw new Error(`backup '${backup.id}' manifest has no valid file inventory`);
  }
  if (!strict) return manifest;
  for (const name of Object.keys(SHARED_FILES)) {
    const record = manifest.files[name];
    if (!record || typeof record.present !== 'boolean') {
      throw new Error(`backup '${backup.id}' manifest has no valid record for ${name}`);
    }
    const snapshot = path.join(backup.dir, name);
    let snapshotIsFile = false;
    try { snapshotIsFile = fs.statSync(snapshot).isFile(); } catch {}
    if (record.present && !snapshotIsFile) {
      throw new Error(`backup '${backup.id}' declared-present snapshot is missing: ${name}`);
    }
    if (!record.present && fs.existsSync(snapshot)) {
      throw new Error(`backup '${backup.id}' declared-absent snapshot unexpectedly exists: ${name}`);
    }
  }
  const snapshotContent = (name) => manifest.files[name].present
    ? fs.readFileSync(path.join(backup.dir, name), 'utf8')
    : null;
  const derivedState = agentsmdSharedState(snapshotContent('hooks.json'), snapshotContent('AGENTS.md'));
  if (manifest.agentsmdSharedState !== undefined
      && (manifest.agentsmdSharedState !== derivedState
        || !['present', 'absent', 'partial'].includes(manifest.agentsmdSharedState))) {
    throw new Error(`backup '${backup.id}' agentsmd shared-state metadata does not match its snapshots`);
  }
  manifest.agentsmdSharedState = derivedState;
  return manifest;
}

// listBackups() — newest first (by dir mtime; id lexical tiebreak for equal mtimes,
// which ISO stamps order correctly).
function listBackups() {
  let entries;
  try { entries = fs.readdirSync(backupsDir(), { withFileTypes: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const backup = { id: e.name, dir: path.join(backupsDir(), e.name), mtime: statMtime(path.join(backupsDir(), e.name)) };
      const manifest = readBackupManifest(backup, false);
      return { ...backup, purpose: manifest && (manifest.purpose === 'pre-install' || manifest.purpose === 'pre-uninstall') ? manifest.purpose : 'unknown' };
    })
    .sort((a, b) => (b.mtime - a.mtime) || (a.id < b.id ? 1 : -1));
}

// pruneBackups(keep) — keep the newest N, delete older. Returns removed ids.
function pruneBackups(keep = DEFAULT_KEEP) {
  const remove = listBackups().slice(Math.max(0, keep));
  for (const b of remove) { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} }
  return remove.map((b) => b.id);
}

// planRestore(id) — resolve which files a restore would touch, WITHOUT writing. `id`
// null → newest compatible pre-install/legacy snapshot. Returns the exact write plan.
function planRestore(id) {
  const all = listBackups();
  if (!all.length) throw new Error('no backups found');
  const currentState = currentAgentsmdInstallState();
  let target, manifest;
  if (id) {
    target = all.find((b) => b.id === id);
    if (!target) throw new Error(`backup not found: ${id}`);
    manifest = readBackupManifest(target);
    if (manifest.agentsmdSharedState !== currentState) {
      throw new Error(`unsafe restore: backup '${id}' has agentsmd shared state '${manifest.agentsmdSharedState}' but the current install state is '${currentState}'; restoring only shared files would create a partial install`);
    }
  } else {
    const candidates = all.filter((b) => b.purpose === 'pre-install' || b.purpose === 'unknown');
    for (const candidate of candidates) {
      const candidateManifest = readBackupManifest(candidate);
      if (candidateManifest.agentsmdSharedState === 'partial') {
        throw new Error(`backup '${candidate.id}' contains a partial agentsmd shared footprint`);
      }
      if (candidateManifest.agentsmdSharedState === currentState) {
        target = candidate;
        manifest = candidateManifest;
        break;
      }
    }
    if (!target) throw new Error(`no pre-install backup matches the current agentsmd install state '${currentState}'`);
  }
  const meta = manifest.files;
  const willRestore = [], willLeave = [];
  for (const name of Object.keys(SHARED_FILES)) {
    (meta[name].present ? willRestore : willLeave).push(name);
  }
  return { id: target.id, dir: target.dir, purpose: target.purpose, willRestore, willLeave };
}

// restoreBackup(id) — copy each present-at-backup snapshot back over the live file
// (atomic). Absent-at-backup files are left untouched. Returns { id, restored, left }.
function sameSnapshot(left, right) {
  return left.present === right.present
    && (!left.present || (left.mode === right.mode && left.content.equals(right.content)));
}

function restoreBackup(id, { write = writeFileAtomic } = {}) {
  const plan = planRestore(id);
  const meta = readBackupManifest(plan).files;
  const prepared = plan.willRestore.map((name) => {
    const file = SHARED_FILES[name]();
    const content = fs.readFileSync(path.join(plan.dir, name));
    const mode = meta[name] && Number.isInteger(meta[name].mode) ? meta[name].mode : 0o600;
    return { name, file, content, mode, before: F.snapshotFile(file) };
  });
  const committed = [];
  try {
    for (const record of prepared) {
      write(record.file, record.content, { mode: record.mode, preserveMode: false });
      record.after = { present: true, content: Buffer.from(record.content), mode: record.mode };
      committed.push(record);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...committed].reverse()) {
      try {
        const current = F.snapshotFile(record.file);
        if (sameSnapshot(current, record.after)) F.restoreFile(record.file, record.before);
        else rollbackErrors.push(`${record.name} changed concurrently; current bytes preserved`);
      } catch (rollbackError) { rollbackErrors.push(`${record.name}: ${rollbackError.message}`); }
    }
    throw new Error(`restore failed: ${error.message}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : ''}`);
  }
  return { id: plan.id, dir: plan.dir, restored: committed.map((record) => record.name), left: plan.willLeave };
}

module.exports = {
  createBackup, listBackups, pruneBackups, planRestore, restoreBackup,
  writeFileAtomic, backupsDir, readBackupManifest, agentsmdSharedState,
  currentAgentsmdInstallState, SHARED_FILES, DEFAULT_KEEP,
};
