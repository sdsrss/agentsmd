'use strict';
// init.js — generate a project-level AGENTS.md for the repo at process.cwd().
// Two-layer model: the installed ~/.codex/AGENTS.md carries the universal HOW
// (discipline); this writes the project's WHAT (stack / structure / commands) as
// a sentinel-delimited managed block, so re-running updates the block in place
// and preserves everything the user wrote outside it. Deterministic, no AI — the
// optional AI convention-distillation is the separate `agentsmd-analyze` skill.

const fs = require('fs');
const path = require('path');
const { detect } = require('./lib/detect');
const { renderProjectAgentsMd, renderConventionsSeed } = require('./lib/project-templates');
const AM = require('./lib/agents-md');
const P = require('./lib/paths');
const CT = require('./lib/config-toml');
const F = require('./lib/fs-atomic');

// Warn (never fail) when the project AGENTS.md + global ~/.codex/AGENTS.md exceed
// Codex's project_doc_max_bytes — the discovery chain silently truncates past the
// cap. Fail-open on an unreadable global spec / config.
function warnChainBudget(projectAgentsMdPath) {
  try {
    let cfg = ''; try { cfg = fs.readFileSync(P.configTomlPath(), 'utf8'); } catch {}
    const globalB = Buffer.byteLength(fs.readFileSync(P.agentsMdPath(), 'utf8'), 'utf8');
    const projB = Buffer.byteLength(fs.readFileSync(projectAgentsMdPath, 'utf8'), 'utf8');
    const b = CT.chainBudget(cfg, globalB, projB);
    if (b.over > 0) {
      console.error(`agentsmd: global + project AGENTS.md = ${b.total}B exceeds project_doc_max_bytes (${b.cap}B) by ${b.over}B — Codex SILENTLY truncates the discovery chain. Trim the project doc or raise the cap in ~/.codex/config.toml.`);
    }
  } catch { /* global spec / config unreadable → skip */ }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LOCAL_SKELETON = [
  '# AGENTS.local.md — personal, git-ignored, AI-read',
  '',
  '> Not committed. Codex reads it ONLY if you add `AGENTS.local.md` to',
  '> `project_doc_fallback_filenames` in ~/.codex/config.toml.',
  '',
  '## Personal preferences', '',
  '- AUTONOMY_LEVEL: ', '- Notes: ', '',
].join('\n');

function ensureGitignore(gitignorePath, line, before, commit) {
  const cur = before.present ? before.content.toString('utf8') : '';
  if (cur.split('\n').some((l) => l.trim() === line)) return false;
  F.writeFileAtomic(gitignorePath, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n', { expectedSnapshot: before });
  commit(gitignorePath, before);
  return true;
}

function writeLocal(localPath, gitignorePath, localBefore, gitignoreBefore, commit) {
  let created = false;
  try {
    fs.writeFileSync(localPath, LOCAL_SKELETON, { flag: 'wx', mode: 0o600 });
    created = true;
    commit(localPath, localBefore);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const gitignore = ensureGitignore(gitignorePath, 'AGENTS.local.md', gitignoreBefore, commit);
  return { path: localPath, created, gitignore };
}

// All-or-nothing multi-file write. body() performs the writes and calls
// commit(file, preSnapshot) after each one that lands; any throw restores every
// committed file to its pre-run snapshot (reverse order) then rethrows the
// original error. A file absent pre-run is restored to absent. The write that
// throws left nothing to undo (writeFileAtomic renames or cleans up its tmp;
// the exclusive-create either creates or throws), so only committed writes roll
// back — a concurrent-change rejection on the first write clobbers nothing.
function transact(body) {
  const committed = [];
  try {
    return body((file, snapshot) => committed.push([file, snapshot]));
  } catch (error) {
    for (let i = committed.length - 1; i >= 0; i--) {
      try { F.restoreFile(committed[i][0], committed[i][1]); } catch { /* best-effort rollback */ }
    }
    throw error;
  }
}

function init({ projectRoot, check = false, dryRun = false, local = false, noFrontend = false } = {}) {
  const root = projectRoot || process.cwd();
  const target = path.join(root, 'AGENTS.md');
  const detection = detect(root);
  const includeFrontend = !!detection.frontend && !noFrontend;
  const blockContent = renderProjectAgentsMd(detection, { includeFrontend });
  const before = F.snapshotFile(target);
  const existing = before.present ? before.content.toString('utf8') : null;
  // Computed pre-injection so an upgrader (existing PROJECT block, no prior
  // Frontend section) is caught even though the run's action is 'updated'.
  const frontendFirstAdded = includeFrontend && !/##\s*Frontend/.test(existing || '');
  // Check on existing content to determine seeding, before modifying content.
  const hasExistingConventions = existing && AM.hasBlockBetween(existing, AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END);
  let { content, updated } = AM.injectBlockBetween(existing, blockContent, AM.PROJECT_BEGIN, AM.PROJECT_END);
  // Seed the agent-owned conventions block ONCE; never overwrite analyze's output.
  if (!hasExistingConventions) {
    content = AM.injectBlockBetween(content, renderConventionsSeed(), AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END).content;
    // Normalize spacing: remove one newline between blocks to match re-injection behavior.
    content = content.replace(
      new RegExp('(\\n' + esc(AM.PROJECT_END) + ')\\n\\n(' + esc(AM.CONVENTIONS_BEGIN) + ')'),
      '$1\n$2');
  }

  if (check) return { action: 'check', target, detection, inSync: existing !== null && existing === content };
  if (dryRun) return { action: 'dry-run', target, detection, content };

  // init writes up to three files (main AGENTS.md, plus AGENTS.local.md and
  // .gitignore in --local mode). Snapshot every file the run may touch BEFORE
  // any write so a failure at any point rolls the whole set back — otherwise a
  // torn multi-file command leaves AGENTS.md modified after a later step fails.
  const localPath = path.join(root, 'AGENTS.local.md');
  const gitignorePath = path.join(root, '.gitignore');
  const localBefore = local ? F.snapshotFile(localPath) : null;
  const gitignoreBefore = local ? F.snapshotFile(gitignorePath) : null;

  return transact((commit) => {
    F.writeFileAtomic(target, content, { expectedSnapshot: before });
    commit(target, before);
    const result = { action: updated ? 'updated' : 'created', target, detection, frontendIncluded: includeFrontend, frontendFirstAdded };
    if (local) result.local = writeLocal(localPath, gitignorePath, localBefore, gitignoreBefore, commit);
    return result;
  });
}

function parseArgs(argv) {
  const opts = { check: false, dryRun: false, local: false, noFrontend: false };
  for (const a of argv) {
    if (a === '--check') opts.check = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--no-frontend') opts.noFrontend = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else return { error: `unknown option: ${a}` };
  }
  const exclusiveModes = [opts.check, opts.dryRun, opts.local].filter(Boolean).length;
  if (exclusiveModes > 1) return { error: '--check, --dry-run, and --local cannot be combined' };
  return opts;
}

const USAGE = 'Usage: agentsmd-init [--check | --dry-run | --local] [--no-frontend]';

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd init: ${parsed.error}`); console.error(USAGE); process.exit(2); }
  const r = init({ projectRoot: process.cwd(), check: parsed.check, dryRun: parsed.dryRun, local: parsed.local, noFrontend: parsed.noFrontend });
  if (r.action === 'check') {
    console.log(r.inSync ? `in sync: ${r.target}` : `drift: ${r.target} — run agentsmd-init to regenerate`);
    process.exit(r.inSync ? 0 : 1);
  }
  if (r.action === 'dry-run') { console.log(r.content); process.exit(0); }
  console.log(`${r.action}: ${r.target} (${r.detection.language}, ${r.detection.packageManager})`);
  warnChainBudget(r.target);
  if (r.frontendFirstAdded) {
    const f = r.detection.frontend;
    const libs = f.uiLibs.length ? ' + ' + f.uiLibs.join(', ') : '';
    console.error(`agentsmd: detected frontend stack (${f.framework}${libs}) — added a ## Frontend section (disable with --no-frontend)`);
  }
  if (parsed.local) {
    const status = r.local.created
      ? 'AGENTS.local.md written (git-ignored).'
      : 'AGENTS.local.md already exists — preserved.';
    console.log(`${status} To let Codex read it, add to ~/.codex/config.toml:`);
    console.log('  project_doc_fallback_filenames = ["AGENTS.local.md"]');
  }
  process.exit(0);
}

module.exports = { init, parseArgs };
