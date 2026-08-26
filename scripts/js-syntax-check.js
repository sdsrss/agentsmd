#!/usr/bin/env node
'use strict';

// Dependency-free syntax compatibility gate. Each repository JavaScript file
// is parsed by the active Node executable, so the existing CI runtime matrix
// checks the exact syntax it claims to support without executing the file.

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = Object.freeze(['bin', 'scripts', path.join('hooks', 'lib'), 'qa']);
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 4096,
  maxFileBytes: 4 * 1024 * 1024,
  timeoutMs: 5000,
  maxReportedFailures: 100,
  maxDiagnosticChars: 2048,
});
const USAGE = [
  'Usage: node scripts/js-syntax-check.js [--json]',
  '',
  'Parse every repository JavaScript file with the active Node runtime.',
  'This is a syntax/runtime-compatibility gate; it does not execute source files.',
].join('\n');

function parseArgs(argv) {
  const parsed = parseStrict(argv, { bools: ['json'], values: [] });
  return { json: parsed.bools.has('json') };
}

function repoRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function collectJavaScriptFiles(root = ROOT, options = {}) {
  const resolvedRoot = fs.realpathSync(root);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const files = [];
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const relative = repoRelative(resolvedRoot, absolute);
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`${relative}: JavaScript file exceeds ${limits.maxFileBytes} bytes`);
      }
      files.push(relative);
      if (files.length > limits.maxFiles) {
        throw new Error(`JavaScript file count exceeds ${limits.maxFiles}`);
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const directory = path.join(resolvedRoot, scanRoot);
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) throw new Error(`${scanRoot}: JavaScript scan root must be a directory`);
    walk(directory);
  }
  return files.sort();
}

function sanitizeDiagnostic(value, root, maxChars) {
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  return String(value || '')
    .split(normalizedRoot).join('')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, maxChars)
    .trim();
}

function checkJavaScript(root = ROOT, options = {}) {
  const resolvedRoot = fs.realpathSync(root);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const spawnSync = options.spawnSync || cp.spawnSync;
  const node = options.node || process.execPath;
  const files = collectJavaScriptFiles(resolvedRoot, { limits });
  const failures = [];
  let failureCount = 0;
  const started = Date.now();

  for (const relative of files) {
    const result = spawnSync(node, ['--check', relative], {
      cwd: resolvedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: limits.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const passed = !result.error && !result.signal && result.status === 0;
    if (passed) continue;
    failureCount += 1;
    if (failures.length >= limits.maxReportedFailures) continue;
    const detail = result.stderr || result.stdout || (result.error && result.error.message) || 'syntax check failed';
    failures.push({
      file: relative,
      exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal || null,
      error_code: result.error && result.error.code ? String(result.error.code).slice(0, 80) : null,
      diagnostic: sanitizeDiagnostic(detail, resolvedRoot, limits.maxDiagnosticChars),
    });
  }

  return {
    schema_version: 1,
    ok: failureCount === 0,
    runtime: { node: process.version },
    files_checked: files.length,
    failures: failureCount,
    failure_details: failures,
    failure_details_truncated: Math.max(0, failureCount - failures.length),
    duration_ms: Date.now() - started,
    scope: SCAN_ROOTS.map((entry) => entry.split(path.sep).join('/')),
    limits: {
      max_files: limits.maxFiles,
      max_file_bytes: limits.maxFileBytes,
      per_file_timeout_ms: limits.timeoutMs,
      max_reported_failures: limits.maxReportedFailures,
      max_diagnostic_chars: limits.maxDiagnosticChars,
    },
    measurement_boundary: 'syntax parsing only; no source file is executed and no semantic lint rule is inferred',
  };
}

function renderHuman(report) {
  const lines = [
    `JavaScript syntax compatibility: ${report.ok ? 'PASS' : 'FAIL'}`,
    `runtime: ${report.runtime.node}`,
    `files: ${report.files_checked}`,
    `failures: ${report.failures}`,
    `duration: ${report.duration_ms} ms`,
  ];
  for (const failure of report.failure_details) {
    lines.push(`- ${failure.file}: ${failure.diagnostic || failure.error_code || 'syntax check failed'}`);
  }
  if (report.failure_details_truncated) lines.push(`- ${report.failure_details_truncated} more failure(s) truncated`);
  lines.push(`boundary: ${report.measurement_boundary}`);
  return lines.join('\n');
}

function main(argv) {
  printHelpAndExit(argv, USAGE);
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    console.error(`agentsmd js syntax check: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const report = checkJavaScript(ROOT);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHuman(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`agentsmd js syntax check failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  DEFAULT_LIMITS,
  SCAN_ROOTS,
  USAGE,
  checkJavaScript,
  collectJavaScriptFiles,
  main,
  parseArgs,
  renderHuman,
  sanitizeDiagnostic,
};
