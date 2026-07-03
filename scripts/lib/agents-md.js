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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = (begin, end) => new RegExp(`\\n*${esc(begin)}[\\s\\S]*?${esc(end)}\\n*`);
const BLOCK_RE = blockRe(BEGIN, END);

// Returns { content, changed, updated }. Generic over the marker pair so the same
// in-place-replace / preserve-everything-outside logic serves both the global
// ~/.codex/AGENTS.md block and the project-scoped block written by init.js.
function injectBlockBetween(input, specText, begin, end) {
  const content = typeof input === 'string' ? input : '';
  const RE = blockRe(begin, end);
  const block = `${begin}\n${String(specText).replace(/\s+$/, '')}\n${end}`;
  if (RE.test(content)) {
    return { content: content.replace(RE, `\n\n${block}\n`).replace(/^\n+/, ''), changed: true, updated: true };
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
  const re = blockRe(begin, end);
  if (!re.test(content)) return { content, changed: false };
  const next = content.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { content: next, changed: true };
}
// Remove agentsmd's own block.
const removeSpecBlock = (input) => removeBlockBetween(input, BEGIN, END);

function hasSpecBlock(input) { return BLOCK_RE.test(typeof input === 'string' ? input : ''); }

function hasBlockBetween(input, begin, end) {
  return blockRe(begin, end).test(typeof input === 'string' ? input : '');
}

module.exports = { BEGIN, END, PROJECT_BEGIN, PROJECT_END, CONVENTIONS_BEGIN, CONVENTIONS_END, injectSpecBlock, injectBlockBetween, removeSpecBlock, removeBlockBetween, hasSpecBlock, hasBlockBetween };
