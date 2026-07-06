'use strict';
// uninstall.js — remove agentsmd from ~/.codex, touching ONLY agentsmd's own
// footprint. OMX (or any other tenant) entries in hooks.json / AGENTS.md are
// left byte-for-byte. Per §5 the config.toml hooks flag is LEFT enabled
// (removing it could break OMX's or the user's own hooks).

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const M = require('./lib/migrate');
const B = require('./lib/backup');
const R = require('./lib/hook-registry');

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// Shim names come from the single-source hook registry (hook-registry.test.js pins
// it against BOTH wirings), not a hardcoded copy. The former fallback list could
// silently miss a newly-added hook, and its dynamic hooks.json read was dead in the
// installed self-uninstall path anyway (installDir — where repoRoot resolves — is
// removed before the shims are written), so the stale copy was authoritative.
function hookShimNames() { return [...R.HOOK_BASENAMES].sort(); }

function writeUninstalledHookShims() {
  const hooksDir = P.installHooksDir();
  fs.mkdirSync(hooksDir, { recursive: true });
  const body = [
    '#!/usr/bin/env bash',
    '# agentsmd uninstalled compatibility shim.',
    '# A Codex session may cache hook commands until restart; exit 0 so stale',
    '# commands do not fail with bash exit 127 after agentsmd uninstall.',
    'exit 0',
    '',
  ].join('\n');
  let written = 0;
  for (const name of hookShimNames()) {
    const p = path.join(hooksDir, name);
    fs.writeFileSync(p, body);
    try { fs.chmodSync(p, 0o755); } catch {}
    written++;
  }
  fs.writeFileSync(path.join(P.installDir(), '.uninstalled-shims'), `${new Date().toISOString()}\n`);
  return written;
}

function uninstall() {
  // 0. Pre-flight abort on an unparseable shared hooks.json (mirror of install's
  //    step-0). It may hold other tenants' hooks we can't see; removeMarkedHooks
  //    would silently no-op on it and ORPHAN agentsmd's own entries while claiming
  //    success. Fail loudly so the user fixes it and gets a clean, full uninstall,
  //    rather than a half-done one that reports done. Nothing has been touched yet.
  const beforeHooks = readOrNull(P.hooksJsonPath());
  if (beforeHooks !== null && beforeHooks.trim() !== '' && !H.parseHooksConfig(beforeHooks)) {
    throw new Error(`${P.hooksJsonPath()} exists but is not valid JSON — agentsmd will not edit it blind (it may hold other tenants' hooks). Fix or remove it, then re-run uninstall.`);
  }

  const result = { hooksRemoved: 0, hooksJsonDeleted: false, agentsBlockRemoved: false, extendedMdRemoved: false, flagLeftEnabled: true };

  // 0a. Best-effort pre-mutation backup of the shared files (mirror of install
  //     step 0a) so a logically-wrong removal is recoverable via `agentsmd restore`
  //     and a crash mid-uninstall leaves the snapshot behind (the state dir — where
  //     backups live — is only deleted on successful completion below). Never blocks
  //     the uninstall: a backup failure must not stop the user removing agentsmd.
  try { B.createBackup(new Date().toISOString()); B.pruneBackups(); } catch {}

  // 1. hooks.json — strip agentsmd entries, preserve others; delete file only if
  //    nothing else remains.
  if (beforeHooks !== null) {
    const r = H.removeAgentsmdHooks(beforeHooks);
    result.hooksRemoved = r.removed;
    if (r.removed > 0) {
      if (r.nextContent === null) { try { fs.unlinkSync(P.hooksJsonPath()); result.hooksJsonDeleted = true; } catch {} }
      else { B.writeFileAtomic(P.hooksJsonPath(), r.nextContent); } // atomic: torn write corrupts co-tenants (OMX)
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
      else B.writeFileAtomic(P.agentsMdPath(), am.content); // atomic: AGENTS.md holds OMX/user content too
    }
  }

  // 2b. AGENTS-extended.md — agentsmd's own standalone file (not shared, not in
  //     the discovery chain). Remove it only when it is ours (carries the
  //     CODEX-CODING-SPEC header); a foreign same-named file is left byte-for-byte.
  const beforeExtended = readOrNull(P.agentsExtendedMdPath());
  if (beforeExtended !== null && beforeExtended.includes('CODEX-CODING-SPEC')) {
    try { fs.unlinkSync(P.agentsExtendedMdPath()); result.extendedMdRemoved = true; } catch {}
  }

  // 3. config.toml hooks flag: intentionally LEFT (see header).

  // 3b. Remove ONLY agentsmd-* skill dirs from the shared Codex skills dir;
  //     every other tenant's skill is left untouched.
  result.skillsRemoved = 0;
  try {
    const sdir = P.codexSkillsDir();
    if (fs.existsSync(sdir)) {
      for (const name of fs.readdirSync(sdir)) {
        if (name.startsWith('agentsmd-')) { fs.rmSync(require('path').join(sdir, name), { recursive: true, force: true }); result.skillsRemoved++; }
      }
    }
  } catch {}

  // 4. Remove the self-contained install dir + agentsmd state. Then leave tiny
  //    no-op hook shims at the old command paths: Codex may keep the current
  //    session's hook command list cached until restart, and `bash "missing.sh"`
  //    exits 127. The shims are not registered and no manifest remains, so
  //    agentsmd is still uninstalled; they only keep stale in-memory commands
  //    quiet until the session refreshes.
  try { fs.rmSync(P.installDir(), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(P.stateDir(), { recursive: true, force: true }); } catch {}
  result.compatibilityShimsWritten = writeUninstalledHookShims();

  // 5. Belt-and-suspenders: sweep any leftover pre-rename codexmd footprint too,
  //    so a clean uninstall leaves no trace of either name (marker-scoped).
  result.legacyCodexmdRemoved = M.removeLegacyCodexmd();
  return result;
}

if (require.main === module) {
  try { console.log('agentsmd uninstalled:\n' + JSON.stringify(uninstall(), null, 2)); }
  catch (e) { console.error('agentsmd uninstall failed:', e.message); process.exit(1); }
}
module.exports = { uninstall };
