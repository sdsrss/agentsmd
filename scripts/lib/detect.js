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

function detectNodePackageManager(root) {
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
  const pm = detectNodePackageManager(root);
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

function detectRust(root) {
  const toml = readText(path.join(root, 'Cargo.toml'));
  if (toml === null) return null;
  const nameMatch = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return {
    language: 'Rust', runtime: 'Cargo',
    projectName: nameMatch ? nameMatch[1] : path.basename(root),
    packageManager: 'cargo',
    monorepo: /\[workspace\]/.test(toml),
    commands: { dev: 'cargo run', build: 'cargo build --release', test: 'cargo test', lint: 'cargo clippy' },
  };
}

function detectPython(root) {
  if (!exists(root, 'pyproject.toml') && !exists(root, 'setup.py') && !exists(root, 'requirements.txt')) return null;
  const pm = exists(root, 'poetry.lock') ? 'poetry' : exists(root, 'uv.lock') ? 'uv' : 'pip';
  return {
    language: 'Python', runtime: 'Python',
    projectName: path.basename(root),
    packageManager: pm, monorepo: false,
    commands: { dev: null, build: null, test: 'pytest', lint: null },
  };
}

function detectGo(root) {
  const mod = readText(path.join(root, 'go.mod'));
  if (mod === null) return null;
  const m = mod.match(/^module\s+(\S+)/m);
  return {
    language: 'Go', runtime: 'Go',
    projectName: m ? path.basename(m[1]) : path.basename(root),
    packageManager: 'go modules', monorepo: false,
    commands: { dev: 'go run .', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' },
  };
}

const FE_FRAMEWORKS = [
  ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'], ['solid-js', 'Solid'], ['preact', 'Preact'],
];
const FE_META = [
  ['next', 'Next.js', 'React'], ['nuxt', 'Nuxt', 'Vue'],
  ['@remix-run/react', 'Remix', 'React'], ['@sveltejs/kit', 'SvelteKit', 'Svelte'],
  ['astro', 'Astro', null], ['vite', 'Vite', null],
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
  const base = detectNode(root) || detectRust(root) || detectPython(root) || detectGo(root) || {
    language: 'Unknown', runtime: 'Unknown', projectName: path.basename(root),
    packageManager: 'Unknown', monorepo: false, commands: { dev: null, build: null, test: null, lint: null },
  };
  const frontend = base.runtime === 'Node.js' ? detectFrontend(root) : null;
  return Object.assign({}, base, { structure: detectStructure(root), frontend });
}

module.exports = { detect, detectNode, detectRust, detectPython, detectGo, detectStructure, detectNodePackageManager, detectFrontend };
