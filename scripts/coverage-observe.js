'use strict';

// Observation-only V8 coverage for the repository's existing multi-process
// tests. Raw V8 ranges can support function and block-range counters, but they
// are not an executable-line denominator or a semantic JavaScript branch model.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { parsePositiveInt, parseStrict, printHelpAndExit } = require('./lib/argv');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PREFIX = 'agentsmd-coverage-observe-';
const DEFAULT_TOP = 50;
const MAX_TOP = 200;
const DEFAULT_LIMITS = Object.freeze({
  maxCaptureFiles: 4096,
  maxCaptureFileBytes: 32 * 1024 * 1024,
  maxCaptureTotalBytes: 512 * 1024 * 1024,
  maxProductionFiles: 4096,
});

const USAGE = [
  'Usage: node scripts/coverage-observe.js --run [--json] [--top=N]',
  '       node scripts/coverage-observe.js --capture-dir=<dir> [--json] [--top=N]',
  '',
  'Observe function and V8 block-range execution without enforcing thresholds.',
  '',
  'Options:',
  '  --run                   Run npm test with propagated NODE_V8_COVERAGE.',
  '  --capture-dir=<dir>     Analyze an existing capture directory read-only.',
  '  --top=N                 Limit uncovered functions in the report (1..200; default 50).',
  '  --json                  Emit the versioned JSON report.',
  '  -h, --help              Show this help.',
].join('\n');

function parseCoverageArgs(argv) {
  const parsed = parseStrict(argv, { bools: ['run', 'json'], values: ['capture-dir', 'top'] });
  const run = parsed.bools.has('run');
  const captureDir = Object.prototype.hasOwnProperty.call(parsed.values, 'capture-dir')
    ? parsed.values['capture-dir']
    : null;
  if (run === !!captureDir) throw new Error('choose exactly one of --run or --capture-dir=<dir>');
  const top = Object.prototype.hasOwnProperty.call(parsed.values, 'top')
    ? parsePositiveInt(parsed.values.top)
    : DEFAULT_TOP;
  if (top === null || top > MAX_TOP) throw new Error(`--top must be an integer in 1..${MAX_TOP}`);
  return { run, captureDir, json: parsed.bools.has('json'), top };
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function toRepoRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function isProductionJs(relative) {
  if (!relative.endsWith('.js')) return false;
  if (relative.startsWith('scripts/tests/')) return false;
  return relative.startsWith('bin/')
    || relative.startsWith('scripts/')
    || relative.startsWith('hooks/lib/')
    || relative.startsWith('qa/');
}

function productionFiles(root, limits = DEFAULT_LIMITS) {
  const files = [];
  const roots = ['bin', 'scripts', path.join('hooks', 'lib'), 'qa'];
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toRepoRelative(root, absolute);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (relative === 'scripts/tests' || relative.startsWith('scripts/tests/')) continue;
        walk(absolute);
      } else if (entry.isFile() && isProductionJs(relative)) {
        files.push(relative);
        if (files.length > limits.maxProductionFiles) {
          throw new Error(`production JavaScript file count exceeds ${limits.maxProductionFiles}`);
        }
      }
    }
  };
  for (const relative of roots) walk(path.join(root, relative));
  return files.sort();
}

function captureFiles(captureDir, limits = DEFAULT_LIMITS) {
  const stat = fs.lstatSync(captureDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('coverage capture path must be a regular directory');
  const names = fs.readdirSync(captureDir).filter((name) => /^coverage-.*[.]json$/u.test(name)).sort();
  if (names.length === 0) throw new Error('coverage capture directory contains no coverage-*.json files');
  if (names.length > limits.maxCaptureFiles) throw new Error(`coverage capture file count exceeds ${limits.maxCaptureFiles}`);
  let totalBytes = 0;
  return names.map((name) => {
    const file = path.join(captureDir, name);
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`coverage capture is not a regular file: ${name}`);
    if (fileStat.size > limits.maxCaptureFileBytes) {
      throw new Error(`coverage capture exceeds ${limits.maxCaptureFileBytes} bytes: ${name}`);
    }
    totalBytes += fileStat.size;
    if (totalBytes > limits.maxCaptureTotalBytes) {
      throw new Error(`coverage capture total exceeds ${limits.maxCaptureTotalBytes} bytes`);
    }
    return { file, name, bytes: fileStat.size };
  });
}

