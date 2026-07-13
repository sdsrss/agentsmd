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

function parseTomlKey(input) {
  const parts = [];
  let i = 0;
  const text = String(input);
  const ws = () => { while (/[ \t]/.test(text[i] || '')) i++; };
  ws();
  while (i < text.length) {
    let part = '';
    if (text[i] === '"') {
      const start = i++;
      let escaped = false;
      while (i < text.length) {
        const ch = text[i++];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') break;
      }
      if (text[i - 1] !== '"') return null;
      try { part = JSON.parse(text.slice(start, i)); } catch { return null; }
    } else if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      part = text.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = text.slice(i).match(/^[A-Za-z0-9_-]+/);
      if (!m) return null;
      part = m[0];
      i += m[0].length;
    }
    parts.push(part);
    ws();
    if (i === text.length) return parts;
    if (text[i] !== '.') return null;
    i++;
    ws();
  }
  return parts.length ? parts : null;
}

function tableName(line) {
  const m = line.match(/^\s*(?:\[\[(.*?)\]\]|\[(.*?)\])\s*(?:#.*)?$/);
  if (!m) return null;
  const parts = parseTomlKey(m[1] === undefined ? m[2] : m[1]);
  return parts ? parts.join('.') : null;
}

function assignment(line) {
  let inDouble = false, inSingle = false, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch !== '=') continue;
    const keys = parseTomlKey(line.slice(0, i).trim());
    return keys ? { keys, value: line.slice(i + 1).trim(), equalsIdx: i } : null;
  }
  return null;
}

function inlineTableBounds(text, start = 0) {
  let inDouble = false, inSingle = false, escaped = false, depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '#' && depth > 0) return null;
    if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0) return { open: start, close: i };
  }
  return null;
}

function inlineTableInner(value) {
  const text = String(value);
  if (!text.startsWith('{')) return null;
  const bounds = inlineTableBounds(text);
  if (!bounds || !/^\s*(?:#.*)?$/.test(text.slice(bounds.close + 1))) return null;
  return text.slice(bounds.open + 1, bounds.close);
}

function replaceInlineTableInner(line, inner) {
  const a = assignment(line);
  const bounds = inlineTableBounds(line, a ? a.equalsIdx + 1 : 0);
  return bounds ? `${line.slice(0, bounds.open + 1)}${inner}${line.slice(bounds.close)}` : line;
}

function splitInlineFields(inner) {
  const fields = [];
  let start = 0, square = 0, curly = 0, inDouble = false, inSingle = false, escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inDouble) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === ',' && square === 0 && curly === 0) { fields.push(inner.slice(start, i)); start = i + 1; }
  }
  fields.push(inner.slice(start));
  return fields;
}

function inlineField(inner, name) {
  for (const field of splitInlineFields(inner)) {
    const a = assignment(field);
    if (a && a.keys.length === 1 && a.keys[0] === name) return a.value.trim();
  }
  return null;
}

function rewriteInlineBoolean(inner, fromName, toName, value) {
  return splitInlineFields(inner).map((field) => {
    const a = assignment(field);
    if (!a || a.keys.length !== 1 || a.keys[0] !== fromName) return field;
    const lhs = field.slice(0, a.equalsIdx).replace(fromName, toName);
    const rhs = field.slice(a.equalsIdx + 1).replace(/^([ \t]*)(?:true|false)\b/, `$1${value}`);
    return `${lhs}=${rhs}`;
  }).join(',');
}

