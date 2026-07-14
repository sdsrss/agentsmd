'use strict';
// design.js — `agentsmd design`: parse a frontend project's design tokens into a
// facts-only DESIGN.md (sentinel-managed block) + a one-line pointer in AGENTS.md.
// Deterministic (tokens are facts — no AI step, unlike analyze's conventions),
// command-only, consent-gated (default PREVIEWS; --write commits), stateless. D1 /
// the detect.js:6 "Phase 2" module. Reuses detect + the agents-md inject machinery.

const path = require('path');
const { detect } = require('./lib/detect');
const { parseDesignTokens } = require('./lib/design-tokens');
const AM = require('./lib/agents-md');
const F = require('./lib/fs-atomic');
const { ArgvError, printHelpAndExit, parseStrict } = require('./lib/argv');

const MAX_DESIGN_BLOCK_BYTES = 12 * 1024; // budget cap on the managed block (refuse, never truncate — like writeConventions)
const CATEGORY_TITLES = { color: 'Colors', spacing: 'Spacing', typography: 'Typography', radius: 'Radii', shadow: 'Shadows', 'z-index': 'Z-index', breakpoint: 'Breakpoints', other: 'Other' };
const POINTER_LINE = 'Design tokens: see [`DESIGN.md`](./DESIGN.md) (facts extracted by `agentsmd design`).';
const TRUNC_NOTE = '_(token scan hit its file/byte cap — some CSS was not read, so results may be incomplete.)_';

function designReport(root) {
  const base = root || process.cwd();
  const det = detect(base);
  const frontend = det.frontend; // null when not a frontend project
  return { root: base, projectName: det.projectName, frontend, tokens: frontend ? parseDesignTokens(base) : null };
}

// Facts-only managed-block content (the body BETWEEN the sentinels). No prescriptive
// advice — detected stack + token name:value grouped by category, and an honest note
// when nothing was found.
function renderDesignMd(report) {
  if (!report.frontend) return '# Design tokens\n\n_(not a frontend project — nothing to extract.)_'; // guard: writeDesign skips non-frontend at its call site, but keep the exported fn safe for direct callers
  const fe = report.frontend;
  const stack = [fe.framework, fe.metaFramework, ...(fe.uiLibs || [])].filter(Boolean).join(' + ') || 'frontend';
  const L = ['# Design tokens', ''];
  const srcNote = report.tokens.sources.length ? ` Source: ${report.tokens.sources.join(', ')}.` : '';
  L.push(`_Facts extracted by \`agentsmd design\`. Stack: ${stack}.${srcNote} Edits inside the markers are overwritten; re-run to refresh._`);
  L.push('');
  if (!report.tokens.count) {
    L.push("No `:root` custom properties or Tailwind `@theme` tokens were found in this project's CSS.");
    if ((fe.uiLibs || []).includes('Tailwind')) L.push('(Tailwind detected — a v3 `theme` lives in `tailwind.config.js`, which `agentsmd design` does not parse yet.)');
    if (report.tokens.truncated) L.push(TRUNC_NOTE); // honest even when the cap zeroed the count
    return L.join('\n');
  }
  for (const cat of report.tokens.categories) {
    L.push(`## ${CATEGORY_TITLES[cat] || cat}`);
    for (const t of report.tokens.tokens[cat]) L.push(renderTokenLine(t));
    L.push('');
  }
  if (report.tokens.truncated) L.push(TRUNC_NOTE);
  return L.join('\n').replace(/\s+$/, '');
}

// One facts-only line per token (R4-01): a determined value renders plainly; a
// themed token reports every selector context; a cross-file conflict reports the
// candidates with provenance and explicitly does NOT pick a winner (the walk order
// is not CSS import order).
function renderTokenLine(t) {
  const status = t.status || 'ok'; // hand-built reports without status are plain values
  if (status === 'contextual') {
    const parts = t.contexts.map((c) => `${c.value} (\`${c.selector}\`, ${c.source})`);
    return `- \`${t.name}\`: by context — ${parts.join(' · ')}`;
  }
  if (status === 'ambiguous') {
    const parts = t.definitions.map((d) => `${d.value} (${d.source}, \`${d.selector}\`)`);
    return `- \`${t.name}\`: ambiguous — ${parts.join(' vs ')}; effective value depends on import order, not guessed`;
  }
  return `- \`${t.name}\`: ${t.value}`;
}

