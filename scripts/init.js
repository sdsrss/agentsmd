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

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
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

function ensureGitignore(root, line) {
  const p = path.join(root, '.gitignore');
  const cur = readOrNull(p) || '';
  if (cur.split('\n').some((l) => l.trim() === line)) return false;
  fs.writeFileSync(p, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
  return true;
}

function writeLocal(root) {
  const localPath = path.join(root, 'AGENTS.local.md');
  let created = false;
  if (!fs.existsSync(localPath)) { fs.writeFileSync(localPath, LOCAL_SKELETON); created = true; }
  const gitignore = ensureGitignore(root, 'AGENTS.local.md');
  return { path: localPath, created, gitignore };
}

function init({ projectRoot, check = false, dryRun = false, local = false, noFrontend = false } = {}) {
  const root = projectRoot || process.cwd();
  const target = path.join(root, 'AGENTS.md');
  const detection = detect(root);
  const includeFrontend = !!detection.frontend && !noFrontend;
  const blockContent = renderProjectAgentsMd(detection, { includeFrontend });
  const existing = readOrNull(target);
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
  fs.writeFileSync(target, content);
  const result = { action: updated ? 'updated' : 'created', target, detection, frontendIncluded: includeFrontend, frontendFirstAdded };
  if (local) result.local = writeLocal(root);
  return result;
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
  return opts;
}

const USAGE = 'Usage: agentsmd-init [--check] [--dry-run] [--local] [--no-frontend]';

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd init: ${parsed.error}`); console.error(USAGE); process.exit(1); }
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