// Scan [features] (header + dotted features.* + inline-table features = {...})
// for the hook flag state. Recognizing the inline-table form is load-bearing:
// without it, ensureCodexHooksFlag would append a SECOND [features] table to a
// file that already defines `features`, which is a duplicate-key error rejected
// by Codex's (Rust) TOML parser — fail-closed for every tenant sharing config.toml.
function scanFeatures(content) {
  const lines = content.split('\n');
  let cur = ''; // current table; '' = top-level document scope
  let enabledNew = false, enabledOld = false;
  let oldTrueIdx = -1, falseIdx = -1, hasFeatures = false, featuresHeaderIdx = -1;
  const falseEntries = [];
  let inlineIdx = -1, inlineInner = null; // top-level `features = { ... }`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = tableName(line);
    if (th !== null) { cur = th; if (cur === 'features') { hasFeatures = true; if (featuresHeaderIdx < 0) featuresHeaderIdx = i; } continue; }
    const a = assignment(line);
    if (cur === '') {
      const inl = a && a.keys.length === 1 && a.keys[0] === 'features' ? inlineTableInner(a.value) : null;
      if (inl !== null) {
        inlineIdx = i; inlineInner = inl;
        const hk = inlineField(inl, 'hooks');
        const ck = inlineField(inl, 'codex_hooks');
        if (/^true\b/.test(hk || '')) enabledNew = true;
        if (/^true\b/.test(ck || '')) enabledOld = true;
        continue;
      }
    }
    let name = null;
    if (a && cur === '' && a.keys.length === 2 && a.keys[0] === 'features') name = a.keys[1];
    if (a && cur === 'features' && a.keys.length === 1) name = a.keys[0];
    if (!a || !['hooks', 'codex_hooks'].includes(name) || !/^(true|false)\b/.test(a.value)) continue;
    const value = a.value.match(/^(true|false)\b/)[1];
    if (value === 'true') {
      if (name === 'hooks') enabledNew = true;
      else { enabledOld = true; if (oldTrueIdx < 0) oldTrueIdx = i; }
    } else {
      falseEntries.push({ index: i, name });
      if (falseIdx < 0) falseIdx = i;
    }
  }
  return { enabledNew, enabledOld, enabled: enabledNew || enabledOld, oldTrueIdx, falseIdx, falseEntries, hasFeatures, featuresHeaderIdx, inlineIdx, inlineInner, lines };
}

// Replace TOML multiline-string bodies before scanning for tables or assignments.
// A literal `[features]\nhooks = true` inside a user string is data, not config.
// Newlines are retained so line-oriented rewrites and diagnostics keep their shape.
function maskMultilineStrings(input) {
  const content = typeof input === 'string' ? input : '';
  const out = content.split('');
  let mode = null;
  let inDouble = false, inSingle = false, escaped = false, comment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (mode !== null) {
      if (ch === '\n') { out[i] = '\n'; escaped = false; continue; }
      const quote = mode === 'basic' ? '"' : "'";
      let quoteRun = 0;
      while (content[i + quoteRun] === quote) quoteRun++;
      if (quoteRun >= 3 && (mode !== 'basic' || !escaped)) {
        for (let offset = 0; offset < quoteRun; offset++) out[i + offset] = ' ';
        i += quoteRun - 1; mode = null; escaped = false;
        continue;
      }
      out[i] = ' ';
      if (mode === 'basic') {
        if (ch === '\\') escaped = !escaped; else escaped = false;
      }
      continue;
    }
    if (ch === '\n') {
      if (inDouble || inSingle) return { content: out.join(''), valid: false };
      comment = false; escaped = false;
      continue;
    }
    if (comment) continue;
    if (inDouble) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) { if (ch === "'") inSingle = false; continue; }
    if (ch === '#') { comment = true; continue; }
    if (content.startsWith('"""', i)) {
      out[i] = '"'; out[i + 1] = '"'; out[i + 2] = ' ';
      i += 2; mode = 'basic'; escaped = false;
      continue;
    }
    if (content.startsWith("'''", i)) {
      out[i] = "'"; out[i + 1] = "'"; out[i + 2] = ' ';
      i += 2; mode = 'literal';
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
  }
  return { content: out.join(''), valid: mode === null && !inDouble && !inSingle };
}

function codexHooksHealth(input) {
  const masked = maskMultilineStrings(input);
  return {
    enabled: masked.valid && scanFeatures(masked.content).enabled,
    lexicallyValid: masked.valid,
  };
}

// True when a lexically isolated hook flag is enabled under [features] by either name.
// Full TOML syntax validation is performed by surface-arbitration through the
// installed Codex CLI, which is the runtime authority for config.toml.
function isCodexHooksEnabled(input) {
  return codexHooksHealth(typeof input === 'string' ? input : '').enabled;
}

