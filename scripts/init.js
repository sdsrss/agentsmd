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
const { renderProjectAgentsMd } = require('./lib/project-templates');
const AM = require('./lib/agents-md');

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function init({ projectRoot, check = false, dryRun = false } = {}) {
  const root = projectRoot || process.cwd();
  const target = path.join(root, 'AGENTS.md');
  const detection = detect(root);
  const blockContent = renderProjectAgentsMd(detection);
  const existing = readOrNull(target);
  const { content, updated } = AM.injectBlockBetween(existing, blockContent, AM.PROJECT_BEGIN, AM.PROJECT_END);

  if (check) return { action: 'check', target, detection, inSync: existing !== null && existing === content };
  if (dryRun) return { action: 'dry-run', target, detection, content };
  fs.writeFileSync(target, content);
  return { action: updated ? 'updated' : 'created', target, detection };
}

function parseArgs(argv) {
  const opts = { check: false, dryRun: false };
  for (const a of argv) {
    if (a === '--check') opts.check = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else return { error: `unknown option: ${a}` };
  }
  return opts;
}

const USAGE = 'Usage: agentsmd-init [--check] [--dry-run]';

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd init: ${parsed.error}`); console.error(USAGE); process.exit(1); }
  const r = init({ projectRoot: process.cwd(), check: parsed.check, dryRun: parsed.dryRun });
  if (r.action === 'check') {
    console.log(r.inSync ? `in sync: ${r.target}` : `drift: ${r.target} — run agentsmd-init to regenerate`);
    process.exit(r.inSync ? 0 : 1);
  }
  if (r.action === 'dry-run') { console.log(r.content); process.exit(0); }
  console.log(`${r.action}: ${r.target} (${r.detection.language}, ${r.detection.packageManager})`);
  process.exit(0);
}

module.exports = { init, parseArgs };
