'use strict';
// distribution.test.js — guards the user-facing install surfaces: the curl
// installer wrapper and the repo marketplace metadata used by `codex plugin add`.

const fs = require('fs');
const crypto = require('crypto');
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

const singlePackResult = (packOutput) => {
  const results = Array.isArray(packOutput)
    ? packOutput
    : (packOutput && typeof packOutput === 'object' ? Object.values(packOutput) : []);
  assert.strictEqual(results.length, 1, `expected one npm pack result, got ${results.length}`);
  return results[0];
};

const {
  inspectReleaseArtifact,
  provenanceUrlFromNpmView,
  stageSources,
} = require('../lib/release-artifact');
const F = require('../lib/fs-atomic');
const fileDigest = (algorithm, file) => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');

t('standalone deploy staging normalizes source modes into one deterministic tree identity', () => withSandbox((dir) => {
  const populateSource = (root, directoryMode, fileMode) => {
    const directories = [
      'hooks',
      'spec',
      'scripts',
      path.join('skills', 'fixture'),
      'schemas',
      'automation',
      'qa',
    ];
    for (const relative of directories) {
      const target = path.join(root, relative);
      fs.mkdirSync(target, { recursive: true });
      fs.chmodSync(target, directoryMode);
    }
    const files = new Map([
      [path.join('hooks', 'fixture.sh'), '#!/bin/sh\nexit 0\n'],
      [path.join('spec', 'AGENTS.md'), '# fixture\n'],
      [path.join('scripts', 'fixture.js'), "'use strict';\n"],
      [path.join('skills', 'fixture', 'SKILL.md'), '# fixture\n'],
      [path.join('schemas', 'fixture.json'), '{}\n'],
      [path.join('automation', 'README.md'), '# fixture\n'],
      [path.join('qa', 'validation-map.json'), '{}\n'],
      ['package.json', '{"name":"fixture","version":"1.0.0"}\n'],
    ]);
    for (const [relative, content] of files) {
      const target = path.join(root, relative);
      fs.writeFileSync(target, content);
      fs.chmodSync(target, fileMode);
    }
  };

  const permissiveSource = path.join(dir, 'source-permissive');
  const restrictiveSource = path.join(dir, 'source-restrictive');
  populateSource(permissiveSource, 0o777, 0o777);
  populateSource(restrictiveSource, 0o700, 0o600);

  const permissiveDeploy = stageSources(permissiveSource, path.join(dir, 'stage-permissive'));
  const restrictiveDeploy = stageSources(restrictiveSource, path.join(dir, 'stage-restrictive'));
  assert.strictEqual(F.sha256Tree(permissiveDeploy), F.sha256Tree(restrictiveDeploy));
  assert.strictEqual(fs.statSync(permissiveDeploy).mode & 0o777, 0o755);
  assert.strictEqual(fs.statSync(path.join(permissiveDeploy, 'skills', 'fixture')).mode & 0o777, 0o755);
  assert.strictEqual(fs.statSync(path.join(permissiveDeploy, 'hooks', 'fixture.sh')).mode & 0o777, 0o755);
  assert.strictEqual(fs.statSync(path.join(permissiveDeploy, 'scripts', 'fixture.js')).mode & 0o777, 0o644);
  assert.strictEqual(fs.statSync(path.join(permissiveDeploy, 'package.json')).mode & 0o777, 0o644);
}));

t('npm pack JSON accepts legacy arrays and npm 12 package maps only when singular', () => {
  const result = { filename: 'agentsmd.tgz', files: [] };
  assert.strictEqual(singlePackResult([result]), result);
  assert.strictEqual(singlePackResult({ '@sdsrs/agentsmd': result }), result);
  assert.throws(() => singlePackResult(null), /expected one npm pack result, got 0/);
  assert.throws(() => singlePackResult({ a: result, b: result }), /expected one npm pack result, got 2/);
});

t('npm provenance metadata accepts npm 10 objects and npm 12 arrays only when singular', () => {
  const provenance = {
    url: 'https://registry.npmjs.org/-/npm/v1/attestations/%40sdsrs%2fagentsmd@4.24.0',
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
  };
  assert.strictEqual(provenanceUrlFromNpmView(provenance), provenance.url);
  assert.strictEqual(provenanceUrlFromNpmView([provenance]), provenance.url);
  assert.throws(() => provenanceUrlFromNpmView(null), /expected one npm SLSA provenance URL, found 0/);
  assert.throws(() => provenanceUrlFromNpmView([
    provenance,
    { ...provenance, url: provenance.url + '?other=1' },
  ]), /expected one npm SLSA provenance URL, found 2/);
  assert.throws(() => provenanceUrlFromNpmView({
    ...provenance,
    url: 'https://example.com/attestation',
  }), /must use https:\/\/registry\.npmjs\.org/);
});

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

