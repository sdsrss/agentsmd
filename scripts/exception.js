#!/usr/bin/env node
'use strict';
// exception.js — register/list/remove structured false-positive exceptions for
// the immutable §8 hooks (R1-01). Exceptions live INSIDE the current project's
// repository at <repo-root>/.agentsmd/exceptions.json so they are committed and
// review-able; there is deliberately no $CODEX_HOME-wide store (a global
// exception would amount to spec-level authorization). The hooks match an
// exception only when rule + full fingerprint agree and the entry is unexpired;
// a missing/oversized/unparseable file means "no exceptions" (block stands).
//
//   agentsmd exception add --rule=§8-secrets --path=<repo-rel-file> \
//     [--pattern=<regex from hooks/secrets.patterns>] [--days=N] --reason=<why>
//   agentsmd exception add --rule=§8-unknown-script --url=<exact https url> \
//     [--days=N] --reason=<why>
//   agentsmd exception list [--json]
//   agentsmd exception rm --id=<exc-id>
//   agentsmd exception prune
//
// §8-rm-rf-var has NO exception path by design: the fix is always a
// mechanically-verified validation shape (see hooks/pre-bash-safety-check.sh).

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 16384; // hooks ignore anything larger (fail-closed)
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;
const RULES = new Set(['§8-secrets', '§8-unknown-script']);
const USAGE = [
  'Usage: agentsmd exception <add|list|rm|prune> [options]',
  '  add   --rule=§8-secrets --path=FILE [--pattern=REGEX] [--days=N] --reason=WHY',
  '  add   --rule=§8-unknown-script --url=https://… [--days=N] --reason=WHY',
  '  list  [--json]',
  '  rm    --id=exc-…',
  '  prune',
  `Exceptions expire (default ${DEFAULT_DAYS}d, max ${MAX_DAYS}d) and never constitute spec-level authorization.`,
].join('\n');

function repoRoot(cwd) {
  const r = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const root = (r.stdout || '').trim();
  return root || null;
}

function exceptionsPath(root) {
  return path.join(root, '.agentsmd', 'exceptions.json');
}

function readStore(file) {
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, exceptions: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const store = JSON.parse(raw); // caller surfaces a parse error verbatim
  if (store === null || typeof store !== 'object' || store.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(store.exceptions)) {
    throw new Error(`unsupported exceptions file (want schemaVersion ${SCHEMA_VERSION}): ${file}`);
  }
  return store;
}

