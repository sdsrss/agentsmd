'use strict';
// install.js — install codexmd into ~/.codex (honors $CODEX_HOME). Independent
// of oh-my-codex: touches only codexmd's own entries, preserves everything else,
// works whether or not ~/.codex pre-exists or OMX is present (ARCHITECTURE.md §5).
// Idempotent — re-running refreshes codexmd's entries without duplicating them.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const CT = require('./lib/config-toml');
const AM = require('./lib/agents-md');

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const writeFile = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const chmodShells = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.sh')) { try { fs.chmodSync(path.join(dir, f), 0o755); } catch {} }
};

function install(nowIso) {
  const repo = P.repoRoot();
  const installDir = P.installDir();
  const hooksDir = P.installHooksDir();

  // 1. Copy hooks/ + spec/ + scripts/ into the self-contained install dir (the
  //    `/codexmd/` path segment is what the hooks.json marker matches).
  fs.mkdirSync(installDir, { recursive: true });
  fs.cpSync(path.join(repo, 'hooks'), hooksDir, { recursive: true });
  fs.cpSync(path.join(repo, 'spec'), P.installSpecDir(), { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), P.installScriptsDir(), { recursive: true });
  chmodShells(hooksDir); chmodShells(path.join(hooksDir, 'lib')); chmodShells(path.join(hooksDir, 'tests'));

  // 1b. Install command-layer skills into the Codex user-skills dir — ONLY our
  //     `codexmd-*` prefixed dirs; never touch any other tenant's skill.
  const installedSkills = [];
  const repoSkills = path.join(repo, 'skills');
  if (fs.existsSync(repoSkills)) {
    fs.mkdirSync(P.codexSkillsDir(), { recursive: true });
    for (const name of fs.readdirSync(repoSkills)) {
      if (!name.startsWith('codexmd-')) continue;
      const src = path.join(repoSkills, name);
      if (!fs.statSync(src).isDirectory()) continue;
      fs.rmSync(path.join(P.codexSkillsDir(), name), { recursive: true, force: true }); // idempotent refresh
      fs.cpSync(src, path.join(P.codexSkillsDir(), name), { recursive: true });
      installedSkills.push(name);
    }
  }

  // 2. Merge hooks.json — marker-scoped, preserve all non-codexmd entries.
  const managed = H.buildManagedConfig(hooksDir, path.join(hooksDir, 'hooks.json'));
  const mergedHooks = H.mergeCodexmdHooks(readOrNull(P.hooksJsonPath()), managed);
  writeFile(P.hooksJsonPath(), mergedHooks);

  // 3. Ensure config.toml [features] codex_hooks = true (append-only).
  const cfg = CT.ensureCodexHooksFlag(readOrNull(P.configTomlPath()));
  if (cfg.changed) writeFile(P.configTomlPath(), cfg.content);

  // 4. Inject the core spec into ~/.codex/AGENTS.md as a sentinel block.
  const specText = fs.readFileSync(path.join(P.installSpecDir(), 'AGENTS.md'), 'utf8');
  const am = AM.injectSpecBlock(readOrNull(P.agentsMdPath()), specText);
  writeFile(P.agentsMdPath(), am.content);

  // 5. Record what we did, for an exact reversible uninstall.
  const manifest = {
    name: 'codexmd',
    installedAt: nowIso || new Date().toISOString(),
    installDir, hooksDir,
    hookCount: H.countCodexmdHooks(mergedHooks),
    installedSkills,
    configFlag: cfg.reason,
    configFlagAddedByUs: cfg.changed,
    agentsBlockUpdated: am.updated === true,
  };
  writeFile(P.manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  try { console.log('codexmd installed:\n' + JSON.stringify(install(), null, 2)); }
  catch (e) { console.error('codexmd install failed:', e.message); process.exit(1); }
}
module.exports = { install };
