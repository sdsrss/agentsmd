'use strict';

// Native Codex event journal. Persist only bounded classifications and
// repo-relative file names: never raw commands, patches, prompts, cwd, models,
// tool responses, or file contents.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lexSafetyCommands } = require('./command-parse');
const { platformCanonicalPath } = require('../../scripts/lib/paths');

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

function safeRepoRelative(raw, cwd) {
  if (typeof raw !== 'string') return null;
  if (path.isAbsolute(raw.trim()) && (raw !== raw.trim() || (path.sep === '/' && raw.includes('\\')))) return null;
  let value = raw.trim().replace(/\\/g, '/');
  if (!value || value.includes('\0')) return null;
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !path.isAbsolute(value)
        || value.length > 4096 || path.normalize(value) !== value) return null;
    try {
      const root = fs.realpathSync(cwd);
      if (root !== platformCanonicalPath(cwd)) return null;
      value = path.relative(root, platformCanonicalPath(value));
      if (!value || value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) return null;
      const parts = value.split(path.sep);
      if (parts.length > 64) return null;
      let current = root;
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return null;
      }
      value = value.replace(/\\/g, '/');
    } catch { return null; }
  }
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.slice(0, 512);
}

function patchFiles(command, cwd) {
  if (typeof command !== 'string') return [];
  const files = [];
  const pattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  let scanned = 0;
  for (const match of command.matchAll(pattern)) {
    if (scanned++ >= 64) break;
    const relative = safeRepoRelative(match[1], cwd);
    if (relative) files.push(relative);
  }
  return [...new Set(files)].slice(0, 64);
}

function mutationFiles(event) {
  const input = event && event.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const files = [];
  for (const key of ['path', 'file_path']) {
    const relative = safeRepoRelative(input[key], event.cwd);
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
      repo_relative_files: patchFiles(command, event.cwd),
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
  const receiptIds = new Set();
  return rows.filter((row) => {
    if (row.reason_code !== 'transcript-terminal-status') return true;
    if (receiptIds.has(row.event_id)) return false;
    receiptIds.add(row.event_id);
    return true;
  }).sort((a, b) => (a.observed_at_ms - b.observed_at_ms)
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
        ? patchFiles(commandFrom(event), event.cwd)
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

// The native Bash payload can omit status. At Stop, the exact runtime-supplied
// transcript can independently prove a completed check. Never join its call_id
// to a native tool_use_id: these are different namespaces in Codex 0.154.0.
function transcriptTerminalRows(event, nativeRows, nowMs) {
  const { singleAwaitedCommand, singleAwaitedPatch } = require('./orchestrator-source');
  const file = event.transcript_path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return [];
  const cap = 1 << 19;
  let fd;
  let records;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(file) !== platformCanonicalPath(file)) return [];
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) return [];
    const head = Buffer.alloc(Math.min(stat.size, 65536));
    fs.readSync(fd, head, 0, head.length, 0);
    const end = head.indexOf(10);
    if (end < 0) return [];
    const meta = JSON.parse(head.subarray(0, end).toString('utf8'));
    if (meta.type !== 'session_meta' || meta.payload?.id !== event.session_id) return [];
    const start = Math.max(0, stat.size - cap);
    const tail = Buffer.alloc(stat.size - start);
    fs.readSync(fd, tail, 0, tail.length, start);
    const lines = tail.toString('utf8').split(/\r?\n/u);
    if (start > 0) lines.shift();
    records = lines.filter(Boolean).map((line) => JSON.parse(line));
    // An append or replacement during the read is not a stable receipt.
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev
        || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return [];
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }

  let boundary = -1;
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].type === 'event_msg' && records[i].payload?.type === 'task_started') boundary = i;
  }
  if (boundary < 0 || records[boundary].payload.turn_id !== event.turn_id) return [];
  const calls = new Map();
  const outputs = new Map();
  const turnOf = (payload) => payload.internal_chat_message_metadata_passthrough?.turn_id;
  for (let i = boundary + 1; i < records.length; i += 1) {
    const record = records[i];
    const p = record.payload;
    if (record.type === 'turn_context' && p?.turn_id && p.turn_id !== event.turn_id) return [];
    if (record.type !== 'response_item' || !p) continue;
    const call = ['custom_tool_call', 'function_call'].includes(p.type);
    const output = ['custom_tool_call_output', 'function_call_output'].includes(p.type);
    if (!call && !output) continue;
    if (turnOf(p) !== event.turn_id || typeof p.call_id !== 'string' || !p.call_id) return [];
    const map = call ? calls : outputs;
    if (map.has(p.call_id)) return [];
    const at = Date.parse(record.timestamp);
    const created = p.internal_chat_message_metadata_passthrough.create_time * 1000;
    if (!Number.isFinite(at) || !Number.isFinite(created) || at > nowMs || created > nowMs) return [];
    map.set(p.call_id, { p, index: i, at, started: Math.min(at, created) });
  }
  if (calls.size !== outputs.size) return [];
  let barrier = Math.max(0, ...nativeRows.filter((row) =>
    row.state === 'mutation_intent' || row.state === 'mutation_completed'
  ).map((row) => row.observed_at_ms));
  const candidates = [];
  for (const [id, call] of calls) {
    const output = outputs.get(id);
    if (!output || output.index <= call.index || output.at < call.at) return [];
    const p = call.p;
    let command = null;
    let result;
    let patch = false;
    if (p.name === 'exec' && p.type === 'custom_tool_call') {
      command = singleAwaitedCommand(p.input);
      patch = singleAwaitedPatch(p.input) !== null;
      if (command === null && !patch) return [];
      const blocks = output.p.output;
      if (!Array.isArray(blocks) || blocks.length !== 2 || blocks.some((block) =>
        block?.type !== 'input_text' || typeof block.text !== 'string'
      ) || !/^Script completed\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n$/u.test(blocks[0].text)) return [];
      try { result = JSON.parse(blocks[1].text); } catch { return []; }
    } else if (p.name === 'exec_command' && p.type === 'function_call') {
      let args;
      try { args = JSON.parse(p.arguments); } catch { return []; }
      if (!args || typeof args.cmd !== 'string') return [];
      command = args.cmd;
      try { result = typeof output.p.output === 'string' ? JSON.parse(output.p.output) : output.p.output; }
      catch { return []; }
    } else if (p.name === 'apply_patch') patch = true;
    else return [];
    if (patch) { barrier = Math.max(barrier, output.at); continue; }
    const terminal = validationOutcome(result);
    if (!terminal || typeof result.output !== 'string' || !Number.isFinite(result.wall_time_seconds)
        || result.wall_time_seconds < 0 || result.session_id != null) return [];
    const type = validationCommand(command);
    // A non-check command can leave background work running after its shell
    // exits. Do not certify the turn through an unclassified command.
    if (!type) {
      // The persisted near-negative canary reads its file before checking it.
      // Only this literal, foreground read is covered; no expansions, flags,
      // redirections, pipelines, compound commands or background work.
      if (/^cat[ \t]+(?:--[ \t]+)?(?!-)[\w./-]+(?:[ \t]+(?!-)[\w./-]+)*[ \t]*$/u.test(command)) continue;
      return [];
    }
    const identity = crypto.createHash('sha256').update(JSON.stringify([p, output.p])).digest('hex');
    candidates.push({ id, identity, at: call.started, terminal, type });
  }
  return candidates.filter((item) => item.at > barrier).map((item) => ({
    schema_version: JOURNAL_SCHEMA_VERSION,
    observed_at_ms: Math.floor(item.at),
    event_id: crypto.createHash('sha256').update(JSON.stringify([event.session_id, event.turn_id, item.id, item.identity])).digest('hex'),
    surface: nativeRows[0]?.surface || 'unknown',
    session_id: event.session_id,
    turn_id: event.turn_id,
    tool_use_id: `transcript:${item.id}`,
    hook_event_name: 'Stop',
    tool_name: 'exec_command',
    state: 'validation_completed',
    ...item.terminal,
    validation_type: item.type,
    repo_relative_files: [],
    reason_code: 'transcript-terminal-status',
  }));
}

