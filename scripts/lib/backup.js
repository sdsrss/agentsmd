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

// The shared multi-tenant files, by stable key → path resolver.
const SHARED_FILES = { 'hooks.json': P.hooksJsonPath, 'config.toml': P.configTomlPath, 'AGENTS.md': P.agentsMdPath };
const DEFAULT_KEEP = 5;

function backupsDir() { return path.join(P.stateDir(), 'backups'); }

// Atomic write (mirror of install.js writeFile) — a torn restore of a shared file
// would corrupt other tenants too.
function writeFileAtomic(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.agentsmd-tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, c); fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function statMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

// createBackup(stamp) — snapshot the current shared files into a new timestamped dir.
// `stamp` is caller-supplied (install passes its nowIso) so the id is deterministic +
// testable; sanitized for the filesystem. A backup-manifest.json records which files
// were present, so restore knows a file was absent (leave it) vs present (restore it).
// Returns { id, dir, files:[present names], skipped:[absent names] }.
function createBackup(stamp) {
  const id = String(stamp || new Date().toISOString()).replace(/[^0-9A-Za-z._-]/g, '_');
  const dir = path.join(backupsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const files = [], skipped = [], meta = {};
  for (const [name, resolve] of Object.entries(SHARED_FILES)) {
    let content = null;
    try { content = fs.readFileSync(resolve(), 'utf8'); } catch { content = null; }
    if (content === null) { skipped.push(name); meta[name] = { present: false }; continue; }
    writeFileAtomic(path.join(dir, name), content);
    files.push(name);
    meta[name] = { present: true };
  }
  writeFileAtomic(path.join(dir, 'backup-manifest.json'), JSON.stringify({ id, stamp: String(stamp || ''), files: meta }, null, 2) + '\n');
  return { id, dir, files, skipped };
}

// listBackups() — newest first (by dir mtime; id lexical tiebreak for equal mtimes,
// which ISO stamps order correctly).
function listBackups() {
  let entries;
  try { entries = fs.readdirSync(backupsDir(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, dir: path.join(backupsDir(), e.name), mtime: statMtime(path.join(backupsDir(), e.name)) }))
    .sort((a, b) => (b.mtime - a.mtime) || (a.id < b.id ? 1 : -1));
}

// pruneBackups(keep) — keep the newest N, delete older. Returns removed ids.
function pruneBackups(keep = DEFAULT_KEEP) {
  const remove = listBackups().slice(Math.max(0, keep));
  for (const b of remove) { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} }
  return remove.map((b) => b.id);
}

// planRestore(id) — resolve which files a restore would touch, WITHOUT writing. `id`
// null → newest. Returns { id, dir, willRestore:[names], willLeave:[absent-at-backup] }.
function planRestore(id) {
  const all = listBackups();
  if (!all.length) throw new Error('no backups found');
  const target = id ? all.find((b) => b.id === id) : all[0];
  if (!target) throw new Error(`backup not found: ${id}`);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(target.dir, 'backup-manifest.json'), 'utf8')).files || {}; } catch {}
  const willRestore = [], willLeave = [];
  for (const name of Object.keys(SHARED_FILES)) {
    const snap = path.join(target.dir, name);
    const wasPresent = meta[name] ? meta[name].present : fs.existsSync(snap);
    (wasPresent && fs.existsSync(snap) ? willRestore : willLeave).push(name);
  }
  return { id: target.id, dir: target.dir, willRestore, willLeave };
}

// restoreBackup(id) — copy each present-at-backup snapshot back over the live file
// (atomic). Absent-at-backup files are left untouched. Returns { id, restored, left }.
function restoreBackup(id) {
  const plan = planRestore(id);
  const restored = [];
  for (const name of plan.willRestore) {
    const content = fs.readFileSync(path.join(plan.dir, name), 'utf8');
    writeFileAtomic(SHARED_FILES[name](), content);
    restored.push(name);
  }
  return { id: plan.id, dir: plan.dir, restored, left: plan.willLeave };
}

module.exports = {
  createBackup, listBackups, pruneBackups, planRestore, restoreBackup,
  backupsDir, SHARED_FILES, DEFAULT_KEEP,
};
