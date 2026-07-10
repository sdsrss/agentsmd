'use strict';
// migrate.js — one-time migration of a prior **codexmd** install (agentsmd's
// former name, published as v1.4.0–v1.4.3) to agentsmd. Anyone who installed
// codexmd carries hooks under the old CODEX_HOME/codexmd install dir, a
// `# >>> codexmd >>>` block in AGENTS.md, `codexmd-*` skills, and
// ~/.codex/{codexmd, .codexmd-state}. This removes exactly those — by the SAME
// marker-scoped discipline agentsmd uses for itself (ARCHITECTURE.md §5): never
// touch OMX or any other tenant. Idempotent + a no-op when no codexmd is present.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const H = require('./codex-hooks');
const AM = require('./agents-md');
const B = require('./backup');
const F = require('./fs-atomic');

// The former identity. Kept HERE — the only place agentsmd still names the old
// project — so the rest of the codebase stays free of it.
const LEGACY_BEGIN = '# >>> codexmd >>>';
const LEGACY_END = '# <<< codexmd <<<';
const LEGACY_SKILL_PREFIX = 'codexmd-';
const LEGACY_INSTALL_DIRNAME = 'codexmd';
const LEGACY_STATE_DIRNAME = '.codexmd-state';

// A command hook belongs to the legacy codexmd install iff its path carries a
// path under the old codexmd install dir in the active CODEX_HOME.
const isLegacyCommand = (command) => {
  if (typeof command !== 'string') return false;
  const legacyInstallDir = path.join(P.codexHome(), LEGACY_INSTALL_DIRNAME).replace(/\\/g, '/').replace(/\/+$/, '');
  return command.replace(/\\/g, '/').includes(`${legacyInstallDir}/`);
};

const readOrNull = (file) => F.readFileOptional(file, 'utf8');
const rmrf = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); return true; } } catch {} return false; };

