'use strict';
// install.test.js — proves agentsmd's install/uninstall are independent of OMX
// (ARCHITECTURE.md §5 + user directive #8886): touch only agentsmd's own entries,
// preserve every other tenant byte-for-byte, idempotent, and work standalone
// with no OMX present. Fully sandboxed via CODEX_HOME → a temp dir; nothing
// touches the real ~/.codex.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

// Fresh module state per sandbox: clear the require cache so paths.js re-reads
// CODEX_HOME. (paths.js reads process.env at call time, but be safe.)
function loadModules() {
  for (const k of Object.keys(require.cache)) if (/scripts[\\/](lib[\\/])?[a-z-]+\.js$/.test(k)) delete require.cache[k];
  return {
    install: require('../install').install,
    uninstall: require('../uninstall').uninstall,
    status: require('../status').status,
    H: require('../lib/codex-hooks'),
    M: require('../lib/migrate'),
  };
}

const OMX_CMD = 'node "/omx/dist/scripts/codex-native-hook.js"';
function omxSeed() {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: OMX_CMD }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OMX_CMD }] }],
      Stop: [{ hooks: [{ type: 'command', command: OMX_CMD, timeout: 30 }] }],
    },
  }, null, 2) + '\n';
}
const countCmd = (content, pred) => {
  const p = JSON.parse(content); let n = 0;
  for (const groups of Object.values(p.hooks || {})) for (const g of groups || []) for (const h of (g.hooks || [])) if (h.type === 'command' && pred(h.command)) n++;
  return n;
};
const withSandbox = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-install-test.'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try { fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ── 1. install alongside OMX: agentsmd added, OMX preserved ──────────────────
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  const { install, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const after = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('install adds agentsmd hook entries', () => assert(H.countAgentsmdHooks(after) >= 7, 'expected ≥7 agentsmd hooks, got ' + H.countAgentsmdHooks(after)));
  t('install preserves the OMX entries (3 events)', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 3));
  t('agentsmd entries land in SessionStart/PreToolUse/Stop', () => {
    const p = JSON.parse(after);
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) assert(p.hooks[ev].some((g) => g.hooks.some((h) => H.isAgentsmdCommand(h.command))), ev + ' missing agentsmd');
  });
});

// ── 2. install is idempotent ────────────────────────────────────────────────
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  const { install, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const once = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  install('2026-07-02T00:00:00.000Z');
  const twice = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('re-install does not duplicate agentsmd entries', () => assert.strictEqual(H.countAgentsmdHooks(once), H.countAgentsmdHooks(twice)));
  t('re-install is byte-stable', () => assert.strictEqual(once, twice));
});

// ── 3. round-trip: install → uninstall restores OMX byte-for-byte ───────────
withSandbox((dir) => {
  const seed = omxSeed();
  fs.writeFileSync(path.join(dir, 'hooks.json'), seed);
  const { install, uninstall, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const res = uninstall();
  const after = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('uninstall removes all agentsmd entries', () => assert.strictEqual(H.countAgentsmdHooks(after), 0));
  t('uninstall reports the removed count (≥7)', () => assert(res.hooksRemoved >= 7, 'removed=' + res.hooksRemoved));
  t('uninstall preserves OMX entries', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 3));
  t('round-trip is byte-identical to the OMX seed', () => assert.strictEqual(after, seed));
  t('uninstall leaves config.toml codex_hooks flag (§5)', () => assert.strictEqual(res.flagLeftEnabled, true));
});

