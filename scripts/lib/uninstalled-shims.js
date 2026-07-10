'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const R = require('./hook-registry');

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

function writeUninstalledHookShims() {
  const hooksDir = P.installHooksDir();
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of hookShimNames()) {
    const file = path.join(hooksDir, name);
    fs.writeFileSync(file, SHIM_BODY);
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(P.installDir(), MARKER), `${new Date().toISOString()}\n`);
  return hookShimNames().length;
}

module.exports = { isExactUninstalledShimTree, writeUninstalledHookShims, SHIM_BODY, MARKER };
