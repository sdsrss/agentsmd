#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function clearThreadGoal(codexBin, threadId) {
  if (!codexBin) throw new Error('codex binary is required');
  if (!UUID_RE.test(threadId)) throw new Error(`invalid thread id: ${threadId}`);

  const child = spawn(codexBin, ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 0;
  let stdoutBuffer = '';
  let stderr = '';
  let settled = false;

  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const split = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, split);
      stdoutBuffer = stdoutBuffer.slice(split + 1);
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.id === undefined || !pending.has(row.id)) continue;
      const { resolve, reject } = pending.get(row.id);
      pending.delete(row.id);
      if (row.error) reject(new Error(JSON.stringify(row.error)));
      else resolve(row.result);
    }
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  child.stdin.on('error', (error) => failPending(error));
  child.on('error', (error) => failPending(error));
  child.on('exit', (code, signal) => {
    if (!settled && pending.size) {
      failPending(new Error(`app-server exited before responding (${signal || code}): ${stderr.trim()}`));
    }
  });

  const timer = setTimeout(() => {
    failPending(new Error('app-server goal cleanup timed out'));
    child.kill('SIGTERM');
  }, 10_000);

  try {
    await request('initialize', {
      clientInfo: { name: 'agentsmd-conformance-cleanup', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const before = await request('thread/goal/get', { threadId });
    if (before.goal === null) {
      settled = true;
      return { threadId, cleared: false, previousGoal: null };
    }
    if (!before.goal || before.goal.threadId !== threadId) {
      throw new Error(`goal/get returned a mismatched thread: ${JSON.stringify(before.goal)}`);
    }
    const cleared = await request('thread/goal/clear', { threadId });
    const after = await request('thread/goal/get', { threadId });
    if (cleared.cleared !== true || after.goal !== null) {
      throw new Error(`goal cleanup verification failed: ${JSON.stringify({ cleared, after })}`);
    }
    settled = true;
    return { threadId, cleared: true, previousGoal: before.goal };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
  }
}

async function main() {
  const [, , codexBin, threadId] = process.argv;
  const result = await clearThreadGoal(codexBin, threadId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`agentsmd: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { clearThreadGoal };
