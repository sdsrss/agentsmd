'use strict';

// Internal worker for perf-baseline.js. Codex launches all matching command
// hooks for an event concurrently, so measuring them one at a time and summing
// the durations is aggregate process cost, not event wall latency. This worker
// starts the supplied hook paths together and times until the last one exits.
// It is a worker (rather than an in-process async API) so perf-baseline.js can
// keep its synchronous public/test surface and exclude worker startup from the
// measured interval.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const median = (nums) => {
  const sorted = [...nums].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (nums, p) => {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};

function timeGroup(hookPaths, eventJson, disabled, resetPath) {
  // dual-cold is measured in an isolated CODEX_HOME. Reset exactly its
  // arbitration cache outside the timed interval so every sample starts cold;
  // accepting any broader/arbitrary deletion target would make this internal
  // benchmark worker unsafe to invoke directly.
  if (resetPath) fs.rmSync(resetPath, { force: true });
  const env = disabled
    ? { ...process.env, DISABLE_AGENTSMD_HOOKS: '1' }
    : process.env;
  const start = process.hrtime.bigint();
  return Promise.all(hookPaths.map((hookPath) => new Promise((resolve, reject) => {
    const child = spawn('bash', [hookPath], {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', resolve);
    child.stdin.end(eventJson);
  }))).then(() => Number(process.hrtime.bigint() - start) / 1e6);
}

async function measure(hookPaths, eventJson, runs, resetPath) {
  const off = [];
  const on = [];
  for (let i = 0; i < runs; i++) off.push(await timeGroup(hookPaths, eventJson, true, resetPath));
  for (let i = 0; i < runs; i++) on.push(await timeGroup(hookPaths, eventJson, false, resetPath));
  return {
    off: { p50: median(off), p95: percentile(off, 95) },
    on: { p50: median(on), p95: percentile(on, 95) },
  };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed.hookPaths) || parsed.hookPaths.length === 0 ||
      typeof parsed.eventJson !== 'string' ||
      !Number.isInteger(parsed.runs) || parsed.runs < 1) {
    throw new Error('invalid perf event-harness input');
  }
  let resetPath = null;
  if (parsed.resetPath !== undefined && parsed.resetPath !== null) {
    const home = process.env.CODEX_HOME;
    const expected = home
      ? path.join(path.resolve(home), '.agentsmd-state', 'arbitration-cache.json')
      : null;
    if (!expected || path.resolve(parsed.resetPath) !== expected) {
      throw new Error('resetPath must be the isolated CODEX_HOME arbitration cache');
    }
    resetPath = expected;
  }
  process.stdout.write(JSON.stringify(
    await measure(parsed.hookPaths, parsed.eventJson, parsed.runs, resetPath),
  ));
}

main().catch((error) => {
  process.stderr.write(`perf event harness: ${error.message}\n`);
  process.exitCode = 1;
});
