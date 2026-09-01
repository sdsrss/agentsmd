#!/usr/bin/env node
'use strict';

// Canonical generated runtime for skills/*/scripts/agentsmd-run.js.
// Keep runner resolution deterministic and outside model-visible SKILL.md text.

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEMVER_RE = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:[.](?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/;
const SCRIPT_BY_SKILL = Object.freeze({
  'agentsmd-analyze': 'analyze.js',
  'agentsmd-audit': 'audit.js',
  'agentsmd-design': 'design.js',
  'agentsmd-doctor': 'doctor.js',
  'agentsmd-init': 'init.js',
  'agentsmd-lesson-bypass-audit': 'lesson-bypass-audit.js',
  'agentsmd-lint-argv': 'lint-argv.js',
  'agentsmd-perf-baseline': 'perf-baseline.js',
  'agentsmd-restore': 'restore.js',
  'agentsmd-rules': 'rules.js',
  'agentsmd-safety-coverage-audit': 'safety-coverage-audit.js',
  'agentsmd-sampling-audit': 'sampling-audit.js',
  'agentsmd-scorecard': 'scorecard.js',
  'agentsmd-sparkline': 'sparkline.js',
  'agentsmd-status': 'status.js',
  'agentsmd-verify': 'verify.js',
  'agentsmd-version-cascade': 'version-cascade-check.js',
});

function regularFile(file) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
}

function readJson(file) {
  if (!regularFile(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rootIdentity(root, script, kind, codexHome, cliEntry = '', runtimeHash = '') {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const packageFile = path.join(root, 'package.json');
    const target = path.join(root, 'scripts', script);
    const runtime = path.join(root, 'scripts', 'lib', 'skill-runner.js');
    if (!regularFile(packageFile) || !regularFile(target) || !regularFile(runtime)
        || (runtimeHash && fileSha256(runtime) !== runtimeHash)) return null;
    const pkg = readJson(packageFile);
    if (!pkg || pkg.name !== '@sdsrs/agentsmd' || !SEMVER_RE.test(pkg.version)) return null;

    const pluginFile = path.join(root, '.codex-plugin', 'plugin.json');
    let plugin = false;
    if (fs.existsSync(pluginFile)) {
      const manifest = readJson(pluginFile);
      if (!manifest || manifest.name !== 'agentsmd' || manifest.version !== pkg.version) return null;
      plugin = true;
    }

    if (kind === 'standalone') {
      const manifest = readJson(path.join(codexHome, '.agentsmd-state', 'manifest.json'));
      const deploy = manifest && manifest.ownedArtifacts && manifest.ownedArtifacts.deploy;
      if (!manifest || manifest.name !== 'agentsmd' || manifest.version !== pkg.version
          || !deploy || path.resolve(deploy.path || '') !== path.resolve(root)
          || !/^[a-f0-9]{64}$/.test(String(deploy.sha256 || ''))) return null;
    }

    if (kind === 'versioned-cli') {
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.agentsmd;
      if (!bin) return null;
      const binPath = path.resolve(root, bin);
      if (!binPath.startsWith(`${path.resolve(root)}${path.sep}`)
          || fs.realpathSync(binPath) !== fs.realpathSync(cliEntry)) return null;
    }
    return { root: path.resolve(root), kind, plugin };
  } catch {
    return null;
  }
}

function findCliEntry(envPath = process.env.PATH || '') {
  const names = process.platform === 'win32'
    ? ['agentsmd.cmd', 'agentsmd.exe', 'agentsmd']
    : ['agentsmd'];
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {}
    }
  }
  return '';
}

function bounded(value) {
  return String(value || 'missing').slice(0, 512);
}

function parseArgs(argv) {
  const [skillFile = '', ...forwarded] = argv;
  return { skillFile, forwarded };
}

function resolveRunner(skillFile, codexHome, envPath, launcherFile = __filename, runtimeHash = '') {
  let expectedRunner;
  let script;
  try {
    if (!path.isAbsolute(skillFile) || path.basename(skillFile) !== 'SKILL.md'
        || !regularFile(skillFile)) return { error: 'selected skill path is not a regular absolute SKILL.md' };
    expectedRunner = path.join(path.dirname(skillFile), 'scripts', 'agentsmd-run.js');
    if (!regularFile(expectedRunner) || fs.realpathSync(expectedRunner) !== fs.realpathSync(launcherFile)) {
      return { error: 'selected skill launcher identity mismatch' };
    }
    script = SCRIPT_BY_SKILL[path.basename(path.dirname(skillFile))];
    if (!script) return { error: 'selected skill is not in the agentsmd runner inventory' };
  } catch {
    return { error: 'selected skill launcher is unreadable' };
  }

  const candidateRoot = path.resolve(path.dirname(skillFile), '..', '..');
  const standaloneRoot = path.join(codexHome, 'agentsmd');
  const selected = rootIdentity(candidateRoot, script, 'selected-bundle', codexHome, '', runtimeHash);
  if (selected) return { selected, script, candidateRoot, standaloneRoot, cliEntry: '' };
  const standalone = rootIdentity(standaloneRoot, script, 'standalone', codexHome, '', runtimeHash);
  if (standalone) return { selected: standalone, script, candidateRoot, standaloneRoot, cliEntry: '' };

  const cliEntry = findCliEntry(envPath);
  if (cliEntry) {
    const cliRoot = path.resolve(path.dirname(cliEntry), '..');
    const cli = rootIdentity(cliRoot, script, 'versioned-cli', codexHome, cliEntry, runtimeHash);
    if (cli) return { selected: cli, script, candidateRoot, standaloneRoot, cliEntry };
  }
  return { script, candidateRoot, standaloneRoot, cliEntry };
}

function main(argv = process.argv.slice(2), launcherFile = __filename, runtimeHash = fileSha256(__filename)) {
  const parsed = parseArgs(argv);
  const skillFile = parsed.skillFile;
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const resolution = resolveRunner(skillFile, codexHome, process.env.PATH || '', launcherFile, runtimeHash);
  if (!resolution.selected) {
    const reason = resolution.error ? ` reason=${bounded(resolution.error)}` : '';
    process.stderr.write(
      `agentsmd skill runner unavailable: script=${bounded(resolution.script)} skill=${bounded(skillFile)}`
      + ` candidate=${bounded(resolution.candidateRoot)} standalone=${bounded(resolution.standaloneRoot)}`
      + ` cli=${bounded(resolution.cliEntry)};${reason} unblock: expose the selected plugin bundle, grant read access to the manifest-owned standalone deploy, or install the versioned agentsmd CLI\n`,
    );
    return 1;
  }

  const env = { ...process.env };
  if (resolution.selected.kind === 'selected-bundle' && resolution.selected.plugin) {
    env.AGENTSMD_PLUGIN_ROOT = resolution.selected.root;
  } else {
    delete env.AGENTSMD_PLUGIN_ROOT;
  }
  const target = path.join(resolution.selected.root, 'scripts', resolution.script);
  const result = cp.spawnSync(process.execPath, [target, ...parsed.forwarded], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(`agentsmd skill runner failed: script=${resolution.script} error=${bounded(result.error.message)}\n`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { SCRIPT_BY_SKILL, findCliEntry, main, parseArgs, resolveRunner, rootIdentity };
