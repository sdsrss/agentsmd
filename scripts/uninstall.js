'use strict';
// uninstall.js — remove codexmd from ~/.codex, touching ONLY codexmd's own
// footprint. OMX (or any other tenant) entries in hooks.json / AGENTS.md are
// left byte-for-byte. Per §5 the config.toml hooks flag is LEFT enabled
// (removing it could break OMX's or the user's own hooks).

const fs = require('fs');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function uninstall() {
  const result = { hooksRemoved: 0, hooksJsonDeleted: false, agentsBlockRemoved: false, flagLeftEnabled: true };

  // 1. hooks.json — strip codexmd entries, preserve others; delete file only if
  //    nothing else remains.
  const beforeHooks = readOrNull(P.hooksJsonPath());
  if (beforeHooks !== null) {
    const r = H.removeCodexmdHooks(beforeHooks);
    result.hooksRemoved = r.removed;
    if (r.removed > 0) {
      if (r.nextContent === null) { try { fs.unlinkSync(P.hooksJsonPath()); result.hooksJsonDeleted = true; } catch {} }
      else { fs.writeFileSync(P.hooksJsonPath(), r.nextContent); }
    }
  }

  // 2. AGENTS.md — remove the sentinel block, preserve surrounding content;
  //    delete the file only if it was ours-only (now empty).
  const beforeAgents = readOrNull(P.agentsMdPath());
  if (beforeAgents !== null) {
    const am = AM.removeSpecBlock(beforeAgents);
    if (am.changed) {
      result.agentsBlockRemoved = true;
      if (am.content.trim() === '') { try { fs.unlinkSync(P.agentsMdPath()); } catch {} }
      else fs.writeFileSync(P.agentsMdPath(), am.content);
    }
  }

  // 3. config.toml hooks flag: intentionally LEFT (see header).

  // 3b. Remove ONLY codexmd-* skill dirs from the shared Codex skills dir;
  //     every other tenant's skill is left untouched.
  result.skillsRemoved = 0;
  try {
    const sdir = P.codexSkillsDir();
    if (fs.existsSync(sdir)) {
      for (const name of fs.readdirSync(sdir)) {
        if (name.startsWith('codexmd-')) { fs.rmSync(require('path').join(sdir, name), { recursive: true, force: true }); result.skillsRemoved++; }
      }
    }
  } catch {}

  // 4. Remove the self-contained install dir + codexmd state.
  try { fs.rmSync(P.installDir(), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(P.stateDir(), { recursive: true, force: true }); } catch {}
  return result;
}

if (require.main === module) {
  try { console.log('codexmd uninstalled:\n' + JSON.stringify(uninstall(), null, 2)); }
  catch (e) { console.error('codexmd uninstall failed:', e.message); process.exit(1); }
}
module.exports = { uninstall };
