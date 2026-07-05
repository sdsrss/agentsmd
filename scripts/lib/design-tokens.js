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

// Extract the BODY of every :root{...} / @theme{...} block. Brace-matched (a depth
// counter, so a stray nested {} won't over-run); handles `:root {` (space),
// `:root:where(...)`, `@theme inline {`. Stops the pre-brace scan at any } so an
// unbalanced block can't swallow the file.
function extractBlocks(css) {
  const bodies = [];
  const re = /(:root|@theme)\b[^{}]*\{/g;
  while (re.exec(css) !== null) {
    const start = re.lastIndex; // just after the {
    let depth = 1, i = start;
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === '{') depth++; else if (c === '}') depth--;
      i++;
    }
    bodies.push(css.slice(start, depth === 0 ? i - 1 : i));
    re.lastIndex = i; // continue past this block
  }
  return bodies;
}

// Parse `--name: value;` declarations from a block body, stripping /* comments */.
function parseDecls(body) {
  const out = [];
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(clean)) !== null) out.push({ name: m[1], value: m[2].trim().replace(/\s+/g, ' ') });
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
