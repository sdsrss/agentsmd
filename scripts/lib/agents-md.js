'use strict';
// agents-md.js — inject / remove agentsmd's spec as a sentinel-delimited managed
// block inside ~/.codex/AGENTS.md. Everything OUTSIDE the sentinels (OMX's
// orchestration brain, the user's own instructions, other tenants) is preserved
// byte-for-byte. Absent file → a new file with only our block. Uninstall removes
// exactly the block (ARCHITECTURE.md §5).

const BEGIN = '# >>> agentsmd >>>';
const END = '# <<< agentsmd <<<';
const PROJECT_BEGIN = '# >>> agentsmd:project >>>';
const PROJECT_END = '# <<< agentsmd:project <<<';
const CONVENTIONS_BEGIN = '# >>> agentsmd:conventions >>>';
const CONVENTIONS_END = '# <<< agentsmd:conventions <<<';
// DESIGN.md managed block + the AGENTS.md pointer to it (D1). HTML-comment
// sentinels — invisible in rendered markdown, unlike the `# >>>` H1-style markers.
const DESIGN_BEGIN = '<!-- agentsmd:design BEGIN -->';
const DESIGN_END = '<!-- agentsmd:design END -->';
const DESIGN_POINTER_BEGIN = '<!-- agentsmd:design-pointer BEGIN -->';
const DESIGN_POINTER_END = '<!-- agentsmd:design-pointer END -->';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = (begin, end, flags = '') => new RegExp(`\\n*${esc(begin)}[\\s\\S]*?${esc(end)}\\n*`, flags);
const BLOCK_RE = blockRe(BEGIN, END);
// A shared AGENTS.md can end up with the SAME managed block twice (a hand-merged
// conflict, a restored backup pasted over a live file). A non-global replace
// updates the first and orphans the rest, so install would leave a stale copy and
// uninstall would leave a whole agentsmd spec block behind — breaking the
// exact-reversibility invariant. Both operations are global; inject keeps the
// first occurrence's position and drops the duplicates.
const countBlocks = (content, begin, end) => (String(content).match(blockRe(begin, end, 'g')) || []).length;

// Returns { content, changed, updated }. Generic over the marker pair so the same
// in-place-replace / preserve-everything-outside logic serves both the global
// ~/.codex/AGENTS.md block and the project-scoped block written by init.js.
function injectBlockBetween(input, specText, begin, end) {
  const content = typeof input === 'string' ? input : '';
  const block = `${begin}\n${String(specText).replace(/\s+$/, '')}\n${end}`;
  const present = countBlocks(content, begin, end);
  if (present > 0) {
    let seen = 0;
    let next = content.replace(blockRe(begin, end, 'g'), () => (seen++ === 0 ? `\n\n${block}\n` : '\n'));
    // Only collapse when duplicates were actually removed — the single-block path
    // must stay byte-identical to the pre-v4.19.2 output.
    if (present > 1) next = next.replace(/\n{3,}/g, '\n\n');
    return { content: next.replace(/^\n+/, ''), changed: true, updated: true, duplicatesRemoved: present - 1 };
  }
  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return { content: `${content}${sep}${block}\n`, changed: true, updated: false };
}

// agentsmd's global spec block — unchanged behavior, now via the generic core.
function injectSpecBlock(input, specText) { return injectBlockBetween(input, specText, BEGIN, END); }

// Remove a sentinel-delimited block by its begin/end markers; collapse the gap.
// Returns { content, changed }. Generic over the marker pair so the legacy
// migration can drop a former `# >>> codexmd >>>` block with the same logic.
function removeBlockBetween(input, begin, end) {
  const content = typeof input === 'string' ? input : '';
  const present = countBlocks(content, begin, end);
  if (present === 0) return { content, changed: false };
  const next = content.replace(blockRe(begin, end, 'g'), '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { content: next, changed: true, removed: present };
}
// Remove agentsmd's own block.
const removeSpecBlock = (input) => removeBlockBetween(input, BEGIN, END);

function hasSpecBlock(input) { return BLOCK_RE.test(typeof input === 'string' ? input : ''); }

function hasBlockBetween(input, begin, end) {
  return blockRe(begin, end).test(typeof input === 'string' ? input : '');
}

module.exports = { BEGIN, END, PROJECT_BEGIN, PROJECT_END, CONVENTIONS_BEGIN, CONVENTIONS_END, DESIGN_BEGIN, DESIGN_END, DESIGN_POINTER_BEGIN, DESIGN_POINTER_END, injectSpecBlock, injectBlockBetween, removeSpecBlock, removeBlockBetween, hasSpecBlock, hasBlockBetween, countBlocks };
