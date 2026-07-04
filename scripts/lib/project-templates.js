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

const FE_FRAMEWORK_RULES = {
  React: [
    'One component per file; PascalCase filenames matching the component.',
    'Custom hooks start with `use` and obey the rules of hooks.',
    'Give every list item a stable, unique `key` — never the array index.',
  ],
  Vue: [
    'One SFC per component; prefer `<script setup>`.',
    'Type `props` and `emits`; avoid untyped passthrough.',
  ],
  Svelte: ['One component per `.svelte` file; keep logic in `<script>`, markup declarative.'],
  Angular: ['One class per file; follow style-guide suffixes (`.component.ts`, `.service.ts`).'],
  Solid: ["Don't destructure props (breaks reactivity); read via `props.x`."],
  Preact: ['Give list items stable keys; use `preact/compat` only when a library needs React.'],
  Astro: ['Prefer `.astro` components for static content; add a framework integration only where you need client-side interactivity.'],
};
const FE_UILIB_RULES = {
  Tailwind: ['Prefer utility classes; reserve custom CSS for what utilities cannot express.'],
  'styled-components': ['Colocate styles with the component; theme via provider, no hardcoded colors.'],
  Emotion: ['Colocate styles with the component; theme via provider, no hardcoded colors.'],
  MUI: ['Theme via `ThemeProvider`; use theme tokens, not ad-hoc color literals.'],
  Chakra: ['Style via props/theme tokens; extend the theme rather than hardcoding hex.'],
};

// Render the ## Frontend managed-block CONTENT from a detection's `frontend` object.
// Deterministic facts (stack line) + a short curated per-stack guideline list
// (agentsmd-owned, regenerated each run). Returns '' when there is no frontend.
function renderFrontendSection(frontend) {
  if (!frontend) return '';
  const { framework, metaFramework, uiLibs = [], cssStrategy, typescript } = frontend;
  const head = metaFramework && metaFramework !== framework ? `${framework} (${metaFramework})` : framework;
  const stack = [head];
  if (typescript) stack.push('TypeScript');
  if (uiLibs.length) stack.push(`UI: ${uiLibs.join(', ')}`);
  if (cssStrategy && cssStrategy !== 'plain') stack.push(`CSS: ${cssStrategy}`);

  const L = ['## Frontend', '', `- Stack: ${stack.join(' · ')}`, ''];
  L.push('Stack guidelines (agentsmd-owned; edit outside the managed block to customize):');
  if (typescript) L.push('- Type everything — avoid `any`; prefer `unknown` + narrowing at boundaries.');
  for (const r of (FE_FRAMEWORK_RULES[framework] || [])) L.push(`- ${r}`);
  const seen = new Set();
  for (const lib of uiLibs) {
    for (const r of (FE_UILIB_RULES[lib] || [])) { if (!seen.has(r)) { seen.add(r); L.push(`- ${r}`); } }
  }
  if (framework === 'React' && cssStrategy && cssStrategy !== 'plain' && !uiLibs.includes('Tailwind')) {
    L.push('- Avoid inline `style={{}}` when a styling system is in use.');
  }
  return L.join('\n');
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
