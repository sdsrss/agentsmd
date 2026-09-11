'use strict';

// Native Codex event journal. Persist only bounded classifications and
// repo-relative file names: never raw commands, patches, prompts, cwd, models,
// tool responses, or file contents.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lexSafetyCommands } = require('./command-parse');

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_MAX_FILES = 256;
const JOURNAL_ROW_MAX_BYTES = 16 * 1024;

const MUTATION_RE = /((?:npx\s+)?prettier\b[^\n]*(?:--write|-w\b)|eslint\b[^\n]*--fix\b|biome\b[^\n]*(?:--write|--fix)\b|gofmt\b[^\n]*-w\b|rustfmt\b|cargo\s+fmt\b|sed\b[^\n]*\s-i(?:\s|$)|perl\b[^\n]*\s-pi\b|npm\s+run\s+(?:format|fmt)\b)/i;
const RUFF_MUTATION_RE = /\bruff\s+format\b/i;
const RUFF_CHECK_RE = /\bruff\s+format\b[^\n]*--check\b/i;
const PREFLIGHT_RE = /(?:^|[;&|]\s*)(?:command\s+)?git(?:\s+-[A-Za-z]\s+\S+|\s+--[A-Za-z-]+(?:=\S+|\s+\S+))*\s+status(?:\s|$)/i;
const REVIEW_RE = /(?:^|[;&|]\s*)(?:command\s+)?git(?:\s+-[A-Za-z]\s+\S+|\s+--[A-Za-z-]+(?:=\S+|\s+\S+))*\s+diff(?:\s|$)/i;

function safeKey(value, fallback = 'unknown') {
  const clean = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

function journalDir(stateDir, sessionId) {
  if (!path.isAbsolute(stateDir)) throw new Error('event journal stateDir must be absolute');
  return path.join(stateDir, `event-journal-${safeKey(sessionId, 'global')}.d`);
}

function safeRepoRelative(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\\/g, '/');
  if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return null;
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.slice(0, 512);
}

function patchFiles(command) {
  if (typeof command !== 'string') return [];
  const files = [];
  const pattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  for (const match of command.matchAll(pattern)) {
    const relative = safeRepoRelative(match[1]);
    if (relative) files.push(relative);
  }
  return [...new Set(files)].slice(0, 64);
}

function mutationFiles(event) {
  const input = event && event.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const files = [];
  for (const key of ['path', 'file_path']) {
    const relative = safeRepoRelative(input[key]);
    if (relative) files.push(relative);
  }
  return [...new Set(files)].slice(0, 64);
}

function commandFrom(event) {
  const input = event && event.tool_input;
  return input && typeof input.command === 'string' ? input.command : '';
}

