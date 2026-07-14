'use strict';
// detect.js — static, deterministic project detection for the project-level
// AGENTS.md generator. Parses real manifest files (never greps JSON) to identify
// language/runtime, package manager, build/test/dev commands, top-level source
// structure, and monorepo layout. Language-agnostic core (Node/Rust/Python/Go);
// frontend-specific detection (UI lib → design tokens) is a Phase 2 module.

const fs = require('fs');
const path = require('path');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const isDir = (root, rel) => { try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; } };

function detectNodePackageManager(root, packageJson = null) {
  const pkg = packageJson || readJson(path.join(root, 'package.json'));
  const declared = pkg && typeof pkg.packageManager === 'string'
    ? pkg.packageManager.trim().match(/^(npm|pnpm|yarn|bun)(?:@[^\s]+)?$/)
    : null;
  if (declared) return declared[1];
  if (exists(root, 'bun.lock')) return 'bun';
  if (exists(root, 'bun.lockb')) return 'bun';
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  return 'npm';
}

const STRUCTURE_CANDIDATES = ['src', 'app', 'lib', 'pkg', 'cmd', 'internal', 'tests', 'test', 'scripts', 'packages', 'apps'];
function detectStructure(root) {
  return STRUCTURE_CANDIDATES.filter((d) => isDir(root, d));
}

function detectNode(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts || {};
  const pm = detectNodePackageManager(root, pkg);
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const hasTs = exists(root, 'tsconfig.json') || !!deps.typescript;
  const run = (name) => (scripts[name] ? `${pm} run ${name}` : null);
  return {
    language: hasTs ? 'TypeScript' : 'JavaScript',
    runtime: 'Node.js',
    projectName: String(pkg.name || path.basename(root)).replace(/^@[^/]+\//, ''),
    packageManager: pm,
    monorepo: !!pkg.workspaces || exists(root, 'pnpm-workspace.yaml') || exists(root, 'lerna.json'),
    commands: { dev: run('dev') || run('start') || run('serve'), build: run('build'), test: run('test'), lint: run('lint') },
  };
}

// Command facts (R4-05): a command is asserted only from manifest/script evidence.
// Toolchain-inherent commands (cargo build/test, go build/test/vet) are facts of the
// manifest's existence; anything conditional is evidence-gated — `cargo run` needs a
// binary target, `pytest`/`ruff` need to be declared, `go run .` needs a root main
// package. Unevidenced → null (the template simply omits the line), never guessed.
function detectRust(root) {
  const toml = readText(path.join(root, 'Cargo.toml'));
  if (toml === null) return null;
  const nameMatch = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  const hasBin = exists(root, path.join('src', 'main.rs')) || /^\s*\[\[bin\]\]/m.test(toml);
  return {
    language: 'Rust', runtime: 'Cargo',
    projectName: nameMatch ? nameMatch[1] : path.basename(root),
    packageManager: 'cargo',
    monorepo: /^\s*\[workspace\]/m.test(toml),
    commands: { dev: hasBin ? 'cargo run' : null, build: 'cargo build --release', test: 'cargo test', lint: 'cargo clippy' },
  };
}

function detectPython(root) {
  const pyproject = readText(path.join(root, 'pyproject.toml'));
  const requirements = ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt']
    .map((f) => readText(path.join(root, f))).filter((t) => t !== null).join('\n');
  if (pyproject === null && !exists(root, 'setup.py') && !requirements) return null;
  const pm = exists(root, 'poetry.lock') ? 'poetry' : exists(root, 'uv.lock') ? 'uv' : 'pip';
  const declared = (tool) => new RegExp(`\\b${tool}\\b`).test(pyproject || '') || new RegExp(`^${tool}\\b`, 'm').test(requirements);
  const hasPytest = declared('pytest') || exists(root, 'pytest.ini');
  return {
    language: 'Python', runtime: 'Python',
    projectName: path.basename(root),
    packageManager: pm, monorepo: false,
    commands: { dev: null, build: null, test: hasPytest ? 'pytest' : null, lint: declared('ruff') ? 'ruff check' : null },
  };
}

function detectGo(root) {
  const mod = readText(path.join(root, 'go.mod'));
  if (mod === null) return null;
  const m = mod.match(/^module\s+(\S+)/m);
  const hasRootMain = exists(root, 'main.go');
  return {
    language: 'Go', runtime: 'Go',
    projectName: m ? path.basename(m[1]) : path.basename(root),
    packageManager: 'go modules', monorepo: false,
    commands: { dev: hasRootMain ? 'go run .' : null, build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' },
  };
}

const FE_FRAMEWORKS = [
  ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'], ['solid-js', 'Solid'], ['preact', 'Preact'],
];
const FE_META = [
  ['next', 'Next.js', 'React'], ['nuxt', 'Nuxt', 'Vue'],
  ['@remix-run/react', 'Remix', 'React'], ['@sveltejs/kit', 'SvelteKit', 'Svelte'],
  ['astro', 'Astro', 'Astro'], ['vite', 'Vite', null],
];
const FE_UILIBS = [
  ['tailwindcss', 'Tailwind'], ['@mui/material', 'MUI'], ['@chakra-ui/react', 'Chakra'],
  ['antd', 'Ant Design'], ['@mantine/core', 'Mantine'],
  ['styled-components', 'styled-components'], ['@emotion/react', 'Emotion'],
];
const TAILWIND_CONFIGS = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'];

function detectFrontend(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return null;
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);

  let framework = null;
  for (const [dep, name] of FE_FRAMEWORKS) { if (has(dep)) { framework = name; break; } }
  let metaFramework = null;
  for (const [dep, name, implies] of FE_META) {
    if (has(dep)) { metaFramework = name; if (!framework && implies) framework = implies; break; }
  }
  if (!framework) return null; // no base framework → not a frontend project

  const uiLibs = [];
  for (const [dep, name] of FE_UILIBS) { if (has(dep)) uiLibs.push(name); }
  if (TAILWIND_CONFIGS.some((f) => exists(root, f)) && !uiLibs.includes('Tailwind')) uiLibs.push('Tailwind');
  if (exists(root, 'components.json')) uiLibs.push('shadcn/ui');

  let cssStrategy = 'plain';
  if (uiLibs.includes('Tailwind')) cssStrategy = 'Tailwind';
  else if (uiLibs.includes('styled-components') || uiLibs.includes('Emotion')) cssStrategy = 'CSS-in-JS';
  else if (has('sass') || has('node-sass')) cssStrategy = 'Sass';

  return {
    framework, metaFramework, uiLibs, cssStrategy,
    typescript: exists(root, 'tsconfig.json') || has('typescript'),
  };
}

function detect(projectRoot) {
  const root = projectRoot || process.cwd();
  // R4-05: a repo can host several ecosystems (Node CLI + Python tooling + Go
  // service). Every detector runs; `stacks` lists ALL verified matches — each one
  // backed by its own manifest, never inferred. The top-level fields remain the
  // primary stack (same priority order as before) for compatibility.
  const stacks = [detectNode(root), detectRust(root), detectPython(root), detectGo(root)].filter(Boolean);
  const base = stacks[0] || {
    language: 'Unknown', runtime: 'Unknown', projectName: path.basename(root),
    packageManager: 'Unknown', monorepo: false, commands: { dev: null, build: null, test: null, lint: null },
  };
  const frontend = base.runtime === 'Node.js' ? detectFrontend(root) : null;
  return Object.assign({}, base, { stacks, structure: detectStructure(root), frontend });
}

module.exports = { detect, detectNode, detectRust, detectPython, detectGo, detectStructure, detectNodePackageManager, detectFrontend };
