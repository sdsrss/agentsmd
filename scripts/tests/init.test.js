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

for (const packageManager of ['npm', 'pnpm', 'yarn', 'bun']) withProject({
  'package.json': JSON.stringify({
    name: `${packageManager}-declared`,
    packageManager: `${packageManager}@1.2.3`,
    scripts: { test: 'runner' },
  }),
  'bun.lock': '',
  'pnpm-lock.yaml': '',
  'yarn.lock': '',
}, (dir) => {
  const d = detect(dir);
  t(`node: packageManager declaration wins over conflicting locks (${packageManager})`, () => {
    assert.strictEqual(d.packageManager, packageManager);
    assert.strictEqual(d.commands.test, `${packageManager} run test`);
  });
});

withProject({ 'package.json': JSON.stringify({ name: 'bun-modern' }), 'bun.lock': '' }, (dir) => {
  t('node: modern bun.lock selects bun', () => assert.strictEqual(detect(dir).packageManager, 'bun'));
});

withProject({ 'Cargo.toml': '[package]\nname = "krate"\n' }, (dir) => {
  const d = detect(dir);
  t('rust: detected from Cargo.toml', () => assert.strictEqual(d.language, 'Rust'));
  t('rust: cargo commands', () => assert.strictEqual(d.commands.test, 'cargo test'));
  t('rust: lib-only crate has no evidenced dev command (R4-05: facts, not guesses)', () => assert.strictEqual(d.commands.dev, null));
});

withProject({ 'Cargo.toml': '[package]\nname = "bincrate"\n', 'src/main.rs': 'fn main() {}\n' }, (dir) => {
  t('rust: a binary target evidences cargo run', () => assert.strictEqual(detect(dir).commands.dev, 'cargo run'));
});

withProject({ 'go.mod': 'module github.com/u/svc\n\ngo 1.22\n' }, (dir) => {
  const d = detect(dir);
  t('go: detected from go.mod', () => assert.strictEqual(d.language, 'Go'));
  t('go: project name from module path', () => assert.strictEqual(d.projectName, 'svc'));
  t('go: no root main.go → no evidenced dev command', () => assert.strictEqual(d.commands.dev, null));
});

withProject({ 'pyproject.toml': '[project]\nname = "pyapp"\n' }, (dir) => {
  const d = detect(dir);
  t('python: detected from pyproject.toml', () => assert.strictEqual(d.language, 'Python'));
  t('python: pytest not declared anywhere → test command is null, not assumed (R4-05)', () => assert.strictEqual(d.commands.test, null));
});

withProject({
  'pyproject.toml': '[project]\nname = "pyapp"\n[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
}, (dir) => {
  const d = detect(dir);
  t('python: declared pytest + ruff evidence their commands', () => {
    assert.strictEqual(d.commands.test, 'pytest');
    assert.strictEqual(d.commands.lint, 'ruff check');
  });
});

// ── R4-05: multi-stack repos report every manifest-verified ecosystem ─────────
withProject({
  'package.json': JSON.stringify({ name: 'poly', scripts: { test: 'node t.js' } }),
  'Cargo.toml': '[package]\nname = "polyrs"\n',
  'pyproject.toml': '[project]\nname = "polypy"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  'go.mod': 'module example.com/poly\n\ngo 1.22\n',
  'main.go': 'package main\n',
}, (dir) => {
  const d = detect(dir);
  t('multi-stack: all four ecosystems verified as stacks, primary stays Node', () => {
    assert.strictEqual(d.language, 'JavaScript');
    assert.deepStrictEqual(d.stacks.map((s) => s.language), ['JavaScript', 'Rust', 'Python', 'Go']);
  });
  t('multi-stack: each stack carries its own manifest-fact commands', () => {
    const by = Object.fromEntries(d.stacks.map((s) => [s.language, s.commands]));
    assert.strictEqual(by.JavaScript.test, 'npm run test');
    assert.strictEqual(by.Python.test, 'pytest');
    assert.strictEqual(by.Go.dev, 'go run .');
    assert.strictEqual(by.Rust.dev, null); // no binary evidence
  });
  t('multi-stack: rendered AGENTS.md lists the stacks and labels commands per runtime', () => {
    const md = require('../lib/project-templates').renderProjectAgentsMd(d);
    assert(/- Stacks: JavaScript \(Node\.js\) · Rust \(Cargo\) · Python · Go/.test(md), md);
    assert(md.includes('pytest  # test (Python)'), md);
    assert(md.includes('npm run test  # test (Node.js)'), md);
  });
});

