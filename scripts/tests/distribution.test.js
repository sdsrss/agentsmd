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

// the npm CLI dispatcher (bin/agentsmd.js), reached the way `npx @sdsrs/agentsmd`
// or a global `agentsmd` would: node runs the bin, the subcommand + args pass through.
const cli = (args, env) => cp.execFileSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), ...args], {
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

t('install.sh cleans its temp source dir when repo validation fails', () => withSandbox((dir) => {
  const script = path.join(dir, 'install.sh');
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'install.sh'), script);
  assert.throws(
    () => cp.execFileSync('sh', [script, '--repo', 'not-a-repo'], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: path.join(dir, 'codex'), TMPDIR: tmpdir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /unsupported --repo value: not-a-repo/
  );
  assert(!fs.existsSync(path.join(dir, 'codex')), 'CODEX_HOME should remain untouched');
  assert.strictEqual(fs.readdirSync(tmpdir).filter((n) => n.startsWith('agentsmd-install.')).length, 0);
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
  assert.strictEqual(status.agentsmdHooksRegistered, 11);
  assert.strictEqual(status.agentsmdStatusLinePreset, true);

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

// ---- npm CLI dispatcher (bin/agentsmd.js) — `npx @sdsrs/agentsmd <cmd>` ----

t('bin/agentsmd.js exists and runs under node', () => {
  assert(fs.existsSync(path.join(ROOT, 'bin', 'agentsmd.js')));
});

t('agentsmd --version prints the package version', () => {
  const v = JSON.parse(read('package.json')).version;
  assert.strictEqual(cli(['--version']).trim(), v);
});

t('agentsmd --help lists every subcommand without touching CODEX_HOME', () => withSandbox((dir) => {
  const out = cli(['--help'], { CODEX_HOME: dir });
  for (const c of ['init', 'analyze', 'install', 'update', 'uninstall', 'status', 'doctor', 'audit', 'rules']) {
    assert(out.includes(c), `help missing subcommand: ${c}`);
  }
  assert(!fs.existsSync(path.join(dir, 'agentsmd')), 'help must not install');
}));

t('agentsmd with no args prints usage and does NOT install (safe npx bare-run)', () => withSandbox((dir) => {
  const out = cli([], { CODEX_HOME: dir });
  assert(/Usage/i.test(out));
  assert(!fs.existsSync(path.join(dir, 'agentsmd')), 'bare run must not install');
}));

t('agentsmd unknown command exits non-zero with usage and does not install', () => withSandbox((dir) => {
  assert.throws(() => cli(['frobnicate'], { CODEX_HOME: dir }), /unknown command/);
  assert(!fs.existsSync(path.join(dir, 'agentsmd')));
}));

t('agentsmd init dispatches to scripts/init.js, targeting the invoking directory rather than CODEX_HOME', () => withSandbox((dir) => {
  // init is the one COMMANDS entry that is NOT $CODEX_HOME-scoped — unlike cli()
  // above (fixed cwd: ROOT), it must run with cwd set to a throwaway project dir,
  // or it would write an AGENTS.md into this repo's own root.
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'dispatchcheck' }));
  const codexHome = path.join(dir, 'codex-home');
  const out = cp.execFileSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), 'init'], {
    cwd: projectDir,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(out.includes('created:'));
  assert(fs.existsSync(path.join(projectDir, 'AGENTS.md')), 'init did not write to the invoking directory');
  assert(!fs.existsSync(codexHome), 'init must not touch CODEX_HOME');
}));

t('agentsmd analyze --gather dispatches to scripts/analyze.js, targeting the invoking dir', () => withSandbox((dir) => {
  // analyze is the other COMMANDS entry that is NOT $CODEX_HOME-scoped, like init
  // above — it must run with cwd set to a throwaway project dir, or it would read
  // this repo's own root instead of the invoking project.
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'ana' }));
  fs.writeFileSync(path.join(projectDir, 'a.js'), 'const x=1');
  const codexHome = path.join(dir, 'codex-home');
  const out = cp.execFileSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), 'analyze', '--gather'], {
    cwd: projectDir,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(/ana|a\.js|files/i.test(out));
  assert(!fs.existsSync(codexHome), 'analyze must not touch CODEX_HOME');
}));

