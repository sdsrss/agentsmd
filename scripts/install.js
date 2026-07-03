'use strict';
// install.js — install agentsmd into ~/.codex (honors $CODEX_HOME). Independent
// of oh-my-codex: touches only agentsmd's own entries, preserves everything else,
// works whether or not ~/.codex pre-exists or OMX is present (ARCHITECTURE.md §5).
// Idempotent — re-running refreshes agentsmd's entries without duplicating them.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const CT = require('./lib/config-toml');
const AM = require('./lib/agents-md');
const M = require('./lib/migrate');

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

  // 0. Abort BEFORE touching anything if the shared hooks.json is present but
  //    unparseable — it may hold other tenants' hooks we cannot see, and
  //    overwriting it would silently delete them (C1). Never clobber blind.
  const existingHooks = readOrNull(P.hooksJsonPath());
  if (existingHooks !== null && existingHooks.trim() !== '' && !H.parseHooksConfig(existingHooks)) {
    throw new Error(`${P.hooksJsonPath()} exists but is not valid JSON — agentsmd will not overwrite it. Fix or remove it, then re-run install.`);
  }

  // 0b. Migrate away any prior codexmd install (agentsmd's former name) BEFORE we
  //     lay down our own entries — strip the legacy /codexmd/ hooks, AGENTS.md
  //     block, skills, and dirs so an upgrader gets a clean replacement, not
  //     duplicates. Marker-scoped (never touches OMX); a no-op when none exists.
  const migratedFromCodexmd = M.removeLegacyCodexmd();
  //     …and carry that user's rule-hit telemetry across the rename so the
  //     promote/demote window survives the upgrade (no-op on a fresh install).
  const migratedTelemetry = M.migrateLegacyTelemetry();

  // 1. Copy hooks/ + spec/ + scripts/ into the self-contained install dir (the
  //    `/agentsmd/` path segment is what the hooks.json marker matches). Wipe the
  //    dir first so a file removed since the last version cannot linger: the
  //    install dir is 100% agentsmd's (manifest/state/log live elsewhere), so it
  //    must mirror the repo exactly, not accumulate stale copies across upgrades.
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.cpSync(path.join(repo, 'hooks'), hooksDir, { recursive: true });
  fs.cpSync(path.join(repo, 'spec'), P.installSpecDir(), { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), P.installScriptsDir(), { recursive: true });
  chmodShells(hooksDir); chmodShells(path.join(hooksDir, 'lib')); chmodShells(path.join(hooksDir, 'tests'));

  // 1b. Install command-layer skills into the Codex user-skills dir — ONLY our
  //     `agentsmd-*` prefixed dirs; never touch any other tenant's skill.
  const installedSkills = [];
  const repoSkills = path.join(repo, 'skills');
  if (fs.existsSync(repoSkills)) {
    fs.mkdirSync(P.codexSkillsDir(), { recursive: true });
    for (const name of fs.readdirSync(repoSkills)) {
      if (!name.startsWith('agentsmd-')) continue;
      const src = path.join(repoSkills, name);
      if (!fs.statSync(src).isDirectory()) continue;
      fs.rmSync(path.join(P.codexSkillsDir(), name), { recursive: true, force: true }); // idempotent refresh
      fs.cpSync(src, path.join(P.codexSkillsDir(), name), { recursive: true });
      installedSkills.push(name);
    }
  }

  // 2. Merge hooks.json — marker-scoped, preserve all non-agentsmd entries.
  const managed = H.buildManagedConfig(hooksDir, path.join(hooksDir, 'hooks.json'));
  const mergedHooks = H.mergeAgentsmdHooks(readOrNull(P.hooksJsonPath()), managed);
  writeFile(P.hooksJsonPath(), mergedHooks);

  // 3. Ensure config.toml [features] hooks = true (Codex 0.142+; migrates a
  //    legacy codex_hooks flag to the canonical name), and restore the useful
  //    Codex built-in footer items formerly configured by OMX. User-defined
  //    [tui] status_line values are preserved byte-for-byte.
  const cfg = CT.ensureCodexHooksFlag(readOrNull(P.configTomlPath()));
  const statusLine = CT.ensureTuiStatusLine(cfg.content);
  if (cfg.changed || statusLine.changed) writeFile(P.configTomlPath(), statusLine.content);

  // 4. Inject the core spec into ~/.codex/AGENTS.md as a sentinel block.
  const specText = fs.readFileSync(path.join(P.installSpecDir(), 'AGENTS.md'), 'utf8');
  const am = AM.injectSpecBlock(readOrNull(P.agentsMdPath()), specText);
  writeFile(P.agentsMdPath(), am.content);

  // 5. Record what we did, for an exact reversible uninstall.
  const manifest = {
    name: 'agentsmd',
    installedAt: nowIso || new Date().toISOString(),
    installDir, hooksDir,
    hookCount: H.countAgentsmdHooks(mergedHooks),
    installedSkills,
    configFlag: cfg.reason,
    configFlagAddedByUs: cfg.changed,
    statusLine: statusLine.reason,
    statusLineAddedByUs: statusLine.changed,
    agentsBlockUpdated: am.updated === true,
    migratedFromCodexmd: migratedFromCodexmd.detected ? migratedFromCodexmd : null,
    migratedTelemetryRows: migratedTelemetry.migrated,
  };
  writeFile(P.manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  try { console.log('agentsmd installed:\n' + JSON.stringify(install(), null, 2)); }
  catch (e) { console.error('agentsmd install failed:', e.message); process.exit(1); }
}
module.exports = { install };