withProject({ 'package.json': JSON.stringify({ name: 'solo' }) }, (dir) => {
  const d = detect(dir);
  t('single-stack: stacks has exactly the one verified entry; rendering stays unchanged', () => {
    assert.strictEqual(d.stacks.length, 1);
    const md = require('../lib/project-templates').renderProjectAgentsMd(d);
    assert(!/- Stacks:/.test(md), 'no Stacks line for a single-stack repo');
    assert(!/\(Node\.js\)\s*$/m.test(md), 'no runtime labels on single-stack commands');
  });
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
  t('merge: project and conventions blocks coexist without collision', () => {
    let c = AM.injectBlockBetween('# Repo\n', 'FACTS', AM.PROJECT_BEGIN, AM.PROJECT_END).content;
    c = AM.injectBlockBetween(c, 'CONV', AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END).content;
    assert(AM.hasBlockBetween(c, AM.PROJECT_BEGIN, AM.PROJECT_END));
    assert(AM.hasBlockBetween(c, AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END));
    // updating conventions leaves facts intact
    const c2 = AM.injectBlockBetween(c, 'CONV2', AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END).content;
    assert(c2.includes('FACTS') && c2.includes('CONV2') && !c2.includes('CONV\n'));
  });
  t('merge: hasBlockBetween false when absent', () =>
    assert(!AM.hasBlockBetween('nothing here', AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END)));
}

// Phase-2a M2: two managed blocks with user prose between them — re-injecting one
// block must preserve the prose and converge (byte-stable on a 2nd re-inject).
{
  const AM = require('../lib/agents-md');
  const twoBlock = [
    AM.PROJECT_BEGIN, 'proj v1', AM.PROJECT_END,
    '', 'user prose between blocks', '',
    AM.CONVENTIONS_BEGIN, 'conv v1', AM.CONVENTIONS_END, '',
  ].join('\n');
  const once = AM.injectBlockBetween(twoBlock, 'proj v2', AM.PROJECT_BEGIN, AM.PROJECT_END).content;
  t('injectBlockBetween: prose + sibling block survive a re-inject', () => {
    assert.ok(once.includes('user prose between blocks'), 'user prose preserved');
    assert.ok(once.includes('proj v2'), 'target block updated');
    assert.ok(once.includes(AM.CONVENTIONS_BEGIN) && once.includes('conv v1'), 'sibling conventions block intact');
  });
  const twice = AM.injectBlockBetween(once, 'proj v2', AM.PROJECT_BEGIN, AM.PROJECT_END).content;
  t('injectBlockBetween: byte-stable on 2nd re-inject (idempotent)', () => {
    assert.strictEqual(twice, once);
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
  t('render: facts block carries no Conventions section', () => assert(!/##\s*Conventions/.test(md)));
  t('render: carries no global-discipline headings (facts only)', () => assert(!/SAFETY|four-section|Iron Law/i.test(md)));

  const bare = renderProjectAgentsMd({
    language: 'Unknown', runtime: 'Unknown', projectName: 'x', packageManager: 'Unknown',
    monorepo: false, structure: [], commands: { dev: null, build: null, test: null, lint: null },
  });
  t('render: omits Structure and Commands when empty', () => assert(!bare.includes('## Structure') && !bare.includes('## Commands')));
  t('render: bare block still emits Project, no Conventions', () => assert(bare.includes('## Project') && !/##\s*Conventions/.test(bare)));

  const { renderConventionsSeed } = require('../lib/project-templates');
  const s = renderConventionsSeed();
  t('seed: conventions seed points at agentsmd-analyze', () => {
    assert(/##\s*Conventions/.test(s) && s.includes('agentsmd-analyze'));
  });
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

withProject({ 'package.json': JSON.stringify({ name: 'two' }) }, (dir) => {
  const target = path.join(dir, 'AGENTS.md');
  init({ projectRoot: dir });
  const body = fs.readFileSync(target, 'utf8');
  t('init: writes both facts and conventions blocks', () => {
    assert(body.includes(AM.PROJECT_BEGIN) && body.includes(AM.CONVENTIONS_BEGIN));
    assert(body.includes('agentsmd-analyze'));
  });
  // simulate analyze having filled the conventions block:
  const filled = body.replace(
    new RegExp(AM.CONVENTIONS_BEGIN + '[\\s\\S]*?' + AM.CONVENTIONS_END),
    AM.CONVENTIONS_BEGIN + '\n## Conventions\n\n- prefer const\n' + AM.CONVENTIONS_END);
  fs.writeFileSync(target, filled);
  init({ projectRoot: dir }); // re-init
  t('init: re-run preserves a filled conventions block (create-once)', () =>
    assert(fs.readFileSync(target, 'utf8').includes('- prefer const')));
});

withProject({ 'package.json': JSON.stringify({ name: 'loc' }) }, (dir) => {
  const r = init({ projectRoot: dir, local: true });
  t('--local: creates AGENTS.local.md', () => assert(fs.existsSync(path.join(dir, 'AGENTS.local.md')) && r.local.created));
  t('--local: adds it to .gitignore', () => assert(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('AGENTS.local.md')));
  // idempotent + no clobber:
  fs.writeFileSync(path.join(dir, 'AGENTS.local.md'), 'MINE');
  const r2 = init({ projectRoot: dir, local: true });
  t('--local: never clobbers an existing local file', () => assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS.local.md'), 'utf8'), 'MINE') && !r2.local.created);
  t('--local: gitignore append is idempotent', () => {
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.strictEqual(gi.match(/AGENTS\.local\.md/g).length, 1);
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'init-cas' }), 'AGENTS.md': '# original\n' }, (dir) => {
  const target = path.join(dir, 'AGENTS.md');
  const external = '# concurrent project tenant\n';
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(target)) {
      injected = true;
      fs.writeFileSync(target, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir }); }
  catch (caught) { error = caught; }
  finally { F.writeFileAtomic = realWrite; }
  t('init: AGENTS.md CAS rejects a concurrent replacement', () => assert(error && /concurrent change detected/i.test(error.message)));
  t('init: AGENTS.md CAS preserves concurrent third-party bytes', () => assert.strictEqual(fs.readFileSync(target, 'utf8'), external));
});
withProject({
  'package.json': JSON.stringify({ name: 'gitignore-cas' }),
  'AGENTS.local.md': 'MINE',
  '.gitignore': '# existing\n',
}, (dir) => {
  const target = path.join(dir, '.gitignore');
  const external = '# concurrent ignore tenant\n';
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(target)) {
      injected = true;
      fs.writeFileSync(target, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir, local: true }); }
  catch (caught) { error = caught; }
  finally { F.writeFileAtomic = realWrite; }
  t('--local: .gitignore CAS rejects a concurrent replacement', () => assert(error && /concurrent change detected/i.test(error.message)));
  t('--local: .gitignore CAS preserves concurrent third-party bytes', () => assert.strictEqual(fs.readFileSync(target, 'utf8'), external));
});
withProject({
  'package.json': JSON.stringify({ name: 'gitignore-cas-new-local' }),
  '.gitignore': '# existing\n',
}, (dir) => {
  const ignoreTarget = path.join(dir, '.gitignore');
  const localTarget = path.join(dir, 'AGENTS.local.md');
  const external = '# concurrent ignore tenant\n';
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(ignoreTarget)) {
      injected = true;
      fs.writeFileSync(ignoreTarget, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir, local: true }); }
  catch (caught) { error = caught; }
  finally { F.writeFileAtomic = realWrite; }
  t('--local: gitignore failure rolls back a newly-created local file', () => {
    assert(error && /concurrent change detected/i.test(error.message));
    assert.strictEqual(fs.existsSync(localTarget), false);
    assert.strictEqual(fs.readFileSync(ignoreTarget, 'utf8'), external);
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'local-race' }) }, (dir) => {
  const target = path.join(dir, 'AGENTS.local.md');
  const realWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(target) && options && options.flag === 'wx') {
      injected = true;
      realWrite(target, 'CONCURRENT LOCAL');
    }
    return realWrite(file, content, options);
  };
  let result;
  try { result = init({ projectRoot: dir, local: true }); }
  finally { fs.writeFileSync = realWrite; }
  t('--local: exclusive create preserves a file won by a concurrent creator', () => {
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'CONCURRENT LOCAL');
    assert.strictEqual(result.local.created, false);
  });
});
// ── --local three-file transaction: any write point fails → full rollback ─────
// The run touches main AGENTS.md, AGENTS.local.md, and .gitignore. A failure at
// ANY write point must leave all three byte-identical to (or as-absent as) their
// pre-run state, and must rethrow the original error unwrapped.

// Write point 1: main AGENTS.md write fails → nothing else touched.
withProject({
  'package.json': JSON.stringify({ name: 'tx-main' }),
  'AGENTS.md': '# main original\n',
  'AGENTS.local.md': 'LOCAL ORIGINAL',
  '.gitignore': '# gi original\n',
}, (dir) => {
  const agents = path.join(dir, 'AGENTS.md');
  const localP = path.join(dir, 'AGENTS.local.md');
  const gi = path.join(dir, '.gitignore');
  const snap = { agents: fs.readFileSync(agents, 'utf8'), local: fs.readFileSync(localP, 'utf8'), gi: fs.readFileSync(gi, 'utf8') };
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  const boom = new Error('injected main-write failure');
  F.writeFileAtomic = (file, content, options) => {
    if (path.resolve(String(file)) === path.resolve(agents)) throw boom;
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir, local: true }); }
  catch (caught) { error = caught; }
  finally { F.writeFileAtomic = realWrite; }
  t('tx: main-write failure rethrows the injected error unwrapped', () => assert.strictEqual(error, boom));
  t('tx: main-write failure leaves all three files at pre-run bytes', () => {
    assert.strictEqual(fs.readFileSync(agents, 'utf8'), snap.agents);
    assert.strictEqual(fs.readFileSync(localP, 'utf8'), snap.local);
    assert.strictEqual(fs.readFileSync(gi, 'utf8'), snap.gi);
  });
});