t('agentsmd install → status → uninstall round-trips against a sandbox CODEX_HOME', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const installOut = cli(['install'], env);
  assert(installOut.includes('agentsmd installed:'));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));

  const status = JSON.parse(cli(['status'], env));
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.agentsmdHooksRegistered, 11);

  const uninstallOut = cli(['uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).installed, false);
}));

t('agentsmd update is an idempotent alias for install', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  cli(['install'], env);
  assert(cli(['update'], env).includes('agentsmd installed:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).agentsmdHooksRegistered, 11);
}));

t('agentsmd audit forwards --days to audit.js (invalid value rejected there)', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  cli(['install'], env);
  assert.throws(() => cli(['audit', '--days=notanumber'], env), /invalid --days value/);
}));

t('package.json bin maps agentsmd to the dispatcher and files[] ships it', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.bin.agentsmd, 'bin/agentsmd.js');
  assert(fs.existsSync(path.join(ROOT, pkg.bin.agentsmd)));
  assert(pkg.files.includes('bin'));
});

t('package.json carries repository, homepage, and bugs metadata', () => {
  const pkg = JSON.parse(read('package.json'));
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
  assert(/github\.com\/sdsrss\/agentsmd/.test(repoUrl));
  assert(/github\.com\/sdsrss\/agentsmd/.test(pkg.homepage));
  const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url;
  assert(/github\.com\/sdsrss\/agentsmd\/issues/.test(bugs));
});

t('npm pack + global install links a runnable agentsmd bin (packaging E2E)', () => withSandbox((dir) => {
  // The `node bin/agentsmd.js` tests above cannot catch bin-resolution / packaging
  // regressions — the failure class behind v2.2.1. Pack the real tarball, install
  // it globally into a sandbox prefix, and run the LINKED bin. POSIX-only (this
  // project targets bash-hook platforms); no deps, so the install is offline.
  const packDir = path.join(dir, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const packed = JSON.parse(cp.execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))[0].filename;
  const tarball = path.join(packDir, packed);
  assert(fs.existsSync(tarball), 'npm pack did not produce a tarball');

  const prefix = path.join(dir, 'prefix');
  cp.execFileSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const binLink = path.join(prefix, 'bin', 'agentsmd');
  assert(fs.existsSync(binLink), 'global install did not link the agentsmd bin');
  const version = cp.execFileSync(binLink, ['--version'], { encoding: 'utf8' }).trim();
  assert.strictEqual(version, JSON.parse(read('package.json')).version);
}));

t('README (EN + zh) leads with global install, not the flaky bare npx form', () => {
  // Regression guard (v2.2.1): a bare `npx @sdsrs/agentsmd <cmd>` for this scoped
  // package is unreliable on npm 11.x (intermittent "agentsmd: not found"). Docs
  // must use `npm i -g … && agentsmd <cmd>` or `npx --package @sdsrs/agentsmd agentsmd <cmd>`.
  // Tolerate flags between `npx` and the scoped name (e.g. `npx -y @sdsrs/agentsmd install`);
  // still allows the recommended `npx --package @sdsrs/agentsmd agentsmd <cmd>` (command follows the name).
  const bareNpx = /npx (?:-\S+ )*@sdsrs\/agentsmd(@[^\s]+)? (install|status|doctor|uninstall|update|audit|rules)\b/;
  for (const f of ['README.md', 'README.zh-CN.md']) {
    const md = read(f);
    assert(md.includes('npm install -g @sdsrs/agentsmd'), `${f}: must document the global install`);
    assert(!bareNpx.test(md), `${f}: bare "npx @sdsrs/agentsmd <cmd>" is unreliable — use "npx --package @sdsrs/agentsmd agentsmd <cmd>"`);
  }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
