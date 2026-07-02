'use strict';
// migrate.js — one-time migration of a prior **codexmd** install (agentsmd's
// former name, published as v1.4.0–v1.4.3) to agentsmd. Anyone who installed
// codexmd carries a `/codexmd/` hook marker in ~/.codex/hooks.json, a
// `# >>> codexmd >>>` block in AGENTS.md, `codexmd-*` skills, and
// ~/.codex/{codexmd, .codexmd-state}. This removes exactly those — by the SAME
// marker-scoped discipline agentsmd uses for itself (ARCHITECTURE.md §5): never
// touch OMX or any other tenant. Idempotent + a no-op when no codexmd is present.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const H = require('./codex-hooks');
const AM = require('./agents-md');

// The former identity. Kept HERE — the only place agentsmd still names the old
// project — so the rest of the codebase stays free of it.
const LEGACY_BEGIN = '# >>> codexmd >>>';
const LEGACY_END = '# <<< codexmd <<<';
const LEGACY_SKILL_PREFIX = 'codexmd-';
const LEGACY_INSTALL_DIRNAME = 'codexmd';
const LEGACY_STATE_DIRNAME = '.codexmd-state';

// A command hook belongs to the legacy codexmd install iff its path carries a
// `/codexmd/` segment (the old marker; mirrors isAgentsmdCommand for the new one).
const isLegacyCommand = (command) =>
  typeof command === 'string' && /[\\/]codexmd[\\/]/.test(command);

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const rmrf = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); return true; } } catch {} return false; };

// Remove any prior codexmd footprint from the active Codex home ($CODEX_HOME).
// Returns a report; `detected` is true iff something was actually removed.
function removeLegacyCodexmd() {
  const report = {
    detected: false, hooksRemoved: 0, agentsBlockRemoved: false,
    skillsRemoved: 0, installDirRemoved: false, stateDirRemoved: false,
  };

  // 1. hooks.json — strip only `/codexmd/`-marked entries; preserve all others
  //    (OMX, the user's own, any tenant) exactly as agentsmd's own remove does.
  const hooksPath = P.hooksJsonPath();
  const hooksContent = readOrNull(hooksPath);
  if (hooksContent !== null) {
    const r = H.removeMarkedHooks(hooksContent, isLegacyCommand);
    if (r.removed > 0) {
      report.hooksRemoved = r.removed; report.detected = true;
      if (r.nextContent === null) { try { fs.unlinkSync(hooksPath); } catch {} }
      else fs.writeFileSync(hooksPath, r.nextContent);
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
      else fs.writeFileSync(amPath, r.content);
    }
  }

  // 3. skills — remove only codexmd-* dirs; every other tenant's skill is kept.
  const sdir = P.codexSkillsDir();
  if (fs.existsSync(sdir)) {
    for (const name of fs.readdirSync(sdir)) {
      if (name.startsWith(LEGACY_SKILL_PREFIX) && rmrf(path.join(sdir, name))) {
        report.skillsRemoved++; report.detected = true;
      }
    }
  }

  // 4. the self-contained install dir + state dir under the Codex home.
  if (rmrf(path.join(P.codexHome(), LEGACY_INSTALL_DIRNAME))) { report.installDirRemoved = true; report.detected = true; }
  if (rmrf(path.join(P.codexHome(), LEGACY_STATE_DIRNAME))) { report.stateDirRemoved = true; report.detected = true; }

  return report;
}

module.exports = { removeLegacyCodexmd, isLegacyCommand, LEGACY_BEGIN, LEGACY_END };