function findExitCode(value, seen = new Set()) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    for (const key of ['exit_code', 'exitCode']) {
      if (Object.hasOwn(value, key) && Number.isInteger(Number(value[key]))) return Number(value[key]);
    }
    for (const child of Object.values(value)) {
      const found = findExitCode(child, seen);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  const match = value.match(/\b(?:exit[_ ]?code|exited(?:\s+with\s+code)?)\s*[:=]?\s*(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function responseOutcome(response) {
  const exitCode = findExitCode(response);
  if (exitCode != null) return { exit_code: exitCode, outcome: exitCode === 0 ? 'success' : 'failure' };
  const text = typeof response === 'string' ? response : JSON.stringify(response == null ? null : response);
  const failed = /\b(?:Script failed|tool_error|timed out|permission denied|Process exited (?:with code )?[1-9]\d*)\b/i.test(text);
  return { exit_code: null, outcome: failed ? 'failure' : 'success' };
}

function validationType(command) {
  if (/\bnpm\s+run\s+check\b|\bmake\s+check\b/i.test(command)) return 'full-check';
  if (/\b(?:tsc|typecheck|cargo\s+check)\b/i.test(command)) return 'typecheck';
  if (/\b(?:lint|eslint|shellcheck|clippy|ruff\s+check|biome\s+(?:check|lint))\b/i.test(command)) return 'lint';
  if (/\b(?:build|cargo\s+build)\b/i.test(command)) return 'build';
  return 'test';
}

// Single literal commands, or an AND-chain containing only checks. Reuse the
// safety lexer's raw/cooked tokens; reject all unconsumed control syntax.
function validationCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 16384 || depth > 2) return null;
  const commands = lexSafetyCommands(command);
  if (!commands.length || commands.length > 16) return null;
  let cursor = 0;
  const types = [];
  for (let index = 0; index < commands.length; index += 1) {
    const words = commands[index].words;
    for (const word of words) {
      while (/\s/.test(command[cursor] || '')) cursor += 1;
      if (word.expands || !command.startsWith(word.raw, cursor)) return null;
      cursor += word.raw.length;
    }
    while (/\s/.test(command[cursor] || '')) cursor += 1;
    if (index < commands.length - 1) {
      if (!command.startsWith('&&', cursor)) return null;
      cursor += 2;
    } else if (cursor !== command.length) return null;
    let argv = words.map((word) => word.value);
    if (path.basename(argv[0]) === 'env') argv = argv.slice(1);
    let pythonOptimize = process.env.PYTHONOPTIMIZE || '';
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] || '')) {
      if (argv[0].startsWith('PYTHONOPTIMIZE=')) {
        pythonOptimize = argv[0].slice(15);
        if (pythonOptimize && pythonOptimize !== '0') return null;
      }
      if (/^(?:NODE_OPTIONS|npm_config_ignore_scripts|NPM_CONFIG_IGNORE_SCRIPTS)=/.test(argv[0])) return null;
      argv = argv.slice(1);
    }
    if (argv[0] === 'command') argv = argv.slice(argv[1] === '--' ? 2 : 1);
    if (argv[0] === 'npx') argv = argv.slice(argv[1] === '--no-install' ? 2 : 1);
    if (!argv.length) return null;
    const name = path.basename(argv[0]);
    const args = argv.slice(1);
    if (args.some((arg) => ['--help', '--version', '--fix', '--write', '-w', '--dry-run',
      '--ignore-scripts', '--showConfig', '--print-config', '--collect-only', '--no-run',
      '--listTests', '--list-tests', '--listFilesOnly'].includes(arg.split('=')[0]))) return null;
    if (name === 'make' && args.some((arg) => /^-[^-]*[nqt]/u.test(arg)
      || ['--just-print', '--dry-run', '--recon', '--question', '--touch'].includes(arg.split('=')[0]))) return null;
    const script = (value) => typeof value === 'string' && /(?:^|\/)(?:tests?\/[^\n]+|[^/]+\.test\.[cm]?[jt]sx?|(?:verify|validate|check|test|smoke)(?:[-.][\w-]+)?\.(?:[cm]?[jt]s|py|sh))$/u.test(value);
    let type = null;
    if (['bash', 'sh'].includes(name) && ['-c', '-lc'].includes(args[0]) && args.length === 2) {
      type = validationCommand(args[1], depth + 1);
    } else if (['node', 'bash', 'sh'].includes(name) && script(args[0])) type = 'test';
    else if (name === 'node' && ['--check', '-c'].includes(args[0]) && args.length === 2 && !args[1].startsWith('-')) type = 'syntax';
    else if (/^python(?:[23](?:\.\d+)?)?$/u.test(name)) {
      if (args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) type = 'test';
      else if (script(args[0])) type = 'test';
      else if ((!pythonOptimize || pythonOptimize === '0') && args.length === 2 && args[0] === '-c' && /^assert\s+[^;\r\n]+$/u.test(args[1])) type = 'test';
    } else if (['npm', 'yarn', 'pnpm'].includes(name)) {
      const task = args[0] === 'run' ? args[1] : args[0];
      if (/^(?:test|lint|check|typecheck|build)(?::[\w-]+)?$/u.test(task || '')) type = validationType(`${name} ${args.join(' ')}`);
    } else if (['pytest', 'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'shellcheck', 'clippy'].includes(name)) type = validationType(name);
    else if (name === 'cargo' && ['test', 'build', 'check', 'clippy'].includes(args[0])) type = validationType(`${name} ${args[0]}`);
    else if (name === 'go' && args[0] === 'test') type = 'test';
    else if (name === 'make' && ['test', 'check'].includes(args[0])) type = validationType(`${name} ${args[0]}`);
    else if (name === 'biome' && ['check', 'lint'].includes(args[0])) type = 'lint';
    else if (name === 'ruff' && (args[0] === 'check' || args[0] === 'format' && args.includes('--check'))) type = 'lint';
    if (!type) return null;
    types.push(type);
  }
  return types.length === 1 ? types[0] : 'test';
}

