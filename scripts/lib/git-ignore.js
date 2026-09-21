'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const GIT_TIMEOUT_MS = 5000;

function checkIgnore(base, entries) {
  // Node's input pipe uses a socket shutdown to send EOF. Some network-restricted
  // sandboxes deny that syscall even for local sockets, leaving Git waiting.
  // A private regular file delivers EOF without relaxing the sandbox policy.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-git-ignore.'));
  const input = path.join(dir, 'paths');
  let fd;
  try {
    fs.writeFileSync(input, entries.join('\0') + '\0', { flag: 'wx', mode: 0o600 });
    fd = fs.openSync(input, 'r');
    return cp.spawnSync('git', ['-C', base, 'check-ignore', '--no-index', '-z', '--stdin'], {
      stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      try { fs.rmSync(input, { force: true }); }
      finally { fs.rmdirSync(dir); }
    }
  }
}

// Preserve the pre-existing non-Git fallback used by analyze: bare directory
// names and suffix globs such as `*.gen.js`. Full Git semantics are delegated
// to Git itself whenever the project is inside a worktree.
function simplePatterns(root) {
  const dirs = new Set();
  const suffixes = [];
  try {
    for (let line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const suffix = line.match(/^\*([.A-Za-z0-9_-]+)$/);
      if (suffix) {
        suffixes.push(suffix[1]);
        continue;
      }
      const bare = line.replace(/\/$/, '').replace(/^\//, '');
      if (bare && !bare.includes('/') && !bare.includes('*') && !bare.startsWith('!')) dirs.add(bare);
    }
  } catch { /* no readable root .gitignore */ }
  return { dirs, suffixes };
}

function fallbackIgnored(root, patterns, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  if (segments.slice(0, -1).some((segment) => patterns.dirs.has(segment))) return true;
  if (patterns.dirs.has(segments[segments.length - 1])) return true;
  return patterns.suffixes.some((suffix) => segments[segments.length - 1].endsWith(suffix));
}

function createIgnoreMatcher(root) {
  const base = path.resolve(root || process.cwd());
  const fallback = simplePatterns(base);
  const probe = cp.spawnSync('git', ['-C', base, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const useGit = !probe.error && probe.status === 0 && probe.stdout.trim() === 'true';

  function ignored(entries) {
    const absoluteEntries = entries.map((entry) => path.resolve(entry));
    if (!useGit || absoluteEntries.length === 0) {
      return new Set(absoluteEntries.filter((entry) => fallbackIgnored(base, fallback, entry)));
    }

    const relativeEntries = [];
    const byRelative = new Map();
    for (const absolute of absoluteEntries) {
      const relative = path.relative(base, absolute);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      relativeEntries.push(relative);
      byRelative.set(relative, absolute);
    }
    if (!relativeEntries.length) return new Set();

    const result = checkIgnore(base, relativeEntries);
    // check-ignore: 0 = at least one match, 1 = no matches. Any other result
    // means Git could not evaluate this batch, so retain the bounded legacy
    // fallback instead of silently treating everything as visible.
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return new Set(absoluteEntries.filter((entry) => fallbackIgnored(base, fallback, entry)));
    }
    const matches = new Set();
    for (const relative of String(result.stdout || '').split('\0').filter(Boolean)) {
      const absolute = byRelative.get(relative);
      if (absolute) matches.add(absolute);
    }
    return matches;
  }

  return { ignored, usesGit: useGit };
}

module.exports = { createIgnoreMatcher };
