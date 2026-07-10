'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let tempSequence = 0;

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function fileMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return null; }
}

function pathExists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function readFileOptional(file, encoding = null) {
  try { return fs.readFileSync(file, encoding || undefined); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeFileAtomic(file, content, options = {}) {
  const existingMode = options.preserveMode === false ? null : fileMode(file);
  const mode = options.mode == null ? (existingMode == null ? 0o600 : existingMode) : options.mode;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agentsmd-tmp-${process.pid}-${++tempSequence}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeEntries(root) {
  const entries = [];
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'dir', mode: stat.mode & 0o777 });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, sha256: sha256File(absolute) });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(absolute) });
      } else {
        throw new Error(`unsupported artifact type: ${absolute}`);
      }
    }
  }
  visit(root, '');
  return entries;
}

function sha256Tree(root) {
  return crypto.createHash('sha256').update(JSON.stringify(treeEntries(root))).digest('hex');
}

function snapshotFile(file) {
  try {
    return { present: true, content: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false };
    throw error;
  }
}

function restoreFile(file, snapshot) {
  if (!snapshot.present) {
    try { fs.unlinkSync(file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return;
  }
  writeFileAtomic(file, snapshot.content, { mode: snapshot.mode, preserveMode: false });
}

module.exports = {
  ensurePrivateDir,
  fileMode,
  pathExists,
  readFileOptional,
  restoreFile,
  sha256File,
  sha256Tree,
  snapshotFile,
  treeEntries,
  writeFileAtomic,
};
