'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try { fn(); PASS++; console.log('  ok   ' + name); }
  catch (error) { FAIL++; console.log('  FAIL ' + name + '\n     ' + error.message); }
};

function loadModules() {
  for (const key of Object.keys(require.cache)) {
    if (/scripts[\\/](lib[\\/])?(?:status|doctor|paths)\.js$/.test(key)) delete require.cache[key];
  }
  return { status: require('../status').status, doctor: require('../doctor').doctor };
}

function withEnv(fn) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-plugin-surface.'));
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    AGENTSMD_PLUGIN_ROOT: process.env.AGENTSMD_PLUGIN_ROOT,
  };
  process.env.CODEX_HOME = codexHome;
  process.env.AGENTSMD_PLUGIN_ROOT = ROOT;
  try { fn(codexHome); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

withEnv((codexHome) => {
  const { status, doctor } = loadModules();
  const result = status();
  t('status preserves standalone fields for plugin-only installs', () => {
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.manifestValid, false);
    assert.strictEqual(result.agentsmdHooksRegistered, 0);
  });
  t('status reports a complete plugin bundle selected by plugin.json', () => {
    assert.strictEqual(result.pluginBundle.detected, true);
    assert.strictEqual(result.pluginBundle.complete, true);
    assert.strictEqual(result.pluginBundle.manifest.hooksPath, './hooks.json');
    assert.strictEqual(result.pluginBundle.hooks.registered, 15);
    assert.deepStrictEqual(result.pluginBundle.hooks.missingScripts, []);
    assert.deepStrictEqual(result.pluginBundle.hooks.missingSupport, []);
    assert.strictEqual(result.pluginBundle.spec.core, true);
    assert.strictEqual(result.pluginBundle.spec.extended, true);
    assert.strictEqual(result.dualSurface, false);
  });
  const diagnosis = doctor();
  t('doctor accepts plugin-only without standalone manifest or global hooks', () => {
    assert.strictEqual(diagnosis.surface, 'plugin');
    assert.strictEqual(diagnosis.dualSurface, false);
    assert.strictEqual(diagnosis.ok, true, JSON.stringify(diagnosis.checks, null, 2));
    assert(!diagnosis.checks.some((check) => /not installed|manifest vs live hooks/.test(check.name)));
  });

  fs.mkdirSync(path.join(codexHome, '.agentsmd-state'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, '.agentsmd-state', 'manifest.json'), '{}\n');
  const dualStatus = status();
  const dualDoctor = doctor();
  t('status and doctor expose dual-surface conflict', () => {
    assert.strictEqual(dualStatus.dualSurface, true);
    assert.strictEqual(dualDoctor.dualSurface, true);
    assert.strictEqual(dualDoctor.ok, false);
    assert(dualDoctor.checks.some((check) => check.name === 'dual surface absent' && !check.ok));
  });
});

withEnv(() => {
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-broken-plugin.'));
  process.env.AGENTSMD_PLUGIN_ROOT = brokenRoot;
  try {
    fs.mkdirSync(path.join(brokenRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'agentsmd', hooks: 'hooks/hooks.json',
    }));
    const { status, doctor } = loadModules();
    const bundle = status().pluginBundle;
    const diagnosis = doctor();
    t('plugin bundle reports manifest, hooks, scripts, and spec gaps', () => {
      assert.strictEqual(bundle.detected, true);
      assert.strictEqual(bundle.complete, false);
      assert(bundle.errors.some((error) => error.includes('./hooks.json')));
      assert.strictEqual(bundle.hooks.registered, 0);
      assert.strictEqual(bundle.hooks.missingScripts.length, 15);
      assert.strictEqual(bundle.spec.core, false);
      assert.strictEqual(bundle.spec.extended, false);
      assert.strictEqual(diagnosis.ok, false);
    });
  } finally {
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  }
});

for (const skill of ['agentsmd-status', 'agentsmd-doctor']) {
  const source = fs.readFileSync(path.join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
  t(`${skill} exports the selected plugin root`, () => {
    assert.match(source, /export AGENTSMD_PLUGIN_ROOT="\$CANDIDATE_ROOT"/);
  });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
