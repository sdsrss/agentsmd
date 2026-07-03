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

// ── project marker-merge (agents-md.js) ──────────────────────────────────────
const AM = require('../lib/agents-md');
{
  const first = AM.injectBlockBetween('# My Project\n\nHand-written notes.\n', 'BODY-A', AM.PROJECT_BEGIN, AM.PROJECT_END);
  t('merge: appends a project block, keeps existing content', () => {
    assert(first.content.includes('Hand-written notes.'));
    assert(first.content.includes(AM.PROJECT_BEGIN) && first.content.includes('BODY-A'));
    assert.strictEqual(first.updated, false);
  });
  const second = AM.injectBlockBetween(first.content, 'BODY-B', AM.PROJECT_BEGIN, AM.PROJECT_END);
  t('merge: re-run replaces the block in place (updated=true)', () => {
    assert.strictEqual(second.updated, true);
    assert(second.content.includes('BODY-B'));
    assert(!second.content.includes('BODY-A'));
    assert(second.content.includes('Hand-written notes.'));
  });
  t('merge: idempotent when body unchanged', () => {
    const a = AM.injectBlockBetween('X\n', 'SAME', AM.PROJECT_BEGIN, AM.PROJECT_END).content;
    const b = AM.injectBlockBetween(a, 'SAME', AM.PROJECT_BEGIN, AM.PROJECT_END).content;
    assert.strictEqual(a, b);
  });
  t('merge: global injectSpecBlock still uses global sentinels', () => {
    const g = AM.injectSpecBlock('', 'GLOBAL').content;
    assert(g.includes(AM.BEGIN) && g.includes('GLOBAL'));
    assert(!g.includes(AM.PROJECT_BEGIN));
  });
}

// ── skeleton rendering (project-templates.js) ────────────────────────────────
const { renderProjectAgentsMd } = require('../lib/project-templates');
{
  const md = renderProjectAgentsMd({
    language: 'TypeScript', runtime: 'Node.js', projectName: 'app', packageManager: 'pnpm',
    monorepo: true, structure: ['src', 'tests'],
    commands: { dev: 'pnpm run dev', build: 'pnpm run build', test: 'pnpm run test', lint: null },
  });
  t('render: names the project and stack', () => assert(md.includes('app') && md.includes('TypeScript')));
  t('render: notes monorepo', () => assert(/monorepo/i.test(md)));
  t('render: lists structure dirs', () => assert(md.includes('`src/`') && md.includes('`tests/`')));
  t('render: emits present commands, skips null ones', () => assert(md.includes('pnpm run build') && !md.includes('lint')));
  t('render: conventions placeholder points at agentsmd-analyze', () => assert(md.includes('## Conventions') && md.includes('agentsmd-analyze')));
  t('render: carries no global-discipline headings (facts only)', () => assert(!/SAFETY|four-section|Iron Law/i.test(md)));

  const bare = renderProjectAgentsMd({
    language: 'Unknown', runtime: 'Unknown', projectName: 'x', packageManager: 'Unknown',
    monorepo: false, structure: [], commands: { dev: null, build: null, test: null, lint: null },
  });
  t('render: omits Structure and Commands when empty', () => assert(!bare.includes('## Structure') && !bare.includes('## Commands')));
  t('render: still emits Project and Conventions when bare', () => assert(bare.includes('## Project') && bare.includes('## Conventions')));
}

// ── init CLI end-to-end ──────────────────────────────────────────────────────
const { init } = require('../init');
withProject({ 'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }), 'src/i': '' }, (dir) => {
  const target = path.join(dir, 'AGENTS.md');
  const r1 = init({ projectRoot: dir });
  t('init: creates AGENTS.md on first run', () => { assert.strictEqual(r1.action, 'created'); assert(fs.existsSync(target)); });
  t('init: written file carries the project block', () => {
    const body = fs.readFileSync(target, 'utf8');
    assert(body.includes(AM.PROJECT_BEGIN) && body.includes('demo') && body.includes('npm run build'));
  });
  const r2 = init({ projectRoot: dir });
  t('init: second run updates in place', () => assert.strictEqual(r2.action, 'updated'));
  t('init: re-run is byte-stable', () => {
    const a = fs.readFileSync(target, 'utf8');
    init({ projectRoot: dir });
    assert.strictEqual(a, fs.readFileSync(target, 'utf8'));
  });
});

withProject({ 'package.json': JSON.stringify({ name: 'keep' }), 'AGENTS.md': '# keep\n\nUser prose stays.\n' }, (dir) => {
  init({ projectRoot: dir });
  t('init: preserves pre-existing user content outside the block', () => {
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert(body.includes('User prose stays.') && body.includes(AM.PROJECT_BEGIN));
  });
});

withProject({ 'package.json': JSON.stringify({ name: 'dry' }) }, (dir) => {
  const r = init({ projectRoot: dir, dryRun: true });
  t('init: --dry-run returns content without writing', () => {
    assert.strictEqual(r.action, 'dry-run');
    assert(typeof r.content === 'string' && r.content.includes('dry'));
    assert(!fs.existsSync(path.join(dir, 'AGENTS.md')));
  });
});

withProject({ 'package.json': JSON.stringify({ name: 'chk' }) }, (dir) => {
  t('init: --check reports drift before generation', () => assert.strictEqual(init({ projectRoot: dir, check: true }).inSync, false));
  init({ projectRoot: dir });
  t('init: --check reports in sync after generation', () => assert.strictEqual(init({ projectRoot: dir, check: true }).inSync, true));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
