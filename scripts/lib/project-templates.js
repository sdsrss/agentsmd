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
  // R4-05: every manifest-verified ecosystem is a fact worth stating; the primary
  // line above stays for single-stack repos, the Stacks line appears when there
  // are several.
  const stacks = Array.isArray(d.stacks) ? d.stacks : [];
  if (stacks.length > 1) {
    L.push(`- Stacks: ${stacks.map((s) => (s.runtime && s.runtime !== s.language ? `${s.language} (${s.runtime})` : s.language)).join(' · ')}`);
  }
  if (d.packageManager && d.packageManager !== 'Unknown') L.push(`- Package manager: \`${d.packageManager}\``);
  L.push('');

  if (d.structure && d.structure.length) {
    L.push('## Structure', '');
    for (const dir of d.structure) L.push(`- \`${dir}/\``);
    L.push('');
  }

  // Commands come from each stack's own manifest facts. Multi-stack repos label
  // every line with its runtime so `pytest  # test` can't read as the Node test.
  const cmdStacks = stacks.length ? stacks : [d];
  const cmdLines = [];
  for (const s of cmdStacks) {
    for (const [k, v] of Object.entries(s.commands || {}).filter(([, v]) => v)) {
      cmdLines.push(`${v}  # ${k}${cmdStacks.length > 1 ? ` (${s.runtime || s.language})` : ''}`);
    }
  }
  if (cmdLines.length) {
    L.push('## Commands', '', '```bash');
    L.push(...cmdLines);
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
