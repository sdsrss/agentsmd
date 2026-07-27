'use strict';
// preflight.js — the ONE prerequisite check every install surface runs BEFORE
// any mutation (R1-03 / audit M-01). The standalone shell (install.sh) reaches
// it through scripts/install.js, the npm CLI (bin/agentsmd.js install|update)
// spawns the same script, and repair re-runs install() — so a missing
// prerequisite is a zero-mutation refusal everywhere, not a post-install
// warning. Degraded installs are explicit opt-in only (--degraded /
// AGENTSMD_ALLOW_DEGRADED=1) and are recorded in the manifest as
// enforcement:false so status/doctor keep warning until a healthy update.

const { spawnSync } = require('child_process');
const { manualInstallCommand } = require('./tool-guidance');

const REQUIRED_NODE_MAJOR = 18; // package.json engines.node

const CHECKS = [
  {
    name: 'jq',
    probe: () => {
      const r = spawnSync('jq', ['--version'], { stdio: 'ignore' });
      return !r.error && r.status === 0;
    },
    why: 'every enforcement hook parses events with jq; without it hooks FAIL OPEN (no §8 blocks)',
    remedy: `run \`${manualInstallCommand('jq')}\``,
  },
  {
    name: `node>=${REQUIRED_NODE_MAJOR}`,
    probe: () => Number.parseInt(process.versions.node.split('.')[0], 10) >= REQUIRED_NODE_MAJOR,
    why: 'command parsing and surface arbitration run Node scripts',
    remedy: `run \`${manualInstallCommand('node')}\`, then verify \`node --version\` reports >= ${REQUIRED_NODE_MAJOR}`,
  },
];

// checkPrerequisites() → { ok, missing: [{name, why, remedy}] }
function checkPrerequisites() {
  const missing = [];
  for (const check of CHECKS) {
    let present = false;
    try { present = check.probe() === true; } catch { present = false; }
    if (!present) missing.push({ name: check.name, why: check.why, remedy: check.remedy });
  }
  return { ok: missing.length === 0, missing };
}

// inspectInstalledAgentsmdPlugin() is a read-only guard against accidentally
// creating a second delivery surface. The Codex registry is authoritative for
// installation/enabled state; cache presence alone is not. An unavailable or
// older CLI is reported as unknown so standalone remains usable.
function inspectInstalledAgentsmdPlugin(env = process.env) {
  const codex = typeof env.AGENTSMD_CODEX_BIN === 'string' && env.AGENTSMD_CODEX_BIN.trim()
    ? env.AGENTSMD_CODEX_BIN.trim()
    : 'codex';
  const result = spawnSync(codex, ['plugin', 'list', '--json'], {
    encoding: 'utf8',
    env,
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) {
    return { state: 'unavailable', plugin: null };
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { return { state: 'unavailable', plugin: null }; }
  const installed = parsed && Array.isArray(parsed.installed) ? parsed.installed : null;
  if (!installed) return { state: 'unavailable', plugin: null };
  const plugin = installed.find((entry) => (
    entry
    && entry.pluginId === 'agentsmd@agentsmd'
    && entry.installed === true
    && entry.enabled === true
  )) || null;
  return { state: plugin ? 'installed' : 'absent', plugin };
}

// degradedOptIn(parsedBools) — true only on the EXPLICIT opt-ins.
function degradedOptIn(bools) {
  if (bools && typeof bools.has === 'function' && bools.has('degraded')) return true;
  return process.env.AGENTSMD_ALLOW_DEGRADED === '1';
}

function refusalMessage(missing) {
  const lines = ['missing prerequisites — refusing to change anything (zero-mutation preflight):'];
  for (const m of missing) lines.push(`  - ${m.name}: ${m.why}; remedy: ${m.remedy}`);
  lines.push('fix the prerequisites and re-run, or explicitly opt in to a NON-ENFORCING install with --degraded');
  lines.push('(degraded installs record enforcement:false; status/doctor warn until a healthy `agentsmd update`)');
  return lines.join('\n');
}

module.exports = {
  checkPrerequisites,
  inspectInstalledAgentsmdPlugin,
  degradedOptIn,
  refusalMessage,
  REQUIRED_NODE_MAJOR,
};
