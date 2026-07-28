'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { packRegistryArtifact } = require('../lib/registry-pack-retry');
const { main } = require('../release-registry-pack');

const CLI = path.join(__dirname, '..', 'release-registry-pack.js');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-registry-pack.'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function fakeNpm(t, root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'npm');
  fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const stateFile = process.env.AGENTSMD_FAKE_NPM_STATE;
const destination = process.env.AGENTSMD_FAKE_NPM_DESTINATION;
const packSucceedAfter = Number(process.env.AGENTSMD_FAKE_NPM_PACK_SUCCEED_AFTER);
const installSucceedAfter = Number(process.env.AGENTSMD_FAKE_NPM_INSTALL_SUCCEED_AFTER);
const state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  : { pack: 0, install: 0 };
const command = process.argv[2];
if (command === 'pack') {
  state.pack += 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(destination, state.pack >= packSucceedAfter ? 'final.tgz' : \`partial-\${state.pack}.tgz\`), 'bytes');
  process.exit(state.pack >= packSucceedAfter ? 0 : 1);
}
if (command === 'install') {
  state.install += 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(state.install >= installSucceedAfter ? 0 : 1);
}
process.exit(2);
`);
  fs.chmodSync(executable, 0o755);
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  return bin;
}

function runCliProbe(t, { attempts, packSucceedAfter, installSucceedAfter = 1 }) {
  const root = sandbox(t);
  const destination = path.join(root, 'destination');
  const stateFile = path.join(root, 'attempts.txt');
  fs.mkdirSync(destination);
  const bin = fakeNpm(t, root);
  const command = [
    shellQuote(process.execPath),
    shellQuote(CLI),
    '--package=@sdsrs/agentsmd@9.9.9',
    `--destination=${shellQuote(destination)}`,
    `--attempts=${attempts}`,
    '--delay-ms=1',
  ].join(' ');
  const result = cp.spawnSync('bash', [
    '--noprofile',
    '--norc',
    '-euo',
    'pipefail',
    '-c',
    command,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTSMD_FAKE_NPM_DESTINATION: destination,
      AGENTSMD_FAKE_NPM_STATE: stateFile,
      AGENTSMD_FAKE_NPM_PACK_SUCCEED_AFTER: String(packSucceedAfter),
      AGENTSMD_FAKE_NPM_INSTALL_SUCCEED_AFTER: String(installSucceedAfter),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  });
  return {
    ...result,
    state: JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    files: fs.readdirSync(destination).sort(),
  };
}

test('transient npm failures are captured inside Node and retried to success', async (t) => {
  const destination = sandbox(t);
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'unrelated');
  const packStatuses = [1, 1, 0];
  const waits = [];
  const logs = [];
  let packCalls = 0;
  let installCalls = 0;
  const result = await packRegistryArtifact({
    packageSpec: '@sdsrs/agentsmd@9.9.9',
    destination,
    attempts: 4,
    delayMs: 7,
    spawn(command, args, options) {
      assert.strictEqual(command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      assert.deepStrictEqual(options, { stdio: 'inherit' });
      if (args[0] === 'install') {
        installCalls += 1;
        assert.strictEqual(args[1], '@sdsrs/agentsmd@9.9.9');
        assert.strictEqual(args[2], '--prefix');
        assert.match(args[3], /\.agentsmd-install-probe\./);
        assert.deepStrictEqual(args.slice(4), [
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--prefer-online',
        ]);
        return { status: 0 };
      }
      assert.deepStrictEqual(args, [
        'pack',
        '@sdsrs/agentsmd@9.9.9',
        '--pack-destination',
        destination,
        '--json',
        '--prefer-online',
      ]);
      packCalls += 1;
      fs.writeFileSync(path.join(destination, packCalls === 3 ? 'final.tgz' : `partial-${packCalls}.tgz`), 'bytes');
      return { status: packStatuses.shift() };
    },
    wait(delay) { waits.push(delay); },
    log(message) { logs.push(message); },
  });

  assert.deepStrictEqual(result, { attempt: 3, status: 0 });
  assert.deepStrictEqual(waits, [7, 7]);
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(packCalls, 3);
  assert.strictEqual(installCalls, 1);
  assert.deepStrictEqual(fs.readdirSync(destination).sort(), ['final.tgz', 'keep.txt']);
});

test('pack success is retried until npm install metadata is ready', async (t) => {
  const destination = sandbox(t);
  const calls = [];
  let packAttempts = 0;
  let installAttempts = 0;
  const result = await packRegistryArtifact({
    packageSpec: '@sdsrs/agentsmd@9.9.9',
    destination,
    attempts: 3,
    delayMs: 0,
    spawn(command, args) {
      calls.push(args[0]);
      if (args[0] === 'pack') {
        packAttempts += 1;
        fs.writeFileSync(path.join(destination, `registry-${packAttempts}.tgz`), 'bytes');
        return { status: 0 };
      }
      assert.strictEqual(args[0], 'install');
      installAttempts += 1;
      return { status: installAttempts === 1 ? 1 : 0 };
    },
    wait() {},
    log() {},
  });

  assert.deepStrictEqual(result, { attempt: 2, status: 0 });
  assert.deepStrictEqual(calls, ['pack', 'install', 'pack', 'install']);
  assert.deepStrictEqual(fs.readdirSync(destination), ['registry-2.tgz']);
});