// Write point 2: AGENTS.local.md create fails after main already written →
// main must roll back to pre-run bytes; local stays absent; .gitignore untouched.
withProject({
  'package.json': JSON.stringify({ name: 'tx-local' }),
  'AGENTS.md': '# main original\n',
  '.gitignore': '# gi original\n',
}, (dir) => {
  const agents = path.join(dir, 'AGENTS.md');
  const localP = path.join(dir, 'AGENTS.local.md');
  const gi = path.join(dir, '.gitignore');
  const snapAgents = fs.readFileSync(agents, 'utf8');
  const snapGi = fs.readFileSync(gi, 'utf8');
  const realWrite = fs.writeFileSync;
  const boom = new Error('injected local-write failure');
  fs.writeFileSync = (file, content, options) => {
    if (path.resolve(String(file)) === path.resolve(localP) && options && options.flag === 'wx') throw boom;
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir, local: true }); }
  catch (caught) { error = caught; }
  finally { fs.writeFileSync = realWrite; }
  t('tx: local-write failure rethrows the injected error unwrapped', () => assert.strictEqual(error, boom));
  t('tx: local-write failure rolls the already-written main AGENTS.md back to pre-run bytes', () => assert.strictEqual(fs.readFileSync(agents, 'utf8'), snapAgents));
  t('tx: local-write failure leaves AGENTS.local.md absent', () => assert.strictEqual(fs.existsSync(localP), false));
  t('tx: local-write failure leaves .gitignore at pre-run bytes', () => assert.strictEqual(fs.readFileSync(gi, 'utf8'), snapGi));
});

