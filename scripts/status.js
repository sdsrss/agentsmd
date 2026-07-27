'use strict';
// status.js — report agentsmd's install state, and explicitly how many OTHER
// tenants' hook entries are present + preserved (the independence guarantee is
// observable, not just asserted).

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const CT = require('./lib/config-toml');
const REG = require('./lib/hook-registry');
const SA = require('./lib/surface-arbitration');
const { readRows } = require('./audit');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function inspectSessionSummaries() {
  const pluginData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || null;
  const stores = [
    pluginData && path.join(pluginData, 'runtime'),
    path.join(P.stateDir(), 'runtime'),
    P.stateDir(),
  ].filter(Boolean);
  const entries = new Map();
  let readError = null;
  for (const store of stores) {
    let found;
    try {
      found = fs.readdirSync(store, { withFileTypes: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') readError ||= error.message;
      continue;
    }
    for (const entry of found) {
      if (!entry.isFile() || !/^session-summary-[A-Za-z0-9_.-]+\.json$/.test(entry.name)) continue;
      if (!entries.has(entry.name)) entries.set(entry.name, path.join(store, entry.name));
    }
  }
  let latest = null;
  for (const file of entries.values()) {
    try {
      const stat = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = {
          mtimeMs: stat.mtimeMs,
          sid: typeof parsed.sid === 'string' ? parsed.sid : null,
          denies: Number.isInteger(parsed.denies) ? parsed.denies : 0,
          bypasses: Number.isInteger(parsed.bypasses) ? parsed.bypasses : 0,
          topSection: typeof parsed.top_section === 'string' ? parsed.top_section : null,
          topCount: Number.isInteger(parsed.top_count) ? parsed.top_count : 0,
        };
      }
    } catch { /* malformed summary is omitted from latest, but remains counted */ }
  }
  if (latest) delete latest.mtimeMs;
  const result = { count: entries.size, latest };
  if (readError) result.error = readError;
  return result;
}

function status() {
  const manifestState = SA.readInstallManifest();
  const manifest = manifestState.manifest;
  const arbitration = SA.inspectAndArbitrate();
  const pluginBundle = arbitration.candidates.plugin;
  const pluginActivation = SA.readActivationReceipt(pluginBundle);
  const standaloneManifestPresent = fs.existsSync(P.manifestPath());
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
    manifestSchemaVersion: manifest
      ? (manifest.manifestSchemaVersion || 1)
      : null,
    surfaceProtocolVersion: manifest && Number.isInteger(manifest.surfaceProtocolVersion)
      ? manifest.surfaceProtocolVersion
      : null,
    configuredProfile: manifest
      ? (manifest.profile ? manifest.profile.materialized : 'full')
      : null,
    profileSelectionMode: manifest
      ? (manifest.profile ? manifest.profile.selectionMode : 'legacy-full')
      : null,
    // R1-03: false only after an explicit --degraded install with prerequisites
    // missing; pre-R1-03 manifests carry no field and report true (jq presence
    // is separately doctor-checked). Heals on the next healthy `agentsmd update`.
    enforcement: manifest ? manifest.enforcement !== false : null,
    missingPrerequisites: (manifest && manifest.missingPrerequisites) || [],
    agentsmdHooksRegistered: hooksContent ? H.countAgentsmdHooks(hooksContent) : 0,
    otherTenantHooksPreserved: other,
    totalHookEntries: total,
    codexHooksFlag: CT.isCodexHooksEnabled(cfg),
    tuiStatusLineConfigured: CT.getTuiStatusLine(cfg).exists,
    agentsmdStatusLinePreset: CT.isAgentsmdStatusLineEnabled(cfg),
    specBlockInAgentsMd: AM.hasSpecBlock(read(P.agentsMdPath())),
    extendedMdInstalled: fs.existsSync(P.agentsExtendedMdPath()),
    telemetryRows: readRows(P.logPath()).length,
    sessionSummaries: inspectSessionSummaries(),
    pluginBundle,
    pluginActivation,
    dualSurface: pluginBundle.detected && standaloneManifestPresent,
    selectedSurface: arbitration.selection.selected,
    surfaceArbitration: arbitration,
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
  const result = status();
  console.log(JSON.stringify(result, null, 2));
  if (result.enforcement === false) {
    console.error(`WARNING: enforcement:false — degraded install (missing: ${result.missingPrerequisites.join(', ') || 'unknown'}). Hooks FAIL OPEN. Install the prerequisites and run \`agentsmd update\`.`);
  }
  // Explain a null selectedSurface on stderr (stdout stays pure JSON). Without
  // this, `node scripts/status.js` with no plugin-root env silently reports
  // selectedSurface:null / no-healthy-surface and looks like a real fault.
  if (result.selectedSurface === null) {
    const pb = result.pluginBundle;
    if (!pb.detected && !pb.contextSource) {
      console.error('note: no plugin bundle detected — set AGENTSMD_PLUGIN_ROOT (or CLAUDE_PLUGIN_ROOT) to the plugin checkout to evaluate the plugin surface; only a standalone install can be checked without it.');
    }
    const standaloneConfig = result.surfaceArbitration.candidates.standalone.config;
    if (standaloneConfig && standaloneConfig.errorCode === 'codex-cli-unavailable') {
      console.error('note: standalone surface health is unverifiable — the codex CLI was not found (install codex or set AGENTSMD_CODEX_BIN); this is distinct from an invalid config.');
    }
  }
}
module.exports = {
  status,
  inspectPluginBundle: SA.inspectPluginBundle,
  inspectSessionSummaries,
  validateInstallManifest: SA.validateInstallManifest,
  readInstallManifest: SA.readInstallManifest,
  parseNoArgs,
  usage,
  PLUGIN_HOOK_SUPPORT: SA.PLUGIN_HOOK_SUPPORT,
};
