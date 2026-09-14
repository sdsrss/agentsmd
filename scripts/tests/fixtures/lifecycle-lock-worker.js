'use strict';

// Real-process scheduling barriers preserve filesystem data/results. The
// no-hardlinks mode separately injects an unsupported-filesystem error.
const fs = require('fs');
const path = require('path');
const L = require('../../lib/lifecycle-lock');
const dir = L.lockDir();
const mode = process.argv[2] || 'hold';
let paused = false;
function emit(event) { fs.writeSync(1, `${JSON.stringify({ event, pid: process.pid })}\n`); }
function wait() {
  if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('barrier EOF');
}
function barrier(event) {
  if (paused) return;
  paused = true;
  emit(event);
  wait();
}
const read = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const result = read.call(this, file, ...args);
  if (mode === 'after-owner-read' && file === path.join(dir, 'owner.json')) barrier(mode);
  return result;
};
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const reaping = from === dir && String(to).startsWith(`${dir}.stale-`);
  if (reaping && mode === 'before-rename') barrier(mode);
  const result = rename.call(this, from, to);
  if (reaping && mode === 'after-rename') barrier(mode);
  return result;
};
const write = fs.writeFileSync;
fs.writeFileSync = function (file, ...args) {
  if (mode === 'before-prepared' && String(file).includes('.reap-prepared-')) barrier(mode);
  const result = write.call(this, file, ...args);
  if (mode === 'prepared' && String(file).includes('.reap-prepared-')) barrier(mode);
  return result;
};
const link = fs.linkSync;
fs.linkSync = function (...args) {
  if (mode === 'no-hardlinks') {
    const error = new Error('fixture filesystem refuses hard links');
    error.code = 'EPERM';
    throw error;
  }
  return link.apply(this, args);
};

try {
  const handle = L.acquire('test-worker');
  emit('acquired');
  wait();
  L.release(handle);
  emit('released');
} catch (error) {
  emit(error.code === 'AGENTSMD_LOCK_HELD' ? 'refused' : `error:${error.message}`);
  process.exitCode = 1;
}
