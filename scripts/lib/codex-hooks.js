'use strict';
// codex-hooks.js — marker-scoped merge/remove of codexmd's own entries in the
// shared ~/.codex/hooks.json. Mirrors oh-my-codex's dist/config/codex-hooks.js
// (production-proven) but identifies OUR entries by the '/codexmd/' path marker
// instead of OMX's codex-native-hook.js. Invariant (ARCHITECTURE.md §5): touch
// ONLY codexmd's entries — never read, modify, reorder, or depend on OMX or any
// other tenant; work whether or not the file pre-exists or OMX is installed.

const fs = require('fs');

const MANAGED_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// A command hook is codexmd's iff its command path contains a `/codexmd/`
// segment. The installer guarantees the install dir carries that segment, so
// this can never match OMX (`codex-native-hook.js`) or any other tenant.
function isCodexmdCommand(command) {
  return typeof command === 'string' && /[\\/]codexmd[\\/]/.test(command);
}

// Build codexmd's managed hook config from the repo template, substituting the
// __CODEXMD_HOOKS_DIR__ placeholder with the absolute install path. The template
// (hooks/hooks.json) is the single source of truth — no duplicated wiring here.
function buildManagedConfig(hooksDir, templatePath) {
  const raw = fs.readFileSync(templatePath, 'utf8').replace(/__CODEXMD_HOOKS_DIR__/g, hooksDir);
  const parsed = JSON.parse(raw);
  if (!isObj(parsed) || !isObj(parsed.hooks)) throw new Error('invalid codexmd hooks template');
  return { hooks: parsed.hooks };
}

function parseHooksConfig(content) {
  try {
    const parsed = JSON.parse(content);
    if (!isObj(parsed)) return null;
    return { root: clone(parsed), hooks: isObj(parsed.hooks) ? clone(parsed.hooks) : {} };
  } catch { return null; }
}

function serialize(root) {
  return JSON.stringify(root, null, 2) + '\n';
}

// Remove codexmd command-hooks from one event group; preserve everything else.
// Returns { group: <group|null>, removed } — null when the group is left empty.
function stripCodexmdFromGroup(group) {
  if (!isObj(group) || !Array.isArray(group.hooks)) return { group: clone(group), removed: 0 };
  const kept = group.hooks.filter((h) => !(isObj(h) && h.type === 'command' && isCodexmdCommand(h.command)));
  const removed = group.hooks.length - kept.length;
  if (removed === 0) return { group: clone(group), removed: 0 };
  if (kept.length === 0) return { group: null, removed };
  return { group: { ...clone(group), hooks: kept }, removed };
}

// Install / update: per event → strip own + preserve all others + append own.
// Idempotent (re-running replaces our stale entries, never duplicates).
function mergeCodexmdHooks(existingContent, managed) {
  const parsed = typeof existingContent === 'string' ? parseHooksConfig(existingContent) : null;
  const root = parsed ? clone(parsed.root) : {};
  const hooks = parsed ? clone(parsed.hooks) : {};
  for (const event of Object.keys(managed.hooks)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const preserved = [];
    for (const group of existing) {
      const s = stripCodexmdFromGroup(group);
      if (s.group !== null) preserved.push(s.group);
    }
    hooks[event] = [...preserved, ...managed.hooks[event].map(clone)];
  }
  if (Object.keys(hooks).length > 0) root.hooks = hooks; else delete root.hooks;
  return serialize(root);
}

// Uninstall: strip own from every event + preserve others. Empty event → drop
// key; empty hooks → drop hooks; empty root → return null (caller deletes file).
function removeCodexmdHooks(existingContent) {
  const parsed = parseHooksConfig(existingContent);
  if (!parsed) return { nextContent: existingContent, removed: 0 };
  const root = clone(parsed.root);
  const hooks = clone(parsed.hooks);
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const preserved = [];
    for (const group of groups) {
      const s = stripCodexmdFromGroup(group);
      removed += s.removed;
      if (s.group !== null) preserved.push(s.group);
    }
    if (preserved.length > 0) hooks[event] = preserved; else delete hooks[event];
  }
  if (removed === 0) return { nextContent: existingContent, removed: 0 };
  if (Object.keys(hooks).length > 0) root.hooks = hooks; else delete root.hooks;
  if (Object.keys(root).length === 0) return { nextContent: null, removed };
  return { nextContent: serialize(root), removed };
}

// How many codexmd command-hooks are currently registered in the given content.
function countCodexmdHooks(content) {
  const parsed = parseHooksConfig(content);
  if (!parsed) return 0;
  let n = 0;
  for (const groups of Object.values(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isObj(g) && Array.isArray(g.hooks)) {
        n += g.hooks.filter((h) => isObj(h) && h.type === 'command' && isCodexmdCommand(h.command)).length;
      }
    }
  }
  return n;
}

module.exports = {
  MANAGED_EVENTS, isCodexmdCommand, buildManagedConfig, parseHooksConfig,
  mergeCodexmdHooks, removeCodexmdHooks, countCodexmdHooks, serialize,
};
