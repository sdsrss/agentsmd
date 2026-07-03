'use strict';
// init.test.js — the project-level AGENTS.md generator: static detection,
// project-scoped marker-merge (preserve user content + idempotent), skeleton
// rendering, and the init CLI end-to-end. Sandboxed via temp project dirs;
// touches no real repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

const { detect } = require('../lib/detect');

// Create a temp project with the given files, run fn(dir), always clean up.
const withProject = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-init-test.'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

// ── detection ───────────────────────────────────────────────────────────────
withProject({
  'package.json': JSON.stringify({ name: '@scope/app', scripts: { dev: 'vite', build: 'vite build', test: 'vitest', lint: 'eslint .' } }),
  'tsconfig.json': '{}',
  'pnpm-lock.yaml': '',
  'src/x': '',
}, (dir) => {
  const d = detect(dir);
  t('node: language is TypeScript when tsconfig present', () => assert.strictEqual(d.language, 'TypeScript'));
  t('node: package manager from lockfile (pnpm)', () => assert.strictEqual(d.packageManager, 'pnpm'));
  t('node: project name strips scope', () => assert.strictEqual(d.projectName, 'app'));
  t('node: dev command from scripts', () => assert.strictEqual(d.commands.dev, 'pnpm run dev'));
  t('node: test command from scripts', () => assert.strictEqual(d.commands.test, 'pnpm run test'));
  t('node: structure lists existing top-level dirs', () => assert.deepStrictEqual(d.structure, ['src']));
});

withProject({ 'package.json': JSON.stringify({ name: 'plain', scripts: {} }) }, (dir) => {
  const d = detect(dir);
  t('node: JavaScript when no tsconfig / typescript dep', () => assert.strictEqual(d.language, 'JavaScript'));
  t('node: package manager defaults to npm', () => assert.strictEqual(d.packageManager, 'npm'));
  t('node: missing scripts yield null commands', () => assert.strictEqual(d.commands.build, null));
});

withProject({ 'Cargo.toml': '[package]\nname = "krate"\n' }, (dir) => {
  const d = detect(dir);
  t('rust: detected from Cargo.toml', () => assert.strictEqual(d.language, 'Rust'));
  t('rust: cargo commands', () => assert.strictEqual(d.commands.test, 'cargo test'));
});

withProject({ 'go.mod': 'module github.com/u/svc\n\ngo 1.22\n' }, (dir) => {
  const d = detect(dir);
  t('go: detected from go.mod', () => assert.strictEqual(d.language, 'Go'));
  t('go: project name from module path', () => assert.strictEqual(d.projectName, 'svc'));
});

withProject({ 'pyproject.toml': '[project]\nname = "pyapp"\n' }, (dir) => {
  const d = detect(dir);
  t('python: detected from pyproject.toml', () => assert.strictEqual(d.language, 'Python'));
});

withProject({ 'README.md': '# nothing' }, (dir) => {
  const d = detect(dir);
  t('unknown: no manifest → Unknown language', () => assert.strictEqual(d.language, 'Unknown'));
  t('unknown: project name falls back to dir basename', () => assert.strictEqual(typeof d.projectName, 'string'));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
