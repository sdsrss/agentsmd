'use strict';

// Parse an untrusted project MEMORY.md into a bounded list of safe relative
// targets. Kept in a file instead of a `node -` heredoc so stock macOS Bash 3.2
// does not have to parse a large command substitution containing the program.
const fs = require('fs');
const path = require('path');

const MAX_MEMORY_BYTES = 64 * 1024;
const STOP = new Set('the and for with this that from memory file when use using before after into your you code spec rule rules note lesson project reference feedback which what will each per via ally'.split(' '));

function safeTarget(root, raw) {
  const target = String(raw || '').trim();
  if (!target || target.includes('\\') || target.includes('\0') || path.isAbsolute(target)
      || /^[A-Za-z]:[\\/]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = target.split('/');
  if (parts[0] !== 'memory' || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')
      || !parts[parts.length - 1].endsWith('.md')) return null;
  const memoryDir = path.join(root, 'memory');
  let memoryDirStat;
  try { memoryDirStat = fs.lstatSync(memoryDir); } catch { return null; }
  if (!memoryDirStat.isDirectory() || memoryDirStat.isSymbolicLink()) return null;
  let memoryReal;
  try { memoryReal = fs.realpathSync(memoryDir); } catch { return null; }
  let cursor = memoryDir;
  for (const part of parts.slice(1)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
  }
  let stat;
  let real;
  try { stat = fs.statSync(cursor); real = fs.realpathSync(cursor); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES || !real.startsWith(memoryReal + path.sep)) return null;
  return parts.join('/');
}

function suggestedLinks(memoryIndex, prompt, limit = 3) {
  let body;
  try { body = fs.readFileSync(memoryIndex, 'utf8'); } catch { return []; }
  const promptText = String(prompt);
  const promptLower = promptText.toLowerCase();
  const root = path.dirname(memoryIndex);
  const found = [];
  for (const line of body.split(/\r?\n/)) {
    if (!/^[-*] \[/.test(line)) continue;
    const english = (line.match(/[A-Za-z][A-Za-z-]{4,}/g) || [])
      .map((word) => word.toLowerCase()).filter((word) => !STOP.has(word));
    const cjk = line.match(/[\u3400-\u9fff]{2,}/g) || [];
    if (!english.some((word) => promptLower.includes(word)) && !cjk.some((word) => promptText.includes(word))) continue;
    for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
      const relative = safeTarget(root, match[1]);
      if (relative && !found.includes(relative)) found.push(relative);
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }
  return found;
}

if (require.main === module) {
  const [memoryIndex, prompt] = process.argv.slice(2);
  const found = suggestedLinks(memoryIndex, prompt);
  if (found.length) process.stdout.write(JSON.stringify(found));
}

module.exports = { safeTarget, suggestedLinks, MAX_MEMORY_BYTES };
