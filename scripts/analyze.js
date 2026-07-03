'use strict';
// analyze.js — deterministic shell for the agentsmd-analyze skill. NO AI here.
// --gather: capped, ignore-aware source map for the agent to read.
// --write:  inject the agent's distilled conventions into ./AGENTS.md, refusing
//           (never truncating) past the size budget.
const fs = require('fs');
const path = require('path');
const { detect } = require('./lib/detect');
const AM = require('./lib/agents-md');

const MAX_FILES = 40, MAX_BYTES = 200 * 1024;
const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt', 'coverage', '__pycache__', 'vendor', '.code-graph']);
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rs|go|rb|java|kt|php|vue|svelte)$/;

function gitignoreDirs(root) {
  try {
    return new Set(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(s => s.replace(/\/$/, '').replace(/^\//, '')).filter(s => !s.includes('/') && !s.includes('*')));
  } catch { return new Set(); }
}

function gather(root) {
  const base = root || process.cwd();
  const skip = new Set([...HARD_SKIP, ...gitignoreDirs(base)]);
  const files = []; let bytes = 0, truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
      if (!SRC_RE.test(e.name)) continue;
      let sz = 0; try { sz = fs.statSync(full).size; } catch { continue; }
      if (files.length >= MAX_FILES || bytes + sz > MAX_BYTES) { truncated = true; return; }
      files.push({ path: full, bytes: sz }); bytes += sz;
    }
  };
  walk(base);
  return { detection: detect(base), files, truncated };
}
module.exports = { gather };
