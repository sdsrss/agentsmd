#!/usr/bin/env node
'use strict';

// Real Codex canary for the native mutation/validation journal. The canary
// installs project-local hooks in a throwaway repository, directs every
// task-owned hook artifact into an isolated CODEX_HOME, and retains only a
// bounded machine-readable verdict. It never rewrites the user's live install.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ArgvError, parseStrict } = require('../scripts/lib/argv');

const ROOT = path.join(__dirname, '..');
const PACKAGE = require('../package.json');
const JOURNAL = require('../hooks/lib/event-journal');
const USAGE = `Usage: node qa/event-journal-runtime-canary.js [options]

Run one real Codex turn against isolated project-local event-journal hooks.

  --codex=PATH    Codex executable (default: codex)
  --model=NAME    Optional model override
  --out=DIR       Capture root (default: docs/qa-captures)
  --scenario=NAME positive (mutation + fresh validation) or near-negative (validation with zero mutation)
  --keep          Preserve the throwaway repository and print its path
  -h, --help      Show this help

Exit: 0 pass · 1 runtime/contract failure · 2 usage error`;

const PRIVACY_KEYS = new Set([
  'schema_version',
  'observed_at_ms',
  'event_id',
  'surface',
  'session_id',
  'turn_id',
  'tool_use_id',
  'hook_event_name',
  'tool_name',
  'state',
  'outcome',
  'exit_code',
  'validation_type',
  'repo_relative_files',
  'reason_code',
  'preflight_observed',
  'plan_observed',
]);

function parseArgs(argv) {
  const helpTokens = argv.filter((arg) => arg === '-h' || arg === '--help');
  const remaining = argv.filter((arg) => arg !== '-h' && arg !== '--help');
  const parsed = parseStrict(remaining, {
    bools: ['keep'],
    values: ['codex', 'model', 'out', 'scenario'],
  });
  const keys = remaining.map((arg) => arg.slice(2).split('=', 1)[0]);
  if (new Set(keys).size !== keys.length) throw new ArgvError('Duplicate options are not allowed');
  for (const key of ['codex', 'model', 'out', 'scenario']) {
    if (Object.hasOwn(parsed.values, key) && parsed.values[key].trim() === '') {
      throw new ArgvError(`--${key} requires a non-empty value`);
    }
  }
  const scenario = parsed.values.scenario || 'positive';
  if (!['positive', 'near-negative'].includes(scenario)) {
    throw new ArgvError(`--scenario must be positive or near-negative, got ${scenario}`);
  }
  return {
    codex: parsed.values.codex || 'codex',
    model: parsed.values.model || null,
    out: parsed.values.out || null,
    scenario,
    keep: parsed.bools.has('keep'),
    help: helpTokens.length > 0,
  };
}

function privacySafe(rows) {
  return rows.every((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (Object.keys(row).some((key) => !PRIVACY_KEYS.has(key))) return false;
    if (!Array.isArray(row.repo_relative_files)) return false;
    return row.repo_relative_files.every((file) => (
      typeof file === 'string'
      && !path.isAbsolute(file)
      && file !== '..'
      && !file.startsWith('../')
    ));
  });
}

function gradeRuntimeCapture({
  rows,
  fileContents,
  processExitCode,
  stopTelemetry,
  unvalidatedFlags,
  changedFiles,
}) {
  const failures = [];
  if (processExitCode !== 0) failures.push('runtime process did not exit 0');
  if (fileContents !== 'AFTER\n') failures.push('canary mutation did not land');

  const completedIndex = rows.findIndex((row) => (
    row.state === 'mutation_completed'
    && row.outcome === 'success'
    && row.repo_relative_files.includes('canary.txt')
  ));
  const completed = completedIndex >= 0 ? rows[completedIndex] : null;
  const intent = completed && rows.some((row) => (
    row.state === 'mutation_intent'
    && row.session_id === completed.session_id
    && row.turn_id === completed.turn_id
    && row.tool_use_id === completed.tool_use_id
    && row.repo_relative_files.includes('canary.txt')
  ));
  if (!intent) failures.push('missing mutation intent');
  const freshValidation = completed && rows.slice(completedIndex + 1).some((row) => (
    row.state === 'validation_completed'
    && row.outcome === 'success'
    && row.session_id === completed.session_id
    && row.turn_id === completed.turn_id
  ));
  if (!freshValidation) failures.push('missing fresh successful validation in the mutation turn');
  if (!stopTelemetry.some((row) => (
    row
    && row.hook === 'session-exit-checkpoint'
    && row.event === 'observe'
    && row.extra
    && row.extra.source === 'native-event-journal'
  ))) failures.push('Stop did not consume the native journal');
  if (unvalidatedFlags.length > 0) failures.push('Stop left an unvalidated-work flag');
  if (!privacySafe(rows)) failures.push('journal rows violate the privacy allowlist');
  if (Array.isArray(changedFiles)
      && (changedFiles.length !== 1 || changedFiles[0] !== 'canary.txt')) {
    failures.push('positive scenario changed files outside canary.txt');
  }

  return {
    pass: failures.length === 0,
    failures,
    session_id: completed ? completed.session_id : null,
    turn_id: completed ? completed.turn_id : null,
    events: rows.length,
  };
}