// R3-01: the default ref is the installer's own pinned release tag — never a
// mutable branch — and it must match the package version (drift gate mirrors this).
t('install.sh pins its default ref to its own release tag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.match(src, new RegExp(`INSTALLER_VERSION="${ver.replace(/\./g, '\\.')}"`));
  assert.match(src, /DEFAULT_REF="v\$INSTALLER_VERSION"/);
  assert(!/DEFAULT_REF="main"/.test(src), 'mutable default ref resurfaced');
});

t('install.sh refuses an explicit mutable ref without --dev, before any download or mutation', () => withSandbox((dir) => {
  for (const ref of ['main', 'feature/x', 'deadbeef']) {
    const codexHome = path.join(dir, 'home-' + ref.replace(/\W/g, '_'));
    const result = cp.spawnSync('sh', [path.join(ROOT, 'install.sh'), '--ref', ref], {
      cwd: ROOT, env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.strictEqual(result.status, 2, `${ref}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /mutable ref/, ref);
    assert.match(result.stderr, /--dev/, ref);
    assert(!fs.existsSync(codexHome), `${ref} touched CODEX_HOME`);
  }
}));

t('install.sh tag path verifies the release SHA-256 end-to-end; a tampered archive dies before mutation (R3-02)', () => withSandbox((dir) => {
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `v${ver}`;
  const relDir = path.join(dir, 'rel', tag);
  fs.mkdirSync(relDir, { recursive: true });
  cp.execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: ROOT, stdio: 'ignore' });
  fs.renameSync(path.join(dir, `sdsrs-agentsmd-${ver}.tgz`), path.join(relDir, `agentsmd-${ver}.tgz`));
  const sha = cp.execFileSync('sha256sum', [`agentsmd-${ver}.tgz`], { cwd: relDir, encoding: 'utf8' });
  fs.writeFileSync(path.join(relDir, `agentsmd-${ver}.tgz.sha256`), sha);
  const base = { AGENTSMD_RELEASE_BASE: `file://${path.join(dir, 'rel')}` };

  const goodHome = path.join(dir, 'home-good');
  const out = run(['--ref', tag], { ...base, CODEX_HOME: goodHome });
  // This harness serves the asset from a local file:// mirror via
  // AGENTSMD_RELEASE_BASE, so it exercises the SUBSTITUTED-base wording. The
  // checksum gates execution identically either way; what it proves against a
  // substituted base is that the archive matches what THAT base published —
  // integrity, not publisher identity — so the installer must not report a bare
  // "sha256 verified" there. The unsubstituted wording needs the real GitHub base.
  assert.match(out, /Resolved: agentsmd v.*UNOFFICIAL mirror.*self-consistent sha256/, out);
  assert.ok(!/sha256 verified/.test(out), `a mirror install must not claim publisher verification:\n${out}`);
  assert(fs.existsSync(path.join(goodHome, 'agentsmd', 'scripts', 'install.js')), 'verified install did not land');

  const archive = path.join(relDir, `agentsmd-${ver}.tgz`);
  const bytes = fs.readFileSync(archive);
  bytes[100] ^= 0xff;
  fs.writeFileSync(archive, bytes);
  const badHome = path.join(dir, 'home-bad');
  const result = cp.spawnSync('sh', [path.join(ROOT, 'install.sh'), '--ref', tag], {
    cwd: ROOT, env: { ...process.env, ...base, CODEX_HOME: badHome }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /SHA-256 mismatch.*refusing to execute/);
  assert(!fs.existsSync(badHome), 'tampered archive must die before any CODEX_HOME mutation');
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
  assert.strictEqual(status.agentsmdHooksRegistered, 19);
  assert.strictEqual(status.agentsmdStatusLinePreset, true);

  const uninstallOut = run(['--source', ROOT, '--uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  const statusAfter = JSON.parse(run(['--source', ROOT, '--status'], env));
  assert.strictEqual(statusAfter.installed, false);
}));

t('install.sh with jq missing → zero-mutation preflight refusal (R1-03), CODEX_HOME untouched', () => withSandbox((dir) => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const home = path.join(dir, 'codex-home');
  const result = cp.spawnSync('/bin/sh', [path.join(ROOT, 'install.sh'), '--source', ROOT], {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: home, PATH: bin },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /zero-mutation preflight/);
  assert.match(result.stdout + result.stderr, /--degraded/);
  assert.ok(!fs.existsSync(home), 'CODEX_HOME must not be created on refusal');
}));

t('install.sh --degraded with jq missing → installs fail-open, manifest enforcement:false', () => withSandbox((dir) => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const home = path.join(dir, 'codex-home');
  const result = cp.spawnSync('/bin/sh', [path.join(ROOT, 'install.sh'), '--source', ROOT, '--degraded'], {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: home, PATH: bin },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Install itself succeeds; the trailing doctor verification stays red on a
  // degraded install ("install enforcement active" + "jq present"), so the
  // script still exits 1 — degraded is usable but never silently healthy.
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '.agentsmd-state', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.enforcement, false);
  assert.deepStrictEqual(manifest.missingPrerequisites, ['jq']);
  assert.match(result.stdout + result.stderr, /doctor reported issues/);
}));

t('repo marketplace exposes the root agentsmd plugin with install policy metadata', () => {
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  const pkg = JSON.parse(read('package.json'));
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.strictEqual(marketplace.name, 'agentsmd');
  assert.strictEqual(marketplace.interface.displayName, 'agentsmd');
  assert.strictEqual(marketplace.plugins.length, 1);

  const entry = marketplace.plugins[0];
  const sourceVersions = String(entry.source.version).split(/\s*\|\|\s*/);
  assert.strictEqual(entry.name, 'agentsmd');
  assert.deepStrictEqual(entry.source, {
    source: 'npm',
    package: pkg.name,
    version: entry.source.version,
  });
  assert.deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.strictEqual(entry.category, 'Coding');
  assert.strictEqual(plugin.name, entry.name);
  assert.strictEqual(plugin.version, pkg.version);
  assert.strictEqual(entry.source.package, pkg.name);
  assert(sourceVersions.length >= 1 && sourceVersions.length <= 2);
  assert(sourceVersions.every((version) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)));
  assert.strictEqual(sourceVersions[sourceVersions.length - 1], plugin.version);
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
  assert(files.includes('schemas'));
  assert(files.includes('automation'));
  assert(files.includes('qa/validation-map.json'));
  assert(files.includes('qa/core-ab-eval.js'));
  assert(files.includes('qa/core-ab/cases.json'));
  assert(files.includes('qa/perf/baseline.json'));
  assert(files.includes('qa/conformance/cases.json'));
  assert(files.includes('qa/conformance/thresholds.json'));
  assert(files.includes('qa/conformance/releases'));
  assert(files.includes('SECURITY.md'));
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
    'init', 'analyze', 'design', 'install', 'update', 'uninstall', 'restore', 'repair',
    'status', 'doctor', 'audit', 'sampling-audit', 'lesson-bypass-audit',
    'sparkline', 'safety-coverage-audit', 'version-cascade', 'perf-baseline',
    'lint-argv', 'verify', 'scorecard', 'outcomes', 'rules',
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
    ['verify', '--since'],
    ['scorecard', '--days=0'],
    ['outcomes', 'list', '--days=0'],
    ['repair'],
    ['repair', '--confirm=not-a-digest'],
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

t('agentsmd exception dispatches to scripts/exception.js, targeting the invoking repo', () => withSandbox((dir) => {
  // exception is repo-scoped like init/analyze — it must read/write the invoking
  // repository's .agentsmd/exceptions.json and never touch CODEX_HOME.
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(path.join(projectDir, 'fixtures'), { recursive: true });
  cp.execFileSync('git', ['-C', projectDir, 'init', '-q']);
  fs.writeFileSync(path.join(projectDir, 'fixtures', 'fake.js'), 'const k = 1;\n');
  const codexHome = path.join(dir, 'codex-home');
  const env = { ...process.env, CODEX_HOME: codexHome };
  const out = cp.execFileSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), 'exception', 'add', '--rule=§8-secrets', '--path=fixtures/fake.js', '--reason=distribution smoke'], {
    cwd: projectDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(out.includes('added: exc-'), out);
  assert(fs.existsSync(path.join(projectDir, '.agentsmd', 'exceptions.json')), 'exception did not write to the invoking repo');
  const list = cp.execFileSync('node', [path.join(ROOT, 'bin', 'agentsmd.js'), 'exception', 'list'], {
    cwd: projectDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(list.includes('fixtures/fake.js'), list);
  assert(!fs.existsSync(codexHome), 'exception must not touch CODEX_HOME');
}));

t('agentsmd install → status → uninstall round-trips against a sandbox CODEX_HOME', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const installOut = cli(['install'], env);
  assert(installOut.includes('agentsmd installed:'));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'task-contract.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'task-evidence.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'scorecard.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'conformance-candidate-attestation.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'conformance-release-binding.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'reviewed-outcomes.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'schemas', 'runtime-canary.schema.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'qa', 'validation-map.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'qa', 'perf', 'baseline.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'qa', 'conformance', 'cases.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'qa', 'conformance', 'thresholds.json')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'conformance-candidate.js')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'conformance-binding.js')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'outcomes.js')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'automation', 'weekly-runtime-canary.md')));
  assert(fs.existsSync(path.join(dir, 'agentsmd', 'skills', 'agentsmd-scorecard', 'SKILL.md')));
  const verifyPlan = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(dir, 'agentsmd', 'scripts', 'verify.js'),
    '--changed',
    '--full',
    '--explain',
    '--json',
  ], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.strictEqual(verifyPlan.schema_version, 1);
  assert.strictEqual(verifyPlan.explain_only, true);
  assert(verifyPlan.checks.some((check) => check.id === 'full-check'));
  const scorecard = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(dir, 'agentsmd', 'scripts', 'scorecard.js'),
    '--days=30',
    '--json',
  ], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.strictEqual(scorecard.schema_version, 2);
  assert.strictEqual(scorecard.performance.state, 'fresh');
  assert.strictEqual(scorecard.automation.recipes_present, 4);
  const outcomeList = JSON.parse(cli(['outcomes', 'list', '--days=30', '--json'], env));
  assert.deepStrictEqual(outcomeList, { days: 30, events: [] });
  assert(!fs.existsSync(path.join(dir, 'logs', 'agentsmd-outcomes.json')),
    'outcomes list must not create a review sidecar');

  const status = JSON.parse(cli(['status'], env));
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.agentsmdHooksRegistered, 19);

  const retainedOutcome = path.join(dir, 'logs', 'agentsmd-outcomes.json');
  fs.mkdirSync(path.dirname(retainedOutcome), { recursive: true });
  fs.writeFileSync(retainedOutcome, JSON.stringify({
    schema_version: 1,
    kind: 'agentsmd-reviewed-outcomes',
    outcomes: [],
  }));
  fs.chmodSync(retainedOutcome, 0o600);
  const uninstallOut = cli(['uninstall'], env);
  assert(uninstallOut.includes('agentsmd uninstalled:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).installed, false);
  assert(fs.existsSync(retainedOutcome), 'uninstall must retain user-owned reviewed outcomes');
}));

