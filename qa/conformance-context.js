'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { platformCanonicalPath } = require('../scripts/lib/paths');

function regularBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== platformCanonicalPath(file)) {
    throw new Error('context input must be a regular non-symlink file');
  }
  if (stat.size > 1024 * 1024) throw new Error('context input exceeds 1 MiB');
  return fs.readFileSync(file);
}

function standaloneContext(home) {
  const root = fs.realpathSync(home);
  const manifest = JSON.parse(regularBytes(path.join(root, '.agentsmd-state', 'manifest.json')));
  if (manifest.deliverySurface !== 'standalone') throw new Error('expected a standalone installation');
  const extended = path.join(root, 'AGENTS-extended.md');
  const owned = manifest.ownedArtifacts && manifest.ownedArtifacts.extended;
  if (!owned || typeof owned.path !== 'string' || platformCanonicalPath(owned.path) !== extended) {
    throw new Error('extended spec path differs from the selected standalone home');
  }
  const bytes = regularBytes(extended);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== owned.sha256) {
    throw new Error('extended spec hash differs from the installation manifest');
  }
  const version = bytes.toString('utf8').match(/^# CODEX-CODING-SPEC v(\d+\.\d+\.\d+) — Extended\r?$/m);
  if (!version || version[1] !== manifest.version) throw new Error('extended spec version differs from the installation manifest');
  return `Test environment: the selected standalone extended spec is ${JSON.stringify(extended)}. Read it only when the core spec requires extended instructions, using this exact path. Do not substitute ~/.codex/AGENTS-extended.md or another installation. This resolves the test environment only; follow every case constraint unchanged.`;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node qa/conformance-context.js <CODEX_HOME>');
    process.stdout.write(`${standaloneContext(process.argv[2])}\n`);
  } catch (error) {
    console.error(`conformance-context: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { standaloneContext };