test('failed attempts preserve pre-existing and nested tarballs', async (t) => {
  const destination = sandbox(t);
  const nested = path.join(destination, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(destination, 'unrelated.tgz'), 'preserve me');
  fs.writeFileSync(path.join(nested, 'nested.tgz'), 'nested');
  let calls = 0;
  const result = await packRegistryArtifact({
    packageSpec: '@sdsrs/agentsmd@9.9.9',
    destination,
    attempts: 2,
    delayMs: 0,
    spawn(command, args) {
      if (args[0] === 'install') return { status: 0 };
      calls += 1;
      fs.writeFileSync(path.join(destination, calls === 2 ? 'final.tgz' : 'partial.tgz'), 'bytes');
      return { status: calls === 2 ? 0 : 1 };
    },
    wait() {},
    log() {},
  });

  assert.deepStrictEqual(result, { attempt: 2, status: 0 });
  assert.deepStrictEqual(fs.readdirSync(destination).sort(), ['final.tgz', 'nested', 'unrelated.tgz']);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'unrelated.tgz'), 'utf8'), 'preserve me');
  assert.strictEqual(fs.readFileSync(path.join(nested, 'nested.tgz'), 'utf8'), 'nested');
});

test('retry exhaustion cleans partial tarballs and reports the final child status', async (t) => {
  const destination = sandbox(t);
  let calls = 0;
  await assert.rejects(
    packRegistryArtifact({
      packageSpec: '@sdsrs/agentsmd@9.9.9',
      destination,
      attempts: 2,
      delayMs: 0,
      spawn() {
        calls += 1;
        fs.writeFileSync(path.join(destination, `partial-${calls}.tgz`), 'bytes');
        return { status: 1 };
      },
      wait() {},
      log() {},
    }),
    /unavailable after 2 attempts \(last npm pack exit 1\)/
  );
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(fs.readdirSync(destination), []);
});

test('install readiness exhaustion cleans every probe and new tarball', async (t) => {
  const destination = sandbox(t);
  fs.writeFileSync(path.join(destination, 'preserved.tgz'), 'pre-existing');
  let packCalls = 0;
  let installCalls = 0;
  await assert.rejects(
    packRegistryArtifact({
      packageSpec: '@sdsrs/agentsmd@9.9.9',
      destination,
      attempts: 2,
      delayMs: 0,
      spawn(command, args) {
        if (args[0] === 'install') {
          installCalls += 1;
          return { status: 1 };
        }
        packCalls += 1;
        fs.writeFileSync(path.join(destination, `attempt-${packCalls}.tgz`), 'bytes');
        return { status: 0 };
      },
      wait() {},
      log() {},
    }),
    /registry install readiness was unavailable after 2 attempts \(last npm install exit 1\)/
  );
  assert.strictEqual(packCalls, 2);
  assert.strictEqual(installCalls, 2);
  assert.deepStrictEqual(fs.readdirSync(destination), ['preserved.tgz']);
});

test('spawn errors fail immediately instead of masquerading as registry propagation', async (t) => {
  const destination = sandbox(t);
  let waits = 0;
  await assert.rejects(
    packRegistryArtifact({
      packageSpec: '@sdsrs/agentsmd@9.9.9',
      destination,
      spawn() { return { error: new Error('npm missing'), status: null }; },
      wait() { waits += 1; },
      log() {},
    }),
    /npm missing/
  );
  assert.strictEqual(waits, 0);
});

test('symlink destinations are rejected before npm is spawned', async (t) => {
  const root = sandbox(t);
  const destination = path.join(root, 'destination');
  const link = path.join(root, 'destination-link');
  fs.mkdirSync(destination);
  fs.symlinkSync(destination, link, 'dir');
  let calls = 0;
  await assert.rejects(
    packRegistryArtifact({
      packageSpec: '@sdsrs/agentsmd@9.9.9',
      destination: link,
      spawn() {
        calls += 1;
        return { status: 0 };
      },
    }),
    /destination must be a real directory/
  );
  assert.strictEqual(calls, 0);
});

test('CLI usage errors remain distinct from retry exhaustion', async () => {
  assert.strictEqual(await main([]), 2);
  assert.strictEqual(await main([
    '--package=@sdsrs/agentsmd@9.9.9',
    '--destination=/tmp',
    '--attempts=1e2',
    '--delay-ms=10',
  ]), 2);
});

test('real CLI retries successfully beneath bash errexit and pipefail', (t) => {
  const result = runCliProbe(t, { attempts: 4, packSucceedAfter: 3 });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.state, { pack: 3, install: 1 });
  assert.deepStrictEqual(result.files, ['final.tgz']);
  assert.match(result.stderr, /waiting for .* \(attempt 1\/4, npm pack exit 1\)/);
  assert.match(result.stderr, /waiting for .* \(attempt 2\/4, npm pack exit 1\)/);
});

test('real CLI retries pack and install as one attempt beneath bash errexit', (t) => {
  const result = runCliProbe(t, {
    attempts: 4,
    packSucceedAfter: 1,
    installSucceedAfter: 3,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.state, { pack: 3, install: 3 });
  assert.deepStrictEqual(result.files, ['final.tgz']);
  assert.match(result.stderr, /registry install readiness \(attempt 1\/4, npm install exit 1\)/);
  assert.match(result.stderr, /registry install readiness \(attempt 2\/4, npm install exit 1\)/);
});

test('real CLI reports exhaustion only after every attempt beneath bash errexit', (t) => {
  const result = runCliProbe(t, { attempts: 2, packSucceedAfter: 99 });
  assert.strictEqual(result.status, 1);
  assert.deepStrictEqual(result.state, { pack: 2, install: 0 });
  assert.deepStrictEqual(result.files, []);
  assert.match(result.stderr, /unavailable after 2 attempts \(last npm pack exit 1\)/);
});
