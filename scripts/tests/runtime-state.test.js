'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-runtime-state-'));
const codexHome = path.join(sandbox, 'codex-home');
const pluginData = path.join(sandbox, 'plugin-data');
const pluginRuntime = path.join(pluginData, 'runtime');
const sharedState = path.join(codexHome, '.agentsmd-state');
const standaloneRuntime = path.join(sharedState, 'runtime');
const standaloneRoot = path.join(codexHome, 'agentsmd');
let PASS = 0;
let FAIL = 0;

const t = (name, fn) => {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
};

function copyStandaloneFixture() {
  for (const relative of ['hooks', 'scripts', 'spec', 'package.json']) {
    fs.cpSync(path.join(ROOT, relative), path.join(standaloneRoot, relative), { recursive: true });
  }
}

function runHook(root, hook, event, extraEnv = {}) {
  return spawnSync('bash', [path.join(root, 'hooks', hook)], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: sandbox,
      CODEX_HOME: codexHome,
      PLUGIN_DATA: pluginData,
      DISABLE_RULE_HITS_LOG: '1',
      ...extraEnv,
    },
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
}

function runQueue(root, sessionId, message, extraEnv = {}) {
  const script = 'source "$1/hooks/lib/hook-common.sh" || exit 1; hook_queue_advisory "$2" "$3"';
  return spawnSync('bash', ['-c', script, '_', root, message, sessionId], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: sandbox,
      CODEX_HOME: codexHome,
      PLUGIN_DATA: pluginData,
      DISABLE_RULE_HITS_LOG: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function resetRuntimeState() {
  fs.rmSync(pluginRuntime, { recursive: true, force: true });
  fs.rmSync(sharedState, { recursive: true, force: true });
}

try {
  copyStandaloneFixture();

  resetRuntimeState();
  const pluginStart = runHook(ROOT, 'session-start-check.sh', {
    session_id: 'p1-plugin',
    hook_event_name: 'SessionStart',
    source: 'startup',
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin physical SessionStart writes its reference under PLUGIN_DATA/runtime only', () => {
    assert.strictEqual(pluginStart.status, 0, pluginStart.stderr);
    assert.ok(fs.existsSync(path.join(pluginRuntime, 'session-start-p1-plugin.ref')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'session-start-p1-plugin.ref')));
    assert.ok(!fs.existsSync(path.join(standaloneRuntime, 'session-start-p1-plugin.ref')));
    assert.ok(!fs.existsSync(sharedState), 'plugin-only legacy reads must not create the shared state root');
  });

  resetRuntimeState();
  const standaloneStart = runHook(standaloneRoot, 'session-start-check.sh', {
    session_id: 'p1-standalone',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  t('standalone physical SessionStart ignores inherited PLUGIN_DATA', () => {
    assert.strictEqual(standaloneStart.status, 0, standaloneStart.stderr);
    assert.ok(fs.existsSync(path.join(standaloneRuntime, 'session-start-p1-standalone.ref')));
    assert.ok(!fs.existsSync(path.join(pluginRuntime, 'session-start-p1-standalone.ref')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'session-start-p1-standalone.ref')));
  });

  resetRuntimeState();
  const pluginQueue = runQueue(ROOT, 'p1-plugin-queue', 'plugin-private', {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin advisory producer writes only to plugin runtime', () => {
    assert.strictEqual(pluginQueue.status, 0, pluginQueue.stderr);
    const queue = path.join(pluginRuntime, 'pending-advisories-p1-plugin-queue.d');
    assert.ok(fs.readdirSync(queue).length > 0);
    assert.ok(!fs.existsSync(path.join(sharedState, 'pending-advisories-p1-plugin-queue.d')));
    assert.ok(!fs.existsSync(path.join(standaloneRuntime, 'pending-advisories-p1-plugin-queue.d')));
  });

  resetRuntimeState();
  const standaloneQueue = runQueue(standaloneRoot, 'p1-standalone-queue', 'standalone-private');
  t('standalone advisory producer writes only to standalone runtime', () => {
    assert.strictEqual(standaloneQueue.status, 0, standaloneQueue.stderr);
    const queue = path.join(standaloneRuntime, 'pending-advisories-p1-standalone-queue.d');
    assert.ok(fs.readdirSync(queue).length > 0);
    assert.ok(!fs.existsSync(path.join(pluginRuntime, 'pending-advisories-p1-standalone-queue.d')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'pending-advisories-p1-standalone-queue.d')));
  });

  resetRuntimeState();
  fs.mkdirSync(sharedState, { recursive: true });
  fs.writeFileSync(path.join(sharedState, 'pending-advisories-p1-legacy'), 'legacy-shared-advisory\n');
  const legacyAdvisory = runHook(ROOT, 'surface-advisories.sh', {
    session_id: 'p1-legacy',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'continue',
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin advisory consumer reads and consumes a legacy shared queue once', () => {
    assert.strictEqual(legacyAdvisory.status, 0, legacyAdvisory.stderr);
    const parsed = JSON.parse(legacyAdvisory.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /legacy-shared-advisory/);
    assert.ok(!fs.existsSync(path.join(sharedState, 'pending-advisories-p1-legacy')));
  });

  resetRuntimeState();
  fs.mkdirSync(sharedState, { recursive: true });
  const payload = path.join(sandbox, 'legacy-remote-payload.sh');
  fs.writeFileSync(payload, '#!/usr/bin/env bash\nprintf "fixture\\n"\n');
  fs.writeFileSync(path.join(sharedState, 'remote-downloads-p1-remote.paths'), `${payload}\n`);
  const legacyRemote = runHook(ROOT, 'pre-bash-safety-check.sh', {
    session_id: 'p1-remote',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: sandbox,
    tool_input: { command: `bash '${payload}'` },
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin remote-exec correlation dual-reads legacy shared provenance', () => {
    assert.strictEqual(legacyRemote.status, 0, legacyRemote.stderr);
    assert.strictEqual(JSON.parse(legacyRemote.stdout).decision, 'block');
  });

  resetRuntimeState();
  const pluginDownload = runHook(ROOT, 'pre-bash-safety-check.sh', {
    session_id: 'p1-download',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: sandbox,
    tool_input: { command: 'curl -o downloaded.sh https://example.invalid/downloaded.sh' },
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin downloader writes provenance only under plugin runtime', () => {
    assert.strictEqual(pluginDownload.status, 0, pluginDownload.stderr);
    assert.ok(fs.existsSync(path.join(pluginRuntime, 'remote-downloads-p1-download.paths')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'remote-downloads-p1-download.paths')));
  });

  resetRuntimeState();
  const standaloneDownload = runHook(standaloneRoot, 'pre-bash-safety-check.sh', {
    session_id: 'p1-standalone-download',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: sandbox,
    tool_input: { command: 'curl -o downloaded.sh https://example.invalid/downloaded.sh' },
  });
  t('standalone downloader writes provenance only under standalone runtime', () => {
    assert.strictEqual(standaloneDownload.status, 0, standaloneDownload.stderr);
    assert.ok(fs.existsSync(path.join(standaloneRuntime, 'remote-downloads-p1-standalone-download.paths')));
    assert.ok(!fs.existsSync(path.join(pluginRuntime, 'remote-downloads-p1-standalone-download.paths')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'remote-downloads-p1-standalone-download.paths')));
  });

  resetRuntimeState();
  runQueue(ROOT, 'p1-continuity', 'private-startup-message', { PLUGIN_ROOT: ROOT });
  fs.mkdirSync(sharedState, { recursive: true });
  fs.writeFileSync(path.join(sharedState, 'pending-advisories-p1-continuity'), 'legacy-startup-message\n');
  fs.writeFileSync(path.join(pluginRuntime, 'remote-downloads-p1-continuity.paths'), `${payload}\n`);
  fs.writeFileSync(path.join(sharedState, 'remote-downloads-p1-continuity.paths'), `${payload}\n`);
  const startup = runHook(ROOT, 'session-start-check.sh', {
    session_id: 'p1-continuity',
    hook_event_name: 'SessionStart',
    source: 'startup',
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin SessionStart startup clears private and legacy continuity state', () => {
    assert.strictEqual(startup.status, 0, startup.stderr);
    assert.ok(!fs.existsSync(path.join(pluginRuntime, 'pending-advisories-p1-continuity.d')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'pending-advisories-p1-continuity')));
    assert.ok(!fs.existsSync(path.join(pluginRuntime, 'remote-downloads-p1-continuity.paths')));
    assert.ok(!fs.existsSync(path.join(sharedState, 'remote-downloads-p1-continuity.paths')));
  });

  resetRuntimeState();
  runQueue(ROOT, 'p1-continuity', 'private-resume-message', { PLUGIN_ROOT: ROOT });
  fs.mkdirSync(sharedState, { recursive: true });
  fs.writeFileSync(path.join(sharedState, 'pending-advisories-p1-continuity'), 'legacy-resume-message\n');
  fs.writeFileSync(path.join(pluginRuntime, 'remote-downloads-p1-continuity.paths'), `${payload}\n`);
  fs.writeFileSync(path.join(sharedState, 'remote-downloads-p1-continuity.paths'), `${payload}\n`);
  const resume = runHook(ROOT, 'session-start-check.sh', {
    session_id: 'p1-continuity',
    hook_event_name: 'SessionStart',
    source: 'resume',
  }, {
    PLUGIN_ROOT: ROOT,
  });
  t('plugin SessionStart resume preserves private and legacy continuity state', () => {
    assert.strictEqual(resume.status, 0, resume.stderr);
    assert.ok(fs.existsSync(path.join(pluginRuntime, 'pending-advisories-p1-continuity.d')));
    assert.ok(fs.existsSync(path.join(sharedState, 'pending-advisories-p1-continuity')));
    assert.ok(fs.existsSync(path.join(pluginRuntime, 'remote-downloads-p1-continuity.paths')));
    assert.ok(fs.existsSync(path.join(sharedState, 'remote-downloads-p1-continuity.paths')));
  });

  console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
  process.exitCode = FAIL === 0 ? 0 : 1;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
