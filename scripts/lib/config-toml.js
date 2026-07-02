'use strict';
// config-toml.js — ensure Codex's hook feature flag is enabled under [features]
// in ~/.codex/config.toml, without disturbing other content. Codex 0.142+ renamed
// the flag `codex_hooks` → `hooks` (`codex_hooks` is deprecated). This module
// recognizes BOTH names, prefers the canonical `hooks`, and migrates a deprecated
// `codex_hooks = true` to `hooks = true` on install. Text-targeted (not a full
// TOML rewrite) so every unrelated key/comment/table is byte-preserved. Per §5,
// uninstall LEAVES the flag (removing it could break OMX or the user's hooks).
//
// TOML-table-aware: only a flag under the [features] table (or dotted
// features.<flag>) counts — a stray `hooks`/`codex_hooks` under another table
// does not (else the installer would no-op and no hook would ever run).

// Scan [features] (+ dotted features.*) for the hook flag state.
function scanFeatures(content) {
  const lines = content.split('\n');
  let cur = ''; // current table; '' = top-level document scope
  let enabledNew = false, enabledOld = false;
  let oldTrueIdx = -1, falseIdx = -1, hasFeatures = false, featuresHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (th) { cur = th[1].trim(); if (cur === 'features') { hasFeatures = true; if (featuresHeaderIdx < 0) featuresHeaderIdx = i; } continue; }
    let m = cur === '' ? line.match(/^[ \t]*features\.(hooks|codex_hooks)[ \t]*=[ \t]*(true|false)\b/) : null;
    if (!m && cur === 'features') m = line.match(/^[ \t]*(hooks|codex_hooks)[ \t]*=[ \t]*(true|false)\b/);
    if (!m) continue;
    if (m[2] === 'true') {
      if (m[1] === 'hooks') enabledNew = true;
      else { enabledOld = true; if (oldTrueIdx < 0) oldTrueIdx = i; }
    } else if (falseIdx < 0) falseIdx = i;
  }
  return { enabledNew, enabledOld, enabled: enabledNew || enabledOld, oldTrueIdx, falseIdx, hasFeatures, featuresHeaderIdx, lines };
}

// True when the hook feature is enabled under [features] by EITHER name.
function isCodexHooksEnabled(input) {
  return scanFeatures(typeof input === 'string' ? input : '').enabled;
}

// Returns { content, changed, reason }. Prefers/sets the canonical `hooks`.
function ensureCodexHooksFlag(input) {
  const content = typeof input === 'string' ? input : '';
  const s = scanFeatures(content);

  if (s.enabledNew) return { content, changed: false, reason: 'already-enabled' };

  // Deprecated `codex_hooks = true` present → migrate it in place to `hooks`.
  if (s.enabledOld) {
    const lines = s.lines.slice();
    lines[s.oldTrueIdx] = lines[s.oldTrueIdx].replace(/\bcodex_hooks\b/, 'hooks');
    return { content: lines.join('\n'), changed: true, reason: 'migrated-codex_hooks-to-hooks' };
  }

  // A features-scoped `(codex_)hooks = false` → set the canonical `hooks = true`.
  if (s.falseIdx >= 0) {
    const lines = s.lines.slice();
    lines[s.falseIdx] = lines[s.falseIdx].replace(/\b(?:codex_hooks|hooks)\b([ \t]*=[ \t]*)false/, 'hooks$1true');
    return { content: lines.join('\n'), changed: true, reason: 'set-hooks-true' };
  }

  // A [features] table exists but lacks the flag → insert after its header.
  if (s.hasFeatures) {
    const lines = s.lines.slice();
    lines.splice(s.featuresHeaderIdx + 1, 0, 'hooks = true');
    return { content: lines.join('\n'), changed: true, reason: 'inserted-under-features' };
  }

  // No [features] table → append one.
  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return { content: `${content}${sep}[features]\nhooks = true\n`, changed: true, reason: 'appended-features-table' };
}

module.exports = { ensureCodexHooksFlag, isCodexHooksEnabled };
