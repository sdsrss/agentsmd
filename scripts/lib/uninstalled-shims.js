'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const R = require('./hook-registry');
const F = require('./fs-atomic');

const MARKER = '.uninstalled-shims';
const SHIM_BODY = [
  '#!/usr/bin/env bash',
  '# agentsmd uninstalled compatibility shim.',
  '# A Codex session may cache hook commands until restart; exit 0 so stale',
  '# commands do not fail with bash exit 127 after agentsmd uninstall.',
  'exit 0',
  '',
].join('\n');

function hookShimNames() { return [...R.HOOK_BASENAMES].sort(); }

function isExactUninstalledShimTree(root = P.installDir()) {
  try {
    if (!fs.lstatSync(root).isDirectory()) return false;
    const rootEntries = fs.readdirSync(root).sort();
    if (rootEntries.length !== 2 || rootEntries[0] !== MARKER || rootEntries[1] !== 'hooks') return false;
    const markerPath = path.join(root, MARKER);
    if (!fs.lstatSync(markerPath).isFile()) return false;
    const marker = fs.readFileSync(markerPath, 'utf8');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/.test(marker)) return false;

    const hooksDir = path.join(root, 'hooks');
    if (!fs.lstatSync(hooksDir).isDirectory()) return false;
    const actual = fs.readdirSync(hooksDir).sort();
    const expected = hookShimNames();
    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) return false;
    for (const name of expected) {
      const file = path.join(hooksDir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o111) === 0 || fs.readFileSync(file, 'utf8') !== SHIM_BODY) return false;
    }
    return true;
  } catch { return false; }
}

// Built in a sibling stage dir and renamed into place, so the deploy path is only
// ever ABSENT or the EXACT shim tree — never a partial one.
//
// Why it matters: this runs AFTER the deploy tree is quarantined, and it was the
// last non-atomic mutation in the uninstall commit phase. classifyStep maps an
// absent path to 'before' (recoverable forward) and an exact shim tree to
// 'after', but a partial tree — mkdir done, some of the 15 shims written, marker
// not yet — matched neither and classified as 'other', which makes planRecovery
// return 'conflict' and every later install/update/uninstall/repair/restore
// refuse until a human deletes the journal. The R2-04 matrix injects at
// u-after-quarantine, which is before this point, so the window was untested.
// `onStaged` is the crash-injection seam for that gap.
function writeUninstalledHookShims({ onStaged = null } = {}) {
  const root = P.installDir();
  const stage = `${root}.agentsmd-shimstage-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  const hooksDir = path.join(stage, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of hookShimNames()) {
    const file = path.join(hooksDir, name);
    fs.writeFileSync(file, SHIM_BODY);
    fs.chmodSync(file, 0o755); // explicit: umask must not strip the exec bit
  }
  fs.writeFileSync(path.join(stage, MARKER), `${new Date().toISOString()}\n`);
  F.fsyncDir(hooksDir);
  F.fsyncDir(stage);
  if (typeof onStaged === 'function') onStaged();
  try {
    fs.renameSync(stage, root);
  } catch (error) {
    // A target that is ALREADY the exact tree means a previous run got here —
    // idempotent, not an error. Anything else is a real ownership collision and
    // is left for the journal to adjudicate; we never delete an unknown tree.
    if (isExactUninstalledShimTree(root)) {
      fs.rmSync(stage, { recursive: true, force: true });
      return hookShimNames().length;
    }
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  F.fsyncDir(path.dirname(root));
  return hookShimNames().length;
}

module.exports = { isExactUninstalledShimTree, writeUninstalledHookShims, SHIM_BODY, MARKER };