// Execution envelopes supply status. Arbitrary stdout and nested user data do
// not. Unknown/nonterminal responses cannot establish fresh validation.
function validationOutcome(response) {
  // Native Bash strings are stdout, even when they happen to be JSON.
  // Decode transcript transport envelopes only at the fallback boundary.
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const values = ['exit_code', 'exitCode'].filter((key) => Object.hasOwn(response, key)).map((key) => response[key]);
  if (!values.length || values.some((value) => !Number.isInteger(value)) || new Set(values).size !== 1 || response.signal) return null;
  const exitCode = values[0];
  return { exit_code: exitCode, outcome: exitCode === 0 ? 'success' : 'failure' };
}

function classifyPost(event) {
  const toolName = String(event.tool_name || '');
  const command = commandFrom(event);
  const result = responseOutcome(event.tool_response);
  if (toolName === 'update_plan') {
    return { state: 'plan_observed', ...result, validation_type: null, repo_relative_files: [] };
  }
  if (toolName === 'apply_patch') {
    return {
      state: 'mutation_completed',
      ...result,
      validation_type: null,
      repo_relative_files: patchFiles(command),
    };
  }
  if (toolName !== 'Bash') return null;
  if (PREFLIGHT_RE.test(command)) {
    return { state: 'preflight_observed', ...result, validation_type: null, repo_relative_files: [] };
  }
  const checkType = validationCommand(command);
  if (checkType) {
    const completion = validationOutcome(event.tool_response);
    if (!completion) return { state: 'validation_observed', outcome: 'unknown', exit_code: null,
      validation_type: checkType, repo_relative_files: [], reason_code: 'terminal-status-unavailable' };
    return {
      state: 'validation_completed',
      ...completion,
      validation_type: checkType,
      repo_relative_files: [],
    };
  }
  if (MUTATION_RE.test(command) || (RUFF_MUTATION_RE.test(command) && !RUFF_CHECK_RE.test(command))) {
    return {
      state: 'mutation_completed',
      ...result,
      validation_type: null,
      repo_relative_files: [],
      reason_code: 'known-in-place-writer',
    };
  }
  if (REVIEW_RE.test(command)) {
    return { state: 'review_observed', ...result, validation_type: null, repo_relative_files: [] };
  }
  return null;
}

function readRows(stateDir, sessionId) {
  const dir = journalDir(stateDir, sessionId);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d{13}-[A-Za-z0-9._-]+\.json$/.test(name)).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_ROW_MAX_BYTES) continue;
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (row && row.schema_version === JOURNAL_SCHEMA_VERSION && row.session_id === sessionId) rows.push(row);
    } catch {
      // One damaged row cannot make the Stop consumer discard other evidence.
    }
  }
  const rank = (row) => row.state === 'mutation_completed' ? 2
    : row.state === 'validation_completed' ? 1 : 0;
  return rows.sort((a, b) => (a.observed_at_ms - b.observed_at_ms)
    || (rank(a) - rank(b))
    || String(a.event_id).localeCompare(String(b.event_id)));
}

function writeRow(stateDir, row, options = {}) {
  const dir = journalDir(stateDir, row.session_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const timestamp = String(row.observed_at_ms).padStart(13, '0');
  const nonce = safeKey(options.nonce || crypto.randomBytes(8).toString('hex'), 'event');
  const identity = safeKey(`${process.pid}-${nonce}-${row.turn_id}-${row.tool_use_id}-${row.state}`);
  const name = `${timestamp}-${identity}.json`;
  const target = path.join(dir, name);
  const temp = path.join(dir, `.tmp-${process.pid}-${nonce}`);
  const serialized = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(serialized) > JOURNAL_ROW_MAX_BYTES) throw new Error('event journal row exceeds cap');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temp); } catch { /* renamed or never created */ }
  }

  // Bounded destructive path: only regular journal rows in this exact session
  // directory are candidates. Tests exercise this against an isolated fixture.
  const rows = fs.readdirSync(dir).filter((entry) => /^\d{13}-[A-Za-z0-9._-]+\.json$/.test(entry)).sort();
  for (const old of rows.slice(0, Math.max(0, rows.length - JOURNAL_MAX_FILES))) {
    const oldPath = path.join(dir, old);
    try {
      const stat = fs.lstatSync(oldPath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(oldPath);
    } catch {
      // A concurrent cap sweep may already have removed the same old row.
    }
  }
  return row;
}

