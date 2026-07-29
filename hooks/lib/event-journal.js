'use strict';

// Native Codex event journal. Persist only bounded classifications and
// repo-relative file names: never raw commands, patches, prompts, cwd, models,
// tool responses, or file contents.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_MAX_FILES = 256;
const JOURNAL_ROW_MAX_BYTES = 16 * 1024;

const VALIDATION_RE = /\b(npm\s+(?:test|run\b[^\n;|&]*\b(?:test|lint|check|typecheck|build))|yarn\s+(?:test|lint)|pnpm\s+(?:test|lint)|python\s+-m\s+pytest|pytest|jest|vitest|mocha|cargo\s+(?:test|build|check|clippy)|go\s+test|tsc\b|eslint|shellcheck|biome\s+(?:check|lint)\b|ruff\s+(?:check\b|format\b[^\n;|&]*--check\b)|clippy|make\s+(?:test|check)|(?:node|bash|sh)\s+[^\n;|&]*(?:\/tests?\/|\.test\.(?:[cm]?[jt]s|tsx?)\b|(?:smoke|test)\.sh\b))/i;
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
  if (VALIDATION_RE.test(command)) {
    return {
      state: 'validation_completed',
      ...result,
      validation_type: validationType(command),
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
  safeRepoRelative,
  summarizeJournal,
};
