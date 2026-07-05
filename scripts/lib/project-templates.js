'use strict';
// project-templates.js — render the project-level AGENTS.md managed-block CONTENT
// from a detection result. Emits FACTS about this repo (stack / structure /
// commands / a conventions placeholder) — NOT global discipline, which the
// installed ~/.codex/AGENTS.md already owns. Kept lean: the block joins Codex's
// AGENTS.md discovery chain, which truncates past ~32 KiB.

function renderProjectAgentsMd(d, opts = {}) {
  const includeFrontend = opts.includeFrontend !== false;
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

  if (includeFrontend && d.frontend) {
    const fe = renderFrontendSection(d.frontend);
    if (fe) L.push(fe, '');
  }

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Render the ## Frontend managed-block CONTENT from a detection's `frontend`
// object: deterministic STACK FACTS only (framework / meta-framework / UI libs /
// CSS strategy / TS). No generic per-stack best-practice bullets — those are
// model-known boilerplate that taxes every turn's context (discovery-chain
// budget, OPERATOR.md §O3) without being specific to THIS project. A project
// that wants stack reminders adds them by hand OUTSIDE the managed block.
// Returns '' when there is no frontend.
function renderFrontendSection(frontend) {
  if (!frontend) return '';
  const { framework, metaFramework, uiLibs = [], cssStrategy, typescript } = frontend;
  const head = metaFramework && metaFramework !== framework ? `${framework} (${metaFramework})` : framework;
  const stack = [head];
  if (typescript) stack.push('TypeScript');
  if (uiLibs.length) stack.push(`UI: ${uiLibs.join(', ')}`);
  if (cssStrategy && cssStrategy !== 'plain') stack.push(`CSS: ${cssStrategy}`);
  return ['## Frontend', '', `- Stack: ${stack.join(' · ')}`].join('\n');
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

module.exports = { renderProjectAgentsMd, renderConventionsSeed, renderFrontendSection };
