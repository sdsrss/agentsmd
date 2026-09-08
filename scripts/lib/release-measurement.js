'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { platformCanonicalPath } = require('./paths');
const F = require('./fs-atomic');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function regularBytes(file, max = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max
    || fs.realpathSync(file) !== platformCanonicalPath(path.resolve(file))) {
    throw new Error('evidence input must be a bounded canonical regular file');
  }
  return fs.readFileSync(file);
}

function sourceReceipt(root = path.resolve(__dirname, '../..')) {
  try {
    const { candidateIdentity } = require('../conformance-candidate');
    return { state: 'measured', ...candidateIdentity(root),
      slo_sha256: sha256(regularBytes(path.join(root, 'qa/perf/slo.json'))) };
  } catch {
    return { state: 'unverified', reason: 'clean-source-identity-unavailable' };
  }
}

function stableSource(before, after) {
  return before.state === 'measured' && JSON.stringify(before) === JSON.stringify(after)
    ? before : { state: 'unverified', reason: 'source-not-stable-during-measurement' };
}

function installedReceipt(home) {
  const root = fs.realpathSync(home);
  const manifest = JSON.parse(regularBytes(path.join(root, '.agentsmd-state/manifest.json')));
  const deploy = path.join(root, 'agentsmd');
  const owned = manifest.ownedArtifacts?.deploy;
  if (manifest.deliverySurface !== 'standalone' || !owned || typeof owned.path !== 'string'
    || platformCanonicalPath(owned.path) !== deploy
    || fs.realpathSync(deploy) !== deploy || fs.lstatSync(deploy).isSymbolicLink()) {
    throw new Error('measurement requires the exact manifest-owned standalone deployment');
  }
  const digest = F.sha256Tree(deploy);
  if (digest !== owned.sha256) throw new Error('installed deployment hash mismatch');
  return { deploy_sha256: digest, version: manifest.version,
    surface: manifest.deliverySurface, profile: manifest.profile?.materialized };
}

module.exports = { sha256, regularBytes, sourceReceipt, stableSource, installedReceipt };
