'use strict';
// analyze.test.js — the deterministic gather/write shell behind agentsmd-analyze:
// capped ignore-aware source map, and (Task 5) size-guarded conventions injection.
// Sandboxed via temp project dirs; touches no real repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

// Create a temp project with the given files, run fn(dir), always clean up.
const withProject = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-analyze-test.'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const { gather } = require('../analyze');

// ── gather ──────────────────────────────────────────────────────────────────
withProject({
  'package.json': JSON.stringify({ name: 'g' }),
  'src/a.js': 'const x=1', 'src/b.ts': 'export const y=2',
  'node_modules/dep/i.js': 'IGN', '.gitignore': 'secret/\n', 'secret/s.js': 'IGN',
}, (dir) => {
  const g = gather(dir);
  t('gather: returns detection + files', () => assert(g.detection.language && Array.isArray(g.files)));
  t('gather: includes source files', () => assert(g.files.some(f => f.path.endsWith('src/a.js'))));
  t('gather: excludes node_modules', () => assert(!g.files.some(f => f.path.includes('node_modules'))));
  t('gather: excludes .gitignore dirs', () => assert(!g.files.some(f => f.path.includes('secret/'))));
});

// ── writeConventions ────────────────────────────────────────────────────────
const { writeConventions } = require('../analyze');
const AM = require('../lib/agents-md');
withProject({ 'package.json': JSON.stringify({ name: 'w' }) }, (dir) => {
  require('../init').init({ projectRoot: dir }); // seed AGENTS.md
  const target = path.join(dir, 'AGENTS.md');
  const r = writeConventions(dir, '## Conventions\n\n- prefer const\n- no default export\n');
  const body = fs.readFileSync(target, 'utf8');
  t('write: injects into conventions block', () => assert(body.includes('- prefer const') && body.includes(AM.CONVENTIONS_BEGIN)));
  t('write: leaves the facts block intact', () => assert(body.includes(AM.PROJECT_BEGIN) && body.includes('w')));
  t('write: idempotent when unchanged', () => {
    const a = fs.readFileSync(target, 'utf8');
    writeConventions(dir, '## Conventions\n\n- prefer const\n- no default export\n');
    assert.strictEqual(a, fs.readFileSync(target, 'utf8'));
  });
  t('write: refuses oversize conventions (no truncation)', () =>
    assert.throws(() => writeConventions(dir, '## Conventions\n\n' + 'x'.repeat(7 * 1024)), /exceeds|budget|size/i));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
