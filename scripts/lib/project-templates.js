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

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The conventions block is agent-owned (filled by `agentsmd-analyze`), so it is a
// SEPARATE managed block, not part of the deterministic facts above. init seeds
// this once; analyze refills it. Hand-edits belong OUTSIDE the managed block.
function renderConventionsSeed() {
  return [
    '## Conventions',
    '',
    "> Distilled from this project's source by the `agentsmd-analyze` skill.",
    '> Run it to fill this block. Hand-edits belong OUTSIDE the managed block (they are preserved; this block is regenerated).',
  ].join('\n');
}

module.exports = { renderProjectAgentsMd, renderConventionsSeed };
