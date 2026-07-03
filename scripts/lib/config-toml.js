'use strict';
// config-toml.js — ensure Codex's hook feature flag is enabled under [features]
// and install agentsmd's preferred TUI status line under [tui], without
// disturbing other content. Codex 0.142+ renamed the flag `codex_hooks` →
// `hooks` (`codex_hooks` is deprecated). This module recognizes BOTH names,
// prefers the canonical `hooks`, and migrates a deprecated `codex_hooks = true`
// to `hooks = true` on install. Text-targeted (not a full TOML rewrite) so every
// unrelated key/comment/table is byte-preserved. Per §5, uninstall LEAVES these
// config values (removing them could break the user's hooks/footer setup).
//
// TOML-table-aware: only a flag under the [features] table (or dotted
// features.<flag>) counts — a stray `hooks`/`codex_hooks` under another table
// does not (else the installer would no-op and no hook would ever run).

const AGENTSMD_STATUS_LINE = [
  'model-with-reasoning',
  'git-branch',
  'context-remaining',
  'total-input-tokens',
  'total-output-tokens',
  'five-hour-limit',
  'weekly-limit',
];

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function quoteTomlString(value) {
  return JSON.stringify(String(value));
}

function formatTomlStringArray(values) {
  return `[${values.map(quoteTomlString).join(', ')}]`;
}

function tableName(line) {
  const m = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
  return m ? m[1].trim() : null;
}

// Scan [features] (+ dotted features.*) for the hook flag state.
function scanFeatures(content) {
  const lines = content.split('\n');
  let cur = ''; // current table; '' = top-level document scope
  let enabledNew = false, enabledOld = false;
  let oldTrueIdx = -1, falseIdx = -1, hasFeatures = false, featuresHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = tableName(line);
    if (th !== null) { cur = th; if (cur === 'features') { hasFeatures = true; if (featuresHeaderIdx < 0) featuresHeaderIdx = i; } continue; }
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

function parseStatusLineItems(value) {
  const trimmed = stripTomlComments(value).trim();
  if (!/^\[[\s\S]*\]$/.test(trimmed)) return null;
  if (/^\[\s*\]$/.test(trimmed)) return [];
  const items = [];
  let rest = trimmed.slice(1, -1).trim();
  while (rest.length) {
    const m = rest.match(/^(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:,\s*)?/);
    if (!m) return null;
    if (m[1] !== undefined) {
      try { items.push(JSON.parse(`"${m[1]}"`)); } catch { return null; }
    } else {
      items.push(m[2]);
    }
    rest = rest.slice(m[0].length).trim();
  }
  return items;
}

function stripTomlComments(value) {
  const lines = String(value).split('\n');
  return lines.map((line) => {
    let inDouble = false, inSingle = false, escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inDouble) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inDouble = false;
        continue;
      }
      if (inSingle) {
        if (ch === "'") inSingle = false;
        continue;
      }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '#') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function collectArrayValue(lines, startIdx, firstValue) {
  let value = firstValue;
  if (/\]/.test(value)) return value;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const th = tableName(line);
    if (th !== null) break;
    value += `\n${line}`;
    if (/\]/.test(line)) break;
  }
  return value;
}

function scanTuiStatusLine(content) {
  const lines = (typeof content === 'string' ? content : '').split('\n');
  let cur = '';
  let hasTui = false, tuiHeaderIdx = -1, topLevelTuiDottedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = tableName(line);
    if (th !== null) { cur = th; if (cur === 'tui') { hasTui = true; if (tuiHeaderIdx < 0) tuiHeaderIdx = i; } continue; }
    if (cur === '' && /^[ \t]*tui\./.test(line)) topLevelTuiDottedIdx = i;
    const m = cur === 'tui'
      ? line.match(/^[ \t]*status_line[ \t]*=[ \t]*(\[[^\n#]*(?:#.*)?)/)
      : (cur === '' ? line.match(/^[ \t]*tui\.status_line[ \t]*=[ \t]*(\[[^\n#]*(?:#.*)?)/) : null);
    if (!m) continue;
    const value = collectArrayValue(lines, i, m[1]).replace(/[ \t]+#.*$/, '').trim();
    const items = parseStatusLineItems(value);
    return { exists: true, items, line: line.trim(), index: i, hasTui, tuiHeaderIdx, topLevelTuiDottedIdx, lines };
  }
  return { exists: false, items: null, line: '', index: -1, hasTui, tuiHeaderIdx, topLevelTuiDottedIdx, lines };
}

function getTuiStatusLine(input) {
  const s = scanTuiStatusLine(input);
  return { exists: s.exists, items: s.items, line: s.line };
}

function isAgentsmdStatusLineEnabled(input) {
  return sameArray(scanTuiStatusLine(input).items, AGENTSMD_STATUS_LINE);
}

function ensureTuiStatusLine(input, items = AGENTSMD_STATUS_LINE) {
  const content = typeof input === 'string' ? input : '';
  const s = scanTuiStatusLine(content);
  if (s.exists) {
    return {
      content,
      changed: false,
      reason: sameArray(s.items, items) ? 'already-agentsmd-preset' : 'already-custom-status-line',
    };
  }

  const statusLine = `status_line = ${formatTomlStringArray(items)}`;
  if (s.hasTui) {
    const lines = s.lines.slice();
    lines.splice(s.tuiHeaderIdx + 1, 0, statusLine);
    return { content: lines.join('\n'), changed: true, reason: 'inserted-under-tui' };
  }
  if (s.topLevelTuiDottedIdx >= 0) {
    const lines = s.lines.slice();
    lines.splice(s.topLevelTuiDottedIdx + 1, 0, `tui.${statusLine}`);
    return { content: lines.join('\n'), changed: true, reason: 'inserted-after-dotted-tui' };
  }

  const sep = content.length === 0 ? '' : (content.endsWith('\n') ? '\n' : '\n\n');
  return { content: `${content}${sep}[tui]\n${statusLine}\n`, changed: true, reason: 'appended-tui-table' };
}

module.exports = {
  AGENTSMD_STATUS_LINE,
  ensureCodexHooksFlag,
  ensureTuiStatusLine,
  getTuiStatusLine,
  isAgentsmdStatusLineEnabled,
  isCodexHooksEnabled,
};