// Remove any prior codexmd footprint from the active Codex home ($CODEX_HOME).
// Returns a report; `detected` is true iff something was actually removed.
function removeLegacyCodexmd() {
  const report = {
    detected: false, hooksRemoved: 0, agentsBlockRemoved: false,
    skillsRemoved: 0, installDirRemoved: false, stateDirRemoved: false,
    ownershipConflicts: [],
  };
  const legacyInstallDir = path.join(P.codexHome(), LEGACY_INSTALL_DIRNAME);
  const legacyStateDir = path.join(P.codexHome(), LEGACY_STATE_DIRNAME);
  const legacyManifestPath = path.join(legacyStateDir, 'manifest.json');
  let legacyManifest = null;
  const legacyManifestRaw = readOrNull(legacyManifestPath);
  if (legacyManifestRaw !== null) {
    try {
      const parsed = JSON.parse(legacyManifestRaw);
      if (parsed && parsed.name === 'codexmd') legacyManifest = parsed;
    } catch {}
  }

  // 1. hooks.json — strip only old CODEX_HOME/codexmd install-dir entries;
  //    preserve all others (OMX, the user's own, any tenant) exactly as
  //    agentsmd's own remove does.
  const hooksPath = P.hooksJsonPath();
  const hooksContent = readOrNull(hooksPath);
  if (hooksContent !== null) {
    const r = H.removeMarkedHooks(hooksContent, isLegacyCommand);
    if (r.removed > 0) {
      report.hooksRemoved = r.removed; report.detected = true;
      if (r.nextContent === null) { try { fs.unlinkSync(hooksPath); } catch {} }
      else B.writeFileAtomic(hooksPath, r.nextContent); // atomic: a torn write of the SHARED hooks.json would corrupt OMX too
    }
  }

  // 2. AGENTS.md — drop the legacy sentinel block; keep all surrounding content.
  const amPath = P.agentsMdPath();
  const amContent = readOrNull(amPath);
  if (amContent !== null) {
    const r = AM.removeBlockBetween(amContent, LEGACY_BEGIN, LEGACY_END);
    if (r.changed) {
      report.agentsBlockRemoved = true; report.detected = true;
      if (r.content.trim() === '') { try { fs.unlinkSync(amPath); } catch {} }
      else B.writeFileAtomic(amPath, r.content); // atomic: AGENTS.md is shared with OMX/user content
    }
  }

  // 3. Skills require an exact legacy manifest record. The namespace prefix by
  //    itself is not provenance and may be used by an unrelated local skill.
  const sdir = P.codexSkillsDir();
  const legacySkills = legacyManifest?.ownedArtifacts && Array.isArray(legacyManifest.ownedArtifacts.skills)
    ? legacyManifest.ownedArtifacts.skills : [];
  if (fs.existsSync(sdir)) {
    for (const record of legacySkills) {
      const name = record && record.name;
      const target = typeof name === 'string' ? path.join(sdir, name) : '';
      if (typeof name !== 'string' || path.basename(name) !== name || !name.startsWith(LEGACY_SKILL_PREFIX)
          || path.resolve(record.path || '') !== path.resolve(target)) {
        report.ownershipConflicts.push(`invalid legacy skill record: ${name || '(unknown)'}`);
        continue;
      }
      if (!F.pathExists(target)) continue;
      let actual = null;
      try { actual = F.sha256Tree(target); } catch {}
      if (actual !== record.sha256) {
        report.ownershipConflicts.push(target);
      } else if (rmrf(target)) {
        report.skillsRemoved++; report.detected = true;
      }
    }
    const unhashedNames = legacyManifest && !legacyManifest.ownedArtifacts && Array.isArray(legacyManifest.installedSkills)
      ? legacyManifest.installedSkills : [];
    for (const name of unhashedNames) {
      const target = typeof name === 'string' ? path.join(sdir, name) : '';
      if (typeof name === 'string' && path.basename(name) === name && name.startsWith(LEGACY_SKILL_PREFIX) && F.pathExists(target)) {
        report.ownershipConflicts.push(target);
      }
    }
  }

  // 4. Fixed-name dirs are deleted only with verified provenance: the manifest
  //    names the exact install path, or live hook commands proved that path was
  //    the active legacy release. A same-named foreign directory is preserved.
  const deployRecord = legacyManifest?.ownedArtifacts && legacyManifest.ownedArtifacts.deploy;
  if (F.pathExists(legacyInstallDir)) {
    let actual = null;
    try { actual = F.sha256Tree(legacyInstallDir); } catch {}
    if (deployRecord && path.resolve(deployRecord.path || '') === path.resolve(legacyInstallDir) && actual === deployRecord.sha256) {
      if (rmrf(legacyInstallDir)) { report.installDirRemoved = true; report.detected = true; }
    } else {
      report.ownershipConflicts.push(legacyInstallDir);
    }
  }
  if (legacyManifest && report.ownershipConflicts.length === 0) {
    try { fs.unlinkSync(legacyManifestPath); report.detected = true; } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    try { fs.rmdirSync(legacyStateDir); report.stateDirRemoved = true; }
    catch (error) { if (!error || (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT')) throw error; }
  }
  if (report.ownershipConflicts.length) report.detected = true;

  return report;
}

// Preserve a prior codexmd user's telemetry across the rename: append the legacy
// ~/.codex/logs/codexmd.jsonl onto agentsmd's log, then remove the legacy file so
// the promote/demote window (the whole point of the closed loop, ARCHITECTURE.md §4)
// survives the upgrade instead of restarting from zero. NOT folded into
// removeLegacyCodexmd(): that runs on uninstall too, where preserving telemetry is
// wrong. Append (never overwrite — agentsmd.jsonl may already exist) and one-shot
// (the legacy file is consumed, so a re-install is a no-op). Best-effort: a failure
// here must never break install. Returns { migrated: <row count> }.
function migrateLegacyTelemetry() {
  const legacy = path.join(P.codexHome(), 'logs', 'codexmd.jsonl');
  const current = P.logPath(); // logs/agentsmd.jsonl — the single file audit.js reads
  try {
    if (!fs.existsSync(legacy)) return { migrated: 0 };
    let data = fs.readFileSync(legacy, 'utf8');
    const migrated = data.split('\n').filter(Boolean).length;
    if (migrated === 0) { try { fs.unlinkSync(legacy); } catch {} return { migrated: 0 }; }
    if (!data.endsWith('\n')) data += '\n';
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.appendFileSync(current, data);
    fs.unlinkSync(legacy); // consumed → idempotent
    return { migrated };
  } catch { return { migrated: 0 }; }
}

// Exact paths mutated by the legacy migration. The transactional installer uses
// this inventory to snapshot the old footprint before migration starts.
function legacyArtifacts() {
  const directories = [
    path.join(P.codexHome(), LEGACY_INSTALL_DIRNAME),
    path.join(P.codexHome(), LEGACY_STATE_DIRNAME),
  ];
  const skillsDir = P.codexSkillsDir();
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      if (name.startsWith(LEGACY_SKILL_PREFIX)) directories.push(path.join(skillsDir, name));
    }
  }
  return {
    directories,
    files: [path.join(P.codexHome(), 'logs', 'codexmd.jsonl'), P.logPath()],
  };
}

module.exports = { removeLegacyCodexmd, migrateLegacyTelemetry, legacyArtifacts, isLegacyCommand, LEGACY_BEGIN, LEGACY_END };
