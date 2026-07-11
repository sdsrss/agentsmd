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
const { readRows } = require('./audit');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const PLUGIN_HOOK_SUPPORT = [
  'hooks/banned-vocab.patterns',
  'hooks/secrets.patterns',
  'hooks/lib/hook-common.sh',
  'hooks/lib/platform.sh',
  'hooks/lib/platform-timeout.js',
  'hooks/lib/rule-hits.sh',
  'hooks/lib/command-parse.js',
  'hooks/lib/orchestrator-source.js',
];

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

function inspectPluginBundle(env = process.env) {
  const configuredRoot = typeof env.AGENTSMD_PLUGIN_ROOT === 'string'
    ? env.AGENTSMD_PLUGIN_ROOT.trim()
    : '';
  const root = configuredRoot ? path.resolve(configuredRoot) : null;
  const result = {
    detected: Boolean(root),
    root,
    complete: false,
    errors: [],
    manifest: { present: false, valid: false, hooksPath: null },
    hooks: {
      present: false,
      valid: false,
      registered: 0,
      expected: REG.HOOK_REGISTRY.length,
      missingRegistrations: [...REG.HOOK_BASENAMES],
      missingScripts: [...REG.HOOK_BASENAMES],
      missingSupport: [...PLUGIN_HOOK_SUPPORT],
    },
    spec: { core: false, extended: false },
  };
  if (!root) return result;

  const pluginPath = path.join(root, '.codex-plugin', 'plugin.json');
  const pluginRaw = read(pluginPath);
  result.manifest.present = pluginRaw !== null;
  let plugin = null;
  if (pluginRaw === null) {
    result.errors.push('missing .codex-plugin/plugin.json');
  } else {
    try { plugin = JSON.parse(pluginRaw); }
    catch { result.errors.push('.codex-plugin/plugin.json is not valid JSON'); }
  }
  if (plugin) {
    result.manifest.hooksPath = typeof plugin.hooks === 'string' ? plugin.hooks : null;
    result.manifest.valid = plugin.name === 'agentsmd' && plugin.hooks === './hooks.json';
    if (plugin.name !== 'agentsmd') result.errors.push('plugin manifest identity must be agentsmd');
    if (plugin.hooks !== './hooks.json') result.errors.push('plugin manifest hooks must be ./hooks.json');
  }

  const hooksPath = path.join(root, 'hooks.json');
  const hooksRaw = read(hooksPath);
  result.hooks.present = hooksRaw !== null;
  if (hooksRaw === null) {
    result.errors.push('missing plugin hooks.json');
  } else {
    try {
      const wiring = JSON.parse(hooksRaw);
      const commands = Object.values(wiring.hooks || {}).flatMap((groups) =>
        (groups || []).flatMap((group) => (group.hooks || [])
          .filter((hook) => hook && hook.type === 'command')
          .map((hook) => hook.command))
      );
      const registered = REG.HOOK_BASENAMES.filter((basename) =>
        commands.some((command) => command === `bash "\${PLUGIN_ROOT}/hooks/${basename}"`)
      );
      result.hooks.registered = registered.length;
      result.hooks.missingRegistrations = REG.HOOK_BASENAMES.filter((name) => !registered.includes(name));
      result.hooks.valid = result.hooks.missingRegistrations.length === 0
        && commands.length === REG.HOOK_REGISTRY.length;
      if (!result.hooks.valid) {
        result.errors.push(`plugin hooks.json registers ${registered.length}/${REG.HOOK_REGISTRY.length} expected hooks`);
      }
    } catch {
      result.errors.push('plugin hooks.json is not valid JSON');
    }
  }

  result.hooks.missingScripts = REG.HOOK_BASENAMES.filter((basename) => {
    try { return !fs.statSync(path.join(root, 'hooks', basename)).isFile(); }
    catch { return true; }
  });
  if (result.hooks.missingScripts.length) {
    result.errors.push(`missing plugin hook scripts: ${result.hooks.missingScripts.join(', ')}`);
  }
  result.hooks.missingSupport = PLUGIN_HOOK_SUPPORT.filter((relative) => {
    try { return !fs.statSync(path.join(root, relative)).isFile(); }
    catch { return true; }
  });
  if (result.hooks.missingSupport.length) {
    result.errors.push(`missing plugin hook support: ${result.hooks.missingSupport.join(', ')}`);
  }
  result.spec.core = read(path.join(root, 'spec', 'AGENTS.md')) !== null;
  result.spec.extended = read(path.join(root, 'spec', 'AGENTS-extended.md')) !== null;
  if (!result.spec.core) result.errors.push('missing spec/AGENTS.md');
  if (!result.spec.extended) result.errors.push('missing spec/AGENTS-extended.md');
  result.complete = result.manifest.valid
    && result.hooks.valid
    && result.hooks.missingScripts.length === 0
    && result.hooks.missingSupport.length === 0
    && result.spec.core
    && result.spec.extended;
  return result;
}

function inspectSessionSummaries() {
  let entries;
  try {
    entries = fs.readdirSync(P.stateDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^session-summary-[A-Za-z0-9_.-]+\.json$/.test(entry.name));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { count: 0, latest: null };
    return { count: 0, latest: null, error: error.message };
  }
  let latest = null;
  for (const entry of entries) {
    const file = path.join(P.stateDir(), entry.name);
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
  return { count: entries.length, latest };
}

function status() {
  const manifestState = readInstallManifest();
  const manifest = manifestState.manifest;
  const pluginBundle = inspectPluginBundle();
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
    dualSurface: pluginBundle.detected && standaloneManifestPresent,
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
module.exports = { status, inspectPluginBundle, inspectSessionSummaries, validateInstallManifest, readInstallManifest, parseNoArgs, usage, PLUGIN_HOOK_SUPPORT };
