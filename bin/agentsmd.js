#!/usr/bin/env node
'use strict';
// agentsmd CLI — a thin dispatcher over the L2 scripts in ../scripts. Each script
// is an independently runnable Node program that reads process.argv and owns its
// own output + exit code, so we SPAWN it as a child (never require it): its arg
// parsing, JSON output, and exit status pass through byte-for-byte, and the L1/L2
// isolation invariant (ARCHITECTURE.md §2 — this CLI adds no logic) stays intact.
// Reached as `npx @sdsrs/agentsmd <cmd>` or, after a global install, `agentsmd <cmd>`.

const path = require('path');
const cp = require('child_process');
const os = require('os');

const SCRIPTS = path.join(__dirname, '..', 'scripts'); // self-derived; survives path/version changes

// subcommand → script under scripts/. `update` is an install re-run (install is idempotent).
// `init` is the one exception to the $CODEX_HOME rule below — it targets the
// current project directory (process.cwd()), not $CODEX_HOME.
const COMMANDS = {
  init: 'init.js',
  install: 'install.js',
  update: 'install.js',
  uninstall: 'uninstall.js',
  status: 'status.js',
  doctor: 'doctor.js',
  audit: 'audit.js',
  rules: 'rules.js',
};

function pkgVersion() {
  try { return require(path.join(__dirname, '..', 'package.json')).version; }
  catch { return 'unknown'; }
}

function usage() {
  return [
    'agentsmd — a coding-discipline spec enforced by native Codex hooks',
    '',
    'Usage: agentsmd <command> [options]',
    '',
    'Commands:',
    '  init               Generate/refresh this project\'s AGENTS.md (current directory).',
    '  install            Install/update agentsmd into $CODEX_HOME (~/.codex). Idempotent.',
    '  update             Alias for install — re-run to refresh to this version.',
    "  uninstall          Remove agentsmd's own entries; every other tenant is preserved.",
    '  status             Print what agentsmd registered, as JSON.',
    '  doctor             Run install health checks.',
    '  audit [--days=N]   Aggregate rule-hit telemetry by spec section (default 30d).',
    '  rules [--days=N]   Promote/demote signals vs the HARD-rules manifest.',
    '',
    'Options:',
    '  -v, --version      Print the agentsmd version.',
    '  -h, --help         Show this help.',
    '',
    'Everything above honors $CODEX_HOME (defaults to ~/.codex) — except `init`, which targets the current project directory instead.',
    'Docs: https://github.com/sdsrss/agentsmd#readme',
  ].join('\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;

  // Bare invocation and help print usage and DO NOTHING else — a bare
  // `npx @sdsrs/agentsmd` must never silently write to $CODEX_HOME.
  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(usage());
    return 0;
  }
  if (cmd === '-v' || cmd === '--version') {
    console.log(pkgVersion());
    return 0;
  }

  const script = COMMANDS[cmd];
  if (!script) {
    console.error(`agentsmd: unknown command: ${cmd}\n`);
    console.error(usage());
    return 1;
  }

  // Spawn the script, inheriting stdio so its output/prompts/exit code are ours.
  const res = cp.spawnSync(process.execPath, [path.join(SCRIPTS, script), ...rest], { stdio: 'inherit' });
  if (res.error) {
    console.error(`agentsmd: could not run ${cmd}: ${res.error.message}`);
    return 1;
  }
  if (res.signal) {
    console.error(`agentsmd: ${cmd} terminated by signal ${res.signal}`);
    // POSIX convention: a process killed by signal N exits with 128+N (e.g. SIGINT → 130).
    const signum = os.constants.signals[res.signal];
    return signum ? 128 + signum : 1;
  }
  return res.status == null ? 1 : res.status;
}

process.exit(main(process.argv.slice(2)));
