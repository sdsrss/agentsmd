'use strict';
// paths.js — resolve agentsmd's install + Codex config locations. Honors
// CODEX_HOME (set by tests to a sandbox) before falling back to ~/.codex.
// Every agentsmd-owned path lives under a `agentsmd` segment or a agentsmd-*
// filename so nothing can collide with OMX or other tenants (ARCHITECTURE.md §5).

const os = require('os');
const path = require('path');

function codexHome() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
}
// Repo root = two levels up from scripts/lib.
function repoRoot() { return path.resolve(__dirname, '..', '..'); }

// Self-contained install dir under Codex home; its `/agentsmd/` segment is what
// the hooks.json marker matches on.
function installDir() { return path.join(codexHome(), 'agentsmd'); }
function installHooksDir() { return path.join(installDir(), 'hooks'); }
function installSpecDir() { return path.join(installDir(), 'spec'); }
function installScriptsDir() { return path.join(installDir(), 'scripts'); }
// Codex user-skills dir (shared with other plugins). agentsmd only ever adds /
// removes its own `agentsmd-*` prefixed dirs here — never touches others.
function codexSkillsDir() { return path.join(codexHome(), 'skills'); }

function hooksJsonPath() { return path.join(codexHome(), 'hooks.json'); }
function configTomlPath() { return path.join(codexHome(), 'config.toml'); }
function agentsMdPath() { return path.join(codexHome(), 'AGENTS.md'); }
// Extended spec — the exact top-level path core §2/§5 tell the agent to `cat` on
// L3. NOT in Codex's discovery chain (zero AGENTS.md-budget); a agentsmd-owned
// standalone file, not the shared/sentinel-merged AGENTS.md.
function agentsExtendedMdPath() { return path.join(codexHome(), 'AGENTS-extended.md'); }
function stateDir() { return path.join(codexHome(), '.agentsmd-state'); }
function manifestPath() { return path.join(stateDir(), 'manifest.json'); }
function logPath() { return path.join(codexHome(), 'logs', 'agentsmd.jsonl'); }

module.exports = {
  codexHome, repoRoot, installDir, installHooksDir, installSpecDir, installScriptsDir, codexSkillsDir,
  hooksJsonPath, configTomlPath, agentsMdPath, agentsExtendedMdPath, stateDir, manifestPath, logPath,
};
