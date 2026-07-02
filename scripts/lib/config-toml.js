'use strict';
// config-toml.js — ensure `[features] codex_hooks = true` in ~/.codex/config.toml
// without disturbing any other content. Text-targeted (not a full TOML rewrite)
// so every unrelated key/comment/table is preserved byte-for-byte. Per §5,
// uninstall LEAVES the flag (removing it could break OMX or the user's own
// hooks) — so only an idempotent `ensure` is provided.

// Returns { content, changed, reason }.
function ensureCodexHooksFlag(input) {
  const content = typeof input === 'string' ? input : '';

  // Already enabled (top-level or under any table) → no-op.
  if (/^[ \t]*codex_hooks[ \t]*=[ \t]*true[ \t]*$/m.test(content)) {
    return { content, changed: false, reason: 'already-enabled' };
  }
  // Explicitly disabled → flip to true in place.
  if (/^[ \t]*codex_hooks[ \t]*=[ \t]*false[ \t]*$/m.test(content)) {
    return {
      content: content.replace(/^([ \t]*codex_hooks[ \t]*=[ \t]*)false([ \t]*)$/m, '$1true$2'),
      changed: true, reason: 'flipped-false-to-true',
    };
  }
  // A [features] table exists → insert the key right after its header.
  if (/^[ \t]*\[features\][ \t]*$/m.test(content)) {
    return {
      content: content.replace(/^([ \t]*\[features\][ \t]*)$/m, '$1\ncodex_hooks = true'),
      changed: true, reason: 'inserted-under-features',
    };
  }
  // No [features] table → append one at the end (valid anywhere in TOML).
  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return {
    content: `${content}${sep}[features]\ncodex_hooks = true\n`,
    changed: true, reason: 'appended-features-table',
  };
}

module.exports = { ensureCodexHooksFlag };