t('agentsmd update is an idempotent alias for install', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  cli(['install'], env);
  assert(cli(['update'], env).includes('agentsmd installed:'));
  assert.strictEqual(JSON.parse(cli(['status'], env)).agentsmdHooksRegistered, 19);
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
  assert.strictEqual(manifest.hookCount, 19);
  assert(manifest.ownedArtifacts && manifest.ownedArtifacts.deploy);
}));

t('agentsmd install/update expose strict standalone profile selection without silent fallback', () => withSandbox((dir) => {
  const env = { CODEX_HOME: dir };
  const invalid = cliResult(['install', '--profile=other'], env);
  assert.strictEqual(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /profile must be full/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  const bare = cliResult(['install', '--profile'], env);
  assert.strictEqual(bare.status, 2, bare.stdout + bare.stderr);
  assert.deepStrictEqual(fs.readdirSync(dir), []);

  const installed = JSON.parse(cli(['install', '--profile=full', '--json'], env));
  assert.strictEqual(installed.manifestSchemaVersion, 2);
  assert.strictEqual(installed.profile.selectionMode, 'full');
  assert.strictEqual(installed.profile.materialized, 'full');

  const updated = JSON.parse(cli(['update', '--json'], env));
  assert.strictEqual(updated.profile.selectionMode, 'full');
  assert.strictEqual(updated.profile.materialized, 'full');
}));

t('agentsmd install refuses an accidental dual surface without mutating CODEX_HOME', () => withSandbox((dir) => {
  const pluginList = JSON.stringify({
    installed: [{
      pluginId: 'agentsmd@agentsmd',
      name: 'agentsmd',
      marketplaceName: 'agentsmd',
      version: '4.24.0',
      installed: true,
      enabled: true,
    }],
    available: [],
  });
  const env = {
    CODEX_HOME: dir,
    PATH: `${path.join(ROOT, 'scripts', 'tests', 'fixtures')}:${process.env.PATH}`,
    AGENTSMD_TEST_PLUGIN_LIST_JSON: pluginList,
  };
  const refused = cliResult(['install'], env);
  assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /plugin is enabled; remove it before standalone install/i);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
}));

