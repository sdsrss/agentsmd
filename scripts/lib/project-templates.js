'use strict';
// project-templates.js — render the project-level AGENTS.md managed-block CONTENT
// from a detection result. Emits FACTS about this repo (stack / structure /
// commands / a conventions placeholder) — NOT global discipline, which the
// installed ~/.codex/AGENTS.md already owns. Kept lean: the block joins Codex's
// AGENTS.md discovery chain, which truncates past ~32 KiB.

function renderProjectAgentsMd(d) {
  const L = [];
  L.push('## Project', '');
  const runtime = d.runtime && d.runtime !== d.language ? ` (${d.runtime})` : '';
  L.push(`- ${d.projectName} — ${d.language}${runtime} project${d.monorepo ? ', monorepo' : ''}`);
  if (d.packageManager && d.packageManager !== 'Unknown') L.push(`- Package manager: \`${d.packageManager}\``);
  L.push('');

  if (d.structure && d.structure.length) {
    L.push('## Structure', '');
    for (const dir of d.structure) L.push(`- \`${dir}/\``);
    L.push('');
  }

  const cmds = Object.entries(d.commands || {}).filter(([, v]) => v);
  if (cmds.length) {
    L.push('## Commands', '', '```bash');
    for (const [k, v] of cmds) L.push(`${v}  # ${k}`);
    L.push('```', '');
  }

  L.push('## Conventions', '');
  L.push('> Document this project\'s conventions here (naming, imports, error handling, request/API encapsulation).');
  L.push('> A future `agentsmd-analyze` pass (Phase 2) will automate distilling these from the source.');

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { renderProjectAgentsMd };
