'use strict';
// agents-md.js — inject / remove codexmd's spec as a sentinel-delimited managed
// block inside ~/.codex/AGENTS.md. Everything OUTSIDE the sentinels (OMX's
// orchestration brain, the user's own instructions, other tenants) is preserved
// byte-for-byte. Absent file → a new file with only our block. Uninstall removes
// exactly the block (ARCHITECTURE.md §5).

const BEGIN = '# >>> codexmd >>>';
const END = '# <<< codexmd <<<';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BLOCK_RE = new RegExp(`\\n*${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n*`);

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

// Returns { content, changed }.
function removeSpecBlock(input) {
  const content = typeof input === 'string' ? input : '';
  if (!BLOCK_RE.test(content)) return { content, changed: false };
  const next = content.replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { content: next, changed: true };
}

function hasSpecBlock(input) { return BLOCK_RE.test(typeof input === 'string' ? input : ''); }

module.exports = { BEGIN, END, injectSpecBlock, removeSpecBlock, hasSpecBlock };
