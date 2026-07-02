'use strict';
// codex-hooks.js — marker-scoped merge/remove of agentsmd's own entries in the
// shared ~/.codex/hooks.json. Mirrors oh-my-codex's dist/config/codex-hooks.js
// (production-proven) but identifies OUR entries by the active CODEX_HOME
// install-dir marker instead of OMX's codex-native-hook.js. Invariant
// (ARCHITECTURE.md §5): touch ONLY agentsmd's entries — never read, modify,
// reorder, or depend on OMX or any other tenant; work whether or not the file
// pre-exists or OMX is installed.

const fs = require('fs');
const P = require('./paths');

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const shellDoubleQuoteEscape = (s) => String(s).replace(/(["\\$`])/g, '\\$1');
const replacePlaceholder = (v, replacement) => {
  if (typeof v === 'string') return v.replace(/__AGENTSMD_HOOKS_DIR__/g, replacement);
  if (Array.isArray(v)) return v.map((x) => replacePlaceholder(x, replacement));
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = replacePlaceholder(val, replacement);
  return out;
};

// A command hook is agentsmd's iff its command path resolves under agentsmd's
// own install dir in the active CODEX_HOME. Matching the exact install dir avoids
// deleting an unrelated tenant whose command happens to live in a project
// directory named `agentsmd`.
function isAgentsmdCommand(command) {
  if (typeof command !== 'string') return false;
  const installDir = P.installDir();
  const normalizedCommand = command.replace(/\\(["\\$`])/g, '$1').replace(/\\/g, '/');
  const normalizedInstallDir = installDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedCommand.includes(`${normalizedInstallDir}/`);
}

// Build agentsmd's managed hook config from the repo template, substituting the
// __AGENTSMD_HOOKS_DIR__ placeholder with the absolute install path. The template
// (hooks/hooks.json) is the single source of truth — no duplicated wiring here.
function buildManagedConfig(hooksDir, templatePath) {
  const parsed = replacePlaceholder(JSON.parse(fs.readFileSync(templatePath, 'utf8')), shellDoubleQuoteEscape(hooksDir));
  if (!isObj(parsed) || !isObj(parsed.hooks)) throw new Error('invalid agentsmd hooks template');
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

// Remove command-hooks matching `isMarked` from one event group; preserve all
// else. Returns { group: <group|null>, removed } — null when the group is empty.
// Parameterized by predicate so the SAME strip discipline serves both agentsmd's
// own marker and the legacy-codexmd migration (scripts/lib/migrate.js).
function stripFromGroup(group, isMarked) {
  if (!isObj(group) || !Array.isArray(group.hooks)) return { group: clone(group), removed: 0 };
  const kept = group.hooks.filter((h) => !(isObj(h) && h.type === 'command' && isMarked(h.command)));
  const removed = group.hooks.length - kept.length;
  if (removed === 0) return { group: clone(group), removed: 0 };
  if (kept.length === 0) return { group: null, removed };
  return { group: { ...clone(group), hooks: kept }, removed };
}
const stripAgentsmdFromGroup = (group) => stripFromGroup(group, isAgentsmdCommand);

// Install / update: per event → strip own + preserve all others + append own.
// Idempotent (re-running replaces our stale entries, never duplicates).
// Refuses to proceed on a present-but-unparseable file: absent/empty → start
// fresh, but a non-empty string that fails to parse may hold OTHER tenants'
// entries we cannot see — clobbering it would silently delete them (the exact
// independence break the marker design exists to prevent). Throw instead.
function mergeAgentsmdHooks(existingContent, managed) {
  let parsed = null;
  if (typeof existingContent === 'string' && existingContent.trim() !== '') {
    parsed = parseHooksConfig(existingContent);
    if (!parsed) {
      throw new Error('refusing to overwrite an unparseable ~/.codex/hooks.json — it may contain other tenants\' hooks. Fix or remove it, then re-run.');
    }
  }
  const root = parsed ? clone(parsed.root) : {};
  const hooks = parsed ? clone(parsed.hooks) : {};

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const preserved = [];
    for (const group of groups) {
      const s = stripAgentsmdFromGroup(group);
      if (s.group !== null) preserved.push(s.group);
    }
    if (preserved.length > 0) hooks[event] = preserved; else delete hooks[event];
  }

  for (const event of Object.keys(managed.hooks)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing, ...managed.hooks[event].map(clone)];
  }
  if (Object.keys(hooks).length > 0) root.hooks = hooks; else delete root.hooks;
  return serialize(root);
}

// Strip every command-hook matching `isMarked` from all events + preserve others.
// Empty event → drop key; empty hooks → drop hooks; empty root → return null
// (caller deletes file). Used by uninstall (agentsmd marker) and the legacy
// migration (codexmd marker) alike — one implementation, two predicates.
function removeMarkedHooks(existingContent, isMarked) {
  const parsed = parseHooksConfig(existingContent);
  if (!parsed) return { nextContent: existingContent, removed: 0 };
  const root = clone(parsed.root);
  const hooks = clone(parsed.hooks);
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const preserved = [];
    for (const group of groups) {
      const s = stripFromGroup(group, isMarked);
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
// Uninstall: strip agentsmd's own entries.
const removeAgentsmdHooks = (existingContent) => removeMarkedHooks(existingContent, isAgentsmdCommand);

// How many agentsmd command-hooks are currently registered in the given content.
function countAgentsmdHooks(content) {
  const parsed = parseHooksConfig(content);
  if (!parsed) return 0;
  let n = 0;
  for (const groups of Object.values(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isObj(g) && Array.isArray(g.hooks)) {
        n += g.hooks.filter((h) => isObj(h) && h.type === 'command' && isAgentsmdCommand(h.command)).length;
      }
    }
  }
  return n;
}

module.exports = {
  isAgentsmdCommand, buildManagedConfig, parseHooksConfig,
  mergeAgentsmdHooks, removeAgentsmdHooks, removeMarkedHooks, countAgentsmdHooks, serialize,
};