function writeStore(file, store) {
  const body = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`refusing to write >${MAX_FILE_BYTES} bytes — hooks would ignore the whole file; run 'agentsmd exception prune' first`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function fingerprintId(rule, detector, fingerprint) {
  const key = JSON.stringify({ rule, detector, fingerprint });
  return `exc-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

function knownPatterns() {
  const file = path.join(__dirname, '..', 'hooks', 'secrets.patterns');
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return null; // patterns file unreadable → skip strict validation
  }
}

// Explicit --flag=value loop (repo argv convention; see lint-argv.test.js).
function parseArgs(argv) {
  const out = { command: '', rule: '', path: '', pattern: '', url: '', reason: '', id: '', json: false, days: DEFAULT_DAYS };
  let sawCommand = false;
  for (const arg of argv) {
    if (!sawCommand && /^(add|list|rm|prune)$/.test(arg)) { out.command = arg; sawCommand = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    const m = arg.match(/^--(rule|path|pattern|url|reason|id|days)=(.*)$/);
    if (!m) return { error: `unknown argument: ${arg}` };
    if (m[1] === 'days') {
      const n = Number(m[2]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return { error: `invalid --days (1..${MAX_DAYS}): ${m[2]}` };
      out.days = n;
    } else {
      out[m[1]] = m[2];
    }
  }
  if (!out.command) return { error: 'missing subcommand (add|list|rm|prune)' };
  return out;
}

function normalizeRule(rule) {
  const r = rule.startsWith('§') ? rule : `§${rule}`;
  return RULES.has(r) ? r : null;
}

function buildEntry(opts, root) {
  const rule = normalizeRule(opts.rule);
  if (!rule) throw new Error(`--rule must be one of: ${[...RULES].join(', ')} (§8-rm-rf-var has no exception path — validate the variable instead)`);
  let detector; let fingerprint;
  if (rule === '§8-secrets') {
    if (!opts.path) throw new Error('--path is required for §8-secrets');
    const abs = path.resolve(root, opts.path);
    if (!fs.existsSync(abs)) throw new Error(`--path does not exist: ${opts.path}`);
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`--path resolves outside the repository: ${opts.path}`);
    }
    const rel = path.relative(realRoot, real).split(path.sep).join('/');
    if (opts.pattern) {
      const known = knownPatterns();
      if (known && !known.some((p) => p === opts.pattern)) {
        throw new Error(`--pattern is not a registered secret pattern; known:\n  ${known.join('\n  ')}`);
      }
      detector = 'pattern';
      fingerprint = { pattern: opts.pattern, path: rel };
    } else {
      detector = 'filename';
      fingerprint = { path: rel };
    }
  } else {
    if (!opts.url) throw new Error('--url is required for §8-unknown-script');
    if (!/^https:\/\/\S+$/.test(opts.url)) throw new Error('--url must be an exact https:// URL (pin a version/commit in it)');
    detector = 'url';
    fingerprint = { url: opts.url };
  }
  if (!opts.reason.trim()) throw new Error('--reason is required (what was reviewed and why it is a false positive)');
  const now = new Date();
  const expires = new Date(now.getTime() + opts.days * 24 * 60 * 60 * 1000);
  return {
    id: fingerprintId(rule, detector, fingerprint),
    rule,
    detector,
    fingerprint,
    reason: opts.reason.trim(),
    created_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function describe(e) {
  const fp = e.detector === 'url' ? e.fingerprint.url
    : e.detector === 'pattern' ? `${e.fingerprint.path} ~ /${e.fingerprint.pattern}/`
      : e.fingerprint.path;
  return `${e.id}  ${e.rule}  [${e.detector}]  ${fp}  expires ${e.expires_at}`;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`${opts.error}\n${USAGE}\n`);
    return 1;
  }
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a git repository — exceptions are per-repo by design\n');
    return 1;
  }
  const file = exceptionsPath(root);
  try {
    const store = readStore(file);
    const now = new Date().toISOString();
    if (opts.command === 'add') {
      const entry = buildEntry(opts, root);
      const kept = store.exceptions.filter((e) => e.id !== entry.id);
      const renewed = kept.length !== store.exceptions.length;
      store.exceptions = [...kept, entry];
      writeStore(file, store);
      process.stdout.write(`${renewed ? 'renewed' : 'added'}: ${describe(entry)}\n${file}\n`);
      return 0;
    }
    if (opts.command === 'list') {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(store, null, 2)}\n`);
        return 0;
      }
      if (!store.exceptions.length) {
        process.stdout.write(`no exceptions registered (${file})\n`);
        return 0;
      }
      for (const e of store.exceptions) {
        process.stdout.write(`${describe(e)}${e.expires_at <= now ? '  ** EXPIRED **' : ''}\n`);
      }
      return 0;
    }
    if (opts.command === 'rm') {
      if (!opts.id) { process.stderr.write(`--id is required\n${USAGE}\n`); return 1; }
      const kept = store.exceptions.filter((e) => e.id !== opts.id);
      if (kept.length === store.exceptions.length) {
        process.stderr.write(`no exception with id ${opts.id}\n`);
        return 1;
      }
      store.exceptions = kept;
      writeStore(file, store);
      process.stdout.write(`removed ${opts.id}\n`);
      return 0;
    }
    // prune
    const kept = store.exceptions.filter((e) => typeof e.expires_at === 'string' && e.expires_at > now);
    const dropped = store.exceptions.length - kept.length;
    store.exceptions = kept;
    writeStore(file, store);
    process.stdout.write(`pruned ${dropped} expired exception(s); ${kept.length} remain\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, buildEntry, readStore, writeStore, exceptionsPath, repoRoot, SCHEMA_VERSION, MAX_FILE_BYTES, MAX_DAYS };
