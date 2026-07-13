'use strict';
// safe-walk.js — symlink-safe project-scan primitives shared by the directory
// walkers (analyze.js gather, design-tokens.js findCssFiles). An untrusted
// checkout must never let a scanner read a file outside the project root: a
// `leak.js -> ../../outside.js` symlink would otherwise be stat'd + read and
// leaked into AI context / generated docs. Two layers, applied together:
//   1) reject every symlink dirent (file OR dir) — `withFileTypes` dirents use
//      lstat semantics, so isSymbolicLink() catches the link before it is
//      followed; accept only real regular files and real dirs.
//   2) realpath the project root once, and realpath every candidate before
//      reading it, requiring the result to stay inside the real root — this also
//      guards mounts/junctions and any future call site.

const fs = require('fs');
const path = require('path');

// Resolve the project root through any symlinks once. Returns null if the root
// itself cannot be resolved (callers then reject every candidate).
function realRoot(root) {
  try { return fs.realpathSync(root); } catch { return null; }
}

// True only if `full` resolves (through symlinks) to a real path inside
// realRootPath. Any realpath failure (broken link, permission) → false, so the
// caller skips the file silently and continues.
function isInsideRoot(realRootPath, full) {
  if (!realRootPath) return false;
  let real; try { real = fs.realpathSync(full); } catch { return false; }
  return real === realRootPath || real.startsWith(realRootPath + path.sep);
}

module.exports = { realRoot, isInsideRoot };