function supplementTranscriptValidations(stateDir, event, options = {}) {
  const rows = readRows(stateDir, event.session_id).filter((row) => row.turn_id === event.turn_id);
  const receipts = transcriptTerminalRows(event, rows, options.nowMs ?? Date.now());
  for (const row of receipts) {
    if (rows.some((old) => old.event_id === row.event_id)) continue;
    writeRow(stateDir, row, { nonce: row.event_id });
  }
  return receipts.map((row) => row.event_id);
}

function summarizeJournal(stateDir, sessionId, turnId, options = {}) {
  // History is retained, but derived receipts must be re-established at every
  // Stop. A later barrier, damaged transcript or conflicting output revokes
  // their applicability without rewriting the original observation.
  const activeReceipts = new Set(options.transcriptReceiptIds || []);
  const rows = readRows(stateDir, sessionId).filter((row) => row.turn_id === turnId
    && (row.reason_code !== 'transcript-terminal-status' || activeReceipts.has(row.event_id)));
  const successfulMutations = rows.filter((row) => row.state === 'mutation_completed' && row.outcome === 'success');
  const firstMutationIndex = rows.findIndex((row) => row.state === 'mutation_intent' || row.state === 'mutation_completed');
  let latestMutationIndex = -1;
  rows.forEach((row, index) => {
    if (row.state === 'mutation_completed' && row.outcome === 'success') latestMutationIndex = index;
  });
  const freshValidation = rows.slice(latestMutationIndex + 1)
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
    validation_sources: [...new Set(rows.filter((row) => row.state === 'validation_completed')
      .map((row) => row.reason_code === 'transcript-terminal-status' ? 'transcript-terminal-status' : 'native-tool-response'))],
    fresh_validation_unknown: rows.slice(latestMutationIndex + 1)
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
  supplementTranscriptValidations,
  transcriptTerminalRows,
};