t('marketplace E2E derives the packaged skill count and refuses an accidental dual surface', () => {
  const script = read('qa/plugin-marketplace-e2e.sh');
  assert.match(script, /EXPECTED_SKILL_COUNT=.*find "\$ROOT\/skills"/);
  assert.match(script, /test "\$SKILL_COUNT" -eq "\$EXPECTED_SKILL_COUNT"/);
  assert.doesNotMatch(script, /test "\$SKILL_COUNT" -eq [0-9]+/);
  assert.doesNotMatch(script, /standalone install skipped:/);
  assert.match(script, /if CODEX_HOME=.*node .*agentsmd\.js" install/);
  assert.match(script, /expected standalone install to refuse an active plugin/);
  assert.match(script, /plugin is enabled; remove it before standalone install/);
});

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
  assert.strictEqual(pkg.scripts['spec:generate'], 'node scripts/spec-source.js --generate');
  assert.strictEqual(pkg.scripts['spec:check'], 'node scripts/spec-source.js --check');
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
  const packOutput = JSON.parse(cp.execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: ROOT,
    env: { ...process.env, npm_config_dry_run: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const packResult = singlePackResult(packOutput);
  const tarball = path.join(packDir, packResult.filename);
  assert(fs.existsSync(tarball), 'npm pack did not produce a tarball');
  const packedPaths = packResult.files.map((entry) => entry.path);
  assert(!packedPaths.includes('spec/AGENTS-omx.md'), 'tarball still contains the removed OMX compatibility core');
  assert(packedPaths.includes('spec/source/layout.json'), 'tarball is missing the canonical spec layout');
  assert(packedPaths.includes('spec/source/base/10-auth.md'), 'tarball is missing canonical shared fragments');
  assert(packedPaths.includes('scripts/spec-source.js'), 'tarball is missing the spec generator');
  assert(packedPaths.includes('qa/core-ab-eval.js'), 'tarball is missing the documented core A/B runner');
  assert(packedPaths.includes('qa/core-ab/cases.json'), 'tarball is missing the core A/B case library');
  assert(packedPaths.includes('qa/conformance/thresholds.json'), 'tarball is missing conformance thresholds');
  assert(packedPaths.includes('qa/conformance/releases/v5.3.0.json'), 'tarball is missing release conformance evidence');
  assert(packedPaths.includes('schemas/conformance-candidate-attestation.schema.json'), 'tarball is missing the candidate-attestation schema');
  assert(packedPaths.includes('schemas/conformance-release-binding.schema.json'), 'tarball is missing the release-binding schema');
  assert(packedPaths.includes('schemas/reviewed-outcomes.schema.json'), 'tarball is missing the reviewed-outcomes schema');
  assert(packedPaths.includes('scripts/conformance-candidate.js'), 'tarball is missing the candidate-attestation generator');
  assert(packedPaths.includes('scripts/conformance-binding.js'), 'tarball is missing the release-binding generator');
  assert(packedPaths.includes('scripts/outcomes.js'), 'tarball is missing the reviewed-outcomes command');
  assert(packedPaths.includes('SECURITY.md'), 'tarball is missing the security policy');
  assert(packedPaths.includes('scripts/security-policy-check.js'), 'tarball is missing the security-policy gate');
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
  const installedScorecard = JSON.parse(installedCli(['scorecard', '--days=30', '--json']));
  assert.strictEqual(installedScorecard.conformance.state, 'stale');
  assert.strictEqual(installedScorecard.conformance.passed, 57);
  assert.strictEqual(installedScorecard.conformance.total, 60);
  assert.strictEqual(installedScorecard.conformance.threshold_verdict, 'waived');
  assert.strictEqual(installedScorecard.conformance.provenance.kind, 'release-evidence');
  assert.strictEqual(installedScorecard.conformance.provenance.release_version, '5.3.0');
  assert.strictEqual(installedScorecard.conformance.provenance.applicability, 'mismatch');
  assert.strictEqual(installedScorecard.conformance.provenance.reason, 'package-version-mismatch');

  const installedRoot = path.resolve(path.dirname(fs.realpathSync(binLink)), '..');
  assert.match(cp.execFileSync(process.execPath, [
    path.join(installedRoot, 'scripts', 'conformance-candidate.js'), '--help',
  ], { cwd: installedRoot, encoding: 'utf8' }), /candidate attestation/u);
  assert.match(cp.execFileSync(process.execPath, [
    path.join(installedRoot, 'scripts', 'conformance-binding.js'), '--help',
  ], { cwd: installedRoot, encoding: 'utf8' }), /post-publication record/u);
  const missingExternal = JSON.parse(installedCli([
    'scorecard', '--days=30', '--json',
    `--conformance-candidate=${path.join(dir, 'missing-candidate.json')}`,
  ]));
  assert.strictEqual(missingExternal.conformance.state, 'unavailable');
  assert.strictEqual(missingExternal.conformance.provenance.reason, 'candidate-evidence-unavailable');
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  const installedCasesFile = path.join(installedRoot, 'qa', 'conformance', 'cases.json');
  const installedThresholdsFile = path.join(installedRoot, 'qa', 'conformance', 'thresholds.json');
  const installedCases = JSON.parse(fs.readFileSync(installedCasesFile, 'utf8')).cases;
  const candidateCommit = 'a'.repeat(40);
  const candidateTree = 'b'.repeat(40);
  const releaseCommit = 'c'.repeat(40);
  const packagedArtifact = inspectReleaseArtifact(installedRoot);
  assert.strictEqual(packagedArtifact.complete, true, packagedArtifact.errors.join('\n'));
  const candidate = {
    schema_version: 1,
    kind: 'agentsmd-conformance-candidate-attestation',
    attested_at: '2026-08-20T01:00:00.000Z',
    subject: {
      package: installedPackage.name,
      version: installedPackage.version,
      source_commit: candidateCommit,
      source_tree: candidateTree,
      source_tracked_clean: true,
      deploy_sha256: packagedArtifact.deploySha256,
      cases_sha256: fileDigest('sha256', installedCasesFile),
      thresholds_sha256: fileDigest('sha256', installedThresholdsFile),
    },
    runs: [{
      capture: 'conformance-20260820T000000Z',
      recorded_at: '2026-08-20T00:00:00.000Z',
      results_sha256: 'd'.repeat(64),
      codex_version: '0.147.0',
      model: 'gpt-5.6-sol',
      agentsmd_version: installedPackage.version,
      surface: 'standalone',
      profile: 'full',
      passed: installedCases.length,
      total: installedCases.length,
      errors: 0,
      false_block_near_negatives: 3,
      threshold_verdict: 'pass',
    }],
    decision: { verdict: 'pass', waiver: null },
  };
  const candidateFile = path.join(dir, 'candidate.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`);
  const tarballSha256 = fileDigest('sha256', tarball);
  const tarballSha512 = fileDigest('sha512', tarball);
  const bindingFile = path.join(dir, 'binding.json');
  fs.writeFileSync(bindingFile, `${JSON.stringify({
    schema_version: 1,
    kind: 'agentsmd-conformance-release-binding',
    verified_at: '2026-08-20T03:00:00.000Z',
    candidate: {
      sha256: fileDigest('sha256', candidateFile),
      package: installedPackage.name,
      version: installedPackage.version,
      source_commit: candidateCommit,
      source_tree: candidateTree,
      deploy_sha256: packagedArtifact.deploySha256,
      attested_at: candidate.attested_at,
    },
    release: {
      package: installedPackage.name,
      version: installedPackage.version,
      commit: releaseCommit,
      tree: candidateTree,
      tag: `v${installedPackage.version}`,
      published_at: '2026-08-20T02:00:00.000Z',
    },
    artifacts: {
      registry_sha256: tarballSha256,
      release_sha256: tarballSha256,
      sha512: tarballSha512,
    },
    provenance: {
      sha256: 'e'.repeat(64),
      subject: `pkg:npm/%40sdsrs/agentsmd@${installedPackage.version}`,
      subject_sha512: tarballSha512,
      repository: 'https://github.com/sdsrss/agentsmd',
      ref: `refs/tags/v${installedPackage.version}`,
      workflow: '.github/workflows/release.yml',
      commit: releaseCommit,
    },
  }, null, 2)}\n`);
  const boundInstalledScorecard = JSON.parse(installedCli([
    'scorecard', '--days=30', '--json',
    `--conformance-candidate=${candidateFile}`,
    `--conformance-binding=${bindingFile}`,
  ]));
  assert.strictEqual(boundInstalledScorecard.conformance.state, 'fresh');
  assert.strictEqual(boundInstalledScorecard.conformance.provenance.evidence_phase, 'published-binding');
  assert.strictEqual(boundInstalledScorecard.conformance.provenance.reason, 'published-binding-and-artifact-match');
  const installedSecurityPolicy = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(installedRoot, 'scripts', 'security-policy-check.js'),
    '--json',
  ], {
    cwd: installedRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.strictEqual(installedSecurityPolicy.ok, true, JSON.stringify(installedSecurityPolicy));
  assert.strictEqual(installedSecurityPolicy.expectedMajor, installedSecurityPolicy.declaredMajor);
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
  assert(selectedCommands.every((command) => (
    command.includes('${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}')
      && command.includes('[ -n "$agentsmd_plugin_root" ] || exit 0')
      && command.includes('bash "$agentsmd_plugin_root/hooks/')
  )), 'plugin-selected commands must implement the guarded PLUGIN_ROOT compatibility contract');
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

  const pluginHome = path.join(dir, 'plugin-home');
  const pluginState = path.join(pluginHome, '.agentsmd-state');
  const pluginData = path.join(dir, 'plugin-data');
  const pluginRuntime = path.join(pluginData, 'runtime');
  fs.mkdirSync(pluginState, { recursive: true });
  fs.mkdirSync(pluginRuntime, { recursive: true });
  fs.writeFileSync(path.join(pluginHome, 'hooks.json'), '{ unrelated malformed shared config\n');
  fs.writeFileSync(path.join(pluginRuntime, 'session-start-package.ref'), '');
  fs.writeFileSync(path.join(pluginState, 'session-start-legacy.ref'), '');
  fs.writeFileSync(path.join(pluginState, 'arbitration-cache.json'), '{"shared":true}');
  fs.writeFileSync(path.join(pluginState, 'foreign-package.txt'), 'keep');
  const pluginCleanup = cp.execFileSync(binLink, ['uninstall', '--plugin-state-only'], {
    env: { ...process.env, CODEX_HOME: pluginHome, PLUGIN_DATA: pluginData },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(pluginCleanup, /agentsmd plugin state removed:/);
  assert(!fs.existsSync(path.join(pluginRuntime, 'session-start-package.ref')));
  assert(fs.existsSync(path.join(pluginState, 'session-start-legacy.ref')));
  assert(fs.existsSync(path.join(pluginState, 'arbitration-cache.json')));
  assert.strictEqual(fs.readFileSync(path.join(pluginState, 'foreign-package.txt'), 'utf8'), 'keep');
  assert.strictEqual(fs.readFileSync(path.join(pluginHome, 'hooks.json'), 'utf8'), '{ unrelated malformed shared config\n');

  assert(installedCli(['install']).includes('agentsmd installed:'));
  const status = JSON.parse(installedCli(['status']));
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.agentsmdHooksRegistered, 19);
  const deployedEvidence = path.join(
    codexHome, 'agentsmd', 'qa', 'conformance', 'releases', 'v5.3.0.json'
  );
  assert(fs.existsSync(deployedEvidence), 'standalone deploy is missing release conformance evidence');
  assert(fs.existsSync(path.join(codexHome, 'agentsmd', 'qa', 'conformance', 'thresholds.json')),
    'standalone deploy is missing conformance thresholds');
  assert(fs.existsSync(path.join(codexHome, 'agentsmd', 'scripts', 'conformance-candidate.js')),
    'standalone deploy is missing the candidate-attestation generator');
  assert(fs.existsSync(path.join(codexHome, 'agentsmd', 'scripts', 'conformance-binding.js')),
    'standalone deploy is missing the release-binding generator');
  const deployedScorecard = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(codexHome, 'agentsmd', 'scripts', 'scorecard.js'),
    '--days=30',
    '--json',
  ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.strictEqual(deployedScorecard.conformance.state, 'stale');
  assert.strictEqual(deployedScorecard.conformance.passed, 57);
  assert.strictEqual(deployedScorecard.conformance.total, 60);
  assert.strictEqual(deployedScorecard.conformance.threshold_verdict, 'waived');
  assert.strictEqual(deployedScorecard.conformance.provenance.kind, 'release-evidence');
  assert.strictEqual(deployedScorecard.conformance.provenance.release_version, '5.3.0');
  assert.strictEqual(deployedScorecard.conformance.provenance.applicability, 'mismatch');
  assert.strictEqual(deployedScorecard.conformance.provenance.reason, 'package-version-mismatch');
  const deployedBoundScorecard = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(codexHome, 'agentsmd', 'scripts', 'scorecard.js'),
    '--days=30',
    '--json',
    `--conformance-candidate=${candidateFile}`,
    `--conformance-binding=${bindingFile}`,
  ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.strictEqual(deployedBoundScorecard.conformance.state, 'fresh');
  assert.strictEqual(deployedBoundScorecard.conformance.provenance.evidence_phase, 'published-binding');
  assert.strictEqual(deployedBoundScorecard.conformance.provenance.reason, 'published-binding-and-artifact-match');
  const healthyPlan = JSON.parse(installedCli(['repair', '--plan']));
  assert.strictEqual(healthyPlan.classification, 'healthy');
  fs.unlinkSync(path.join(codexHome, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  const deployedPlan = JSON.parse(cp.execFileSync(process.execPath, [
    path.join(codexHome, 'agentsmd', 'scripts', 'repair.js'), '--plan',
  ], { env, encoding: 'utf8' }));
  assert.strictEqual(deployedPlan.classification, 'ownership-unprovable');
  assert.strictEqual(deployedPlan.artifactCandidates[0].complete, false);
  const repairPlan = JSON.parse(installedCli(['repair', '--plan']));
  assert.strictEqual(repairPlan.classification, 'owned-files-missing');
  const repairResult = JSON.parse(installedCli(['repair', `--confirm=${repairPlan.planDigest}`]));
  assert.strictEqual(repairResult.repaired, true);
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

t('README plugin lifecycle resolves the installed version and default Codex home', () => {
  for (const f of ['README.md', 'README.zh-CN.md']) {
    const md = read(f);
    const normalized = md.replace(/\s+/g, ' ');
    assert(md.includes('codex plugin marketplace add sdsrss/agentsmd --json'),
      `${f}: must document the GitHub marketplace install`);
    assert(md.includes('select(.pluginId == "agentsmd@agentsmd")'),
      `${f}: uninstall must resolve the installed plugin version`);
    assert(md.includes('${CODEX_HOME:-$HOME/.codex}/plugins/cache/agentsmd/agentsmd/$AGENTSMD_PLUGIN_VERSION/scripts/uninstall.js" --plugin-state-only'),
      `${f}: uninstall must work when CODEX_HOME is unset`);
    assert(!md.includes('$CODEX_HOME/plugins/cache/agentsmd/agentsmd/<version>'),
      `${f}: uninstall must not require an unset CODEX_HOME or manual version placeholder`);
    const cleanupIndex = md.indexOf('node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/agentsmd/agentsmd/$AGENTSMD_PLUGIN_VERSION/scripts/uninstall.js" --plugin-state-only');
    const pluginRemoveIndex = md.indexOf('codex plugin remove agentsmd --marketplace agentsmd --json');
    const marketplaceRemoveIndex = md.indexOf('codex plugin marketplace remove agentsmd --json');
    assert(cleanupIndex >= 0 && cleanupIndex < pluginRemoveIndex && pluginRemoveIndex < marketplaceRemoveIndex,
      `${f}: packaged cleanup must run before plugin and marketplace removal`);
    assert(!normalized.includes('removed the plugin, delete those two paths by hand'),
      `${f}: must not tell users to delete shared state or retained telemetry`);
    assert(!normalized.includes('手动 删除这两个路径'),
      `${f}: must not tell users to delete shared state or retained telemetry`);
  }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