// ── 4. standalone: no OMX, no pre-existing files ────────────────────────────
withSandbox((dir) => {
  const { install, uninstall, status, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const hooks = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('standalone install creates a valid hooks.json (agentsmd-only)', () => {
    assert(H.countAgentsmdHooks(hooks) >= 7);
    assert.strictEqual(countCmd(hooks, (c) => !H.isAgentsmdCommand(c)), 0);
  });
  t('standalone install sets hooks=true', () => assert(/^\s*hooks\s*=\s*true/m.test(cfg)));
  t('standalone install injects the spec sentinel block', () => assert(agents.includes('# >>> agentsmd >>>') && agents.includes('CODEX-CODING-SPEC')));
  const st = status();
  t('status reports installed with 0 other-tenant hooks', () => { assert.strictEqual(st.installed, true); assert.strictEqual(st.otherTenantHooksPreserved, 0); assert(st.agentsmdHooksRegistered >= 7); });
  uninstall();
  t('standalone uninstall removes hooks.json (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'hooks.json'))));
  t('standalone uninstall removes AGENTS.md (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'AGENTS.md'))));
});

// ── 5. config.toml + AGENTS.md preserve unrelated content ───────────────────
withSandbox((dir) => {
  const userCfg = '# my config\nmodel = "gpt-5.5"\n\n[features]\nmulti_agent = true\n';
  const userAgents = '# My global instructions\nAlways write tests.\n';
  fs.writeFileSync(path.join(dir, 'config.toml'), userCfg);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), userAgents);
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('config.toml keeps the user model + multi_agent keys', () => { assert(cfg.includes('model = "gpt-5.5"')); assert(cfg.includes('multi_agent = true')); assert(/^\s*hooks\s*=\s*true/m.test(cfg)); });
  t('AGENTS.md keeps the user instructions + adds the block', () => { assert(agents.includes('Always write tests.')); assert(agents.includes('# >>> agentsmd >>>')); });
  uninstall();
  const agents2 = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('uninstall restores AGENTS.md user content (block gone)', () => { assert(agents2.includes('Always write tests.')); assert(!agents2.includes('# >>> agentsmd >>>')); });
});

// ── 6. skills: add agentsmd-* only, preserve other tenants' skills ───────────
withSandbox((dir) => {
  const skillsDir = path.join(dir, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'other-plugin-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'), '---\nname: other\n---\n');
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  t('install registers agentsmd-* skills', () => assert(fs.existsSync(path.join(skillsDir, 'agentsmd-audit', 'SKILL.md'))));
  t('install preserves other tenant skills', () => assert(fs.existsSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'))));
  t('install copies scripts into the install dir', () => assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'audit.js'))));
  const un = uninstall();
  t('uninstall removes agentsmd-* skills', () => assert(!fs.existsSync(path.join(skillsDir, 'agentsmd-audit'))));
  t('uninstall preserves other tenant skills', () => assert(fs.existsSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'))));
  t('uninstall reports skillsRemoved count', () => assert(un.skillsRemoved >= 4, 'skillsRemoved=' + un.skillsRemoved));
});

// ── 7. C1: never clobber a present-but-unparseable shared hooks.json ─────────
{
  const H = require('../lib/codex-hooks');
  const managed = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "/x/agentsmd/hooks/a.sh"' }] }] } };
  t('merge throws on a present-but-unparseable hooks.json', () => assert.throws(() => H.mergeAgentsmdHooks('{"hooks": nope,}', managed)));
  t('merge treats empty/whitespace as absent (starts fresh)', () => assert.strictEqual(H.countAgentsmdHooks(H.mergeAgentsmdHooks('  \n', managed)), 1));
  withSandbox((dir) => {
    const malformed = '{"hooks": {,}}  // OMX was here: node /omx/x.js\n';
    fs.writeFileSync(path.join(dir, 'hooks.json'), malformed);
    const { install } = loadModules();
    t('install aborts (throws) on a malformed hooks.json', () => assert.throws(() => install('2026-07-02T00:00:00.000Z')));
    t('install leaves the malformed hooks.json byte-untouched', () => assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), malformed));
  });
}

// ── 8. config.toml [features] flag detection + codex_hooks→hooks migration ───
{
  const CT = require('../lib/config-toml');
  t('config: canonical [features] hooks=true → no-op', () => assert.strictEqual(CT.ensureCodexHooksFlag('[features]\nhooks = true\n').changed, false));
  t('config: deprecated codex_hooks=true migrated to hooks=true (Codex 0.142)', () => {
    const r = CT.ensureCodexHooksFlag('[features]\ncodex_hooks = true\n');
    assert.strictEqual(r.reason, 'migrated-codex_hooks-to-hooks');
    assert(/^\s*hooks = true/m.test(r.content) && !/codex_hooks/.test(r.content), 'renamed in place: ' + r.content);
  });
  t('config: either-name flag under a NON-features table is not "enabled"', () => {
    const r = CT.ensureCodexHooksFlag('[experimental]\ncodex_hooks = true\n');
    assert.strictEqual(r.changed, true);
    assert(CT.isCodexHooksEnabled(r.content) && /^\s*hooks = true/m.test(r.content));
    assert(r.content.includes('[experimental]'), 'stray key preserved');
  });
  t('config: features hooks=false → set true (no duplicate key)', () => {
    const r = CT.ensureCodexHooksFlag('[features]\nhooks = false\n');
    assert(/hooks = true/.test(r.content) && !/=\s*false/.test(r.content));
  });
  t('config: isCodexHooksEnabled recognizes BOTH names', () => {
    assert(CT.isCodexHooksEnabled('[features]\nhooks = true\n'));
    assert(CT.isCodexHooksEnabled('[features]\ncodex_hooks = true\n'));
    assert(!CT.isCodexHooksEnabled('[features]\nmulti_agent = true\n'));
  });
}

