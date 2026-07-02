'use strict';
// agents-md.js — inject / remove agentsmd's spec as a sentinel-delimited managed
// block inside ~/.codex/AGENTS.md. Everything OUTSIDE the sentinels (OMX's
// orchestration brain, the user's own instructions, other tenants) is preserved
// byte-for-byte. Absent file → a new file with only our block. Uninstall removes
// exactly the block (ARCHITECTURE.md §5).

const BEGIN = '# >>> agentsmd >>>';
const END = '# <<< agentsmd <<<';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = (begin, end) => new RegExp(`\\n*${esc(begin)}[\\s\\S]*?${esc(end)}\\n*`);
const BLOCK_RE = blockRe(BEGIN, END);

// Returns { content, changed, updated }.
function injectSpecBlock(input, specText) {
  const content = typeof input === 'string' ? input : '';
  const block = `${BEGIN}\n${String(specText).replace(/\s+$/, '')}\n${END}`;
  if (BLOCK_RE.test(content)) {
    // Replace existing block in place, keeping one blank line of separation.
    return { content: content.replace(BLOCK_RE, `\n\n${block}\n`).replace(/^\n+/, ''), changed: true, updated: true };
  }
  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return { content: `${content}${sep}${block}\n`, changed: true, updated: false };
}

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

module.exports = { BEGIN, END, injectSpecBlock, removeSpecBlock, removeBlockBetween, hasSpecBlock };
