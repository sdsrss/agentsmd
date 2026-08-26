'use strict';

const fs = require('fs');
const path = require('path');
const F = require('../scripts/lib/fs-atomic');
const { parseStrict } = require('../scripts/lib/argv');
const { maskMultilineStrings } = require('../scripts/lib/config-toml');
const { platformCanonicalPath } = require('../scripts/lib/paths');

const MAX_CONFIG_BYTES = 1024 * 1024;
const SANDBOX_BASENAME_RE = /^agentsmd-conformance\.[A-Za-z0-9]+$/u;

function sameCanonicalPath(left, right, platform = process.platform) {
  return platformCanonicalPath(left, platform) === platformCanonicalPath(right, platform);
}

function validateSandbox(value) {
  const sandbox = path.resolve(value);
  const stat = fs.lstatSync(sandbox);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || !sameCanonicalPath(fs.realpathSync(sandbox), sandbox)) {
    throw new Error('sandbox must be a real non-symlink directory');
  }
  if (!SANDBOX_BASENAME_RE.test(path.basename(sandbox))) {
    throw new Error('sandbox basename must match agentsmd-conformance.<random>');
  }
  return sandbox;
}

function validateConfig(file) {
  const config = path.resolve(file);
  const stat = fs.lstatSync(config);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('config must be a regular non-symlink file');
  if (!owned) throw new Error('config must be owned by the current user');
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
  return config;
}

function tableHeader(line) {
  const source = line.replace(/\r?\n$/u, '');
  const match = source.match(/^\[projects\."([^"\\\r\n]+)"\]$/u);
  return match ? match[1] : null;
}

function isAnyTableHeader(line) {
  return /^\s*\[[^\r\n]+\]\s*(?:#.*)?\r?\n?$/u.test(line);
}

function removeProjectTrustTables(configFile, sandboxValue, options = {}) {
  const sandbox = validateSandbox(sandboxValue);
  const config = validateConfig(configFile);
  const snapshot = F.snapshotFile(config);
  const content = snapshot.content.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(snapshot.content)) {
    throw new Error('config must contain valid UTF-8');
  }
  const masked = maskMultilineStrings(content);
  if (!masked.valid) throw new Error('cannot clean config with an unterminated TOML string');
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) || [];
  const maskedLines = masked.content.match(/[^\n]*\n|[^\n]+$/gu) || [];
  if (lines.length !== maskedLines.length) throw new Error('config masking changed line boundaries');
  const removals = [];

  for (let index = 0; index < lines.length; index += 1) {
    const project = tableHeader(maskedLines[index]);
    if (!project) continue;
    const resolvedProject = path.resolve(project);
    if (!sameCanonicalPath(path.dirname(resolvedProject), sandbox)
      || !path.basename(resolvedProject).startsWith('case-')) continue;
    if (project !== resolvedProject) throw new Error('task project trust path must be canonical');

    let end = index + 1;
    while (end < lines.length && !isAnyTableHeader(maskedLines[end])) end += 1;
    const meaningful = [];
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (!/^\s*(?:#.*)?(?:\r?\n)?$/u.test(maskedLines[cursor])) meaningful.push(lines[cursor]);
    }
    if (meaningful.length !== 1 || !/^\s*trust_level\s*=\s*"trusted"\s*\r?\n?$/u.test(meaningful[0])) {
      throw new Error(`task project trust table has unexpected content: ${path.basename(resolvedProject)}`);
    }
    let start = index;
    if (start > 0 && /^\s*\r?\n$/u.test(lines[start - 1])) start -= 1;
    else if (end < lines.length && /^\s*\r?\n$/u.test(lines[end])) end += 1;
    removals.push([start, end]);
    index = end - 1;
  }

  if (removals.length === 0) return { removed: 0, changed: false };
  const merged = [];
  for (const [start, end] of removals.sort((left, right) => left[0] - right[0])) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  for (const [start, end] of merged.reverse()) lines.splice(start, end - start);
  const next = Buffer.from(lines.join(''), 'utf8');
  const write = options.write || F.writeFileAtomic;
  write(config, next, {
    expectedSnapshot: snapshot,
    mode: snapshot.mode,
    preserveMode: false,
  });
  return { removed: removals.length, changed: true };
}

function parseArgs(argv) {
  const parsed = parseStrict(argv, { values: ['config', 'sandbox'] });
  const output = { config: parsed.values.config || null, sandbox: parsed.values.sandbox || null };
  if (!output.config || !output.sandbox) throw new Error('--config and --sandbox are required');
  return output;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    process.stdout.write(`${JSON.stringify(removeProjectTrustTables(args.config, args.sandbox))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`agentsmd conformance trust cleanup: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, removeProjectTrustTables, sameCanonicalPath };