// Preview (default) or commit. Returns a plan/result object; writes files only when
// commit === true. Refuses (never truncates) if the block exceeds the byte budget.
function writeDesign(root, { commit = false } = {}) {
  const base = root || process.cwd();
  const report = designReport(base);
  if (!report.frontend) return { action: 'skip', reason: 'not a frontend project', report };

  const body = renderDesignMd(report);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_DESIGN_BLOCK_BYTES)
    throw new Error(`DESIGN.md managed block ${bytes}B exceeds ${MAX_DESIGN_BLOCK_BYTES}B budget — too many tokens to inline; trim source CSS or raise the cap`);

  const designPath = path.join(base, 'DESIGN.md');
  const agentsPath = path.join(base, 'AGENTS.md');
  const designBefore = F.snapshotFile(designPath);
  const designExisting = designBefore.present ? designBefore.content.toString('utf8') : null;
  const design = AM.injectBlockBetween(designExisting, body, AM.DESIGN_BEGIN, AM.DESIGN_END);
  // Pointer only when AGENTS.md already exists — creating it is `agentsmd init`'s job.
  const agentsBefore = F.snapshotFile(agentsPath);
  const agentsExisting = agentsBefore.present ? agentsBefore.content.toString('utf8') : null;
  const pointer = agentsExisting !== null
    ? AM.injectBlockBetween(agentsExisting, POINTER_LINE, AM.DESIGN_POINTER_BEGIN, AM.DESIGN_POINTER_END)
    : null;

  const plan = {
    action: commit ? 'written' : 'preview',
    report, tokenCount: report.tokens.count, body,
    designPath, designUpdated: design.updated,
    agentsPath: pointer ? agentsPath : null, pointerAdded: !!pointer,
  };
  if (commit) {
    const designContent = design.content.endsWith('\n') ? design.content : design.content + '\n';
    let designAfter = null;
    try {
      F.writeFileAtomic(designPath, designContent, { expectedSnapshot: designBefore });
      designAfter = {
        present: true,
        content: Buffer.from(designContent),
        mode: designBefore.present ? designBefore.mode : 0o600,
      };
      if (pointer) F.writeFileAtomic(agentsPath, pointer.content, { expectedSnapshot: agentsBefore });
    } catch (error) {
      if (designAfter) {
        try {
          if (designBefore.present) {
            F.writeFileAtomic(designPath, designBefore.content, {
              expectedSnapshot: designAfter,
              mode: designBefore.mode,
              preserveMode: false,
            });
          } else {
            F.unlinkFileIfUnchanged(designPath, designAfter);
          }
        } catch (rollbackError) {
          const combined = new Error(`${error.message}; DESIGN.md rollback conflict: ${rollbackError.message}`);
          combined.cause = error;
          throw combined;
        }
      }
      throw error;
    }
  }
  return plan;
}

function formatPlan(plan) {
  if (plan.action === 'skip') return `agentsmd design: ${plan.reason} — nothing to do.`;
  const wrote = plan.action === 'written';
  const L = [`${wrote ? 'Wrote' : 'Would write'} ${plan.tokenCount} design token(s) -> ${plan.designPath}${plan.designUpdated ? ' (updated block)' : ''}`];
  if (plan.pointerAdded) L.push(`${wrote ? 'Added' : 'Would add'} a pointer block -> ${plan.agentsPath}`);
  else L.push(`(no AGENTS.md found — run \`agentsmd init\` first for the pointer; DESIGN.md still ${wrote ? 'written' : 'previewed'})`);
  if (!wrote) { L.push('', '--- DESIGN.md managed block preview ---', plan.body, '--- end preview (re-run with --write to commit) ---'); }
  return L.join('\n');
}

if (require.main === module) {
  const usage = 'Usage: agentsmd-design [--write]   (default: preview — writes nothing)';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try { opts = parseStrict(argv, { bools: ['write'] }); }
  catch (e) {
    if (e instanceof ArgvError) { console.error(`agentsmd design: ${e.message}\n${usage}`); process.exit(2); }
    throw e;
  }
  try {
    console.log(formatPlan(writeDesign(process.cwd(), { commit: opts.bools.has('write') })));
  } catch (e) { console.error(`agentsmd design: ${e.message}`); process.exit(1); }
}
module.exports = { designReport, renderDesignMd, renderTokenLine, writeDesign, formatPlan, POINTER_LINE, MAX_DESIGN_BLOCK_BYTES };
