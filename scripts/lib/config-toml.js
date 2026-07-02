'use strict';
// config-toml.js — ensure `[features] codex_hooks = true` in ~/.codex/config.toml
// without disturbing any other content. Text-targeted (not a full TOML rewrite)
// so every unrelated key/comment/table is preserved byte-for-byte. Per §5,
// uninstall LEAVES the flag (removing it could break OMX or the user's own
// hooks) — so only an idempotent `ensure` is provided.
//
// TOML-table-aware: Codex only honors `features.codex_hooks`. A `codex_hooks`
// key under some OTHER table (e.g. [experimental]) or a subtable ([features.x])
// does NOT count as enabled — otherwise the installer would no-op and no hook
// would ever run, a silent failure (reviewer I2).

// Scan the config for the state of the features.codex_hooks flag.
function scanFeatures(content) {
  const lines = content.split('\n');
  let cur = ''; // current table; '' = top-level document scope
  let enabled = false, disabledIdx = -1, hasFeatures = false, featuresHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (th) { cur = th[1].trim(); if (cur === 'features') { hasFeatures = true; if (featuresHeaderIdx < 0) featuresHeaderIdx = i; } continue; }
    const dotted = line.match(/^[ \t]*features\.codex_hooks[ \t]*=[ \t]*(true|false)\b/);
    if (dotted && cur === '') { if (dotted[1] === 'true') enabled = true; else if (disabledIdx < 0) disabledIdx = i; continue; }
    const bare = line.match(/^[ \t]*codex_hooks[ \t]*=[ \t]*(true|false)\b/);
    if (bare && cur === 'features') { if (bare[1] === 'true') enabled = true; else if (disabledIdx < 0) disabledIdx = i; }
  }
  return { enabled, disabledIdx, hasFeatures, featuresHeaderIdx, lines };
}

// True only when features.codex_hooks is true (features table or dotted form).
function isCodexHooksEnabled(input) {
  return scanFeatures(typeof input === 'string' ? input : '').enabled;
}

// Returns { content, changed, reason }.
function ensureCodexHooksFlag(input) {
  const content = typeof input === 'string' ? input : '';
  const s = scanFeatures(content);

  if (s.enabled) return { content, changed: false, reason: 'already-enabled' };

  // A features-scoped codex_hooks=false → flip it in place (avoids a duplicate key).
  if (s.disabledIdx >= 0) {
    const lines = s.lines.slice();
    lines[s.disabledIdx] = lines[s.disabledIdx].replace(/(codex_hooks[ \t]*=[ \t]*)false/, '$1true');
    return { content: lines.join('\n'), changed: true, reason: 'flipped-false-to-true' };
  }

  // A [features] table exists but lacks the key → insert right after its header.
  if (s.hasFeatures) {
    const lines = s.lines.slice();
    lines.splice(s.featuresHeaderIdx + 1, 0, 'codex_hooks = true');
    return { content: lines.join('\n'), changed: true, reason: 'inserted-under-features' };
  }

  // No [features] table → append one at the end (valid anywhere in TOML).
  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return { content: `${content}${sep}[features]\ncodex_hooks = true\n`, changed: true, reason: 'appended-features-table' };
}

module.exports = { ensureCodexHooksFlag, isCodexHooksEnabled };
