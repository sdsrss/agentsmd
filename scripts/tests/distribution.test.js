'use strict';
// distribution.test.js — guards the user-facing install surfaces: the curl
// installer wrapper and the repo marketplace metadata used by `codex plugin add`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try { fn(); PASS++; console.log('  ok   ' + name); }
  catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); }
};

const run = (args, env) => cp.execFileSync('sh', [path.join(ROOT, 'install.sh'), ...args], {
  cwd: ROOT,
  env: { ...process.env, ...env },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const withSandbox = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-distribution-test.'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

t('install.sh has valid POSIX shell syntax', () => {
  cp.execFileSync('sh', ['-n', path.join(ROOT, 'install.sh')]);
});

t('install.sh help documents curl install, update, uninstall, and raw URL caveat', () => {
  const out = run(['--help']);
  assert(out.includes('raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh'));
  assert(out.includes('--update'));
  assert(out.includes('--uninstall'));
  assert(out.includes('GitHub does not serve raw files from https://github.com/sdsrss/agentsmd/install.sh'));
});

t('install.sh rejects unknown options before touching CODEX_HOME', () => withSandbox((dir) => {
  assert.throws(
    () => run(['--nope'], { CODEX_HOME: dir }),
    /unknown option: --nope/
  );
  assert(!fs.existsSync(path.join(dir, 'agentsmd')));
}));

t('install.sh installs, updates, reports status, and uninstalls from a local source', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const installOut = run(['--source', ROOT, '--yes'], env);
  assert(installOut.includes('agentsmd installed:'));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));

  const updateOut = run(['--source', ROOT, '--update'], env);
  assert(updateOut.includes('agentsmd installed:'));

  const status = JSON.parse(run(['--source', ROOT, '--status'], env));
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.agentsmdHooksRegistered, 10);

  const uninstallOut = run(['--source', ROOT, '--uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  const statusAfter = JSON.parse(run(['--source', ROOT, '--status'], env));
  assert.strictEqual(statusAfter.installed, false);
}));

t('repo marketplace exposes the root agentsmd plugin with install policy metadata', () => {
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  assert.strictEqual(marketplace.name, 'agentsmd');
  assert.strictEqual(marketplace.interface.displayName, 'agentsmd');
  assert.strictEqual(marketplace.plugins.length, 1);

  const entry = marketplace.plugins[0];
  assert.strictEqual(entry.name, 'agentsmd');
  assert.deepStrictEqual(entry.source, { source: 'local', path: './' });
  assert.deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.strictEqual(entry.category, 'Coding');

  const pluginRoot = path.resolve(ROOT, entry.source.path);
  const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(plugin.name, entry.name);
  assert(fs.existsSync(path.join(pluginRoot, 'hooks.json')), 'plugin-root hooks.json missing');
  assert(fs.existsSync(path.join(pluginRoot, 'skills', 'agentsmd-status', 'SKILL.md')), 'skills dir missing');
});

t('package files include curl installer and repo marketplace metadata', () => {
  const files = JSON.parse(read('package.json')).files;
  assert(files.includes('install.sh'));
  assert(files.includes('.agents'));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
