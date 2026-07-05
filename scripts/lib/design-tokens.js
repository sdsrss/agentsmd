'use strict';
// design-tokens.js — deterministic design-token extraction for `agentsmd design`
// (D1, the detect.js:6 "Phase 2" module). Scans a frontend project's CSS for
// custom properties declared in :root{} and Tailwind v4 @theme{} blocks, and
// groups them into facts-only categories by name/value. Pure static text parsing —
// NO JS eval (a Tailwind v3 config-object theme is a documented non-goal), no
// side effects. Mirrors analyze.js gather: ignore-aware walk, capped.

const fs = require('fs');
const path = require('path');

const MAX_CSS_FILES = 40, MAX_CSS_BYTES = 400 * 1024;
const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor', '.code-graph']);
const CSS_RE = /\.(css|pcss|postcss)$/;

// ignore-aware .css walk (capped like analyze.js gather).
function findCssFiles(root) {
  const files = []; let bytes = 0, truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue; // skip dotdirs
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!HARD_SKIP.has(e.name)) walk(full); continue; }
      if (!CSS_RE.test(e.name)) continue;
      let sz = 0; try { sz = fs.statSync(full).size; } catch { continue; }
      if (files.length >= MAX_CSS_FILES || bytes + sz > MAX_CSS_BYTES) { truncated = true; return; }
      files.push(full); bytes += sz;
    }
  };
  walk(root);
  return { files, truncated };
}

// Strip /* comments */ — but NOT inside string literals, so a value like
// `--note: "/* x */"` survives intact. A `}` or a whole commented-out :root{} inside
// a comment must not close or forge a block (facts-only: no dropped/phantom tokens).
function stripComments(css) {
  let out = '';
  for (let i = 0, q = null, n = css.length; i < n; i++) {
    const c = css[i];
    if (q) { out += c; if (c === '\\' && i + 1 < n) out += css[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); out += ' '; i = e < 0 ? n : e + 1; continue; }
    out += c;
  }
  return out;
}

// A structural view: string CONTENTS blanked to spaces (quotes + newlines kept, length
// preserved), so a `:root{`, `@theme{`, or stray `{`/`}` sitting inside a string VALUE
// is invisible to block/brace matching. Indices stay aligned with the input, so bodies
// are sliced from the real (comment-stripped) CSS — token values are never blanked.
function blankStrings(css) {
  let out = '';
  for (let i = 0, q = null, n = css.length; i < n; i++) {
    const c = css[i];
    if (q) {
      if (c === '\\' && i + 1 < n) { out += '  '; i++; continue; }
      if (c === q) { q = null; out += c; continue; }
      out += c === '\n' ? '\n' : ' '; continue;
    }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    out += c;
  }
  return out;
}

