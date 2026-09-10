'use strict';

const { sourceReceipt, installedReceipt, regularBytes, sha256 } = require('../scripts/lib/release-measurement');
const { validateDeclaration } = require('../scripts/lib/release-readiness');

function conformanceReceipt(home, file, codexVersion, model) {
  const source = sourceReceipt();
  if (source.state !== 'measured') throw new Error('formal measurement requires clean source');
  const declaration = JSON.parse(regularBytes(file, 48000));
  validateDeclaration(declaration, source);
  if (declaration.subject.source_commit !== source.source_commit) throw new Error('formal run must use declared candidate commit');
  const installed = installedReceipt(home);
  if (installed.deploy_sha256 !== source.deploy_sha256 || installed.version !== source.version
    || installed.surface !== declaration.runtime.surface || installed.profile !== declaration.runtime.profile
    || codexVersion !== declaration.runtime.codex_version || model !== declaration.runtime.model) {
    throw new Error('installed deployment or requested runtime differs from declaration');
  }
  return { declaration_sha256: sha256(JSON.stringify(declaration)), deploy_sha256: installed.deploy_sha256 };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 6) throw new Error('Usage: node qa/conformance-receipt.js HOME DECLARATION CODEX_VERSION MODEL');
    console.log(JSON.stringify(conformanceReceipt(...process.argv.slice(2))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { conformanceReceipt };