// Write point 3: .gitignore update fails after main + local already written →
// this is the defect the fix targets: main AGENTS.md must roll back (old code
// left it modified), the newly-created local file must roll back to absent.
withProject({
  'package.json': JSON.stringify({ name: 'tx-gi' }),
  'AGENTS.md': '# main original\n',
  '.gitignore': '# gi original\n',
}, (dir) => {
  const agents = path.join(dir, 'AGENTS.md');
  const localP = path.join(dir, 'AGENTS.local.md');
  const gi = path.join(dir, '.gitignore');
  const snapAgents = fs.readFileSync(agents, 'utf8');
  const snapGi = fs.readFileSync(gi, 'utf8');
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  const boom = new Error('injected gitignore-write failure');
  F.writeFileAtomic = (file, content, options) => {
    if (path.resolve(String(file)) === path.resolve(gi)) throw boom;
    return realWrite(file, content, options);
  };
  let error;
  try { init({ projectRoot: dir, local: true }); }
  catch (caught) { error = caught; }
  finally { F.writeFileAtomic = realWrite; }
  t('tx: gitignore-write failure rethrows the injected error unwrapped', () => assert.strictEqual(error, boom));
  t('tx: gitignore-write failure rolls the already-written main AGENTS.md back to pre-run bytes', () => assert.strictEqual(fs.readFileSync(agents, 'utf8'), snapAgents));
  t('tx: gitignore-write failure rolls the newly-created AGENTS.local.md back to absent', () => assert.strictEqual(fs.existsSync(localP), false));
  t('tx: gitignore-write failure leaves .gitignore at pre-run bytes', () => assert.strictEqual(fs.readFileSync(gi, 'utf8'), snapGi));
});

