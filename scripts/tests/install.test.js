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
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

// Exact expected hook count, derived from the wiring template — a dropped or added
// registration then turns this test red instead of passing a loose `>= 7`.
const EXPECTED_HOOKS = (() => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  let n = 0;
  for (const groups of Object.values(tpl.hooks)) for (const g of groups || []) n += (g.hooks || []).length;
  return n;
})();

// Fresh module state per sandbox: clear the require cache so paths.js re-reads
// CODEX_HOME. (paths.js reads process.env at call time, but be safe.)
function loadModules() {
  for (const k of Object.keys(require.cache)) if (/scripts[\\/](lib[\\/])?[a-z-]+\.js$/.test(k)) delete require.cache[k];
  return {
    install: require('../install').install,
    uninstall: require('../uninstall').uninstall,
    status: require('../status').status,
    doctor: require('../doctor').doctor,
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
  t('install adds agentsmd hook entries', () => assert.strictEqual(H.countAgentsmdHooks(after), EXPECTED_HOOKS));
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

// ── 2b. update removes stale agentsmd hook entries from retired events ──────
withSandbox((dir) => {
  const retiredAgentsmd = `bash "${path.join(dir, 'agentsmd', 'hooks', 'retired-notification.sh')}"`;
  const unrelatedProjectHook = 'node "/home/user/projects/agentsmd/custom-hook.js"';
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: {
      Notification: [{ hooks: [
        { type: 'command', command: retiredAgentsmd },
        { type: 'command', command: unrelatedProjectHook },
        { type: 'command', command: OMX_CMD },
      ] }],
    },
  }, null, 2) + '\n');
  const { install, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const after = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('update removes stale agentsmd entries from retired events', () => {
    assert.strictEqual(H.countAgentsmdHooks(after), EXPECTED_HOOKS);
    assert(!after.includes('retired-notification.sh'));
  });
  t('update preserves unrelated hooks in a project named agentsmd', () => assert.strictEqual(countCmd(after, (c) => c === unrelatedProjectHook), 1));
  t('update preserves other tenants in retired events', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 1));
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
  t('uninstall reports the removed count', () => assert.strictEqual(res.hooksRemoved, EXPECTED_HOOKS));
  t('uninstall preserves OMX entries', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 3));
  t('round-trip is byte-identical to the OMX seed', () => assert.strictEqual(after, seed));
  t('uninstall leaves config.toml codex_hooks flag (§5)', () => assert.strictEqual(res.flagLeftEnabled, true));
});

