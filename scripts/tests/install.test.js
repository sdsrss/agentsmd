'use strict';
// install.test.js — proves codexmd's install/uninstall are independent of OMX
// (ARCHITECTURE.md §5 + user directive #8886): touch only codexmd's own entries,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmd-install-test.'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try { fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ── 1. install alongside OMX: codexmd added, OMX preserved ──────────────────
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  const { install, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const after = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('install adds codexmd hook entries', () => assert(H.countCodexmdHooks(after) >= 7, 'expected ≥7 codexmd hooks, got ' + H.countCodexmdHooks(after)));
  t('install preserves the OMX entries (3 events)', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 3));
  t('codexmd entries land in SessionStart/PreToolUse/Stop', () => {
    const p = JSON.parse(after);
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) assert(p.hooks[ev].some((g) => g.hooks.some((h) => H.isCodexmdCommand(h.command))), ev + ' missing codexmd');
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
  t('re-install does not duplicate codexmd entries', () => assert.strictEqual(H.countCodexmdHooks(once), H.countCodexmdHooks(twice)));
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
  t('uninstall removes all codexmd entries', () => assert.strictEqual(H.countCodexmdHooks(after), 0));
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
  t('standalone install creates a valid hooks.json (codexmd-only)', () => {
    assert(H.countCodexmdHooks(hooks) >= 7);
    assert.strictEqual(countCmd(hooks, (c) => !H.isCodexmdCommand(c)), 0);
  });
  t('standalone install sets codex_hooks=true', () => assert(/codex_hooks\s*=\s*true/.test(cfg)));
  t('standalone install injects the spec sentinel block', () => assert(agents.includes('# >>> codexmd >>>') && agents.includes('CODEX-CODING-SPEC')));
  const st = status();
  t('status reports installed with 0 other-tenant hooks', () => { assert.strictEqual(st.installed, true); assert.strictEqual(st.otherTenantHooksPreserved, 0); assert(st.codexmdHooksRegistered >= 7); });
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
  t('config.toml keeps the user model + multi_agent keys', () => { assert(cfg.includes('model = "gpt-5.5"')); assert(cfg.includes('multi_agent = true')); assert(/codex_hooks\s*=\s*true/.test(cfg)); });
  t('AGENTS.md keeps the user instructions + adds the block', () => { assert(agents.includes('Always write tests.')); assert(agents.includes('# >>> codexmd >>>')); });
  uninstall();
  const agents2 = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('uninstall restores AGENTS.md user content (block gone)', () => { assert(agents2.includes('Always write tests.')); assert(!agents2.includes('# >>> codexmd >>>')); });
});

// ── 6. skills: add codexmd-* only, preserve other tenants' skills ───────────
withSandbox((dir) => {
  const skillsDir = path.join(dir, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'other-plugin-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'), '---\nname: other\n---\n');
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  t('install registers codexmd-* skills', () => assert(fs.existsSync(path.join(skillsDir, 'codexmd-audit', 'SKILL.md'))));
  t('install preserves other tenant skills', () => assert(fs.existsSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'))));
  t('install copies scripts into the install dir', () => assert(fs.existsSync(path.join(dir, 'codexmd', 'scripts', 'audit.js'))));
  const un = uninstall();
  t('uninstall removes codexmd-* skills', () => assert(!fs.existsSync(path.join(skillsDir, 'codexmd-audit'))));
  t('uninstall preserves other tenant skills', () => assert(fs.existsSync(path.join(skillsDir, 'other-plugin-skill', 'SKILL.md'))));
  t('uninstall reports skillsRemoved count', () => assert(un.skillsRemoved >= 4, 'skillsRemoved=' + un.skillsRemoved));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