function gradeNearNegativeCapture({
  rows,
  fileContents,
  processExitCode,
  stopTelemetry,
  unvalidatedFlags,
  changedFiles,
}) {
  const failures = [];
  if (processExitCode !== 0) failures.push('runtime process did not exit 0');
  if (fileContents !== 'STABLE\n') failures.push('near-negative fixture content changed');
  if (rows.some((row) => row && (row.state === 'mutation_intent' || row.state === 'mutation_completed'))) {
    failures.push('near-negative emitted a mutation event');
  }
  const successfulValidation = rows.some((row) => (
    row
    && row.state === 'validation_completed'
    && row.outcome === 'success'
  ));
  if (!successfulValidation) failures.push('near-negative missing successful validation');
  if (!stopTelemetry.some((row) => (
    row
    && row.hook === 'session-exit-checkpoint'
    && row.event === 'observe'
    && row.extra
    && row.extra.source === 'native-event-journal'
  ))) failures.push('Stop did not consume the native journal');
  if (unvalidatedFlags.length > 0) failures.push('Stop left an unvalidated-work flag');
  if (!privacySafe(rows)) failures.push('journal rows violate the privacy allowlist');
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    failures.push('near-negative changed tracked files');
  }
  const validation = rows.find((row) => row && row.state === 'validation_completed' && row.outcome === 'success');
  return {
    pass: failures.length === 0,
    failures,
    session_id: validation ? validation.session_id : null,
    turn_id: validation ? validation.turn_id : null,
    events: rows.length,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookCommand(hookHome, script) {
  return `env CODEX_HOME=${shellQuote(hookHome)} AGENTSMD_TELEMETRY_TAG=qa bash ${shellQuote(script)}`;
}

function writeFixture(sandbox, scenario = 'positive') {
  const project = path.join(sandbox, 'repo');
  const hookHome = path.join(sandbox, 'hook-home');
  const codexDir = path.join(project, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(hookHome, { recursive: true, mode: 0o700 });
  const initial = scenario === 'near-negative' ? 'STABLE\n' : 'BEFORE\n';
  const expected = scenario === 'near-negative' ? 'STABLE\\n' : 'AFTER\\n';
  fs.writeFileSync(path.join(project, 'canary.txt'), initial);
  fs.writeFileSync(path.join(project, 'verify.js'), [
    "'use strict';",
    "const fs = require('fs');",
    `if (fs.readFileSync('canary.txt', 'utf8') !== '${expected}') process.exit(1);`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({
    private: true,
    scripts: { test: 'node verify.js' },
  }, null, 2)}\n`);

  const manifest = {
    description: 'agentsmd isolated native event-journal runtime canary',
    hooks: {
      PreToolUse: [{
        matcher: 'apply_patch',
        hooks: [{
          type: 'command',
          command: hookCommand(hookHome, path.join(ROOT, 'hooks', 'pre-mutation-journal.sh')),
          timeout: 3,
        }],
      }],
      PostToolUse: [{
        matcher: 'Bash|apply_patch',
        hooks: [{
          type: 'command',
          command: hookCommand(hookHome, path.join(ROOT, 'hooks', 'post-tool-journal.sh')),
          timeout: 3,
        }],
      }],
      Stop: [{
        hooks: [{
          type: 'command',
          command: hookCommand(hookHome, path.join(ROOT, 'hooks', 'session-exit-checkpoint.sh')),
          timeout: 5,
        }],
      }],
    },
  };
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const git = cp.spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init failed: ${(git.stderr || '').trim()}`);
  const add = cp.spawnSync('git', ['-C', project, 'add', '-A'], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`git add failed: ${(add.stderr || '').trim()}`);
  const commit = cp.spawnSync('git', [
    '-C', project,
    '-c', 'user.name=agentsmd canary',
    '-c', 'user.email=canary@invalid.example',
    'commit', '-q', '-m', 'runtime canary fixture',
  ], { encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(`git commit failed: ${(commit.stderr || '').trim()}`);
  return { project, hookHome };
}

function changedFiles(project) {
  const status = cp.spawnSync('git', ['-C', project, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (status.status !== 0) throw new Error(`git status failed: ${(status.stderr || '').trim()}`);
  return status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 128).map((line) => {
    const value = line.slice(3).trim();
    return value.includes(' -> ') ? value.split(' -> ').pop() : value;
  }).sort();
}

function collectRows(stateDir) {
  let directories = [];
  try {
    directories = fs.readdirSync(stateDir)
      .filter((name) => /^event-journal-[A-Za-z0-9._-]+\.d$/.test(name))
      .slice(0, 16);
  } catch {
    return [];
  }
  const rows = [];
  for (const directory of directories) {
    const dir = path.join(stateDir, directory);
    let names = [];
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      names = fs.readdirSync(dir)
        .filter((name) => /^\d{13}-[A-Za-z0-9._-]+\.json$/.test(name))
        .slice(0, JOURNAL.JOURNAL_MAX_FILES);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL.JOURNAL_ROW_MAX_BYTES) continue;
        rows.push(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // A damaged row becomes a missing-event canary failure, not a crash.
      }
    }
  }
  const rank = (row) => row.state === 'mutation_completed' ? 2
    : row.state === 'validation_completed' ? 1 : 0;
  return rows.sort((a, b) => (a.observed_at_ms - b.observed_at_ms)
    || (rank(a) - rank(b))
    || String(a.event_id).localeCompare(String(b.event_id)));
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function safeCleanupTemp(sandbox) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(sandbox));
  const stat = fs.lstatSync(sandbox);
  if (parent !== tempRoot
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || !path.basename(sandbox).startsWith('agentsmd-event-journal-runtime-')) {
    throw new Error(`refusing unsafe canary cleanup target: ${sandbox}`);
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function runCanary(options) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-event-journal-runtime-'));
  let preserve = options.keep;
  try {
    const scenario = options.scenario || 'positive';
    const { project, hookHome } = writeFixture(sandbox, scenario);
    const runtimeHome = path.join(sandbox, 'runtime-home');
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runtimeHome, 'config.toml'), '[features]\nhooks = true\n', { mode: 0o600 });
    const versionRun = cp.spawnSync(options.codex, ['--version'], { encoding: 'utf8', timeout: 10000 });
    const codexVersion = ((versionRun.stdout || '').match(/\d+\.\d+\.\d+/) || [null])[0];
    if (versionRun.status !== 0 || !codexVersion) {
      throw new Error(`could not determine Codex version from ${options.codex}`);
    }
    const lastMessage = path.join(sandbox, 'last.txt');
    const args = [
      '-a', 'never',
      '--dangerously-bypass-hook-trust',
      'exec',
      '--sandbox', 'workspace-write',
      '--add-dir', path.join(project, '.git'),
      '--ignore-rules',
      '--json',
      '--skip-git-repo-check',
      '-C', project,
      '-o', lastMessage,
    ];
    if (options.model) args.push('-m', options.model);
    args.push(scenario === 'positive'
      ? (
        'Use the apply_patch tool exactly once to replace BEFORE with AFTER in canary.txt. '
        + 'Then run exactly `npm test` once. Do not modify any other file and do not run any other command. '
        + 'After the test succeeds, reply with exactly DONE.'
      )
      : (
        'Read canary.txt, then run exactly `npm test` once. Do not modify any file and do not run any other command. '
        + 'After the test succeeds, reply with exactly DONE.'
      ));
    const runtime = cp.spawnSync(options.codex, args, {
      encoding: 'utf8',
      timeout: 300000,
      env: {
        ...process.env,
        CODEX_HOME: runtimeHome,
        AGENTSMD_CODEX_BIN: options.codex,
        AGENTSMD_TELEMETRY_TAG: 'qa',
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    const stateDir = path.join(hookHome, '.agentsmd-state');
    const rows = collectRows(stateDir);
    const telemetry = readJsonLines(path.join(hookHome, 'logs', 'agentsmd.jsonl'));
    const unvalidatedFlags = (() => {
      try {
        return fs.readdirSync(stateDir).filter((name) => /^unvalidated-[A-Za-z0-9._-]+\.flag$/.test(name));
      } catch {
        return [];
      }
    })();
    const fileContents = (() => {
      try { return fs.readFileSync(path.join(project, 'canary.txt'), 'utf8'); }
      catch { return null; }
    })();
    const changed = changedFiles(project);
    const grade = scenario === 'near-negative' ? gradeNearNegativeCapture : gradeRuntimeCapture;
    const graded = grade({
      rows,
      fileContents,
      processExitCode: runtime.status,
      stopTelemetry: telemetry,
      unvalidatedFlags,
      changedFiles: changed,
    });
    if (runtime.error) graded.failures.unshift(`runtime spawn failed: ${runtime.error.message}`);
    graded.pass = graded.failures.length === 0;

    const captureRoot = path.resolve(options.out || path.join(ROOT, 'docs', 'qa-captures'));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const captureDir = path.join(captureRoot, `event-journal-runtime-${scenario}-${stamp}`);
    fs.mkdirSync(captureDir, { recursive: true });
    const report = {
      schema_version: 2,
      kind: 'event-journal-runtime-canary',
      scenario,
      captured_at: new Date().toISOString(),
      pass: graded.pass,
      failures: graded.failures,
      runtime: {
        codex_version: codexVersion,
        model: options.model || 'config-default',
        agentsmd_version: PACKAGE.version,
        surface: 'project-local-source-hooks',
      },
      evidence: {
        events: graded.events,
        session_id: graded.session_id,
        turn_id: graded.turn_id,
        mutation_landed: fileContents === 'AFTER\n',
        no_mutation: !rows.some((row) => row && (row.state === 'mutation_intent' || row.state === 'mutation_completed')),
        validation_completed: rows.some((row) => row && row.state === 'validation_completed' && row.outcome === 'success'),
        changed_files: changed,
        native_stop_consumer: telemetry.some((row) => (
          row.hook === 'session-exit-checkpoint'
          && row.event === 'observe'
          && row.extra
          && row.extra.source === 'native-event-journal'
        )),
        unvalidated_flags: unvalidatedFlags.length,
        privacy_allowlist: privacySafe(rows),
        process_exit_code: runtime.status,
      },
      limits: [
        'One real runtime/model turn; deterministic fixture assertions grade the result.',
        'Project-local source hooks and the Codex runtime home are isolated from live installed state.',
        'This capture does not establish behavior for other Codex versions or models.',
      ],
      sandbox: options.keep ? sandbox : null,
    };
    fs.writeFileSync(path.join(captureDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (options.keep) preserve = true;
    return { report, captureDir, sandbox: options.keep ? sandbox : null };
  } finally {
    if (!preserve && fs.existsSync(sandbox)) safeCleanupTemp(sandbox);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agentsmd event-journal runtime canary: ${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = runCanary(options);
    process.stdout.write(`${JSON.stringify({
      pass: result.report.pass,
      failures: result.report.failures,
      runtime: result.report.runtime,
      scenario: result.report.scenario,
      evidence: result.report.evidence,
      capture: result.captureDir,
      sandbox: result.sandbox,
    }, null, 2)}\n`);
    process.exitCode = result.report.pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(`agentsmd event-journal runtime canary: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  changedFiles,
  collectRows,
  gradeNearNegativeCapture,
  gradeRuntimeCapture,
  parseArgs,
  privacySafe,
  runCanary,
  safeCleanupTemp,
  writeFixture,
};