// Returns { content, changed, reason }. Prefers/sets the canonical `hooks`.
function ensureCodexHooksFlag(input) {
  const content = typeof input === 'string' ? input : '';
  const masked = maskMultilineStrings(content);
  if (!masked.valid) throw new Error('cannot safely update config.toml with an unterminated TOML string');
  const s = scanFeatures(masked.content);
  s.lines = content.split('\n');

  if (s.enabledNew) return { content, changed: false, reason: 'already-enabled' };

  // Inline-table `features = { ... }` (not already-enabled): edit INSIDE the braces
  // — never append a second [features] table (duplicate-key error in a shared file).
  // Reconstruct via the same anchored regex the scanner used, so an inline trailing
  // comment and the closing brace are preserved verbatim.
  if (s.inlineIdx >= 0) {
    const inner = s.inlineInner;
    let newInner;
    const oldTrue = /^true\b/.test(inlineField(inner, 'codex_hooks') || '');
    const oldFalse = /^false\b/.test(inlineField(inner, 'codex_hooks') || '');
    const canonicalFalse = /^false\b/.test(inlineField(inner, 'hooks') || '');
    if (oldTrue && canonicalFalse) {
      const withoutOld = splitInlineFields(inner).filter((field) => {
        const a = assignment(field);
        return !(a && a.keys.length === 1 && a.keys[0] === 'codex_hooks');
      }).join(',');
      newInner = rewriteInlineBoolean(withoutOld, 'hooks', 'hooks', 'true');
    } else if (oldTrue) {
      newInner = rewriteInlineBoolean(inner, 'codex_hooks', 'hooks', 'true');
    } else if (oldFalse && canonicalFalse) {
      const withoutOld = splitInlineFields(inner).filter((field) => {
        const a = assignment(field);
        return !(a && a.keys.length === 1 && a.keys[0] === 'codex_hooks');
      }).join(',');
      newInner = rewriteInlineBoolean(withoutOld, 'hooks', 'hooks', 'true');
    } else if (oldFalse) {
      newInner = rewriteInlineBoolean(inner, 'codex_hooks', 'hooks', 'true');
    } else if (canonicalFalse) {
      newInner = rewriteInlineBoolean(inner, 'hooks', 'hooks', 'true');
    } else {
      const trimmed = inner.trim();
      newInner = trimmed.length ? `${inner.replace(/[ \t]*$/, '')}, hooks = true ` : ' hooks = true ';
    }
    const lines = s.lines.slice();
    lines[s.inlineIdx] = replaceInlineTableInner(lines[s.inlineIdx], newInner);
    return { content: lines.join('\n'), changed: true, reason: 'set-hooks-in-inline-features' };
  }

  // Deprecated `codex_hooks = true` present → migrate it in place to `hooks`.
  if (s.enabledOld) {
    const lines = s.lines.slice();
    // If a canonical `hooks = false` coexists in the same table, renaming
    // codex_hooks→hooks would produce TWO `hooks` keys (duplicate-key error).
    // Flip the existing hooks=false→true and drop the codex_hooks line instead.
    const falseAssignment = s.falseIdx >= 0 ? assignment(lines[s.falseIdx]) : null;
    if (falseAssignment && falseAssignment.keys.at(-1) === 'hooks') {
      lines[s.falseIdx] = lines[s.falseIdx].replace(/false\b/, 'true');
      lines.splice(s.oldTrueIdx, 1);
      return { content: lines.join('\n'), changed: true, reason: 'migrated-codex_hooks-dedup' };
    }
    lines[s.oldTrueIdx] = lines[s.oldTrueIdx].replace(/\bcodex_hooks\b/, 'hooks');
    return { content: lines.join('\n'), changed: true, reason: 'migrated-codex_hooks-to-hooks' };
  }

  // A features-scoped `(codex_)hooks = false` → set the canonical `hooks = true`.
  if (s.falseIdx >= 0) {
    const lines = s.lines.slice();
    const canonicalFalse = s.falseEntries.find((entry) => entry.name === 'hooks');
    const legacyFalse = s.falseEntries.filter((entry) => entry.name === 'codex_hooks');
    if (canonicalFalse && legacyFalse.length) {
      lines[canonicalFalse.index] = lines[canonicalFalse.index].replace(/false\b/, 'true');
      for (const entry of legacyFalse.sort((a, b) => b.index - a.index)) lines.splice(entry.index, 1);
      return { content: lines.join('\n'), changed: true, reason: 'set-hooks-true-dedup' };
    }
    const a = assignment(lines[s.falseIdx]);
    let lhs = lines[s.falseIdx].slice(0, a.equalsIdx);
    if (a.keys.at(-1) === 'codex_hooks') {
      lhs = lhs.replace(/(["']?)codex_hooks\1([ \t]*)$/, '$1hooks$1$2');
    }
    lines[s.falseIdx] = `${lhs}=${lines[s.falseIdx].slice(a.equalsIdx + 1).replace(/false\b/, 'true')}`;
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
  let inlineTuiIdx = -1, inlineTuiInner = null; // top-level `tui = { ... }`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const th = tableName(line);
    if (th !== null) { cur = th; if (cur === 'tui') { hasTui = true; if (tuiHeaderIdx < 0) tuiHeaderIdx = i; } continue; }
    const a = assignment(line);
    if (cur === '') {
      const inl = a && a.keys.length === 1 && a.keys[0] === 'tui' ? inlineTableInner(a.value) : null;
      if (inl !== null) {
        inlineTuiIdx = i; inlineTuiInner = inl;
        // An inline tui table that already carries status_line = the user's own
        // footer → treat as existing so ensureTuiStatusLine no-ops (never appends
        // a second [tui] table → duplicate-key TOML error in a shared file).
        const statusValue = inlineField(inl, 'status_line');
        if (statusValue !== null) {
          return { exists: true, items: parseStatusLineItems(statusValue), line: line.trim(), index: i, hasTui, tuiHeaderIdx, topLevelTuiDottedIdx, inlineTuiIdx, inlineTuiInner, lines };
        }
        continue;
      }
      if (a && a.keys.length > 1 && a.keys[0] === 'tui') topLevelTuiDottedIdx = i;
    }
    const statusAssignment = a && ((cur === 'tui' && a.keys.length === 1 && a.keys[0] === 'status_line')
      || (cur === '' && a.keys.length === 2 && a.keys[0] === 'tui' && a.keys[1] === 'status_line'));
    if (!statusAssignment || !/^\[/.test(a.value)) continue;
    const value = collectArrayValue(lines, i, a.value).replace(/[ \t]+#.*$/, '').trim();
    const items = parseStatusLineItems(value);
    return { exists: true, items, line: line.trim(), index: i, hasTui, tuiHeaderIdx, topLevelTuiDottedIdx, inlineTuiIdx, inlineTuiInner, lines };
  }
  return { exists: false, items: null, line: '', index: -1, hasTui, tuiHeaderIdx, topLevelTuiDottedIdx, inlineTuiIdx, inlineTuiInner, lines };
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
  // Inline `tui = { ... }` without status_line → insert inside the braces, never
  // append a second [tui] table (duplicate-key error in a shared file).
  if (s.inlineTuiIdx >= 0) {
    const inner = s.inlineTuiInner;
    const trimmed = inner.trim();
    const newInner = trimmed.length ? `${inner.replace(/[ \t]*$/, '')}, ${statusLine} ` : ` ${statusLine} `;
    const lines = s.lines.slice();
    lines[s.inlineTuiIdx] = replaceInlineTableInner(lines[s.inlineTuiIdx], newInner);
    return { content: lines.join('\n'), changed: true, reason: 'inserted-into-inline-tui' };
  }
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

// Codex's project_doc_max_bytes — the discovery-chain byte cap the GLOBAL
// ~/.codex/AGENTS.md shares with every project's AGENTS.md chain. Truncation past
// it is SILENT, so tooling should watch it. Default 32 KiB when unset.
const DEFAULT_DOC_MAX_BYTES = 32768;
function projectDocMaxBytes(input) {
  const content = typeof input === 'string' ? input : '';
  const m = content.match(/(?:^|\n)[ \t]*project_doc_max_bytes[ \t]*=[ \t]*([0-9]+)/);
  return m ? Number(m[1]) : DEFAULT_DOC_MAX_BYTES;
}

// Budget the combined global + project AGENTS.md against the cap (bytes).
function chainBudget(configContent, globalBytes, projectBytes) {
  const cap = projectDocMaxBytes(configContent);
  const g = globalBytes || 0, p = projectBytes || 0, total = g + p;
  return { cap, globalBytes: g, projectBytes: p, total, over: total - cap, headroom: cap - total };
}

module.exports = {
  AGENTSMD_STATUS_LINE,
  DEFAULT_DOC_MAX_BYTES,
  ensureCodexHooksFlag,
  ensureTuiStatusLine,
  getTuiStatusLine,
  isAgentsmdStatusLineEnabled,
  codexHooksHealth,
  isCodexHooksEnabled,
  projectDocMaxBytes,
  chainBudget,
};
