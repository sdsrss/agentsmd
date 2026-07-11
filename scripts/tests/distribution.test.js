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

const cliResult = (args, env) => cp.spawnSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), ...args], {
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
  assert.match(out, /Exit status:.*2 = argv\/usage error/);
  assert(out.includes('GitHub does not serve raw files from https://github.com/sdsrss/agentsmd/install.sh'));
});

t('install.sh rejects unknown options before touching CODEX_HOME', () => withSandbox((dir) => {
  const result = cp.spawnSync('sh', [path.join(ROOT, 'install.sh'), '--nope'], {
    cwd: ROOT, env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8',
  });
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown option: --nope/);
  assert(!fs.existsSync(path.join(dir, 'agentsmd')));
}));

t('install.sh rejects option-like values before touching CODEX_HOME', () => withSandbox((dir) => {
  for (const option of ['--repo', '--ref', '--source']) {
    const codexHome = path.join(dir, option.slice(2));
    const result = cp.spawnSync('sh', [path.join(ROOT, 'install.sh'), option, '--status'], {
      cwd: ROOT,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.strictEqual(result.status, 2, `${option}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${option} requires a value`));
    assert(!fs.existsSync(path.join(codexHome, 'agentsmd')), `${option} malformed value installed agentsmd`);
  }
}));

t('install.sh rejects conflicting lifecycle actions without uninstalling', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  run(['--source', ROOT], env);
  const result = cp.spawnSync('sh', [path.join(ROOT, 'install.sh'), '--source', ROOT, '--status', '--uninstall'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /multiple action options|conflicting.*action/i);
  assert.strictEqual(JSON.parse(cli(['status'], env)).installed, true, 'conflicting action must not mutate CODEX_HOME');
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
  assert.strictEqual(status.agentsmdHooksRegistered, 15);
  assert.strictEqual(status.agentsmdStatusLinePreset, true);

  const uninstallOut = run(['--source', ROOT, '--uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  const statusAfter = JSON.parse(run(['--source', ROOT, '--status'], env));
  assert.strictEqual(statusAfter.installed, false);
}));

t('install.sh exits non-zero when doctor fails because jq is missing', () => withSandbox((dir) => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const result = cp.spawnSync('/bin/sh', [path.join(ROOT, 'install.sh'), '--source', ROOT], {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: path.join(dir, 'codex-home'), PATH: bin },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /jq.*not found|FAIL jq present|doctor reported issues/i);
}));

t('repo marketplace exposes the root agentsmd plugin with install policy metadata', () => {
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  const pkg = JSON.parse(read('package.json'));
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.strictEqual(marketplace.name, 'agentsmd');
  assert.strictEqual(marketplace.interface.displayName, 'agentsmd');
  assert.strictEqual(marketplace.plugins.length, 1);

  const entry = marketplace.plugins[0];
  assert.strictEqual(entry.name, 'agentsmd');
  assert.deepStrictEqual(entry.source, {
    source: 'npm',
    package: pkg.name,
    version: pkg.version,
  });
  assert.deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.strictEqual(entry.category, 'Coding');
  assert.strictEqual(plugin.name, entry.name);
  assert.strictEqual(plugin.version, pkg.version);
  assert.strictEqual(entry.source.package, pkg.name);
  assert.strictEqual(entry.source.version, plugin.version);
  assert(Array.isArray(plugin.interface.defaultPrompt));
  assert(plugin.interface.defaultPrompt.length > 0);
  assert(plugin.interface.defaultPrompt.every((prompt) => (
    typeof prompt === 'string' && prompt.trim().length > 0
  )));
});

t('package files include curl installer and repo marketplace metadata', () => {
  const files = JSON.parse(read('package.json')).files;
  assert(files.includes('install.sh'));
  assert(files.includes('.agents'));
  assert(files.includes('!hooks/tests'));
  assert(files.includes('!scripts/tests'));
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
  for (const c of [
    'init', 'analyze', 'design', 'install', 'update', 'uninstall', 'restore',
    'status', 'doctor', 'audit', 'sampling-audit', 'lesson-bypass-audit',
    'sparkline', 'safety-coverage-audit', 'version-cascade', 'perf-baseline',
    'lint-argv', 'rules',
  ]) {
    assert(out.includes(c), `help missing subcommand: ${c}`);
  }
  assert.match(out, /sparkline .*--include-test/, 'top-level help must expose sparkline --include-test');
  assert.match(out, /Exit status:.*2 = argv\/usage error/);
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

t('all dispatcher argv and usage errors exit 2', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const cases = [
    ['frobnicate'],
    ['init', '--check', '--dry-run'],
    ['analyze', '--write', '--from', '--adoption'],
    ['audit', '--days=-1'],
    ['rules', '--project='],
    ['sampling-audit', '--limit=1.5'],
    ['lesson-bypass-audit', '--days=tomorrow'],
    ['sparkline', '--windows=1'],
    ['perf-baseline', '--runs=0'],
  ];
  for (const args of cases) {
    const result = cliResult(args, env);
    assert.strictEqual(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Usage:|unknown command|invalid |requires |cannot be combined|out of range/i, args.join(' '));
  }
  assert(!fs.existsSync(path.join(dir, 'agentsmd')), 'usage errors must not install');
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
  assert.strictEqual(status.agentsmdHooksRegistered, 15);

  const uninstallOut = cli(['uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).installed, false);
}));

t('agentsmd update is an idempotent alias for install', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  cli(['install'], env);
  assert(cli(['update'], env).includes('agentsmd installed:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).agentsmdHooksRegistered, 15);
}));

for (const command of ['install', 'update']) {
  t(`agentsmd ${command} --help is read-only`, () => withSandbox((dir) => {
    const run = cliResult([command, '--help'], { CODEX_HOME: dir });
    assert.strictEqual(run.status, 0, run.stderr);
    assert(run.stdout.startsWith(`Usage: agentsmd ${command}`), run.stdout);
    assert(!fs.existsSync(path.join(dir, 'agentsmd')), `${command} --help mutated CODEX_HOME`);
  }));

  t(`agentsmd ${command} rejects unknown options without installing`, () => withSandbox((dir) => {
    const run = cliResult([command, '--bogus'], { CODEX_HOME: dir });
    assert.strictEqual(run.status, 2, run.stdout + run.stderr);
    assert(new RegExp(`^agentsmd ${command}: .*unknown`, 'im').test(run.stderr), run.stderr);
    assert(!fs.existsSync(path.join(dir, 'agentsmd')), `${command} --bogus mutated CODEX_HOME`);
  }));
}

t('agentsmd update runtime failures retain update command identity', () => withSandbox((dir) => {
  fs.mkdirSync(path.join(dir, 'agentsmd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agentsmd', 'foreign'), 'owned elsewhere');
  const run = cliResult(['update'], { CODEX_HOME: dir });
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^agentsmd update failed:/);
}));

for (const option of ['--help', '--bogus']) {
  t(`agentsmd uninstall ${option} does not uninstall`, () => withSandbox((dir) => {
    const env = { CODEX_HOME: dir };
    cli(['install'], env);
    const run = cliResult(['uninstall', option], env);
    assert.strictEqual(run.status, option === '--help' ? 0 : 2, run.stdout + run.stderr);
    assert.strictEqual(JSON.parse(cli(['status'], env)).installed, true);
  }));
}

t('agentsmd install is concise by default and --json emits the full manifest', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const concise = cli(['install'], env);
  assert(concise.startsWith('agentsmd installed:'), concise);
  assert(!concise.includes('ownedArtifacts'), concise);
  assert(concise.trim().split('\n').length <= 2, concise);
  const manifest = JSON.parse(cli(['update', '--json'], env));
  assert.strictEqual(manifest.name, 'agentsmd');
  assert.strictEqual(manifest.hookCount, 15);
  assert(manifest.ownedArtifacts && manifest.ownedArtifacts.deploy);
}));

