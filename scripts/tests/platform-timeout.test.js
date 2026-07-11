'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-timeout-'));
const pidFile = path.join(temp, 'child.pid');
let childPid = null;
try {
  const script = [
    `source ${JSON.stringify(path.join(ROOT, 'hooks', 'lib', 'platform.sh'))}`,
    `AGENTSMD_NO_TIMEOUT_BIN=1 platform_timeout 0.1 sh -c 'sleep 30 & echo $! > "$1"; wait' sh ${JSON.stringify(pidFile)}`,
    'test $? -eq 124',
  ].join('\n');
  const result = cp.spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(result.status, 0, result.stderr);
  childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert(Number.isInteger(childPid) && childPid > 1);
  let alive = true;
  for (let i = 0; i < 20; i += 1) {
    try { process.kill(childPid, 0); alive = true; } catch { alive = false; }
    if (!alive) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.strictEqual(alive, false, `timed-out descendant ${childPid} survived`);
  console.log('  ok   portable timeout terminates the complete command process group');
  console.log('\nRESULT: 1 passed, 0 failed');
} finally {
  if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(temp, { recursive: true, force: true });
}
