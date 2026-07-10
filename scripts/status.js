'use strict';
// status.js — report agentsmd's install state, and explicitly how many OTHER
// tenants' hook entries are present + preserved (the independence guarantee is
// observable, not just asserted).

const fs = require('fs');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const CT = require('./lib/config-toml');
const REG = require('./lib/hook-registry');
const { readRows } = require('./audit');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateOwnedRecord(record, label) {
  if (!isObject(record)) return `manifest ${label} must be an object`;
  if (typeof record.path !== 'string' || !record.path.trim()) return `manifest ${label}.path must be a non-empty string`;
  if (typeof record.sha256 !== 'string' || !SHA256_RE.test(record.sha256)) return `manifest ${label}.sha256 must be a SHA-256 hex digest`;
  return null;
}

function validateInstallManifest(manifest) {
  if (!isObject(manifest)) return 'manifest must be an object';
  if (manifest.name !== 'agentsmd') return 'manifest identity must be agentsmd';
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) return 'manifest version must be semantic version text';
  if (typeof manifest.installedAt !== 'string' || !Number.isFinite(Date.parse(manifest.installedAt))) return 'manifest installedAt must be a valid timestamp';
  if (!isObject(manifest.ownedArtifacts)) return 'manifest ownedArtifacts must be an object';
  for (const key of ['deploy', 'extended']) {
    const error = validateOwnedRecord(manifest.ownedArtifacts[key], `ownedArtifacts.${key}`);
    if (error) return error;
  }
  if (!Array.isArray(manifest.ownedArtifacts.skills)) return 'manifest ownedArtifacts.skills must be an array';
  for (const [index, skill] of manifest.ownedArtifacts.skills.entries()) {
    if (!isObject(skill) || typeof skill.name !== 'string' || !skill.name.trim()) {
      return `manifest ownedArtifacts.skills[${index}].name must be a non-empty string`;
    }
    const error = validateOwnedRecord(skill, `ownedArtifacts.skills[${index}]`);
    if (error) return error;
  }
  return null;
}

function readInstallManifest() {
  let raw;
  try { raw = fs.readFileSync(P.manifestPath(), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { manifest: null, valid: false, error: null };
    return { manifest: null, valid: false, error: `manifest could not be read: ${error.message}` };
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { return { manifest: null, valid: false, error: 'manifest is not valid JSON' }; }
  const error = validateInstallManifest(manifest);
  return error
    ? { manifest: null, valid: false, error }
    : { manifest, valid: true, error: null };
}

function status() {
  const manifestState = readInstallManifest();
  const manifest = manifestState.manifest;
  const hooksContent = read(P.hooksJsonPath());
  const cfg = read(P.configTomlPath()) || '';

  let total = 0, other = 0;
  if (hooksContent) {
    try {
      const p = JSON.parse(hooksContent);
      for (const groups of Object.values(p.hooks || {})) for (const g of groups || []) for (const h of (g.hooks || [])) {
        if (h && h.type === 'command') { total++; if (!H.isAgentsmdCommand(h.command)) other++; }
      }
    } catch {}
  }
  return {
    installed: manifestState.valid,
    manifestValid: manifestState.valid,
    manifestError: manifestState.error,
    installedVersion: (manifest && manifest.version) || null,
    installedAt: (manifest && manifest.installedAt) || null,
    agentsmdHooksRegistered: hooksContent ? H.countAgentsmdHooks(hooksContent) : 0,
    otherTenantHooksPreserved: other,
    totalHookEntries: total,
    codexHooksFlag: CT.isCodexHooksEnabled(cfg),
    tuiStatusLineConfigured: CT.getTuiStatusLine(cfg).exists,
    agentsmdStatusLinePreset: CT.isAgentsmdStatusLineEnabled(cfg),
    specBlockInAgentsMd: AM.hasSpecBlock(read(P.agentsMdPath())),
    extendedMdInstalled: fs.existsSync(P.agentsExtendedMdPath()),
    telemetryRows: readRows(P.logPath()).length,
    // Which hooks are currently switched off via env kill-switches (registry-
    // enumerated; global DISABLE_AGENTSMD_HOOKS or per-hook DISABLE_<SUFFIX>_HOOK).
    // Usually { global:false, disabled:[] } — a non-empty list explains "why did a
    // hook not fire" without hunting through env + hook-common.sh.
    killSwitches: REG.killSwitchState(),
  };
}

function usage(commandName, description) {
  return [
    `Usage: ${commandName}`,
    '',
    description,
    '',
    'Options:',
    '  -h, --help   Show this help.',
  ].join('\n');
}

function parseNoArgs(argv, commandName, description) {
  for (const arg of argv) {
    const text = usage(commandName, description);
    if (arg === '--help' || arg === '-h') return { help: true, usage: text };
    return { error: `unknown option: ${arg}`, usage: text };
  }
  return { usage: usage(commandName, description) };
}

if (require.main === module) {
  const parsed = parseNoArgs(
    process.argv.slice(2),
    'agentsmd status',
    'Print agentsmd install state as JSON: hooks, config, spec block, telemetry, and kill-switch state.'
  );
  if (parsed.help) {
    console.log(parsed.usage);
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd status: ${parsed.error}`);
    console.error(parsed.usage);
    process.exit(2);
  }
  console.log(JSON.stringify(status(), null, 2));
}
module.exports = { status, validateInstallManifest, readInstallManifest, parseNoArgs, usage };