t('default restore after install → update → uninstall does not reactivate agentsmd shared entries', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo tenant' }] }] },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# tenant\n');
  cli(['install'], env);
  cli(['update'], env);
  cli(['uninstall'], env);
  cli(['restore', '--confirm'], env);
  const status = JSON.parse(cli(['status'], env));
  assert.strictEqual(status.installed, false);
  assert.strictEqual(status.agentsmdHooksRegistered, 0);
  assert.strictEqual(status.otherTenantHooksPreserved, 1);
  assert.strictEqual(status.specBlockInAgentsMd, false);
}));

t('explicit restore rejects an update snapshot after uninstall', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  cli(['install'], env);
  cli(['update'], env);
  cli(['uninstall'], env);
  const list = cli(['restore', '--list'], env);
  const updateBackup = (list.match(/^  (\S+) \[pre-install\]$/gm) || [])[0];
  assert(updateBackup, list);
  const id = updateBackup.trim().split(' ')[0];
  const run = cliResult(['restore', `--id=${id}`, '--confirm'], env);
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /partial install|install state|unsafe/i);
  assert.strictEqual(JSON.parse(cli(['status'], env)).agentsmdHooksRegistered, 0);
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
  assert.strictEqual(pkg.scripts['release:version'], 'node scripts/version-sync.js');
  assert.strictEqual(pkg.scripts.prepublishOnly, 'npm run check');
});