t('--local: parseArgs recognizes the flag', () => assert.strictEqual(require('../init').parseArgs(['--local']).local, true));
t('parseArgs rejects --check with --dry-run instead of silently ignoring --dry-run', () =>
  assert.match(require('../init').parseArgs(['--check', '--dry-run']).error, /cannot be combined/));
t('parseArgs rejects --local with --check instead of silently ignoring --local', () =>
  assert.match(require('../init').parseArgs(['--check', '--local']).error, /cannot be combined/));
t('parseArgs rejects --local with --dry-run instead of silently ignoring --local', () =>
  assert.match(require('../init').parseArgs(['--dry-run', '--local']).error, /cannot be combined/));

// ── frontend detection (detect.js) ───────────────────────────────────────────
const { detectFrontend } = require('../lib/detect');
withProject({
  'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18', 'react-dom': '^18' }, devDependencies: { typescript: '^5', tailwindcss: '^3' } }),
  'tsconfig.json': '{}',
  'tailwind.config.js': 'module.exports = {}',
}, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: React detected from react dep', () => assert.strictEqual(f.framework, 'React'));
  t('frontend: Tailwind in uiLibs', () => assert(f.uiLibs.includes('Tailwind')));
  t('frontend: cssStrategy is Tailwind', () => assert.strictEqual(f.cssStrategy, 'Tailwind'));
  t('frontend: typescript flagged', () => assert.strictEqual(f.typescript, true));
});
withProject({ 'package.json': JSON.stringify({ name: 'nextapp', dependencies: { next: '^14', react: '^18' } }) }, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: Next.js meta-framework', () => assert.strictEqual(f.metaFramework, 'Next.js'));
  t('frontend: framework React under Next', () => assert.strictEqual(f.framework, 'React'));
});
withProject({ 'package.json': JSON.stringify({ name: 'nuxtapp', dependencies: { nuxt: '^3' } }) }, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: Nuxt infers Vue framework', () => { assert.strictEqual(f.metaFramework, 'Nuxt'); assert.strictEqual(f.framework, 'Vue'); });
});
withProject({ 'package.json': JSON.stringify({ name: 'sv', dependencies: { svelte: '^4' }, devDependencies: { '@sveltejs/kit': '^2' } }) }, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: Svelte + SvelteKit', () => { assert.strictEqual(f.framework, 'Svelte'); assert.strictEqual(f.metaFramework, 'SvelteKit'); });
});
withProject({ 'package.json': JSON.stringify({ name: 'mix', dependencies: { react: '^18', '@mui/material': '^5', '@emotion/react': '^11' } }) }, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: multiple UI libs collected', () => { assert(f.uiLibs.includes('MUI')); assert(f.uiLibs.includes('Emotion')); });
  t('frontend: cssStrategy CSS-in-JS via emotion', () => assert.strictEqual(f.cssStrategy, 'CSS-in-JS'));
});
withProject({ 'package.json': JSON.stringify({ name: 'shad', dependencies: { react: '^18' } }), 'components.json': '{}' }, (dir) => {
  t('frontend: shadcn/ui from components.json', () => assert(detect(dir).frontend.uiLibs.includes('shadcn/ui')));
});
withProject({ 'package.json': JSON.stringify({ name: 'plainnode', dependencies: { express: '^4' } }) }, (dir) => {
  t('frontend: non-frontend node project → frontend null', () => assert.strictEqual(detect(dir).frontend, null));
});
withProject({ 'Cargo.toml': '[package]\nname = "k"\n' }, (dir) => {
  t('frontend: non-node project → frontend null', () => assert.strictEqual(detect(dir).frontend, null));
});
t('frontend: detectFrontend exported', () => assert.strictEqual(typeof detectFrontend, 'function'));
withProject({ 'package.json': JSON.stringify({ name: 'astroapp', dependencies: { astro: '^4' } }) }, (dir) => {
  const f = detect(dir).frontend;
  t('frontend: pure-Astro project detected as Astro framework', () => assert.strictEqual(f.framework, 'Astro'));
});

