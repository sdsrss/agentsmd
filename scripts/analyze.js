'use strict';
// analyze.js — deterministic shell for the agentsmd-analyze skill. NO AI here.
// --gather: capped, ignore-aware source map for the agent to read.
// --write:  inject the agent's distilled conventions into ./AGENTS.md, refusing
//           (never truncating) past the size budget.
const fs = require('fs');
const path = require('path');
const { detect } = require('./lib/detect');
const AM = require('./lib/agents-md');
const { stampConventionAnchors, CONVENTIONS_CITE_NOTICE } = require('./lib/conventions-taxonomy');

const MAX_FILES = 40, MAX_BYTES = 200 * 1024;
const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt', 'coverage', '__pycache__', 'vendor', '.code-graph']);
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rs|go|rb|java|kt|php|vue|svelte)$/;

function gitignorePatterns(root) {
  const dirs = new Set(); const extGlobs = [];
  try {
    for (let line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^\*(\.[A-Za-z0-9.]+)$/);   // *.log, *.gen.ts
      if (m) { extGlobs.push(m[1]); continue; }
      const bare = line.replace(/\/$/, '').replace(/^\//, '');
      if (bare && !bare.includes('/') && !bare.includes('*')) dirs.add(bare);
    }
  } catch { /* no .gitignore */ }
  return { dirs, extGlobs };
}

function gather(root) {
  const base = root || process.cwd();
  const { dirs, extGlobs } = gitignorePatterns(base);
  const skip = new Set([...HARD_SKIP, ...dirs]);
  const files = []; let bytes = 0, truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
      if (extGlobs.some((ext) => e.name.endsWith(ext))) continue;
      if (!SRC_RE.test(e.name)) continue;
      let sz = 0; try { sz = fs.statSync(full).size; } catch { continue; }
      if (files.length >= MAX_FILES || bytes + sz > MAX_BYTES) { truncated = true; return; }
      files.push({ path: full, bytes: sz }); bytes += sz;
    }
  };
  walk(base);
  return { detection: detect(base), files, truncated };
}

const MAX_CONVENTIONS_BYTES = 6 * 1024, MAX_AGENTS_MD_BYTES = 32 * 1024;
const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function writeConventions(root, md) {
  const base = root || process.cwd();
  const target = path.join(base, 'AGENTS.md');
  const stamped = stampConventionAnchors(String(md).trim());
  const body = `${CONVENTIONS_CITE_NOTICE}\n\n${stamped}`;
  if (Buffer.byteLength(body, 'utf8') > MAX_CONVENTIONS_BYTES)
    throw new Error(`conventions block ${Buffer.byteLength(body, 'utf8')}B exceeds ${MAX_CONVENTIONS_BYTES}B budget — distill fewer, higher-signal conventions`);
  const existing = readOrNull(target) || '';
  const { content } = AM.injectBlockBetween(existing, body, AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END);
  if (Buffer.byteLength(content, 'utf8') > MAX_AGENTS_MD_BYTES)
    throw new Error(`AGENTS.md would be ${Buffer.byteLength(content, 'utf8')}B, past the ~32 KiB discovery budget — trim facts or conventions`);
  fs.writeFileSync(target, content);
  return { action: 'written', target, bytes: Buffer.byteLength(content, 'utf8') };
}
module.exports = { gather, writeConventions };

const USAGE = 'Usage: agentsmd-analyze [--gather] | agentsmd-analyze --write --from <file> | --help';

function parseArgs(argv) {
  const opts = { mode: 'gather', from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--gather') opts.mode = 'gather';
    else if (a === '--write') opts.mode = 'write';
    else if (a === '--from') opts.from = argv[++i];
    else return { error: `unknown option: ${a}` };
  }
  if (opts.mode === 'write' && !opts.from) return { error: '--write requires --from <file>' };
  return opts;
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd analyze: ${parsed.error}`); console.error(USAGE); process.exit(1); }
  if (parsed.mode === 'write') {
    let md;
    try { md = fs.readFileSync(parsed.from, 'utf8'); }
    catch (e) { console.error(`agentsmd analyze: cannot read ${parsed.from}: ${e.message}`); process.exit(1); }
    try {
      const r = writeConventions(process.cwd(), md);
      console.log(`written: ${r.target}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    const g = gather(process.cwd());
    console.log(`${g.detection.language} (${g.detection.packageManager}) — ${g.files.length} file(s)${g.truncated ? ', truncated' : ''}`);
    for (const f of g.files) console.log(`  ${f.path} (${f.bytes}B)`);
  }
}
