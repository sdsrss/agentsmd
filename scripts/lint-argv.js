'use strict';
// lint-argv.js — gate against the "silent-fallback argv" bug class in agentsmd's
// CLIs. Two scans over bin/ + scripts/ (excluding scripts/tests/ — tests assert on
// CLI OUTPUT, not argv — plus scripts/lib/argv.js and this file):
//   A. antipattern regexes — args.includes('--x') / .find|findIndex|filter(a=>
//      a.startsWith('--')) / .indexOf('--x'): the shapes that read a flag by scanning
//      argv and silently fall back (bool/index) when it is absent or mis-shaped. The
//      literal must be flag-shaped (--<letter>) so a `--- separator ---` string is not
//      flagged. Explicit `arg === '--flag'` dispatch is NOT here — it is a normal,
//      non-silent branch (the repo's grandfathered manual parseArgs use it) and scan B
//      already governs those. Suppress a deliberate line with `// argv-lint:allow`.
//   B. main-block-without-validation — a `require.main === module` block that never
//      calls a real argv parser (parseStrict / parseArgs / parseDaysArg / ...), so a
//      new CLI cannot silently skip arg validation. No-arg CLIs are allowlisted.
// The bug class is currently ABSENT; this locks it out. Ported from
// claudemd/scripts/lint-argv.js (ESM→CJS, import.meta→require.main).

const fs = require('fs');
const path = require('path');
const { ArgvError, printHelpAndExit, parseStrict } = require('./lib/argv');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['bin', 'scripts'];
const SCAN_EXT = '.js';
const SKIP_DIRS = new Set(['tests', 'node_modules', '.git']);
const FILE_ALLOWLIST = new Set(['scripts/lib/argv.js', 'scripts/lint-argv.js']);

const PATTERNS = [
  { name: 'includes(--flag)',                     regex: /\b\w+\.includes\s*\(\s*['"]--[A-Za-z]/ },
  { name: 'find/findIndex/filter(=>startsWith(--flag))', regex: /\.(?:find|findIndex|filter)\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.startsWith\s*\(\s*['"]--[A-Za-z]/ },
  { name: 'indexOf(--flag)',                      regex: /\b\w+\.indexOf\s*\(\s*['"]--[A-Za-z]/ },
];
const WHY = 'reads a flag by scanning argv and silently falls back when absent/mis-shaped — parse via scripts/lib/argv.js parseStrict instead';

const MAIN_BLOCK_GUARD_RE = /if\s*\(\s*require\.main\s*===\s*module\s*\)/;
const REQUIRED_CALL_RE = /\b(parseStrict|printHelpAndExit|parseDaysArg|parseNoArgs|parseArgs)\s*\(/;
const MAIN_BLOCK_ALLOWLIST = new Set(['scripts/install.js', 'scripts/uninstall.js']); // no-arg CLIs

function walkJsFiles(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walkJsFiles(path.join(dir, ent.name), acc); }
    else if (ent.name.endsWith(SCAN_EXT)) acc.push(path.join(dir, ent.name));
  }
  return acc;
}

function scan({ root = ROOT } = {}) {
  const files = [];
  for (const d of SCAN_DIRS) { const abs = path.join(root, d); if (fs.existsSync(abs)) walkJsFiles(abs, files); }
  const hits = [];
  for (const abs of files) {
    const r = path.relative(root, abs).split(path.sep).join('/');
    if (FILE_ALLOWLIST.has(r)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const lines = src.split('\n');
    // A. antipattern lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // pure comment (avoids self-match on the pattern defs)
      if (line.includes('argv-lint:allow')) continue;                    // inline suppression
      for (const p of PATTERNS) if (p.regex.test(line)) hits.push({ file: r, line: i + 1, pattern: p.name, why: WHY, text: trimmed.slice(0, 120) });
    }
    // B. main block must validate
    if (MAIN_BLOCK_GUARD_RE.test(src) && !MAIN_BLOCK_ALLOWLIST.has(r) && !REQUIRED_CALL_RE.test(src)) {
      const idx = lines.findIndex((l) => MAIN_BLOCK_GUARD_RE.test(l));
      hits.push({ file: r, line: idx + 1, pattern: 'main-block-without-argv-validation', why: 'a require.main===module CLI that never calls an argv parser', text: 'if (require.main === module) { ... }' });
    }
  }
  return hits;
}

function formatReport(hits) {
  if (!hits.length) return 'argv-lint: 0 hits across bin + scripts/ (tests + lib/argv.js excluded).';
  const L = [`argv-lint: ${hits.length} hit(s):`];
  for (const h of hits) { L.push(`  ${h.file}:${h.line} [${h.pattern}]`); L.push(`    ${h.text}`); L.push(`    -> ${h.why}`); }
  L.push('Fix: parse argv through scripts/lib/argv.js (parseStrict / parsePositiveInt / printHelpAndExit), or add `// argv-lint:allow` if deliberate.');
  return L.join('\n');
}

if (require.main === module) {
  const usage = 'Usage: agentsmd-lint-argv [--json]';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try { opts = parseStrict(argv, { bools: ['json'] }); }
  catch (e) {
    if (e instanceof ArgvError) { console.error(`agentsmd lint-argv: ${e.message}\n${usage}`); process.exit(2); }
    throw e;
  }
  const hits = scan();
  console.log(opts.bools.has('json') ? JSON.stringify(hits, null, 2) : formatReport(hits));
  process.exit(hits.length ? 1 : 0);
}
module.exports = { scan, formatReport, PATTERNS, walkJsFiles };
