'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./fs-atomic');

const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function includeStandaloneDeploySource(repo, source) {
  const relative = path.relative(repo, source);
  const segments = relative.split(path.sep);
  return !(segments.length >= 2
    && segments[1] === 'tests'
    && (segments[0] === 'hooks' || segments[0] === 'scripts'));
}

function chmodShells(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) chmodShells(file);
    else if (entry.isFile() && entry.name.endsWith('.sh')) fs.chmodSync(file, 0o755);
  }
}

function stageSources(repo, stageRoot) {
  const deploy = path.join(stageRoot, 'deploy');
  fs.mkdirSync(deploy, { recursive: true });
  for (const name of ['hooks', 'spec', 'scripts', 'skills']) {
    const source = path.join(repo, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(deploy, name), {
      recursive: true,
      filter: (entry) => includeStandaloneDeploySource(repo, entry),
    });
  }
  const packageJson = path.join(repo, 'package.json');
  if (fs.existsSync(packageJson)) fs.copyFileSync(packageJson, path.join(deploy, 'package.json'));
  for (const required of ['hooks', 'spec', 'scripts', 'skills']) {
    if (!fs.existsSync(path.join(deploy, required))) throw new Error(`install source is incomplete: missing ${required}/`);
  }
  chmodShells(path.join(deploy, 'hooks'));
  return deploy;
}

function specVersion(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/CODEX-CODING-SPEC v(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function inspectReleaseArtifact(repo) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-artifact-plan.'));
  try {
    const errors = [];
    let deploy;
    try { deploy = stageSources(repo, temp); }
    catch (error) {
      errors.push(error.message);
      return {
        kind: 'local-source', root: path.resolve(repo), name: null, version: null,
        complete: false, errors, deploySha256: null, deployedFiles: [], skills: [],
      };
    }
    const readJson = (file, label) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { errors.push(`${label} is missing or invalid: ${error.message}`); return {}; }
    };
    const packageInfo = readJson(path.join(deploy, 'package.json'), 'package.json');
    const plugin = readJson(path.join(repo, '.codex-plugin', 'plugin.json'), 'plugin manifest');
    const rules = readJson(path.join(deploy, 'spec', 'hard-rules.json'), 'hard-rules manifest');
    let coreVersion = null, extendedVersion = null;
    try { coreVersion = specVersion(path.join(deploy, 'spec', 'AGENTS.md')); }
    catch (error) { errors.push(`core spec is missing or unreadable: ${error.message}`); }
    try { extendedVersion = specVersion(path.join(deploy, 'spec', 'AGENTS-extended.md')); }
    catch (error) { errors.push(`extended spec is missing or unreadable: ${error.message}`); }
    const version = packageInfo.version;
    if (packageInfo.name !== '@sdsrs/agentsmd') errors.push('package identity is not @sdsrs/agentsmd');
    if (typeof version !== 'string' || !SEMVER_RE.test(version)) errors.push('package version is not semantic version text');
    if (plugin.name !== 'agentsmd' || plugin.hooks !== './hooks.json') errors.push('plugin manifest identity/hooks are invalid');
    if (plugin.version !== version) errors.push('plugin version differs from package version');
    if (rules.spec_version !== `v${version}`) errors.push('hard-rules spec_version differs from package version');
    if (coreVersion !== version || extendedVersion !== version) errors.push('spec header version differs from package version');
    for (const relative of [
      'hooks/hooks.json',
      'hooks/banned-vocab.patterns',
      'hooks/secrets.patterns',
      'hooks/lib/hook-common.sh',
      'hooks/lib/memory-links.js',
      'hooks/lib/platform.sh',
      'hooks/lib/platform-timeout.js',
      'hooks/lib/rule-hits.sh',
      'hooks/lib/command-parse.js',
      'hooks/lib/orchestrator-source.js',
      'scripts/install.js',
      'scripts/repair.js',
      'scripts/doctor.js',
      'scripts/status.js',
    ]) {
      if (!fs.existsSync(path.join(deploy, relative))) errors.push(`artifact runtime file is missing: ${relative}`);
    }
    const skillsRoot = path.join(deploy, 'skills');
    const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('agentsmd-'))
      .map((entry) => ({
        name: entry.name,
        sha256: F.sha256Tree(path.join(skillsRoot, entry.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!skills.length) errors.push('artifact has no agentsmd skills');
    return {
      kind: 'local-source',
      root: path.resolve(repo),
      name: packageInfo.name || null,
      version: version || null,
      complete: errors.length === 0,
      errors,
      deploySha256: F.sha256Tree(deploy),
      deployedFiles: F.treeEntries(deploy).filter((entry) => entry.type !== 'dir'),
      skills,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { includeStandaloneDeploySource, inspectReleaseArtifact, stageSources };