function validateRange(range, sourceLength, captureName) {
  if (!range || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)
      || !Number.isInteger(range.count) || range.startOffset < 0
      || range.endOffset < range.startOffset || range.endOffset > sourceLength
      || range.count < 0) {
    throw new Error(`invalid or source-drifted V8 range in ${captureName}`);
  }
}

function lineAtOffset(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function percentage(covered, total) {
  return total === 0 ? null : Number(((covered / total) * 100).toFixed(2));
}

function summarizeStates(states) {
  let functionsTotal = 0;
  let functionsCovered = 0;
  let blocksTotal = 0;
  let blocksCovered = 0;
  for (const state of states) {
    for (const fn of state.functions.values()) {
      functionsTotal += 1;
      if (fn.covered) functionsCovered += 1;
      for (const block of fn.blocks.values()) {
        blocksTotal += 1;
        if (block.covered) blocksCovered += 1;
      }
    }
  }
  return {
    functions: {
      covered: functionsCovered,
      total: functionsTotal,
      percent: percentage(functionsCovered, functionsTotal),
    },
    block_ranges: {
      covered: blocksCovered,
      total: blocksTotal,
      percent: percentage(blocksCovered, blocksTotal),
    },
  };
}

const FOCUS_MATCHERS = Object.freeze({
  lifecycle_and_rollback: /^(?:scripts\/(?:install|uninstall|repair|restore|backup|migrate)[.]js|scripts\/lib\/(?:fs-atomic|backup|lifecycle-journal|lifecycle-lock|repair-classification|uninstalled-shims)[.]js)$/u,
  parsers_and_arbitration: /^(?:hooks\/lib\/command-parse[.]js|scripts\/lib\/(?:argv|config-toml|surface-arbitration)[.]js)$/u,
  release_evidence: /^(?:scripts\/(?:conformance-candidate|conformance-binding|conformance-evidence|release-registry-pack|version-sync)[.]js|scripts\/lib\/release-artifact[.]js)$/u,
  telemetry_and_scorecard: /^(?:scripts\/(?:audit|outcomes|sampling-audit|lesson-bypass-audit|sparkline|scorecard)[.]js|scripts\/lib\/(?:telemetry|scorecard|outcomes-store)[.]js)$/u,
});

function focusNames(relative) {
  return Object.entries(FOCUS_MATCHERS)
    .filter(([, matcher]) => matcher.test(relative))
    .map(([name]) => name);
}

function collectCoverage(captureDir, options = {}) {
  const root = fs.realpathSync(options.root || ROOT);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const top = options.top ?? DEFAULT_TOP;
  if (!Number.isInteger(top) || top < 1 || top > MAX_TOP) throw new Error(`top must be in 1..${MAX_TOP}`);
  const production = productionFiles(root, limits);
  const productionSet = new Set(production);
  const captures = captureFiles(path.resolve(captureDir), limits);
  const states = new Map();
  let captureBytes = 0;
  let scriptEntries = 0;

  for (const capture of captures) {
    captureBytes += capture.bytes;
    let document;
    try { document = JSON.parse(fs.readFileSync(capture.file, 'utf8')); }
    catch (error) { throw new Error(`invalid coverage JSON ${capture.name}: ${error.message}`); }
    if (!document || !Array.isArray(document.result)) throw new Error(`coverage JSON has no result array: ${capture.name}`);
    for (const script of document.result) {
      if (!script || typeof script.url !== 'string' || !script.url.startsWith('file:')) continue;
      let absolute;
      try { absolute = fs.realpathSync(fileURLToPath(script.url)); }
      catch { continue; }
      if (!insideRoot(root, absolute)) continue;
      const relative = toRepoRelative(root, absolute);
      if (!productionSet.has(relative)) continue;
      const sourceStat = fs.lstatSync(absolute);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
      if (!Array.isArray(script.functions)) throw new Error(`coverage script has no functions array: ${capture.name}`);
      const source = fs.readFileSync(absolute, 'utf8');
      let state = states.get(relative);
      if (!state) {
        state = { relative, source, functions: new Map() };
        states.set(relative, state);
      } else if (state.source !== source) {
        throw new Error(`source bytes changed while coverage was collected: ${relative}`);
      }
      scriptEntries += 1;
      for (const fn of script.functions) {
        if (!fn || typeof fn.functionName !== 'string' || !Array.isArray(fn.ranges) || fn.ranges.length === 0) {
          throw new Error(`invalid V8 function coverage in ${capture.name}`);
        }
        for (const range of fn.ranges) validateRange(range, source.length, capture.name);
        const rootRange = fn.ranges[0];
        const functionKey = `${rootRange.startOffset}:${rootRange.endOffset}:${fn.functionName}`;
        let functionState = state.functions.get(functionKey);
        if (!functionState) {
          functionState = {
            name: fn.functionName,
            startOffset: rootRange.startOffset,
            endOffset: rootRange.endOffset,
            covered: false,
            blocks: new Map(),
          };
          state.functions.set(functionKey, functionState);
        }
        if (rootRange.count > 0) functionState.covered = true;
        for (const range of fn.ranges.slice(1)) {
          const blockKey = `${range.startOffset}:${range.endOffset}`;
          let block = functionState.blocks.get(blockKey);
          if (!block) {
            block = { startOffset: range.startOffset, endOffset: range.endOffset, covered: false };
            functionState.blocks.set(blockKey, block);
          }
          if (range.count > 0) block.covered = true;
        }
      }
    }
  }

  const observed = [...states.keys()].sort();
  const unobserved = production.filter((relative) => !states.has(relative));
  const observedStates = observed.map((relative) => states.get(relative));
  const metrics = summarizeStates(observedStates);
  const fileMetrics = observed.map((relative) => ({
    file: relative,
    ...summarizeStates([states.get(relative)]),
  }));
  const focus = {};
  for (const [name, matcher] of Object.entries(FOCUS_MATCHERS)) {
    const focusObserved = observed.filter((relative) => matcher.test(relative));
    const focusUnobserved = unobserved.filter((relative) => matcher.test(relative));
    focus[name] = {
      observed_files: focusObserved,
      unobserved_files: focusUnobserved,
      ...summarizeStates(focusObserved.map((relative) => states.get(relative))),
    };
  }

  const uncovered = [];
  for (const relative of observed) {
    const state = states.get(relative);
    for (const fn of state.functions.values()) {
      if (fn.covered) continue;
      uncovered.push({
        file: relative,
        line: lineAtOffset(state.source, fn.startOffset),
        function: (fn.name || '<anonymous>').slice(0, 160),
        focus: focusNames(relative),
      });
    }
  }
  uncovered.sort((left, right) => {
    const focusDelta = Number(right.focus.length > 0) - Number(left.focus.length > 0);
    return focusDelta || left.file.localeCompare(right.file) || left.line - right.line
      || left.function.localeCompare(right.function);
  });

  const git = (args) => {
    const result = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(['rev-parse', 'HEAD']);
  const dirtyOutput = git(['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    schema_version: 1,
    mode: 'v8-observation',
    threshold_enforced: false,
    source_tree: {
      commit,
      dirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
    },
    runtime: { node: process.version },
    capture: {
      files: captures.length,
      bytes: captureBytes,
      production_script_entries: scriptEntries,
    },
    production_files: {
      total: production.length,
      observed: observed.length,
      unobserved: unobserved.length,
      unobserved_files: unobserved,
    },
    metrics,
    focus,
    files: fileMetrics,
    uncovered_function_count: uncovered.length,
    uncovered_functions: uncovered.slice(0, top),
    uncovered_functions_truncated: Math.max(0, uncovered.length - top),
    exact_lines: {
      status: 'unmeasured',
      reason: 'raw V8 ranges do not define a source-mapped executable-line denominator',
    },
    semantic_branches: {
      status: 'unmeasured',
      reason: 'nested V8 block ranges are execution counters, not a semantic JavaScript branch taxonomy',
    },
    limitations: [
      'Metrics cover this npm test execution only and do not represent production workloads.',
      'Files absent from every capture are listed separately and have no inferred function denominator.',
      'Function and block-range identity is deduplicated across subprocess captures; counts are reduced to covered or uncovered.',
      'No threshold affects the command exit status.',
    ],
  };
}

function ownedWorkspace(root, tmpDir = os.tmpdir()) {
  const resolvedRoot = path.resolve(root);
  const resolvedTmp = path.resolve(tmpDir);
  return path.dirname(resolvedRoot) === resolvedTmp
    && path.basename(resolvedRoot).startsWith(WORKSPACE_PREFIX);
}

function createCoverageWorkspace(tmpDir = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(path.resolve(tmpDir), WORKSPACE_PREFIX));
  const captureDir = path.join(root, 'capture');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(captureDir, { mode: 0o700 });
  fs.mkdirSync(codexHome, { mode: 0o700 });
  return { root, captureDir, codexHome };
}

function cleanupCoverageWorkspace(root, tmpDir = os.tmpdir()) {
  if (!ownedWorkspace(root, tmpDir)) throw new Error(`refusing unexpected coverage cleanup path: ${root}`);
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('refusing non-directory coverage workspace cleanup');
  fs.rmSync(root, { recursive: true, force: false });
}

function runObservation(options = {}) {
  const root = fs.realpathSync(options.root || ROOT);
  const tmpDir = options.tmpDir || os.tmpdir();
  const spawnSync = options.spawnSync || cp.spawnSync;
  const workspace = createCoverageWorkspace(tmpDir);
  const started = Date.now();
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const childEnv = {
      ...process.env,
      CODEX_HOME: workspace.codexHome,
      NODE_V8_COVERAGE: workspace.captureDir,
      AGENTSMD_TELEMETRY_TAG: 'qa',
    };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
    delete childEnv.CODEX_ACCESS_TOKEN;
    const result = spawnSync(npm, ['test'], {
      cwd: root,
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const tail = `${result.stdout || ''}\n${result.stderr || ''}`.slice(-8000);
      throw new Error(`npm test failed during coverage observation (exit ${result.status}):\n${tail}`);
    }
    const report = collectCoverage(workspace.captureDir, {
      root,
      top: options.top ?? DEFAULT_TOP,
      limits: options.limits,
    });
    report.test_run = { command: 'npm test', exit_code: 0, duration_ms: Date.now() - started };
    return report;
  } finally {
    cleanupCoverageWorkspace(workspace.root, tmpDir);
  }
}

function renderHuman(report) {
  const lines = [
    'agentsmd V8 coverage observation (no threshold)',
    `source: ${report.source_tree.commit || 'unknown'}${report.source_tree.dirty ? ' (dirty)' : ''}`,
    `capture: ${report.capture.files} files / ${report.capture.bytes} bytes`,
    `production JS: ${report.production_files.observed}/${report.production_files.total} observed; ${report.production_files.unobserved} unobserved`,
    `functions: ${report.metrics.functions.covered}/${report.metrics.functions.total} (${report.metrics.functions.percent === null ? 'n/a' : `${report.metrics.functions.percent}%`})`,
    `V8 block ranges: ${report.metrics.block_ranges.covered}/${report.metrics.block_ranges.total} (${report.metrics.block_ranges.percent === null ? 'n/a' : `${report.metrics.block_ranges.percent}%`})`,
    `exact lines: ${report.exact_lines.status} — ${report.exact_lines.reason}`,
    `semantic branches: ${report.semantic_branches.status} — ${report.semantic_branches.reason}`,
    `uncovered functions: ${report.uncovered_function_count} (showing ${report.uncovered_functions.length})`,
  ];
  for (const entry of report.uncovered_functions) {
    lines.push(`- ${entry.file}:${entry.line} ${entry.function}${entry.focus.length ? ` [${entry.focus.join(',')}]` : ''}`);
  }
  return lines.join('\n');
}

function main(argv) {
  printHelpAndExit(argv, USAGE);
  let options;
  try { options = parseCoverageArgs(argv); }
  catch (error) {
    console.error(`agentsmd coverage observe: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const report = options.run
      ? runObservation({ top: options.top })
      : collectCoverage(options.captureDir, { top: options.top });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHuman(report));
    return 0;
  } catch (error) {
    console.error(`agentsmd coverage observe failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  DEFAULT_LIMITS,
  MAX_TOP,
  USAGE,
  cleanupCoverageWorkspace,
  collectCoverage,
  createCoverageWorkspace,
  isProductionJs,
  main,
  ownedWorkspace,
  parseCoverageArgs,
  productionFiles,
  renderHuman,
  runObservation,
};