function processEvent(mode, event, options = {}) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  const stateDir = options.stateDir;
  const surface = safeKey(options.surface, 'unknown');
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const base = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    observed_at_ms: nowMs,
    event_id: safeKey(options.nonce || crypto.randomBytes(8).toString('hex'), 'event'),
    surface,
    session_id: String(event.session_id || ''),
    turn_id: String(event.turn_id || ''),
    tool_use_id: String(event.tool_use_id || ''),
    hook_event_name: String(event.hook_event_name || ''),
    tool_name: String(event.tool_name || ''),
  };
  if (!base.session_id || !base.turn_id || !base.tool_use_id) return null;

  let classified;
  if (mode === 'pre') {
    if (!['apply_patch', 'Edit', 'Write'].includes(base.tool_name)) return null;
    const earlier = readRows(stateDir, base.session_id).filter((row) => row.turn_id === base.turn_id);
    classified = {
      state: 'mutation_intent',
      outcome: 'started',
      exit_code: null,
      validation_type: null,
      repo_relative_files: base.tool_name === 'apply_patch'
        ? patchFiles(commandFrom(event))
        : mutationFiles(event),
      preflight_observed: earlier.some((row) => row.state === 'preflight_observed' && row.outcome === 'success'),
      plan_observed: earlier.some((row) => row.state === 'plan_observed' && row.outcome === 'success'),
    };
  } else if (mode === 'post') {
    classified = classifyPost(event);
    if (!classified) return null;
  } else {
    throw new Error(`unknown journal mode: ${mode}`);
  }

  return writeRow(stateDir, { ...base, ...classified }, options);
}

function summarizeJournal(stateDir, sessionId, turnId) {
  const rows = readRows(stateDir, sessionId).filter((row) => row.turn_id === turnId);
  const successfulMutations = rows.filter((row) => row.state === 'mutation_completed' && row.outcome === 'success');
  const firstMutationIndex = rows.findIndex((row) => row.state === 'mutation_intent' || row.state === 'mutation_completed');
  let latestMutationIndex = -1;
  rows.forEach((row, index) => {
    if (row.state === 'mutation_completed' && row.outcome === 'success') latestMutationIndex = index;
  });
  const freshValidation = latestMutationIndex >= 0 && rows.slice(latestMutationIndex + 1)
    .some((row) => row.state === 'validation_completed' && row.outcome === 'success');
  const preMutationRows = firstMutationIndex < 0 ? rows : rows.slice(0, firstMutationIndex);
  const intentRows = rows.filter((row) => row.state === 'mutation_intent');
  return {
    schema_version: JOURNAL_SCHEMA_VERSION,
    source: 'native-event-journal',
    events: rows.length,
    mutations: successfulMutations.length,
    validations: rows.filter((row) => row.state === 'validation_completed').length,
    failed_validations: rows.filter((row) => row.state === 'validation_completed' && row.outcome === 'failure').length,
    fresh_validation: freshValidation,
    fresh_validation_unknown: latestMutationIndex >= 0 && rows.slice(latestMutationIndex + 1)
      .some((row) => row.state === 'validation_observed' && row.outcome === 'unknown'),
    preflight_before_mutation: preMutationRows.some((row) => row.state === 'preflight_observed' && row.outcome === 'success')
      || intentRows.some((row) => row.preflight_observed === true),
    plan_before_mutation: preMutationRows.some((row) => row.state === 'plan_observed' && row.outcome === 'success')
      || intentRows.some((row) => row.plan_observed === true),
    repo_relative_files: [...new Set(successfulMutations.flatMap((row) => row.repo_relative_files || []))].sort(),
  };
}

function parseCli(argv) {
  let mode = '';
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) mode = arg.slice('--mode='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['pre', 'post'].includes(mode)) throw new Error('--mode must be pre or post');
  return mode;
}

function main() {
  let mode;
  try {
    mode = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agentsmd event journal: ${error.message}\n`);
    process.exit(2);
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      processEvent(mode, event, {
        stateDir: process.env.AGENTSMD_EVENT_JOURNAL_STATE_DIR,
        surface: process.env.AGENTSMD_EVENT_JOURNAL_SURFACE,
      });
    } catch (error) {
      process.stderr.write(`agentsmd event journal: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

if (require.main === module) main();

module.exports = {
  JOURNAL_MAX_FILES,
  JOURNAL_ROW_MAX_BYTES,
  classifyPost,
  mutationFiles,
  patchFiles,
  processEvent,
  readRows,
  responseOutcome,
  validationCommand,
  validationOutcome,
  safeRepoRelative,
  summarizeJournal,
};