// Extract the BODY of every :root{...} / @theme{...} block. Comments are stripped and
// string contents blanked FIRST — a `}`, or a `:root{`, inside a comment or a string
// value must not close or forge a block (facts-only: no dropped or phantom tokens).
// Then brace-matched on that structural view (a depth counter, so a stray nested {}
// won't over-run); handles `:root {` (space), `:root:where(...)`, `:root[data-x="y"]`,
// `@theme inline {`. Stops the pre-brace scan at any } so an unbalanced block can't
// swallow the file. Bodies are sliced from the real CSS so values are kept verbatim.
function extractBlocks(css) {
  css = stripComments(css);
  const struct = blankStrings(css); // string-blanked structural view; indices aligned with css
  const bodies = [];
  const re = /(:root|@theme)\b[^{}]*\{/g;
  while (re.exec(struct) !== null) {
    const start = re.lastIndex; // just after the {
    let depth = 1, i = start;
    while (i < struct.length && depth > 0) {
      const c = struct[i];
      if (c === '{') depth++; else if (c === '}') depth--;
      i++;
    }
    bodies.push(css.slice(start, depth === 0 ? i - 1 : i)); // real CSS, not the blanked view
    re.lastIndex = i; // continue past this block
  }
  return bodies;
}

// Parse `--name: value;` declarations from a block body. Comments are stripped
// (string-aware); the value runs to the first `;` at paren-depth 0 outside any string
// — so a `;` inside url("data:…;base64,…") or a quoted value doesn't truncate it — or
// to the end of the body (a final declaration may omit its `;`).
function parseDecls(body) {
  const css = stripComments(body);
  const out = [];
  const n = css.length;
  const declRe = /(--[A-Za-z0-9_-]+)\s*:/g;
  let m;
  while ((m = declRe.exec(css)) !== null) {
    let j = declRe.lastIndex; // just after the ':'
    let q = null, paren = 0;
    while (j < n) {
      const c = css[j];
      if (q) { if (c === '\\') j += 2; else { if (c === q) q = null; j++; } continue; }
      if (c === '"' || c === "'") { q = c; j++; continue; }
      if (c === '(') { paren++; j++; continue; }
      if (c === ')') { if (paren > 0) paren--; j++; continue; }
      if ((c === ';' && paren === 0) || c === '{' || c === '}') break; // value end (or a stray brace)
      j++;
    }
    const value = css.slice(declRe.lastIndex, j).trim().replace(/\s+/g, ' ');
    if (value) out.push({ name: m[1], value });
    declRe.lastIndex = css[j] === ';' ? j + 1 : j; // resume after the terminator
  }
  return out;
}

// Facts-only category from name prefix + value sniff. Deterministic; ambiguous → 'other'.
const COLOR_VAL_RE = /^#[0-9a-fA-F]{3,8}$|^(rgb|hsl|oklch|oklab|lab|lch|color)a?\(/;
function categorize(name, value) {
  const n = name.toLowerCase();
  if (/^--colou?r-|-colou?r$|^--(bg|fg|border|ring|accent|primary|secondary|muted|destructive|foreground|background|card|popover|input)\b/.test(n) || COLOR_VAL_RE.test(value)) return 'color';
  if (/^--(spacing|space|gap|inset|size)-|-(spacing|gap)$/.test(n)) return 'spacing';
  if (/^--(font|text|leading|tracking|line-height|letter-spacing)-|-font(-\w+)?$/.test(n)) return 'typography';
  if (/^--(radius|rounded)-|-radius$|^--radius$/.test(n)) return 'radius';
  if (/^--(shadow|elevation)-|-shadow$/.test(n)) return 'shadow';
  if (/^--(z|z-index)-|^--z$/.test(n)) return 'z-index';
  if (/^--(breakpoint|screen)-/.test(n)) return 'breakpoint';
  return 'other';
}

const CATEGORY_ORDER = ['color', 'spacing', 'typography', 'radius', 'shadow', 'z-index', 'breakpoint', 'other'];

function parseDesignTokens(root) {
  const base = root || process.cwd();
  const { files, truncated } = findCssFiles(base);
  const byName = new Map(); // name → { value } (last definition across files wins, CSS-cascade-ish)
  const sources = new Set();
  for (const file of files) {
    let css; try { css = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(base, file);
    let had = false;
    for (const body of extractBlocks(css)) {
      for (const { name, value } of parseDecls(body)) { byName.set(name, { value }); had = true; }
    }
    if (had) sources.add(rel);
  }
  const tokens = {};
  for (const [name, { value }] of byName) {
    const cat = categorize(name, value);
    (tokens[cat] = tokens[cat] || []).push({ name, value });
  }
  for (const cat of Object.keys(tokens)) tokens[cat].sort((a, b) => a.name.localeCompare(b.name));
  return {
    tokens,
    categories: CATEGORY_ORDER.filter((c) => tokens[c] && tokens[c].length),
    count: byName.size,
    sources: [...sources].sort(),
    files: files.map((f) => path.relative(base, f)),
    truncated,
  };
}

module.exports = { parseDesignTokens, findCssFiles, extractBlocks, parseDecls, categorize, CATEGORY_ORDER };