t('package.json carries repository, homepage, and bugs metadata', () => {
  const pkg = JSON.parse(read('package.json'));
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
  assert(/github\.com\/sdsrss\/agentsmd/.test(repoUrl));
  assert(/github\.com\/sdsrss\/agentsmd/.test(pkg.homepage));
  const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url;
  assert(/github\.com\/sdsrss\/agentsmd\/issues/.test(bugs));
});

t('npm tarball excludes tests/state and linked bin completes install lifecycle (packaging E2E)', () => withSandbox((dir) => {
  // The `node bin/agentsmd.js` tests above cannot catch bin-resolution / packaging
  // regressions — the failure class behind v2.2.1. Pack the real tarball, install
  // it globally into a sandbox prefix, and run the LINKED bin. POSIX-only (this
  // project targets bash-hook platforms); no deps, so the install is offline.
  const packDir = path.join(dir, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const packResult = JSON.parse(cp.execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: ROOT,
    env: { ...process.env, npm_config_dry_run: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))[0];
  const tarball = path.join(packDir, packResult.filename);
  assert(fs.existsSync(tarball), 'npm pack did not produce a tarball');
  const packedPaths = packResult.files.map((entry) => entry.path);
  const forbidden = [
    /^hooks\/tests(?:\/|$)/,
    /^scripts\/tests(?:\/|$)/,
    /^(?:tasks|tmp|memory|logs|\.git|\.agentsmd-state)(?:\/|$)/,
    /^MEMORY\.md$/,
  ];
  for (const packedPath of packedPaths) {
    assert(!forbidden.some((pattern) => pattern.test(packedPath)), `tarball contains local/test state: ${packedPath}`);
  }

  const prefix = path.join(dir, 'prefix');
  cp.execFileSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
    env: { ...process.env, npm_config_dry_run: 'false' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const binLink = path.join(prefix, 'bin', 'agentsmd');
  assert(fs.existsSync(binLink), 'global install did not link the agentsmd bin');
  const codexHome = path.join(dir, 'codex-home');
  const env = { ...process.env, CODEX_HOME: codexHome };
  const installedCli = (args) => cp.execFileSync(binLink, args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(installedCli(['--version']).trim(), JSON.parse(read('package.json')).version);

  const installedRoot = path.resolve(path.dirname(fs.realpathSync(binLink)), '..');
  assert(!fs.existsSync(path.join(installedRoot, 'hooks', 'tests')));
  assert(!fs.existsSync(path.join(installedRoot, 'scripts', 'tests')));
  const installedPlugin = JSON.parse(fs.readFileSync(
    path.join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'
  ));
  assert.strictEqual(installedPlugin.hooks, './hooks.json');
  assert(installedPlugin.hooks.startsWith('./'), 'plugin hook path must be explicitly relative');
  const selectedHookManifest = path.resolve(installedRoot, installedPlugin.hooks);
  assert.strictEqual(selectedHookManifest, path.join(installedRoot, 'hooks.json'));
  assert.notStrictEqual(selectedHookManifest, path.join(installedRoot, 'hooks', 'hooks.json'));
  const selectedWiring = JSON.parse(fs.readFileSync(selectedHookManifest, 'utf8'));
  const selectedCommands = Object.values(selectedWiring.hooks).flatMap((groups) =>
    (groups || []).flatMap((group) => (group.hooks || []).map((hook) => hook.command))
  );
  assert(selectedCommands.length > 0, 'plugin-selected hook manifest must register commands');
  assert(selectedCommands.every((command) => command.includes('${CLAUDE_PLUGIN_ROOT}/hooks/')),
    'plugin-selected commands must resolve from Codex CLAUDE_PLUGIN_ROOT');
  for (const rel of ['hooks.json', 'hooks/hooks.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(installedRoot, rel), 'utf8'));
    assert.deepStrictEqual(
      Object.keys(manifest).sort(),
      ['description', 'hooks'],
      `${rel} in the npm artifact must satisfy Codex's strict hook-manifest schema`
    );
    assert.strictEqual(typeof manifest.description, 'string');
    assert.ok(manifest.description.trim(), `${rel} in the npm artifact needs a description`);
  }

  assert(installedCli(['install']).includes('agentsmd installed:'));
  const status = JSON.parse(installedCli(['status']));
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.agentsmdHooksRegistered, 15);
  assert.match(installedCli(['doctor']), /agentsmd doctor: all checks passed/);
  assert(installedCli(['uninstall']).includes('agentsmd uninstalled:'));
  assert.strictEqual(JSON.parse(installedCli(['status'])).installed, false);
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
