'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function realDirectoryEntries(destination) {
  const stat = fs.lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('destination must be a real directory');
  }
  return fs.readdirSync(destination, { withFileTypes: true });
}

function tarballNames(destination) {
  return new Set(
    realDirectoryEntries(destination)
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => entry.name)
  );
}

function cleanTarballs(destination, preserved = new Set()) {
  for (const entry of realDirectoryEntries(destination)) {
    if (entry.isFile() && entry.name.endsWith('.tgz') && !preserved.has(entry.name)) {
      fs.unlinkSync(path.join(destination, entry.name));
    }
  }
}

async function packRegistryArtifact({
  packageSpec,
  destination,
  attempts = 12,
  delayMs = 10_000,
  spawn = cp.spawnSync,
  wait = sleep,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (typeof packageSpec !== 'string' || packageSpec.length === 0) {
    throw new Error('packageSpec must be non-empty text');
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('destination must be non-empty text');
  }
  positiveInteger(attempts, 'attempts');
  positiveInteger(delayMs, 'delayMs', { allowZero: true });
  const preservedTarballs = tarballNames(destination);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    realDirectoryEntries(destination);
    const result = spawn(npm, [
      'pack',
      packageSpec,
      '--pack-destination',
      destination,
      '--json',
      '--prefer-online',
    ], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status === 0) return { attempt, status: 0 };

    lastStatus = result.status;
    cleanTarballs(destination, preservedTarballs);
    if (attempt < attempts) {
      log(`waiting for ${packageSpec} registry bytes (attempt ${attempt}/${attempts}, npm exit ${result.status})`);
      await wait(delayMs);
    }
  }
  throw new Error(`${packageSpec} registry bytes were unavailable after ${attempts} attempts (last npm exit ${lastStatus})`);
}

module.exports = {
  cleanTarballs,
  packRegistryArtifact,
  positiveInteger,
  realDirectoryEntries,
  tarballNames,
};