// ── 9. legacy codexmd → agentsmd migration (agentsmd's former name) ──────────
const LEGACY_SS = 'bash "/home/u/.codex/codexmd/hooks/session-start-check.sh"';
const LEGACY_BASH = 'bash "/home/u/.codex/codexmd/hooks/pre-bash-safety-check.sh"';
const isCodexmd = (c) => /[\\/]codexmd[\\/]/.test(c);
function codexmdSeed() {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: LEGACY_SS }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OMX_CMD }, { type: 'command', command: LEGACY_BASH }] }],
    },
  }, null, 2) + '\n';
}

// 9a. install migrates a full prior codexmd footprint; OMX + user content survive.
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), codexmdSeed());
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My instructions\nAlways write tests.\n\n# >>> codexmd >>>\nold codexmd spec\n# <<< codexmd <<<\n');
  fs.mkdirSync(path.join(dir, 'skills', 'codexmd-audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'codexmd-audit', 'SKILL.md'), '---\nname: codexmd-audit\n---\n');
  fs.mkdirSync(path.join(dir, 'skills', 'other-plugin-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'other-plugin-skill', 'SKILL.md'), '---\nname: other\n---\n');
  fs.mkdirSync(path.join(dir, 'codexmd', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codexmd', 'hooks', 'x.sh'), '# old\n');
  fs.mkdirSync(path.join(dir, '.codexmd-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codexmd-state', 'manifest.json'), '{}\n');

  const { install, H } = loadModules();
  const manifest = install('2026-07-03T00:00:00.000Z');
  const hooks = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('migrate: legacy /codexmd/ hooks stripped', () => assert.strictEqual(countCmd(hooks, isCodexmd), 0));
  t('migrate: OMX entry preserved through migration', () => assert.strictEqual(countCmd(hooks, (c) => c === OMX_CMD), 1));
  t('migrate: agentsmd hooks installed', () => assert(H.countAgentsmdHooks(hooks) >= 7));
  t('migrate: legacy AGENTS.md block gone; agentsmd block + user content kept', () => {
    assert(!agents.includes('# >>> codexmd >>>'), 'legacy block still present');
    assert(agents.includes('# >>> agentsmd >>>') && agents.includes('Always write tests.'));
  });
  t('migrate: codexmd-* skill removed; agentsmd-* + other tenant kept', () => {
    assert(!fs.existsSync(path.join(dir, 'skills', 'codexmd-audit')));
    assert(fs.existsSync(path.join(dir, 'skills', 'agentsmd-audit')));
    assert(fs.existsSync(path.join(dir, 'skills', 'other-plugin-skill')));
  });
  t('migrate: legacy install + state dirs removed', () => {
    assert(!fs.existsSync(path.join(dir, 'codexmd')) && !fs.existsSync(path.join(dir, '.codexmd-state')));
  });
  t('migrate: manifest records the migration (detected + counts)', () => {
    const m = manifest.migratedFromCodexmd;
    assert(m && m.detected === true, 'migratedFromCodexmd not recorded');
    assert.strictEqual(m.hooksRemoved, 2);
    assert.strictEqual(m.agentsBlockRemoved, true);
    assert.strictEqual(m.installDirRemoved, true);
  });
});

// 9b. removeLegacyCodexmd is a no-op when nothing codexmd is present.
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  const { M } = loadModules();
  const r = M.removeLegacyCodexmd();
  t('migrate: no-op when no codexmd present (detected=false)', () => {
    assert.strictEqual(r.detected, false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), omxSeed());
  });
});

// 9c. uninstall sweeps a leftover codexmd remnant too.
withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  fs.mkdirSync(path.join(dir, 'codexmd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codexmd', 'x'), '1');
  const res = uninstall();
  t('migrate: uninstall sweeps + reports a leftover codexmd remnant', () => {
    assert(res.legacyCodexmdRemoved && res.legacyCodexmdRemoved.installDirRemoved === true);
    assert(!fs.existsSync(path.join(dir, 'codexmd')));
  });
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
