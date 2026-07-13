'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');
const F = require('./fs-atomic');
const H = require('./codex-hooks');
const AM = require('./agents-md');
const CT = require('./config-toml');
const REG = require('./hook-registry');
const { ArgvError, parseStrict } = require('./argv');

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const CONFIG_PARSE_CACHE = new Map();

const PLUGIN_HOOK_SUPPORT = [
  'hooks/banned-vocab.patterns',
  'hooks/secrets.patterns',
  'hooks/lib/hook-common.sh',
  'hooks/lib/memory-links.js',
  'hooks/lib/platform.sh',
  'hooks/lib/platform-timeout.js',
  'hooks/lib/rule-hits.sh',
  'hooks/lib/command-parse.js',
  'hooks/lib/orchestrator-source.js',
];

const STANDALONE_HOOK_SUPPORT = [
  'hooks/hooks.json',
  ...PLUGIN_HOOK_SUPPORT,
];

function parseSemver(value) {
  const match = typeof value === 'string' ? value.match(SEMVER_RE) : null;
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((identifier) => /^[0-9]+$/.test(identifier)
      && identifier.length > 1 && identifier.startsWith('0'))) return null;
  return {
    raw: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
    build: match[5] ? match[5].split('.') : [],
  };
}

function compareDecimal(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return compareDecimal(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`cannot compare invalid semantic versions: ${left} / ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    const compared = compareDecimal(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return null; }
}

function readJson(file, label, errors) {
  const raw = readText(file);
  if (raw === null) {
    errors.push(`missing ${label}`);
    return null;
  }
  try { return JSON.parse(raw); }
  catch { errors.push(`${label} is not valid JSON`); return null; }
}

function readBundleFile(root, relative, label, errors) {
  const absolute = path.join(root, relative);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) {
      errors.push(`${label} is not a regular in-bundle file`);
      return null;
    }
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(absolute);
    const inside = realFile.startsWith(`${realRoot}${path.sep}`);
    if (!inside) {
      errors.push(`${label} resolves outside the plugin root`);
      return null;
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    errors.push(`missing ${label}`);
    return null;
  }
}

function readBundleJson(root, relative, label, errors) {
  const raw = readBundleFile(root, relative, label, errors);
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { errors.push(`${label} is not valid JSON`); return null; }
}

function specVersion(content) {
  return ((content || '').match(/CODEX-CODING-SPEC v([^\s]+)/) || [])[1] || null;
}

function validateOwnedRecord(record, label) {
  if (!isObject(record)) return `manifest ${label} must be an object`;
  if (typeof record.path !== 'string' || !record.path.trim()) return `manifest ${label}.path must be a non-empty string`;
  if (typeof record.sha256 !== 'string' || !SHA256_RE.test(record.sha256)) return `manifest ${label}.sha256 must be a SHA-256 hex digest`;
  return null;
}

function validateInstallManifest(manifest) {
  if (!isObject(manifest)) return 'manifest must be an object';
  if (manifest.name !== 'agentsmd') return 'manifest identity must be agentsmd';
  if (!parseSemver(manifest.version)) return 'manifest version must be semantic version text';
  if (typeof manifest.installedAt !== 'string' || !Number.isFinite(Date.parse(manifest.installedAt))) return 'manifest installedAt must be a valid timestamp';
  if (!isObject(manifest.ownedArtifacts)) return 'manifest ownedArtifacts must be an object';
  for (const key of ['deploy', 'extended']) {
    const error = validateOwnedRecord(manifest.ownedArtifacts[key], `ownedArtifacts.${key}`);
    if (error) return error;
  }
  if (!Array.isArray(manifest.ownedArtifacts.skills)) return 'manifest ownedArtifacts.skills must be an array';
  for (const [index, skill] of manifest.ownedArtifacts.skills.entries()) {
    if (!isObject(skill) || typeof skill.name !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill.name)) {
      return `manifest ownedArtifacts.skills[${index}].name must be a safe path segment`;
    }
    const error = validateOwnedRecord(skill, `ownedArtifacts.skills[${index}]`);
    if (error) return error;
  }
  return null;
}

function readInstallManifest() {
  let raw;
  try {
    const stateStat = fs.lstatSync(P.stateDir());
    const manifestStat = fs.lstatSync(P.manifestPath());
    if (!stateStat.isDirectory()) {
      return { manifest: null, valid: false, error: 'manifest state root must be a real directory' };
    }
    if (!manifestStat.isFile()) {
      return { manifest: null, valid: false, error: 'manifest must be a regular file' };
    }
    raw = fs.readFileSync(P.manifestPath(), 'utf8');
  }
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

function pluginHookRows(hooksRoot) {
  const rows = [];
  if (!isObject(hooksRoot)) return null;
  const expectedEvents = [...new Set(REG.HOOK_REGISTRY.map((hook) => hook.hookEvent))];
  const actualEvents = Object.keys(hooksRoot);
  if (actualEvents.length !== expectedEvents.length
      || actualEvents.some((event) => !expectedEvents.includes(event))) return null;
  for (const event of expectedEvents) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) return null;
    for (const [groupIndex, group] of groups.entries()) {
      if (!isObject(group) || !Array.isArray(group.hooks)) return null;
      for (const [hookIndex, hook] of group.hooks.entries()) {
        if (!isObject(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return null;
        rows.push({
          event,
          groupIndex,
          hookIndex,
          matcher: group.matcher == null ? null : group.matcher,
          command: hook.command,
          timeout: hook.timeout == null ? null : hook.timeout,
        });
      }
    }
  }
  return rows;
}

function expectedPluginHookRows() {
  const eventOffsets = new Map();
  return REG.HOOK_REGISTRY.map((hook) => {
    const hookIndex = eventOffsets.get(hook.hookEvent) || 0;
    eventOffsets.set(hook.hookEvent, hookIndex + 1);
    return {
      event: hook.hookEvent,
      groupIndex: 0,
      hookIndex,
      matcher: hook.matcher == null ? null : hook.matcher,
      command: `bash "\${CLAUDE_PLUGIN_ROOT}/hooks/${hook.basename}"`,
      timeout: hook.timeout,
    };
  });
}

function pluginRootFromEnv(env = process.env) {
  const runtime = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.trim() : '';
  const compatibility = typeof env.AGENTSMD_PLUGIN_ROOT === 'string' ? env.AGENTSMD_PLUGIN_ROOT.trim() : '';
  if (runtime && compatibility && path.resolve(runtime) !== path.resolve(compatibility)) {
    return {
      root: path.resolve(runtime),
      source: 'conflict',
      error: 'CLAUDE_PLUGIN_ROOT and AGENTSMD_PLUGIN_ROOT resolve to different roots',
    };
  }
  if (runtime) return { root: path.resolve(runtime), source: 'CLAUDE_PLUGIN_ROOT', error: null };
  if (compatibility) return { root: path.resolve(compatibility), source: 'AGENTSMD_PLUGIN_ROOT', error: null };
  return { root: null, source: null, error: null };
}

function inspectPluginBundle(env = process.env) {
  const context = pluginRootFromEnv(env);
  const root = context.root;
  const result = {
    detected: Boolean(root),
    root,
    contextSource: context.source,
    version: null,
    protocolVersion: 0,
    healthy: false,
    complete: false,
    integrityLevel: 'structural',
    errors: context.error ? [context.error] : [],
    reasons: [],
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
    spec: { core: false, extended: false, coreVersion: null, extendedVersion: null },
  };
  if (!root) return result;

  try {
    if (!fs.statSync(root).isDirectory()) result.errors.push('plugin root is not a directory');
  } catch { result.errors.push('plugin root is not readable'); }

  const plugin = readBundleJson(root, '.codex-plugin/plugin.json', '.codex-plugin/plugin.json', result.errors);
  result.manifest.present = F.pathExists(path.join(root, '.codex-plugin', 'plugin.json'));
  if (plugin) {
    result.manifest.hooksPath = typeof plugin.hooks === 'string' ? plugin.hooks : null;
    result.version = typeof plugin.version === 'string' ? plugin.version : null;
    result.protocolVersion = Number.isInteger(plugin.surfaceProtocolVersion) ? plugin.surfaceProtocolVersion : 0;
    result.manifest.valid = plugin.name === 'agentsmd'
      && plugin.hooks === './hooks.json'
      && parseSemver(plugin.version) !== null;
    if (plugin.name !== 'agentsmd') result.errors.push('plugin manifest identity must be agentsmd');
    if (plugin.hooks !== './hooks.json') result.errors.push('plugin manifest hooks must be ./hooks.json');
    if (!parseSemver(plugin.version)) result.errors.push('plugin manifest version must be semantic version text');
  }

  const packageInfo = readBundleJson(root, 'package.json', 'package.json', result.errors);
  if (plugin && packageInfo && plugin.version !== packageInfo.version) {
    result.errors.push('plugin manifest version differs from package version');
  }

  const wiring = readBundleJson(root, 'hooks.json', 'plugin hooks.json', result.errors);
  result.hooks.present = F.pathExists(path.join(root, 'hooks.json'));
  if (wiring) {
    const actualRows = pluginHookRows(wiring.hooks);
    if (actualRows === null) result.errors.push('plugin hooks.json has an invalid hooks schema');
    const commands = actualRows === null ? [] : actualRows.map((row) => row.command);
    const registered = REG.HOOK_BASENAMES.filter((basename) =>
      commands.some((command) => command === `bash "\${CLAUDE_PLUGIN_ROOT}/hooks/${basename}"`)
    );
    result.hooks.registered = registered.length;
    result.hooks.missingRegistrations = REG.HOOK_BASENAMES.filter((name) => !registered.includes(name));
    result.hooks.valid = actualRows !== null
      && JSON.stringify(actualRows) === JSON.stringify(expectedPluginHookRows());
    if (!result.hooks.valid) {
      result.errors.push(`plugin hooks.json wiring differs from the registry contract (${registered.length}/${REG.HOOK_REGISTRY.length} commands found)`);
    }
  }

  result.hooks.missingScripts = REG.HOOK_BASENAMES.filter((basename) => {
    const localErrors = [];
    return readBundleFile(root, path.join('hooks', basename), `plugin hook ${basename}`, localErrors) === null;
  });
  if (result.hooks.missingScripts.length) {
    result.errors.push(`missing plugin hook scripts: ${result.hooks.missingScripts.join(', ')}`);
  }
  result.hooks.missingSupport = PLUGIN_HOOK_SUPPORT.filter((relative) => {
    const localErrors = [];
    return readBundleFile(root, relative, `plugin support ${relative}`, localErrors) === null;
  });
  if (result.hooks.missingSupport.length) {
    result.errors.push(`missing plugin hook support: ${result.hooks.missingSupport.join(', ')}`);
  }

  const core = readBundleFile(root, 'spec/AGENTS.md', 'spec/AGENTS.md', result.errors);
  const extended = readBundleFile(root, 'spec/AGENTS-extended.md', 'spec/AGENTS-extended.md', result.errors);
  result.spec.core = F.pathExists(path.join(root, 'spec', 'AGENTS.md'));
  result.spec.extended = F.pathExists(path.join(root, 'spec', 'AGENTS-extended.md'));
  result.spec.coreVersion = specVersion(core);
  result.spec.extendedVersion = specVersion(extended);
  if (!result.spec.core) result.errors.push('missing spec/AGENTS.md');
  if (!result.spec.extended) result.errors.push('missing spec/AGENTS-extended.md');
  if (plugin && result.spec.coreVersion !== plugin.version) result.errors.push('plugin core spec version differs from manifest version');
  if (plugin && result.spec.extendedVersion !== plugin.version) result.errors.push('plugin extended spec version differs from manifest version');

  result.complete = result.manifest.valid
    && result.hooks.valid
    && result.hooks.missingScripts.length === 0
    && result.hooks.missingSupport.length === 0
    && result.spec.core
    && result.spec.extended
    && result.errors.length === 0;
  result.healthy = result.complete;
  result.reasons = [...result.errors];
  return result;
}

function activeGlobalSpec() {
  const override = path.join(P.codexHome(), 'AGENTS.override.md');
  const selectedPath = F.pathExists(override) ? override : P.agentsMdPath();
  const content = readText(selectedPath);
  return {
    path: selectedPath,
    present: content !== null,
    version: specVersion(content),
    managedBlock: selectedPath === P.agentsMdPath() && AM.hasSpecBlock(content),
  };
}

function extractManagedSpec(content) {
  if (typeof content !== 'string') return null;
  const start = content.indexOf(AM.BEGIN);
  const end = content.indexOf(AM.END, start + AM.BEGIN.length);
  if (start < 0 || end < 0) return null;
  return content
    .slice(start + AM.BEGIN.length, end)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
}

function activeSpecMatchesDeployed(active, activeContent, deployedCore) {
  if (activeContent === null || deployedCore === null) return false;
  const managed = extractManagedSpec(activeContent);
  if (managed !== null) return managed === deployedCore.replace(/\s+$/, '');
  const override = path.basename(active.path) === 'AGENTS.override.md';
  return override && activeContent.replace(/\s+$/, '') === deployedCore.replace(/\s+$/, '');
}

function managedHookRows(hooksRoot) {
  const rows = [];
  if (!isObject(hooksRoot)) return null;
  const registryEvents = [...new Set(REG.HOOK_REGISTRY.map((hook) => hook.hookEvent))];
  const extraEvents = Object.keys(hooksRoot).filter((event) => !registryEvents.includes(event)).sort();
  for (const event of [...registryEvents, ...extraEvents]) {
    const groups = hooksRoot[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) return null;
      for (const hook of group.hooks) {
        if (hook && hook.type === 'command' && H.isAgentsmdCommand(hook.command)) {
          rows.push({
            event,
            matcher: group.matcher == null ? null : group.matcher,
            command: hook.command,
            timeout: hook.timeout == null ? null : hook.timeout,
          });
        }
      }
    }
  }
  return rows;
}

function standaloneWiringMatches(rawHooks) {
  if (rawHooks === null) return false;
  let live;
  try { live = JSON.parse(rawHooks); } catch { return false; }
  let expected;
  try {
    expected = H.buildManagedConfig(P.installHooksDir(), path.join(P.installHooksDir(), 'hooks.json'));
  } catch { return false; }
  const liveRows = managedHookRows(live.hooks);
  const expectedRows = managedHookRows(expected.hooks);
  return liveRows !== null && expectedRows !== null
    && JSON.stringify(liveRows) === JSON.stringify(expectedRows);
}

function removeConfigParserSandbox(root) {
  const realTmp = fs.realpathSync(os.tmpdir());
  const realRoot = fs.realpathSync(root);
  if (path.dirname(realRoot) !== realTmp || !path.basename(realRoot).startsWith('agentsmd-config-parse.')) {
    throw new Error('refusing to remove an unexpected config parser sandbox');
  }
  fs.rmSync(realRoot, { recursive: true, force: true });
}

function validateCodexConfigSyntax(content) {
  const cacheKey = crypto.createHash('sha256')
    .update(process.env.PATH || '')
    .update('\0')
    .update(content)
    .digest('hex');
  if (CONFIG_PARSE_CACHE.has(cacheKey)) return CONFIG_PARSE_CACHE.get(cacheKey);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-config-parse.'));
  try {
    const home = path.join(root, 'home');
    const codexHome = path.join(home, '.codex');
    const claudeHome = path.join(home, '.claude');
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), content, { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      DISABLE_AGENTSMD_HOOKS: '1',
    };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.AGENTSMD_PLUGIN_ROOT;
    const parsed = cp.spawnSync('codex', ['features', 'list'], {
      env,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 5000,
    });
    const result = parsed.error
      ? { valid: false, validator: 'codex-cli', errorCode: parsed.error.code === 'ENOENT' ? 'codex-cli-unavailable' : 'codex-cli-error' }
      : { valid: parsed.status === 0, validator: 'codex-cli', errorCode: parsed.status === 0 ? null : 'codex-rejected-config' };
    CONFIG_PARSE_CACHE.set(cacheKey, result);
    return result;
  } finally {
    removeConfigParserSandbox(root);
  }
}

function inspectStandaloneSurface() {
  const reasons = [];
  const manifestState = readInstallManifest();
  const rawHooks = readText(P.hooksJsonPath());
  const registeredHooks = rawHooks === null ? 0 : H.countAgentsmdHooks(rawHooks);
  const agentsText = readText(P.agentsMdPath());
  const detected = F.pathExists(P.manifestPath())
    || F.pathExists(P.installDir())
    || F.pathExists(P.agentsExtendedMdPath())
    || AM.hasSpecBlock(agentsText)
    || registeredHooks > 0;
  const result = {
    detected,
    version: manifestState.manifest ? manifestState.manifest.version : null,
    protocolVersion: manifestState.manifest && Number.isInteger(manifestState.manifest.surfaceProtocolVersion)
      ? manifestState.manifest.surfaceProtocolVersion
      : 0,
    healthy: false,
    integrityLevel: 'manifest-hash',
    reasons,
    manifestValid: manifestState.valid,
    manifestError: manifestState.error,
    hooksRegistered: registeredHooks,
    hooksExpected: REG.HOOK_REGISTRY.length,
    activeSpec: activeGlobalSpec(),
    config: { parseable: false, hooksEnabled: false, validator: 'codex-cli', errorCode: null },
  };
  if (!detected) return result;
  if (!manifestState.valid) {
    reasons.push(manifestState.error || 'standalone manifest is missing');
    return result;
  }
  const manifest = manifestState.manifest;
  const deployRecord = manifest.ownedArtifacts.deploy;
  const extendedRecord = manifest.ownedArtifacts.extended;

  if (path.resolve(deployRecord.path) !== path.resolve(P.installDir())) reasons.push('manifest deploy path is not the active standalone path');
  if (path.resolve(extendedRecord.path) !== path.resolve(P.agentsExtendedMdPath())) reasons.push('manifest extended path is not the active standalone path');
  let deployRootIsDirectory = false;
  try { deployRootIsDirectory = fs.lstatSync(P.installDir()).isDirectory(); } catch {}
  if (!deployRootIsDirectory) {
    reasons.push('standalone deploy root is missing or not a real directory');
  } else if (!Array.isArray(manifest.deployedFiles) || manifest.deployedFiles.length === 0) {
    reasons.push('manifest deployed inventory is missing or empty');
  } else {
    try {
      const allActual = F.treeEntries(P.installDir());
      const actual = allActual.filter((entry) => entry.type !== 'dir');
      const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
      const expectedMap = new Map();
      for (const record of manifest.deployedFiles) {
        if (!record || typeof record.path !== 'string' || expectedMap.has(record.path)) {
          reasons.push('manifest deployed inventory contains an invalid or duplicate path');
          continue;
        }
        expectedMap.set(record.path, record);
      }
      for (const [relative, expected] of expectedMap) {
        const actualEntry = actualMap.get(relative);
        if (!actualEntry || actualEntry.type !== expected.type
            || (expected.type === 'file' && actualEntry.sha256 !== expected.sha256)
            || (expected.type === 'symlink' && actualEntry.target !== expected.target)) {
          reasons.push(`deploy integrity mismatch: ${relative}`);
        }
      }
      for (const relative of actualMap.keys()) {
        if (!expectedMap.has(relative)) reasons.push(`unexpected deploy artifact: ${relative}`);
      }
      const actualTreeHash = crypto.createHash('sha256').update(JSON.stringify(allActual)).digest('hex');
      if (actualTreeHash !== deployRecord.sha256) reasons.push('deploy tree hash differs from manifest');
    } catch (error) {
      reasons.push(`cannot inspect deploy integrity: ${error.message}`);
    }
  }

  for (const relative of STANDALONE_HOOK_SUPPORT) {
    try {
      if (!fs.statSync(path.join(P.installDir(), relative)).isFile()) reasons.push(`missing standalone support: ${relative}`);
    } catch { reasons.push(`missing standalone support: ${relative}`); }
  }
  if (registeredHooks !== REG.HOOK_REGISTRY.length) {
    reasons.push(`standalone hooks registered ${registeredHooks}/${REG.HOOK_REGISTRY.length}`);
  }
  if (!standaloneWiringMatches(rawHooks)) reasons.push('standalone live hook wiring differs from the deployed registry contract');
  const config = readText(P.configTomlPath()) || '';
  const configHealth = CT.codexHooksHealth(config);
  const configSyntax = validateCodexConfigSyntax(config);
  result.config = {
    parseable: configSyntax.valid,
    hooksEnabled: configHealth.enabled,
    validator: configSyntax.validator,
    errorCode: configSyntax.errorCode,
  };
  if (!configSyntax.valid) reasons.push(`config.toml was rejected by the Codex CLI parser (${configSyntax.errorCode})`);
  if (!configHealth.enabled) reasons.push('standalone hooks are disabled in config.toml');

  try {
    const descriptor = F.describePath(P.agentsExtendedMdPath());
    if (!descriptor.present || descriptor.type !== 'file') reasons.push('extended spec is missing or not a regular file');
    else if (descriptor.sha256 !== extendedRecord.sha256) reasons.push('extended spec hash differs from manifest');
  } catch { reasons.push('extended spec is missing or unreadable'); }
  for (const skill of manifest.ownedArtifacts.skills) {
    const expectedPath = path.join(P.codexSkillsDir(), skill.name);
    if (path.resolve(skill.path) !== path.resolve(expectedPath)) {
      reasons.push(`manifest skill path is not active: ${skill.name}`);
      continue;
    }
    try {
      const descriptor = F.describePath(expectedPath);
      if (!descriptor.present || descriptor.type !== 'tree') reasons.push(`skill is missing or not a real directory: ${skill.name}`);
      else if (descriptor.sha256 !== skill.sha256) reasons.push(`skill tree hash differs from manifest: ${skill.name}`);
    } catch { reasons.push(`skill is missing or unreadable: ${skill.name}`); }
  }

  const deployedPackage = readJson(path.join(P.installDir(), 'package.json'), 'standalone package.json', reasons);
  if (deployedPackage && deployedPackage.version !== manifest.version) reasons.push('standalone package version differs from manifest version');
  if (result.activeSpec.version !== manifest.version) reasons.push('active spec version differs from standalone manifest version');
  const deployedCore = readText(path.join(P.installSpecDir(), 'AGENTS.md'));
  const activeCore = readText(result.activeSpec.path);
  result.activeSpec.contentMatchesDeployed = activeSpecMatchesDeployed(result.activeSpec, activeCore, deployedCore);
  if (!result.activeSpec.contentMatchesDeployed) reasons.push('active spec content differs from deployed standalone core');
  const deployedExtended = readText(path.join(P.installSpecDir(), 'AGENTS-extended.md'));
  const topExtended = readText(P.agentsExtendedMdPath());
  if (deployedExtended === null || topExtended === null || deployedExtended !== topExtended) reasons.push('active extended spec differs from deployed standalone spec');
  if (specVersion(topExtended) !== manifest.version) reasons.push('extended spec version differs from standalone manifest version');

  result.healthy = reasons.length === 0;
  return result;
}

function arbitrateSurfaces(standalone, plugin) {
  let selected = null;
  let reasonCode = 'no-healthy-surface';
  if (standalone.healthy && plugin.healthy) {
    const comparison = compareSemver(standalone.version, plugin.version);
    if (comparison >= 0) {
      selected = 'standalone';
      reasonCode = comparison === 0 ? 'same-version-standalone' : 'higher-version-standalone';
    } else {
      selected = 'plugin';
      reasonCode = 'higher-version-plugin';
    }
  } else if (standalone.healthy) {
    selected = 'standalone';
    reasonCode = plugin.detected ? 'plugin-unhealthy' : 'standalone-only-healthy';
  } else if (plugin.healthy) {
    selected = 'plugin';
    reasonCode = standalone.detected ? 'standalone-unhealthy' : 'plugin-only-healthy';
  }

  const loserCanYield = selected === 'standalone'
    ? (!plugin.detected || (plugin.healthy && plugin.protocolVersion >= 1))
    : (selected === 'plugin' ? !standalone.detected : false);
  const exclusive = selected !== null && loserCanYield;
  return {
    schemaVersion: 1,
    candidates: { standalone, plugin },
    selection: {
      selected,
      reasonCode,
      exclusive,
      degraded: selected === null || !exclusive,
      loserCanYield,
    },
  };
}

function inspectAndArbitrate(env = process.env) {
  return arbitrateSurfaces(inspectStandaloneSurface(), inspectPluginBundle(env));
}

if (require.main === module) {
  const usage = 'Usage: node surface-arbitration.js --hook-json';
  try {
    const parsed = parseStrict(process.argv.slice(2), { bools: ['hook-json'] });
    if (!parsed.bools.has('hook-json')) throw new ArgvError('missing required option: --hook-json');
    process.stdout.write(`${JSON.stringify(inspectAndArbitrate())}\n`);
  } catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    console.error(`${error.message}\n${usage}`);
    process.exitCode = 2;
  }
}

module.exports = {
  PLUGIN_HOOK_SUPPORT,
  SEMVER_RE,
  arbitrateSurfaces,
  compareSemver,
  inspectAndArbitrate,
  inspectPluginBundle,
  inspectStandaloneSurface,
  parseSemver,
  pluginRootFromEnv,
  readInstallManifest,
  specVersion,
  validateCodexConfigSyntax,
  validateInstallManifest,
};
