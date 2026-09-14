'use strict';

// Development-only measurements. Not a runtime CLI or a new quality threshold.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const acorn = require('acorn');
const { parseStrict } = require('../scripts/lib/argv');
const ROOT = path.resolve(__dirname, '..');
const lines = (s) => (s ? s.split('\n').length - Number(s.endsWith('\n')) : 0);
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const executable = (f) => /\.(?:[cm]?js|sh)$/.test(f);
const testFile = (f) =>
  /(?:^|\/)(?:tests|fixtures)(?:\/|$)|\.test\.[cm]?js$/.test(f);
const canonical = (f) =>
  executable(f) &&
  !testFile(f) &&
  (f === 'install.sh' || /^(?:bin|scripts|hooks|qa)\//.test(f));

function inventory(root = ROOT) {
  root = fs.realpathSync(root);
  const result = cp.spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (result.status !== 0)
    throw new Error(`git inventory failed: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .sort()
    .flatMap((file) => {
      const absolute = path.join(root, file);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        fs.realpathSync(absolute) !== absolute
      )
        return [];
      const bytes = fs.readFileSync(absolute);
      return [
        {
          file,
          bytes: bytes.length,
          sha256: digest(bytes),
          lines: bytes.includes(0) ? null : lines(bytes.toString('utf8')),
        },
      ];
    });
}

function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value))
      value.forEach((child) => walk(child, node, visit));
    else if (value && typeof value === 'object') walk(value, node, visit);
  }
}

function analyzeJs(source, file) {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: file.endsWith('.mjs') ? 'module' : 'commonjs',
    locations: true,
  });
  const functions = [],
    imports = [],
    dynamic = [],
    exports = [];
  walk(ast, null, (node, parent) => {
    if (
      [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
      ].includes(node.type)
    ) {
      functions.push({
        file,
        name:
          node.id?.name ||
          parent?.id?.name ||
          parent?.key?.name ||
          '<anonymous>',
        line: node.loc.start.line,
        end: node.loc.end.line,
        lines: node.loc.end.line - node.loc.start.line + 1,
        parameters: node.params.length,
      });
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      if (node.source)
        imports.push({ request: node.source.value, line: node.loc.start.line });
    }
    if (
      node.type === 'ImportExpression' ||
      (node.type === 'CallExpression' && node.callee.name === 'require')
    ) {
      const arg = node.source || node.arguments[0];
      if (arg?.type === 'Literal' && typeof arg.value === 'string')
        imports.push({ request: arg.value, line: node.loc.start.line });
      else
        dynamic.push({
          file,
          line: node.loc.start.line,
          expression: source.slice(node.start, node.end).slice(0, 160),
        });
    }
    if (
      node.type === 'AssignmentExpression' &&
      source.slice(node.left.start, node.left.end) === 'module.exports'
    ) {
      exports.push({
        line: node.loc.start.line,
        declaration: source.slice(node.right.start, node.right.end),
      });
    }
  });
  return { functions, imports, dynamic, exports };
}

function dependencyGraph(modules, resources = new Set()) {
  const names = new Set(Object.keys(modules));
  const graph = Object.fromEntries([...names].map((name) => [name, []]));
  const unresolved = [],
    nonModule = [];
  for (const [file, data] of Object.entries(modules)) {
    for (const entry of data.imports) {
      if (!entry.request.startsWith('.')) continue;
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), entry.request)
      );
      const target = [
        base,
        `${base}.js`,
        `${base}.cjs`,
        `${base}.mjs`,
        `${base}/index.js`,
      ].find((f) => names.has(f));
      if (target) graph[file].push(target);
      else if (resources.has(base))
        nonModule.push({ file, ...entry, target: base });
      else unresolved.push({ file, ...entry });
    }
    graph[file] = [...new Set(graph[file])].sort();
  }
  return { graph, unresolved, non_module: nonModule };
}

function cycles(graph) {
  let serial = 0;
  const index = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    found = [];
  function visit(node) {
    index.set(node, serial);
    low.set(node, serial++);
    stack.push(node);
    active.add(node);
    for (const next of graph[node] || []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (active.has(next))
        low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let next;
    do {
      next = stack.pop();
      active.delete(next);
      component.push(next);
    } while (next !== node);
    if (component.length > 1 || (graph[node] || []).includes(node))
      found.push(component.sort());
  }
  Object.keys(graph)
    .sort()
    .forEach((node) => {
      if (!index.has(node)) visit(node);
    });
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

function duplication(sources, minimum = 8) {
  if (!Number.isInteger(minimum) || minimum < 2)
    throw new Error('minimum must be at least 2');
  const windows = new Map(),
    covered = new Set();
  let total = 0;
  for (const [file, text] of Object.entries(sources)) {
    const normalized = text
      .split('\n')
      .map((text, i) => ({ text: text.trim(), line: i + 1 }))
      .filter((r) => r.text);
    total += normalized.length;
    for (let i = 0; i <= normalized.length - minimum; i++) {
      const key = JSON.stringify(
        normalized.slice(i, i + minimum).map((r) => r.text)
      );
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push({
        file,
        lines: normalized.slice(i, i + minimum).map((r) => r.line),
      });
    }
  }
  const groups = [];
  for (const occurrences of windows.values()) {
    if (occurrences.length < 2) continue;
    for (const occurrence of occurrences)
      for (const line of occurrence.lines)
        covered.add(`${occurrence.file}:${line}`);
    groups.push(
      occurrences.map((r) => ({
        file: r.file,
        line: r.lines[0],
        end: r.lines.at(-1),
      }))
    );
  }
  return {
    minimum_nonblank_lines: minimum,
    duplicated_lines: covered.size,
    total_nonblank_lines: total,
    percent: total ? Number(((100 * covered.size) / total).toFixed(2)) : null,
    matching_windows: groups.length,
    examples: groups.slice(0, 30),
    examples_truncated: Math.max(0, groups.length - 30),
  };
}

function measure(root = ROOT) {
  const files = inventory(root),
    sources = {},
    modules = {};
  for (const entry of files.filter((e) => canonical(e.file))) {
    sources[entry.file] = fs.readFileSync(path.join(root, entry.file), 'utf8');
    if (/\.[cm]?js$/.test(entry.file))
      modules[entry.file] = analyzeJs(sources[entry.file], entry.file);
  }
  const functions = Object.values(modules).flatMap((m) => m.functions);
  const deps = dependencyGraph(modules, new Set(files.map((f) => f.file)));
  const sorted = (list) =>
    [...list]
      .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
      .slice(0, 10);
  const copies = Object.fromEntries(
    files
      .filter((e) => executable(e.file) && !testFile(e.file))
      .map((e) => [e.file, fs.readFileSync(path.join(root, e.file), 'utf8')])
  );
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    runtime: process.version,
    tools: {
      acorn: require('acorn/package.json').version,
      prettier: require('prettier/package.json').version,
    },
    source_digest: digest(JSON.stringify(files.map((f) => [f.file, f.sha256]))),
    scope: {
      inventory:
        'Git tracked plus nonignored untracked regular files; missing tracked files and symlinks excluded',
      canonical_source:
        'non-test JS/CJS/MJS/Shell under bin,scripts,hooks,qa plus install.sh; excludes mirrored skills',
      long_functions:
        'JavaScript AST only, all nested functions/arrows, physical start/end lines; Shell unmeasured',
      duplication:
        'union of nonblank lines in repeated 8-line windows after trim; includes comments; not semantic clones',
      cycles:
        'cyclic SCCs of static literal local JS imports; no lexical require binding analysis or full Node resolver; dynamic/spawn/Shell edges not inferred',
    },
    repository: {
      files: files.length,
      text_files: files.filter((f) => f.lines !== null).length,
      total_lines: files.reduce((n, f) => n + (f.lines || 0), 0),
      largest: sorted(files.filter((f) => f.lines !== null)),
    },
    source: {
      files: Object.keys(sources).length,
      total_lines: Object.values(sources).reduce((n, s) => n + lines(s), 0),
      largest: sorted(files.filter((f) => canonical(f.file))),
      javascript_files: Object.keys(modules).length,
    },
    functions: {
      total: functions.length,
      over_50: functions.filter((f) => f.lines > 50).length,
      long: functions
        .filter((f) => f.lines > 50)
        .sort((a, b) => b.lines - a.lines),
      over_5_parameters: functions.filter((f) => f.parameters > 5),
    },
    duplication: duplication(sources),
    distribution_duplication: duplication(copies),
    dependencies: {
      ...deps,
      cycles: cycles(deps.graph),
      dynamic: Object.entries(modules).flatMap(([, m]) => m.dynamic),
    },
    modules: Object.fromEntries(
      Object.entries(modules).map(([f, m]) => [
        f,
        { exports: m.exports, functions: m.functions.length },
      ])
    ),
    files,
  };
}

function runChecks(includeCoverage = true) {
  const { runObservation } = require('../scripts/coverage-observe');
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agentsmd-engineering-baseline-')
  );
  const env = {
    ...process.env,
    TMPDIR: scratch,
    CODEX_HOME: path.join(scratch, 'home'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    PATH: `${path.join(ROOT, 'scripts/tests/fixtures')}${path.delimiter}${process.env.PATH || ''}`,
  };
  delete env.AGENTSMD_SKIP_LIVE_GUARD;
  delete env.AGENTSMD_LIVE_GUARD_HOME;
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'])
    delete env[key];
  const commands = [];
  const run = (command, argv, options = {}) => {
    process.stderr.write(`baseline check: ${command} ${argv.join(' ')}\n`);
    const start = Date.now();
    const childEnv = {
      ...env,
      ...options.env,
      TMPDIR: scratch,
      npm_config_cache: env.npm_config_cache,
      PATH: env.PATH,
    };
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'AGENTSMD_SKIP_LIVE_GUARD',
      'AGENTSMD_LIVE_GUARD_HOME',
    ])
      delete childEnv[key];
    const result = cp.spawnSync(command, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600000,
      ...options,
      env: childEnv,
    });
    commands.push({
      command: [command, ...argv],
      exit: result.status,
      signal: result.signal,
      duration_ms: Date.now() - start,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message || null,
    });
    if (result.error) throw result.error;
    return result;
  };
  try {
    // Existing suite and live guard run exactly once; reuse its V8 observation.
    let coverage = { status: 'not-run', reason: 'static checks only' };
    if (includeCoverage) {
      try {
        coverage = runObservation({ tmpDir: scratch, spawnSync: run });
      } catch (error) {
        coverage = { status: 'failed', error: error.message };
      }
    }
    run('npm', ['run', 'test:phase4']);
    run('npm', ['run', 'lint']);
    const shellFiles = inventory()
      .filter(
        (f) =>
          f.file === 'install.sh' ||
          /^(hooks\/[^/]+|hooks\/lib\/[^/]+|hooks\/tests\/[^/]+|qa\/[^/]+)\.sh$/.test(
            f.file
          )
      )
      .map((f) => f.file);
    const shell = run('shellcheck', [
      '-S',
      'warning',
      '--format=json',
      ...shellFiles,
    ]);
    const syntax = run(process.execPath, [
      'scripts/js-syntax-check.js',
      '--json',
    ]);
    const argv = run(process.execPath, ['scripts/lint-argv.js', '--json']);
    const formatter = run(process.execPath, [
      'node_modules/prettier/bin/prettier.cjs',
      '--list-different',
      '--single-quote',
      '--trailing-comma',
      'es5',
      '{bin,scripts,hooks/lib,qa}/**/*.{js,cjs}',
      'package.json',
    ]);
    const details = {
      shell: JSON.parse(shell.stdout),
      syntax: JSON.parse(syntax.stdout),
      argv: JSON.parse(argv.stdout),
    };
    return {
      status: coverage.status === 'failed' ? 'failed' : 'completed',
      coverage,
      commands,
      lint_details: details,
      formatting: {
        exit: formatter.status,
        files: formatter.stdout.trim().split('\n').filter(Boolean),
        status:
          formatter.status === 0
            ? 'pass'
            : formatter.status === 1
              ? 'existing-format-differences'
              : 'tool-error',
      },
    };
  } catch (error) {
    return { status: 'failed', error: error.message, commands };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log(
      'Usage: node qa/engineering-baseline.cjs [--checks | --static-checks]\nJSON to stdout; --checks runs isolated tests/coverage/lint/format; --static-checks skips full tests/coverage. Neither rewrites source.'
    );
    return 0;
  }
  const options = parseStrict(argv, {
    bools: ['checks', 'static-checks'],
    values: [],
  });
  if (options.bools.size > 1)
    throw new Error('choose --checks or --static-checks');
  const before = measure();
  if (options.bools.size)
    before.checks = runChecks(options.bools.has('checks'));
  if (measure().source_digest !== before.source_digest)
    throw new Error('source changed during measurement');
  console.log(JSON.stringify(before, null, 2));
  return before.checks?.status === 'failed' ||
    before.checks?.commands.some((c) => c.exit !== 0)
    ? 1
    : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`engineering baseline: ${error.message}`);
    process.exitCode = 2;
  }
}
module.exports = {
  analyzeJs,
  canonical,
  cycles,
  dependencyGraph,
  duplication,
  inventory,
  lines,
  measure,
};