// ── 4. standalone: no OMX, no pre-existing files ────────────────────────────
withSandbox((dir) => {
  const { install, uninstall, status, doctor, H } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const hooks = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('standalone install creates a valid hooks.json (agentsmd-only)', () => {
    assert.strictEqual(H.countAgentsmdHooks(hooks), EXPECTED_HOOKS);
    assert.strictEqual(countCmd(hooks, (c) => !H.isAgentsmdCommand(c)), 0);
  });
  t('standalone install sets hooks=true', () => assert(/^\s*hooks\s*=\s*true/m.test(cfg)));
  t('standalone install injects the spec sentinel block', () => assert(agents.includes('# >>> agentsmd >>>') && agents.includes('CODEX-CODING-SPEC')));
  const st = status();
  t('status reports installed with 0 other-tenant hooks', () => { assert.strictEqual(st.installed, true); assert.strictEqual(st.otherTenantHooksPreserved, 0); assert.strictEqual(st.agentsmdHooksRegistered, EXPECTED_HOOKS); });
  t('doctor reports a healthy standalone install', () => assert.strictEqual(doctor().ok, true));
  uninstall();
  t('standalone uninstall removes hooks.json (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'hooks.json'))));
  t('standalone uninstall removes AGENTS.md (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'AGENTS.md'))));
  t('doctor fails after standalone uninstall', () => {
    const d = doctor();
    assert.strictEqual(d.ok, false);
    assert(d.checks.some((c) => c.name === 'agentsmd hooks registered' && c.ok === false));
    assert(d.checks.some((c) => c.name === 'installed hooks executable' && c.ok === false));
  });
});

// ── 4b. doctor catches a broken registration even if files remain installed ─
withSandbox((dir) => {
  const { install, doctor } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.unlinkSync(path.join(dir, 'hooks.json'));
  t('doctor fails when hooks.json no longer registers agentsmd', () => {
    const d = doctor();
    assert.strictEqual(d.ok, false);
    assert(d.checks.some((c) => c.name === 'agentsmd hooks registered' && c.ok === false && c.detail === `0/${EXPECTED_HOOKS}`));
  });
});

// ── 4c. install works when CODEX_HOME needs shell/JSON escaping ─────────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-install-test.'));
  const dir = path.join(base, 'codex"home$test');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { install, status, doctor } = loadModules();
    install('2026-07-02T00:00:00.000Z');
    const st = status();
    t('install handles CODEX_HOME with shell-special characters', () => {
      assert.strictEqual(st.installed, true);
      assert.strictEqual(st.agentsmdHooksRegistered, EXPECTED_HOOKS);
      assert.strictEqual(doctor().ok, true);
    });
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
    const preBash = hooks.hooks.PreToolUse[0].hooks[0].command;
    const out = cp.execSync(preBash, {
      input: '{"tool_name":"Bash","tool_input":{"command":"rm -rf $BUILD_DIR"},"session_id":"special-path"}',
      env: { ...process.env, CODEX_HOME: dir },
      encoding: 'utf8',
    });
    t('installed hook command runs from shell-special CODEX_HOME', () => assert.strictEqual(JSON.parse(out).decision, 'block'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

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
  withSandbox((dir) => {
    const { H } = loadModules();
    const managed = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash "${path.join(dir, 'agentsmd', 'hooks', 'a.sh')}"` }] }] } };
    t('merge throws on a present-but-unparseable hooks.json', () => assert.throws(() => H.mergeAgentsmdHooks('{"hooks": nope,}', managed)));
    t('merge treats empty/whitespace as absent (starts fresh)', () => assert.strictEqual(H.countAgentsmdHooks(H.mergeAgentsmdHooks('  \n', managed)), 1));
  });
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
  t('config: [features] table with inline comment is recognized', () => {
    const r = CT.ensureCodexHooksFlag('[features] # Codex feature flags\nmulti_agent = true\n');
    assert.strictEqual(r.reason, 'inserted-under-features');
    assert(!/\n\[features\]\n/.test(r.content), 'must not append a duplicate [features] table: ' + r.content);
    assert(/\[features\] # Codex feature flags\nhooks = true\nmulti_agent = true/.test(r.content), 'hooks inserted under existing table: ' + r.content);
  });
  t('config: commented [features] hooks=false → set true in place', () => {
    const r = CT.ensureCodexHooksFlag('[features] # Codex feature flags\nhooks = false\n');
    assert.strictEqual(r.reason, 'set-hooks-true');
    assert.strictEqual((r.content.match(/\[features\]/g) || []).length, 1);
    assert(/hooks = true/.test(r.content) && !/=\s*false/.test(r.content));
  });
  t('config: isCodexHooksEnabled recognizes BOTH names', () => {
    assert(CT.isCodexHooksEnabled('[features]\nhooks = true\n'));
    assert(CT.isCodexHooksEnabled('[features]\ncodex_hooks = true\n'));
    assert(!CT.isCodexHooksEnabled('[features]\nmulti_agent = true\n'));
  });
}

// ── 9. legacy codexmd → agentsmd migration (agentsmd's former name) ──────────
const isCodexmd = (c) => /[\\/]codexmd[\\/]/.test(c);
const legacySessionCmd = (dir) => `bash "${path.join(dir, 'codexmd', 'hooks', 'session-start-check.sh')}"`;
const legacyBashCmd = (dir) => `bash "${path.join(dir, 'codexmd', 'hooks', 'pre-bash-safety-check.sh')}"`;
function codexmdSeed(dir) {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: legacySessionCmd(dir) }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OMX_CMD }, { type: 'command', command: legacyBashCmd(dir) }] }],
    },
  }, null, 2) + '\n';
}

// 9a. install migrates a full prior codexmd footprint; OMX + user content survive.
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), codexmdSeed(dir));
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
  t('migrate: agentsmd hooks installed', () => assert.strictEqual(H.countAgentsmdHooks(hooks), EXPECTED_HOOKS));
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

// 9c. migration preserves unrelated hooks in a project directory named codexmd.
withSandbox((dir) => {
  const unrelated = 'bash "/home/user/projects/codexmd/custom-hook.sh"';
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: legacyBashCmd(dir) },
        { type: 'command', command: unrelated },
        { type: 'command', command: OMX_CMD },
      ] }],
    },
  }, null, 2) + '\n');
  const { install, H } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  const hooks = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('migrate: unrelated project-codexmd hook preserved', () => assert.strictEqual(countCmd(hooks, (c) => c === unrelated), 1));
  t('migrate: active legacy codexmd hook removed', () => assert.strictEqual(countCmd(hooks, (c) => c === legacyBashCmd(dir)), 0));
  t('migrate: agentsmd hooks installed after preserving unrelated codexmd path', () => assert.strictEqual(H.countAgentsmdHooks(hooks), EXPECTED_HOOKS));
});

// 9d. uninstall sweeps a leftover codexmd remnant too.
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

// 9e. install migrates prior codexmd telemetry into agentsmd's log (upgraders keep
//     their promote/demote window instead of restarting it at zero).
withSandbox((dir) => {
  const legacyLog = path.join(dir, 'logs', 'codexmd.jsonl');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, '{"ts":"2026-07-01T00:00:00Z","hook":"pre-bash-safety","event":"block"}\n{"ts":"2026-07-01T01:00:00Z","hook":"banned-vocab","event":"block"}\n');
  const { install } = loadModules();
  const manifest = install('2026-07-03T00:00:00.000Z');
  const newLog = path.join(dir, 'logs', 'agentsmd.jsonl');
  t('migrate: legacy telemetry appended to agentsmd log', () => {
    assert(fs.existsSync(newLog), 'agentsmd.jsonl not created');
    assert.strictEqual(fs.readFileSync(newLog, 'utf8').split('\n').filter(Boolean).length, 2);
  });
  t('migrate: legacy telemetry file consumed (one-shot)', () => assert(!fs.existsSync(legacyLog)));
  t('migrate: manifest records migrated telemetry row count', () => assert.strictEqual(manifest.migratedTelemetryRows, 2));
  // idempotent: a second install must not double-append (legacy file already gone).
  install('2026-07-03T00:00:00.000Z');
  t('migrate: re-install does not duplicate migrated rows', () => assert.strictEqual(fs.readFileSync(newLog, 'utf8').split('\n').filter(Boolean).length, 2));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