// ── frontend section rendering (project-templates.js) ────────────────────────
const { renderFrontendSection } = require('../lib/project-templates');
{
  const fe = { framework: 'React', metaFramework: 'Next.js', uiLibs: ['Tailwind'], cssStrategy: 'Tailwind', typescript: true };
  const md = renderFrontendSection(fe);
  t('fe-render: heading present', () => assert(/##\s*Frontend/.test(md)));
  t('fe-render: stack line names framework + meta', () => assert(md.includes('React (Next.js)')));
  t('fe-render: stack notes TypeScript + Tailwind', () => assert(md.includes('TypeScript') && md.includes('Tailwind')));
  t('fe-render: facts-only — stack line present, no generic guideline bullets', () => {
    assert(md.includes('- Stack: React (Next.js)'));
    assert(!/Stack guidelines/.test(md) && !/one component per file/i.test(md) && !/avoid `any`/.test(md));
  });
  t('fe-render: null frontend → empty string', () => assert.strictEqual(renderFrontendSection(null), ''));

  const baseD = { language: 'TypeScript', runtime: 'Node.js', projectName: 'w', packageManager: 'npm', monorepo: false, structure: ['src'], commands: { dev: 'npm run dev', build: null, test: null, lint: null } };
  const on = renderProjectAgentsMd(Object.assign({}, baseD, { frontend: fe }), { includeFrontend: true });
  t('fe-render: renderProjectAgentsMd includes Frontend when includeFrontend true', () => assert(/##\s*Frontend/.test(on)));
  const off = renderProjectAgentsMd(Object.assign({}, baseD, { frontend: fe }), { includeFrontend: false });
  t('fe-render: suppressed when includeFrontend false', () => assert(!/##\s*Frontend/.test(off)));
  const none = renderProjectAgentsMd({ language: 'Go', runtime: 'Go', projectName: 'g', packageManager: 'go modules', monorepo: false, structure: [], commands: { dev: null, build: null, test: null, lint: null } });
  t('fe-render: no Frontend section when detection has no frontend', () => assert(!/##\s*Frontend/.test(none)));

  const astroMd = renderFrontendSection({ framework: 'Astro', metaFramework: 'Astro', uiLibs: [], cssStrategy: 'plain', typescript: false });
  t('fe-render: pure-Astro stack head dedups to "Astro" (not "Astro (Astro)")', () => {
    assert(astroMd.includes('Astro'));
    assert(!astroMd.includes('Astro (Astro)'));
  });
}

// ── init frontend end-to-end ─────────────────────────────────────────────────
withProject({ 'package.json': JSON.stringify({ name: 'fe', dependencies: { react: '^18', tailwindcss: '^3' }, devDependencies: { typescript: '^5' } }), 'tsconfig.json': '{}', 'src/i': '' }, (dir) => {
  const target = path.join(dir, 'AGENTS.md');
  const r = init({ projectRoot: dir });
  t('init-fe: frontendIncluded true for a React project', () => assert.strictEqual(r.frontendIncluded, true));
  t('init-fe: written AGENTS.md has a ## Frontend section', () => assert(/##\s*Frontend/.test(fs.readFileSync(target, 'utf8'))));
  t('init-fe: re-run byte-stable with Frontend section', () => {
    const a = fs.readFileSync(target, 'utf8'); init({ projectRoot: dir });
    assert.strictEqual(a, fs.readFileSync(target, 'utf8'));
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'feoff', dependencies: { react: '^18' } }) }, (dir) => {
  const r = init({ projectRoot: dir, noFrontend: true });
  t('init-fe: --no-frontend suppresses the section and flag', () => {
    assert.strictEqual(r.frontendIncluded, false);
    assert(!/##\s*Frontend/.test(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')));
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'beapp', dependencies: { express: '^4' } }) }, (dir) => {
  const r = init({ projectRoot: dir });
  t('init-fe: non-frontend project → no section, flag false', () => {
    assert.strictEqual(r.frontendIncluded, false);
    assert(!/##\s*Frontend/.test(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')));
  });
});
t('init-fe: parseArgs recognizes --no-frontend', () => assert.strictEqual(require('../init').parseArgs(['--no-frontend']).noFrontend, true));

withProject({ 'package.json': JSON.stringify({ name: 'fe-upgrade', dependencies: { react: '^18' } }) }, (dir) => {
  const r1 = init({ projectRoot: dir, noFrontend: true });
  t('init-fe: first run with --no-frontend has no Frontend section yet', () => {
    assert.strictEqual(r1.action, 'created');
    assert(!/##\s*Frontend/.test(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')));
  });
  const r2 = init({ projectRoot: dir });
  t('init-fe: upgrader run (PROJECT block exists, no Frontend yet) → frontendFirstAdded true though action is updated', () => {
    assert.strictEqual(r2.action, 'updated');
    assert.strictEqual(r2.frontendFirstAdded, true);
  });
  const r3 = init({ projectRoot: dir });
  t('init-fe: third run (Frontend already present) → frontendFirstAdded false', () => {
    assert.strictEqual(r3.action, 'updated');
    assert.strictEqual(r3.frontendFirstAdded, false);
  });
});
withProject({ 'package.json': JSON.stringify({ name: 'fe-new', dependencies: { react: '^18' } }) }, (dir) => {
  const r = init({ projectRoot: dir });
  t('init-fe: brand-new frontend project first run → frontendFirstAdded true', () => {
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(r.frontendFirstAdded, true);
  });
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
