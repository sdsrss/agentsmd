'use strict';

// Unix fallback for systems without GNU timeout (notably stock macOS). Spawn
// the command in its own process group so a timeout cannot orphan descendants.
const { spawn } = require('child_process');

const seconds = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);
if (!Number.isFinite(seconds) || seconds <= 0 || !command) process.exit(1);

const child = spawn(command, args, { detached: true, stdio: 'inherit' });
let timedOut = false;
let forceTimer = null;
const signalGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch { /* already exited */ }
};
const timer = setTimeout(() => {
  timedOut = true;
  signalGroup('SIGTERM');
  forceTimer = setTimeout(() => signalGroup('SIGKILL'), 250);
  forceTimer.unref();
}, seconds * 1000);

child.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) process.exitCode = 124;
  else if (Number.isInteger(code)) process.exitCode = code;
  else process.exitCode = signal ? 128 + (signal === 'SIGTERM' ? 15 : 1) : 1;
});
