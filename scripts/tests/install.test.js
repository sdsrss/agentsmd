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

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.rmSync(path.join(dir, '.agentsmd-state', 'backups'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.agentsmd-state', 'backups'), 'not a directory');
  const result = uninstall();
  t('uninstall surfaces a pre-uninstall backup failure while completing removal', () => {
    assert.match(result.backupWarning || '', /pre-uninstall backup failed/i);
    assert(!fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
  });
});

withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  fs.mkdirSync(path.join(dir, '.agentsmd-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentsmd-state', 'backups'), 'not a directory');
  const before = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  const { install } = loadModules();
  t('install fails before mutation when its recovery backup cannot be created', () => {
    assert.throws(() => install('2026-07-02T00:00:00.000Z'), /backup|not a directory|ENOTDIR/i);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), before);
    assert(!fs.existsSync(path.join(dir, 'agentsmd')), 'failed backup must abort before deploy');
  });
});

// Existing private config must not be widened by temp-file + rename. New files
// managed under CODEX_HOME carry private defaults because config can contain env
// and MCP credentials and state/manifest data describes the local installation.
withSandbox((dir) => {
  const cfgPath = path.join(dir, 'config.toml');
  fs.writeFileSync(cfgPath, '[features]\nhooks = false\n', { mode: 0o600 });
  fs.chmodSync(cfgPath, 0o600);
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  t('atomic install preserves an existing config.toml mode', () => assert.strictEqual(fs.statSync(cfgPath).mode & 0o777, 0o600));
  t('new sensitive install files are owner-only', () => {
    for (const rel of ['hooks.json', 'AGENTS.md', 'AGENTS-extended.md', '.agentsmd-state/manifest.json']) {
      assert.strictEqual(fs.statSync(path.join(dir, rel)).mode & 0o777, 0o600, rel);
    }
    assert.strictEqual(fs.statSync(path.join(dir, '.agentsmd-state')).mode & 0o777, 0o700);
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
  const agentsmdPathAsArgument = `node "/other/tenant.js" --log "${path.join(dir, 'agentsmd', 'hooks', 'session-start-check.sh')}"`;
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: {
      Notification: [{ hooks: [
        { type: 'command', command: retiredAgentsmd },
        { type: 'command', command: unrelatedProjectHook },
        { type: 'command', command: agentsmdPathAsArgument },
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
  t('update preserves another tenant whose argument mentions an agentsmd hook path', () => assert.strictEqual(countCmd(after, (c) => c === agentsmdPathAsArgument), 1));
  t('update preserves other tenants in retired events', () => assert.strictEqual(countCmd(after, (c) => c === OMX_CMD), 1));
  t('hook ownership rejects path traversal outside the hooks root', () => {
    assert.strictEqual(H.isAgentsmdCommand(`bash "${path.join(dir, 'agentsmd', 'hooks', '..', 'foreign.sh')}"`), false);
  });
  t('hook ownership rejects dynamically expanded script paths', () => {
    const root = path.join(dir, 'agentsmd', 'hooks');
    for (const command of [
      `bash "${root}/$(printf session-start-check.sh)"`,
      `bash "${root}/\`printf session-start-check.sh\`"`,
      'bash "$CODEX_HOME/agentsmd/hooks/session-start-check.sh"',
    ]) assert.strictEqual(H.isAgentsmdCommand(command), false, command);
  });
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

// A successful commit must compare the shared-file bytes it merged against.
// Inject a tenant edit immediately before agentsmd's hooks.json commit: the
// update must abort and preserve the injected bytes instead of replacing them.
withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const hooks = path.join(dir, 'hooks.json');
  const external = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo concurrent-tenant' }] }] } }, null, 2) + '\n';
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(hooks)) {
      injected = true;
      fs.writeFileSync(hooks, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { F.writeFileAtomic = realWrite; }
  t('install CAS aborts when hooks.json changes after merge', () => assert(error && /concurrent.*hooks\.json|hooks\.json.*concurrent/i.test(error.message)));
  t('install CAS preserves the concurrent hooks tenant bytes', () => assert.strictEqual(fs.readFileSync(hooks, 'utf8'), external));
});

for (const [name, relative, prepare, external] of [
  ['config.toml', 'config.toml', (file) => fs.writeFileSync(file, '[features]\nhooks = false\n'), '# concurrent config tenant\n[features]\nhooks = false\n'],
  ['AGENTS.md', 'AGENTS.md', () => {}, '# concurrent AGENTS tenant\n'],
  ['AGENTS-extended.md', 'AGENTS-extended.md', () => {}, '# concurrent extended tenant\n'],
  ['manifest.json', '.agentsmd-state/manifest.json', () => {}, '{"concurrent":"manifest-tenant"}\n'],
]) withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const target = path.join(dir, relative);
  prepare(target);
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(target)) {
      injected = true;
      fs.writeFileSync(target, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { F.writeFileAtomic = realWrite; }
  t(`install CAS aborts when ${name} changes after merge`, () => assert(error && /concurrent change detected/i.test(error.message)));
  t(`install CAS preserves concurrent ${name} bytes`, () => assert.strictEqual(fs.readFileSync(target, 'utf8'), external));
});

for (const [name, relative] of [
  ['deploy', 'agentsmd'],
  ['skill', 'skills/agentsmd-audit'],
]) withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const target = path.join(dir, relative);
  const foreign = path.join(target, 'concurrent-tenant.txt');
  const F = require('../lib/fs-atomic');
  const realHash = F.sha256Tree;
  let targetHashes = 0;
  F.sha256Tree = (root) => {
    if (path.resolve(String(root)) === path.resolve(target) && ++targetHashes === 2) fs.writeFileSync(foreign, 'concurrent owned-artifact replacement\n');
    return realHash(root);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { F.sha256Tree = realHash; }
  t(`install revalidates ${name} immediately before replacement`, () => assert(error && /ownership collision/i.test(error.message)));
  t(`install preserves concurrently changed ${name}`, () => assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'concurrent owned-artifact replacement\n'));
});

// ── 3b. uninstall aborts on an unparseable shared hooks.json (mirror of install) ─
withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const corrupt = '{ this is not valid json';
  fs.writeFileSync(path.join(dir, 'hooks.json'), corrupt);
  t('uninstall throws on an unparseable hooks.json (never edits it blind)', () => {
    assert.throws(() => uninstall(), /not valid JSON/);
  });
  t('uninstall abort leaves the corrupt file byte-untouched', () => {
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), corrupt);
  });
});

withSandbox((dir) => {
  const foreign = path.join(dir, '.agentsmd-state', 'foreign.txt');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, 'foreign state\n');
  const { uninstall } = loadModules();
  uninstall();
  t('uninstall without a manifest preserves a foreign state directory', () => assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign state\n'));
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const foreign = path.join(dir, '.agentsmd-state', 'foreign.txt');
  fs.writeFileSync(foreign, 'foreign state\n');
  uninstall();
  t('uninstall removes owned state but preserves unknown state files', () => {
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign state\n');
    assert(!fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
  });
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const manifest = path.join(dir, '.agentsmd-state', 'manifest.json');
  const hooks = path.join(dir, 'hooks.json');
  const hooksBefore = fs.readFileSync(hooks, 'utf8');
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(manifest)) {
      const denied = new Error('permission denied'); denied.code = 'EACCES'; throw denied;
    }
    return realRead(file, ...args);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { fs.readFileSync = realRead; }
  t('uninstall fails closed when the ownership manifest is unreadable', () => assert(error && /EACCES|permission denied/i.test(error.message)));
  t('unreadable manifest abort preserves shared and owned artifacts', () => {
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), hooksBefore);
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));
    assert(fs.existsSync(path.join(dir, 'skills', 'agentsmd-audit', 'SKILL.md')));
  });
});

withSandbox((dir) => {
  const foreignDeploy = path.join(dir, 'agentsmd');
  fs.mkdirSync(foreignDeploy, { recursive: true });
  fs.writeFileSync(path.join(foreignDeploy, 'foreign.txt'), 'foreign deploy\n');
  const { install } = loadModules();
  t('install rejects an unowned deploy directory collision', () => assert.throws(
    () => install('2026-07-02T00:00:00.000Z'),
    /ownership collision.*deploy/i
  ));
  t('deploy collision preserves foreign bytes', () => assert.strictEqual(fs.readFileSync(path.join(foreignDeploy, 'foreign.txt'), 'utf8'), 'foreign deploy\n'));
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const manifest = path.join(dir, '.agentsmd-state', 'manifest.json');
  const hooks = path.join(dir, 'hooks.json');
  const hooksBefore = fs.readFileSync(hooks, 'utf8');
  fs.writeFileSync(manifest, '{ invalid ownership manifest');
  t('uninstall rejects an unparseable ownership manifest before mutation', () => assert.throws(
    () => uninstall(),
    /manifest.*not valid JSON.*ownership/i
  ));
  t('malformed manifest abort preserves hooks, deploy, skill, and extended artifacts', () => {
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), hooksBefore);
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));
    assert(fs.existsSync(path.join(dir, 'skills', 'agentsmd-audit', 'SKILL.md')));
    assert(fs.existsSync(path.join(dir, 'AGENTS-extended.md')));
  });
});

// ── 3c. install writes shared files atomically (temp+rename, no leftover temps) ─
withSandbox((dir) => {
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  t('install leaves no .agentsmd-tmp-* files (atomic temp+rename cleaned up)', () => {
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.agentsmd-tmp-'));
    assert.deepStrictEqual(leftovers, [], 'temp files: ' + leftovers.join(', '));
  });
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
  t('standalone install configures the agentsmd status line preset', () => {
    assert(cfg.includes('status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]'));
  });
  t('standalone install injects the spec sentinel block', () => assert(agents.includes('# >>> agentsmd >>>') && agents.includes('CODEX-CODING-SPEC')));
  t('standalone install writes AGENTS-extended.md at the top level (core §2/§5 cat target)', () => {
    const ext = fs.readFileSync(path.join(dir, 'AGENTS-extended.md'), 'utf8');
    assert(ext.includes('CODEX-CODING-SPEC') && ext.includes('Extended'), 'extended header missing');
    assert.strictEqual(ext, fs.readFileSync(path.join(dir, 'agentsmd', 'spec', 'AGENTS-extended.md'), 'utf8'), 'top-level extended must match the install-dir copy');
  });
  t('standalone deploy excludes source-only hook and script tests', () => {
    assert(!fs.existsSync(path.join(dir, 'agentsmd', 'hooks', 'tests')), 'hooks/tests leaked into deploy');
    assert(!fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'tests')), 'scripts/tests leaked into deploy');
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'hooks', 'lib')), 'runtime hooks/lib missing');
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'lib')), 'runtime scripts/lib missing');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.agentsmd-state', 'manifest.json'), 'utf8'));
    assert(!manifest.deployedFiles.some((entry) => /^(?:hooks|scripts)[\\/]tests(?:[\\/]|$)/.test(entry.path)), 'manifest inventories source tests');
    assert.strictEqual(
      manifest.ownedArtifacts.deploy.sha256,
      require('../lib/fs-atomic').sha256Tree(path.join(dir, 'agentsmd')),
      'manifest deploy hash does not match filtered tree'
    );
  });
  const st = status();
  t('status reports installed with 0 other-tenant hooks', () => { assert.strictEqual(st.installed, true); assert.strictEqual(st.otherTenantHooksPreserved, 0); assert.strictEqual(st.agentsmdHooksRegistered, EXPECTED_HOOKS); });
  t('status reports a valid ownership manifest', () => { assert.strictEqual(st.manifestValid, true); assert.strictEqual(st.manifestError, null); });
  t('status reports the agentsmd status line preset', () => { assert.strictEqual(st.tuiStatusLineConfigured, true); assert.strictEqual(st.agentsmdStatusLinePreset, true); });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'agentsmd.jsonl'), [
    JSON.stringify({ ts: '2026-07-03T00:00:00.000Z', hook: 'pre-bash-safety', event: 'block' }),
    'not json',
  ].join('\n') + '\n');
  t('status telemetryRows counts parseable telemetry, not malformed lines', () => assert.strictEqual(status().telemetryRows, 1));
  t('doctor reports a healthy standalone install', () => assert.strictEqual(doctor().ok, true));
  t('doctor flags a stale deployed spec version (install lags the source)', () => {
    const p = path.join(dir, 'AGENTS.md');
    const orig = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, orig.replace(/CODEX-CODING-SPEC v\d+\.\d+\.\d+/, 'CODEX-CODING-SPEC v1.0.0'));
    const c = doctor().checks.find((x) => x.name === 'installed spec is not older than doctor source');
    assert(c && c.ok === false && /agentsmd update/.test(c.detail) && /agentsmd repair --plan/.test(c.detail), 'expected classified stale-spec remediation; got: ' + JSON.stringify(c));
    fs.writeFileSync(p, orig); // restore so later checks in this sandbox are unaffected
  });
  t('doctor reports discovery-chain headroom, and flags an over-tiny cap', () => {
    const okCheck = doctor().checks.find((x) => x.name === 'discovery-chain headroom for project docs');
    assert(okCheck && okCheck.ok === true && /left for project chains/.test(okCheck.detail), 'healthy headroom; got: ' + JSON.stringify(okCheck));
    const cfgP = path.join(dir, 'config.toml');
    const orig = fs.readFileSync(cfgP, 'utf8');
    fs.writeFileSync(cfgP, 'project_doc_max_bytes = 10\n' + orig);
    const bad = doctor().checks.find((x) => x.name === 'discovery-chain headroom for project docs');
    assert(bad && bad.ok === false && /EXCEEDS/.test(bad.detail), 'expected over-budget fail; got: ' + JSON.stringify(bad));
    fs.writeFileSync(cfgP, orig); // restore
  });
  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\nhooks = true\n\n[tui]\nstatus_line = [broken\n');
  t('doctor fails on an unparseable tui.status_line', () => {
    const d = doctor();
    assert.strictEqual(d.ok, false);
    assert(d.checks.some((c) => c.name === 'config.toml tui.status_line configured' && c.ok === false && c.detail === 'unparseable'));
  });
  fs.writeFileSync(path.join(dir, 'config.toml'), "[features]\nhooks = true\n\n[tui]\nstatus_line = ['git-branch']\n");
  t('doctor accepts a single-quoted custom tui.status_line', () => {
    const d = doctor();
    assert.strictEqual(d.ok, true);
    assert(d.checks.some((c) => c.name === 'config.toml tui.status_line configured' && c.ok === true && c.detail === 'custom'));
  });
  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\nhooks = true\n\n[tui]\nstatus_line = [\n  "git-branch",\n]\n');
  t('doctor accepts a multiline custom tui.status_line', () => {
    const d = doctor();
    assert.strictEqual(d.ok, true);
    assert(d.checks.some((c) => c.name === 'config.toml tui.status_line configured' && c.ok === true && c.detail === 'custom'));
  });
  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\nhooks = true\n\n[tui]\nstatus_line = [\n  "git-branch", # keep footer small\n]\n');
  t('doctor accepts comments inside a multiline custom tui.status_line', () => {
    const d = doctor();
    assert.strictEqual(d.ok, true);
    assert(d.checks.some((c) => c.name === 'config.toml tui.status_line configured' && c.ok === true && c.detail === 'custom'));
  });
  uninstall();
  t('standalone uninstall removes hooks.json (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'hooks.json'))));
  t('standalone uninstall removes AGENTS.md (was ours-only)', () => assert(!fs.existsSync(path.join(dir, 'AGENTS.md'))));
  t('standalone uninstall removes AGENTS-extended.md', () => assert(!fs.existsSync(path.join(dir, 'AGENTS-extended.md'))));
  t('standalone uninstall removes the install manifest', () => assert(!fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json'))));
  t('standalone uninstall leaves stale-session hook shims that exit 0', () => {
    const hook = path.join(dir, 'agentsmd', 'hooks', 'pre-bash-safety-check.sh');
    assert(fs.existsSync(hook), 'compatibility shim missing');
    fs.accessSync(hook, fs.constants.X_OK);
    const r = cp.spawnSync('bash', [hook], { input: '{}', encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });
  t('status reports uninstalled even while compatibility shims remain', () => {
    const st = status();
    assert.strictEqual(st.installed, false);
    assert.strictEqual(st.agentsmdHooksRegistered, 0);
  });
  t('doctor fails after standalone uninstall', () => {
    const d = doctor();
    assert.strictEqual(d.ok, false);
    assert(d.checks.some((c) => c.name === 'agentsmd hooks registered' && c.ok === false));
    assert(d.checks.some((c) => c.name === 'installed hooks executable' && c.ok === false));
  });
  install('2026-07-02T01:00:00.000Z');
  t('reinstall replaces the exact shim-only tree with a healthy install', () => {
    assert.strictEqual(status().installed, true);
    assert.strictEqual(status().agentsmdHooksRegistered, EXPECTED_HOOKS);
    assert.strictEqual(doctor().ok, true);
    assert(!fs.existsSync(path.join(dir, 'agentsmd', '.uninstalled-shims')));
  });
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  uninstall();
  const shim = path.join(dir, 'agentsmd', 'hooks', 'pre-bash-safety-check.sh');
  fs.appendFileSync(shim, '# user edit\n');
  t('reinstall rejects a modified shim tree as a foreign ownership collision', () => {
    assert.throws(() => install('2026-07-02T01:00:00.000Z'), /ownership collision.*deploy/i);
    assert(fs.readFileSync(shim, 'utf8').endsWith('# user edit\n'));
  });
});

for (const kind of ['root', 'marker', 'hooks']) withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  uninstall();
  const root = path.join(dir, 'agentsmd');
  if (kind === 'root') {
    const external = path.join(dir, 'shim-root-external');
    fs.renameSync(root, external);
    fs.symlinkSync(external, root, 'dir');
  } else if (kind === 'marker') {
    const marker = path.join(root, '.uninstalled-shims');
    const external = path.join(dir, 'shim-marker-external');
    fs.renameSync(marker, external);
    fs.symlinkSync(external, marker);
  } else {
    const hooks = path.join(root, 'hooks');
    const external = path.join(dir, 'shim-hooks-external');
    fs.renameSync(hooks, external);
    fs.symlinkSync(external, hooks, 'dir');
  }
  t(`reinstall rejects a symlinked shim ${kind}`, () => {
    assert.throws(() => install('2026-07-02T01:00:00.000Z'), /ownership collision.*deploy/i);
  });
});

// ── 4a. status/doctor CLIs reject unknown args and support help ─────────────
withSandbox((dir) => {
  t('status CLI rejects unknown options instead of printing JSON', () => {
    assert.throws(
      () => cp.execFileSync('node', [path.join(__dirname, '..', 'status.js'), '--wat'], { env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 2 && /unknown option: --wat/.test(String(e.stderr)) && /Usage: agentsmd status/.test(String(e.stderr))
    );
  });
  t('doctor CLI --help prints actionable usage without running checks', () => {
    const out = cp.execFileSync('node', [path.join(__dirname, '..', 'doctor.js'), '--help'], { env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8' });
    assert(/Usage: agentsmd doctor/.test(out), out);
    assert(/install health checks/.test(out), out);
  });
});

withSandbox((dir) => {
  const state = path.join(dir, '.agentsmd-state');
  fs.mkdirSync(state, { recursive: true });
  const manifestPath = path.join(state, 'manifest.json');
  const { status } = loadModules();
  const invalidManifests = [
    ['malformed JSON', '{'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['missing identity', '{}'],
    ['wrong identity', JSON.stringify({ name: 'other', version: '3.1.0', installedAt: '2026-07-02T00:00:00.000Z', ownedArtifacts: {} })],
    ['invalid version', JSON.stringify({ name: 'agentsmd', version: true, installedAt: '2026-07-02T00:00:00.000Z', ownedArtifacts: {} })],
    ['invalid installedAt', JSON.stringify({ name: 'agentsmd', version: '3.1.0', installedAt: 'not-a-date', ownedArtifacts: {} })],
    ['invalid ownedArtifacts', JSON.stringify({ name: 'agentsmd', version: '3.1.0', installedAt: '2026-07-02T00:00:00.000Z', ownedArtifacts: [] })],
  ];
  for (const [label, body] of invalidManifests) {
    fs.writeFileSync(manifestPath, body);
    const st = status();
    t(`status rejects ${label} as an installed manifest`, () => {
      assert.strictEqual(st.installed, false);
      assert.strictEqual(st.manifestValid, false);
      assert.match(st.manifestError, /manifest/i);
      assert.strictEqual(st.installedVersion, null);
      assert.strictEqual(st.installedAt, null);
    });
  }
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

// ── 4d. doctor catches a missing top-level AGENTS-extended.md (the cat target) ─
withSandbox((dir) => {
  const { install, doctor } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  t('doctor healthy while ~/.codex/AGENTS-extended.md is present', () => assert.strictEqual(doctor().ok, true));
  fs.unlinkSync(path.join(dir, 'AGENTS-extended.md'));
  t('doctor fails when ~/.codex/AGENTS-extended.md is missing', () => {
    const d = doctor();
    assert.strictEqual(d.ok, false);
    assert(d.checks.some((c) => c.name === 'AGENTS-extended.md installed at ~/.codex/' && c.ok === false && /missing/.test(c.detail)));
  });
});

// ── 4e. ownership: a FOREIGN ~/.codex/AGENTS-extended.md fails closed ─────────
withSandbox((dir) => {
  const foreign = "# Someone else's CODEX-CODING-SPEC notes\nnot ours\n";
  fs.writeFileSync(path.join(dir, 'AGENTS-extended.md'), foreign);
  const { install } = loadModules();
  t('install rejects an unowned AGENTS-extended.md collision', () => {
    assert.throws(() => install('2026-07-02T00:00:00.000Z'), /ownership collision.*AGENTS-extended\.md/i);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS-extended.md'), 'utf8'), foreign);
  });
  t('collision abort occurs before any install mutation', () => {
    assert(!fs.existsSync(path.join(dir, 'agentsmd')));
    assert(!fs.existsSync(path.join(dir, 'hooks.json')));
  });
});

// ── 5. config.toml + AGENTS.md preserve unrelated content ───────────────────
withSandbox((dir) => {
  const userCfg = '# my config\nmodel = "gpt-5.5"\n\n[features]\nmulti_agent = true\n\n[tui]\nstatus_line = ["model"]\n';
  const userAgents = '# My global instructions\nAlways write tests.\n';
  fs.writeFileSync(path.join(dir, 'config.toml'), userCfg);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), userAgents);
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  t('config.toml keeps the user model + multi_agent keys', () => { assert(cfg.includes('model = "gpt-5.5"')); assert(cfg.includes('multi_agent = true')); assert(/^\s*hooks\s*=\s*true/m.test(cfg)); });
  t('config.toml preserves a user-defined status_line', () => assert(cfg.includes('status_line = ["model"]')));
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

withSandbox((dir) => {
  const skillsDir = path.join(dir, 'skills');
  const foreign = path.join(skillsDir, 'agentsmd-personal');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: agentsmd-personal\n---\n');
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.agentsmd-state', 'manifest.json'), 'utf8'));
  t('manifest records exact owned artifacts with hashes', () => {
    assert(manifest.ownedArtifacts && /^[a-f0-9]{64}$/.test(manifest.ownedArtifacts.extended.sha256));
    assert(manifest.ownedArtifacts.skills.length > 0);
    assert(manifest.ownedArtifacts.skills.every((x) => x.path && /^[a-f0-9]{64}$/.test(x.sha256)));
  });
  uninstall();
  t('uninstall preserves an unlisted agentsmd-* foreign skill', () => assert(fs.existsSync(path.join(foreign, 'SKILL.md'))));
});

withSandbox((dir) => {
  const collision = path.join(dir, 'skills', 'agentsmd-audit');
  fs.mkdirSync(collision, { recursive: true });
  fs.writeFileSync(path.join(collision, 'SKILL.md'), 'foreign skill bytes\n');
  const { install } = loadModules();
  t('install rejects an unowned skill collision', () => assert.throws(
    () => install('2026-07-02T00:00:00.000Z'),
    /ownership collision.*agentsmd-audit/i
  ));
  t('skill collision preserves the foreign bytes and aborts before deployment', () => {
    assert.strictEqual(fs.readFileSync(path.join(collision, 'SKILL.md'), 'utf8'), 'foreign skill bytes\n');
    assert(!fs.existsSync(path.join(dir, 'agentsmd')));
  });
});

withSandbox((dir) => {
  const collision = path.join(dir, 'skills', 'agentsmd-audit');
  fs.mkdirSync(path.dirname(collision), { recursive: true });
  fs.symlinkSync(path.join(dir, 'missing-foreign-skill'), collision);
  const { install } = loadModules();
  t('install treats a broken skill symlink as an ownership collision', () => assert.throws(
    () => install('2026-07-02T00:00:00.000Z'),
    /ownership collision.*agentsmd-audit/i
  ));
  t('broken foreign skill symlink remains byte-for-byte', () => {
    assert.strictEqual(fs.readlinkSync(collision), path.join(dir, 'missing-foreign-skill'));
    assert(!fs.existsSync(path.join(dir, 'agentsmd')));
  });
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const skill = path.join(dir, 'skills', 'agentsmd-audit', 'SKILL.md');
  fs.appendFileSync(skill, '\nuser edit\n');
  const hooksBefore = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  t('uninstall rejects a modified owned skill before mutation', () => assert.throws(() => uninstall(), /ownership collision.*agentsmd-audit/i));
  t('modified skill abort preserves the complete install and manifest', () => {
    assert(fs.existsSync(skill));
    assert(fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), hooksBefore);
  });
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.appendFileSync(path.join(dir, 'AGENTS-extended.md'), '\nuser edit\n');
  t('uninstall rejects modified extended metadata before mutation', () => assert.throws(() => uninstall(), /ownership collision.*AGENTS-extended/i));
  t('modified extended abort retains ownership manifest', () => assert(fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json'))));
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.writeFileSync(path.join(dir, 'agentsmd', 'foreign.txt'), 'user bytes\n');
  t('uninstall rejects a modified deploy tree before mutation', () => assert.throws(() => uninstall(), /ownership collision.*deploy/i));
  t('modified deploy abort retains foreign bytes and manifest', () => {
    assert.strictEqual(fs.readFileSync(path.join(dir, 'agentsmd', 'foreign.txt'), 'utf8'), 'user bytes\n');
    assert(fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
  });
});

// A failure after the live deploy switch must restore every pre-update artifact.
withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const deployedInstaller = path.join(dir, 'agentsmd', 'scripts', 'install.js');
  const beforeDeploy = fs.readFileSync(deployedInstaller, 'utf8');
  const beforeHooks = fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8');
  const beforeManifest = fs.readFileSync(path.join(dir, '.agentsmd-state', 'manifest.json'), 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(path.join(dir, 'hooks.json'))) throw new Error('simulated commit failure');
    return realRename(from, to);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { fs.renameSync = realRename; }
  t('failed update reports its commit error', () => assert(error && /simulated commit failure/.test(error.message)));
  t('failed update rolls back deploy, hooks, and manifest exactly', () => {
    assert.strictEqual(fs.readFileSync(deployedInstaller, 'utf8'), beforeDeploy);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'), beforeHooks);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.agentsmd-state', 'manifest.json'), 'utf8'), beforeManifest);
  });
});

withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const manifestPath = path.join(dir, '.agentsmd-state', 'manifest.json');
  const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete legacy.ownedArtifacts;
  delete legacy.deployedFiles;
  fs.writeFileSync(manifestPath, JSON.stringify(legacy));
  fs.writeFileSync(path.join(dir, 'agentsmd', 'user-edit.txt'), 'deploy user edit\n');
  fs.appendFileSync(path.join(dir, 'skills', 'agentsmd-audit', 'SKILL.md'), '\nskill user edit\n');
  const next = install('2026-07-03T00:00:00.000Z');
  t('legacy agentsmd manifest upgrades through a persistent artifact backup', () => {
    assert(next.legacyArtifactBackup && fs.existsSync(next.legacyArtifactBackup));
    assert.strictEqual(fs.readFileSync(path.join(next.legacyArtifactBackup, 'deploy', 'user-edit.txt'), 'utf8'), 'deploy user edit\n');
    assert(/skill user edit/.test(fs.readFileSync(path.join(next.legacyArtifactBackup, 'skills', 'agentsmd-audit', 'SKILL.md'), 'utf8')));
  });
});

withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const hooks = path.join(dir, 'hooks.json');
  const external = '{"external":"concurrent"}\n';
  const realRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && path.resolve(String(to)) === path.resolve(hooks)) {
      injected = true;
      fs.writeFileSync(hooks, external);
      throw new Error('simulated concurrent commit failure');
    }
    return realRename(from, to);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { fs.renameSync = realRename; }
  t('rollback preserves a concurrent tenant edit instead of overwriting it', () => {
    assert(error && /rollback conflict.*hooks\.json/i.test(error.message));
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), external);
  });
});

// Running update from the deployed copy used to erase its own source tree before
// cpSync reached scripts/. Stage-before-switch makes this flow equivalent to repo install.
withSandbox((dir) => {
  const { install } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const deployedInstaller = path.join(dir, 'agentsmd', 'scripts', 'install.js');
  const run = cp.spawnSync('node', [deployedInstaller], {
    env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  t('deployed-copy self-update completes without deleting its source', () => {
    assert.strictEqual(run.status, 0, run.stderr);
    assert(fs.existsSync(deployedInstaller));
  });
});

withSandbox((dir) => {
  const { install, doctor } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.unlinkSync(path.join(dir, 'agentsmd', 'hooks', 'lib', 'hook-common.sh'));
  t('doctor fails when an installed hook support file is missing', () => {
    const check = doctor().checks.find((x) => x.name === 'installed hook and support files intact');
    assert(check && check.ok === false && /hook-common\.sh/.test(check.detail));
  });
});

withSandbox((dir) => {
  const { install, doctor } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  const manifestPath = path.join(dir, '.agentsmd-state', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.deployedFiles = [];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  t('doctor rejects an empty self-reported deploy inventory', () => {
    const check = doctor().checks.find((x) => x.name === 'installed hook and support files intact');
    assert(check && check.ok === false && /inventory/i.test(check.detail));
  });
});

withSandbox((dir) => {
  const { install, doctor } = loadModules();
  install('2026-07-02T00:00:00.000Z');
  fs.unlinkSync(path.join(dir, 'agentsmd', 'hooks', 'secrets-scan.sh'));
  t('doctor checks every registry hook, including missing files', () => {
    const check = doctor().checks.find((x) => x.name === 'installed hooks executable');
    assert(check && check.ok === false && /secrets-scan\.sh/.test(check.detail));
  });
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
  t('config: deprecated codex_hooks=false migrates to canonical hooks=true', () => {
    const table = CT.ensureCodexHooksFlag('[features]\ncodex_hooks = false\n');
    const inline = CT.ensureCodexHooksFlag('features = { codex_hooks = false }\n');
    for (const r of [table, inline]) {
      assert(/\bhooks\s*=\s*true/.test(r.content), r.content);
      assert(!/codex_hooks/.test(r.content), r.content);
    }
  });
  t('config: [features] table with inline comment is recognized', () => {
    const r = CT.ensureCodexHooksFlag('[features] # Codex feature flags\nmulti_agent = true\n');
    assert.strictEqual(r.reason, 'inserted-under-features');
    assert(!/\n\[features\]\n/.test(r.content), 'must not append a duplicate [features] table: ' + r.content);
    assert(/\[features\] # Codex feature flags\nhooks = true\nmulti_agent = true/.test(r.content), 'hooks inserted under existing table: ' + r.content);
  });
  t('config: quoted ["features"] table is recognized without appending a duplicate', () => {
    const input = '["features"]\nmulti_agent = true\n';
    const r = CT.ensureCodexHooksFlag(input);
    assert.strictEqual(r.reason, 'inserted-under-features');
    assert.strictEqual((r.content.match(/features/g) || []).length, 1, r.content);
    assert(CT.isCodexHooksEnabled(r.content), r.content);
  });
  t('config: quoted hooks key under ["features"] is enabled in place', () => {
    const input = '["features"]\n"hooks" = false\n';
    const r = CT.ensureCodexHooksFlag(input);
    assert(!/=\s*false/.test(r.content), r.content);
    assert.strictEqual((r.content.match(/features/g) || []).length, 1, r.content);
    assert(CT.isCodexHooksEnabled(r.content), r.content);
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
  // Inline-table `features = { ... }` — must edit INSIDE the braces, never append
  // a second [features] table. A duplicate table/key is invalid TOML → Codex's
  // Rust parser fails closed for EVERY tenant sharing config.toml. (Regression:
  // these two produced invalid TOML before the inline-table-aware scanner.)
  t('config: inline features hooks=true → no-op, read as enabled (was: dup [features])', () => {
    assert(CT.isCodexHooksEnabled('features = { hooks = true }\n'), 'inline hooks=true must read enabled');
    assert.strictEqual(CT.ensureCodexHooksFlag('features = { hooks = true }\n').changed, false);
  });
  t('config: inline features hooks=false → flipped inside braces (no dup table)', () => {
    const r = CT.ensureCodexHooksFlag('features = { hooks = false }\n');
    assert.strictEqual(r.content, 'features = { hooks = true }\n');
    assert(!/\[features\]/.test(r.content), 'no appended table: ' + r.content);
  });
  t('config: inline features codex_hooks=true → migrated inside braces', () => {
    const r = CT.ensureCodexHooksFlag('features = { codex_hooks = true }\n');
    assert.strictEqual(r.content, 'features = { hooks = true }\n');
    assert(!/codex_hooks/.test(r.content), r.content);
  });
  t('config: inline hooks=false plus codex_hooks=true deduplicates to one hooks=true', () => {
    const r = CT.ensureCodexHooksFlag('features = { hooks = false, codex_hooks = true }\n');
    assert.strictEqual((r.content.match(/\bhooks\s*=/g) || []).length, 1, r.content);
    assert(!/codex_hooks/.test(r.content), r.content);
    assert(/hooks\s*=\s*true/.test(r.content), r.content);
  });
  t('config: inline features w/o hooks → inserted; siblings + comment preserved', () => {
    const r = CT.ensureCodexHooksFlag('features = { web_search = true } # flags\n');
    assert.strictEqual(r.content, 'features = { web_search = true, hooks = true } # flags\n');
    assert.strictEqual((r.content.match(/features/g) || []).length, 1, 'single features def: ' + r.content);
  });
  t('config: inline empty features {} → hooks inserted', () => {
    assert.strictEqual(CT.ensureCodexHooksFlag('features = {}\n').content, 'features = { hooks = true }\n');
  });
  t('config: features hooks=false + codex_hooks=true → single hooks=true (no dup key)', () => {
    const r = CT.ensureCodexHooksFlag('[features]\nhooks = false\ncodex_hooks = true\n');
    assert.strictEqual(r.reason, 'migrated-codex_hooks-dedup');
    assert.strictEqual((r.content.match(/^\s*hooks\s*=/gm) || []).length, 1, 'exactly one hooks key: ' + r.content);
    assert(!/codex_hooks/.test(r.content), 'codex_hooks dropped: ' + r.content);
    assert(!/=\s*false/.test(r.content), 'no leftover false: ' + r.content);
  });
  t('config: dual false legacy/canonical flags collapse to one canonical true key', () => {
    const table = CT.ensureCodexHooksFlag('[features]\ncodex_hooks = false\nhooks = false\n');
    const inline = CT.ensureCodexHooksFlag('features = { codex_hooks = false, hooks = false }\n');
    assert.strictEqual((table.content.match(/^\s*hooks\s*=/gm) || []).length, 1, table.content);
    assert.strictEqual((inline.content.match(/\bhooks\s*=/g) || []).length, 1, inline.content);
    for (const r of [table, inline]) {
      assert(!/codex_hooks/.test(r.content), r.content);
      assert(/\bhooks\s*=\s*true/.test(r.content), r.content);
      assert(!/=\s*false/.test(r.content), r.content);
    }
  });
  t('config: missing [tui] gets the agentsmd status line preset', () => {
    const r = CT.ensureTuiStatusLine('[features]\nhooks = true\n');
    assert.strictEqual(r.reason, 'appended-tui-table');
    assert(CT.isAgentsmdStatusLineEnabled(r.content), r.content);
  });
  t('config: existing [tui] with inline comment receives status_line once', () => {
    const r = CT.ensureTuiStatusLine('[tui] # display\nnotifications = true\n');
    assert.strictEqual(r.reason, 'inserted-under-tui');
    assert(!/\n\[tui\]\n/.test(r.content), 'must not append a duplicate [tui] table: ' + r.content);
    assert(/\[tui\] # display\nstatus_line = \["model-with-reasoning"/.test(r.content), r.content);
  });
  t('config: quoted ["tui"] table is recognized without appending a duplicate', () => {
    const input = '["tui"]\nnotifications = true\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.reason, 'inserted-under-tui');
    assert.strictEqual((r.content.match(/tui/g) || []).length, 1, r.content);
    assert(CT.isAgentsmdStatusLineEnabled(r.content), r.content);
  });
  t('config: existing user status_line is preserved', () => {
    const input = '[tui]\nstatus_line = ["model"]\nnotifications = true\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.reason, 'already-custom-status-line');
    assert.strictEqual(r.content, input);
    assert.strictEqual(CT.isAgentsmdStatusLineEnabled(r.content), false);
  });
  t('config: existing single-quoted user status_line is preserved', () => {
    const input = "[tui]\nstatus_line = ['model']\nnotifications = true\n";
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.reason, 'already-custom-status-line');
    assert.strictEqual(r.content, input);
    assert.deepStrictEqual(CT.getTuiStatusLine(input).items, ['model']);
  });
  t('config: existing multiline user status_line is preserved', () => {
    const input = '[tui]\nstatus_line = [\n  "model",\n]\nnotifications = true\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.reason, 'already-custom-status-line');
    assert.strictEqual(r.content, input);
    assert.deepStrictEqual(CT.getTuiStatusLine(input).items, ['model']);
  });
  t('config: existing commented multiline user status_line is preserved', () => {
    const input = '[tui]\nstatus_line = [\n  "model", # keep footer small\n  "branch#name",\n]\nnotifications = true\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.reason, 'already-custom-status-line');
    assert.strictEqual(r.content, input);
    assert.deepStrictEqual(CT.getTuiStatusLine(input).items, ['model', 'branch#name']);
  });
  t('config: existing dotted user tui.status_line is preserved', () => {
    const input = 'tui.status_line = ["model"]\n[features]\nhooks = true\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.reason, 'already-custom-status-line');
    assert.strictEqual(r.content, input);
  });
  t('config: top-level dotted tui keys receive dotted status_line', () => {
    const r = CT.ensureTuiStatusLine('tui.notifications = true\n[features]\nhooks = true\n');
    assert.strictEqual(r.reason, 'inserted-after-dotted-tui');
    assert(/^tui\.notifications = true\ntui\.status_line = \["model-with-reasoning"/.test(r.content), r.content);
    assert(CT.isAgentsmdStatusLineEnabled(r.content), r.content);
  });
  t('config: status_line under a NON-tui table is not treated as configured', () => {
    const r = CT.ensureTuiStatusLine('[foo]\nstatus_line = ["model"]\n');
    assert.strictEqual(r.changed, true);
    assert(CT.isAgentsmdStatusLineEnabled(r.content), r.content);
  });
  // Inline-table `tui = { ... }` — same duplicate-table hazard as inline features.
  t('config: inline tui with status_line → preserved (no duplicate [tui])', () => {
    const input = 'tui = { status_line = ["git-branch"] }\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.content, input);
    assert(!/\[tui\]/.test(r.content), 'no appended [tui] table: ' + r.content);
    assert.deepStrictEqual(CT.getTuiStatusLine(input).items, ['git-branch']);
  });
  t('config: inline tui without status_line → inserted inside braces', () => {
    const r = CT.ensureTuiStatusLine('tui = { theme = "dark" }\n');
    assert.strictEqual(r.reason, 'inserted-into-inline-tui');
    assert(!/\[tui\]/.test(r.content), 'no appended [tui] table: ' + r.content);
    // preset written inside the braces, existing key preserved (items inside an
    // inline table are intentionally not re-parsed, so assert on the text).
    assert(/tui = \{ theme = "dark", status_line = \["model-with-reasoning"/.test(r.content), r.content);
    // idempotent: a second run sees the inline status_line and no-ops.
    assert.strictEqual(CT.ensureTuiStatusLine(r.content).changed, false, 're-run must no-op');
  });
  t('config: inline tui insertion ignores a closing brace in the trailing comment', () => {
    const input = 'tui = { theme = "dark" } # tenant comment } stays\n';
    const r = CT.ensureTuiStatusLine(input);
    assert.match(r.content, /^tui = \{ theme = "dark", status_line = \[/);
    assert(r.content.endsWith(' } # tenant comment } stays\n'), r.content);
  });
  t('config: projectDocMaxBytes reads the cap, defaults to 32768', () => {
    assert.strictEqual(CT.projectDocMaxBytes('project_doc_max_bytes = 65536\n'), 65536);
    assert.strictEqual(CT.projectDocMaxBytes('model = "x"\n'), 32768);
  });
  t('config: chainBudget flags a global+project sum over the cap', () => {
    const b = CT.chainBudget('project_doc_max_bytes = 100\n', 60, 50);
    assert.strictEqual(b.cap, 100);
    assert.strictEqual(b.total, 110);
    assert.strictEqual(b.over, 10);
    assert.strictEqual(b.headroom, -10);
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
  const artifactHash = require('../lib/fs-atomic');
  fs.writeFileSync(path.join(dir, '.codexmd-state', 'manifest.json'), JSON.stringify({
    name: 'codexmd',
    installDir: path.join(dir, 'codexmd'),
    installedSkills: ['codexmd-audit'],
    ownedArtifacts: {
      deploy: { path: path.join(dir, 'codexmd'), sha256: artifactHash.sha256Tree(path.join(dir, 'codexmd')) },
      skills: [{ name: 'codexmd-audit', path: path.join(dir, 'skills', 'codexmd-audit'), sha256: artifactHash.sha256Tree(path.join(dir, 'skills', 'codexmd-audit')) }],
    },
  }) + '\n');

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

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo initial-uninstall-tenant' }] }] },
  }, null, 2) + '\n');
  install('2026-07-03T00:00:00.000Z');
  const hooks = path.join(dir, 'hooks.json');
  const external = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo concurrent-uninstall-tenant' }] }] } }, null, 2) + '\n';
  const F = require('../lib/fs-atomic');
  const realWrite = F.writeFileAtomic;
  let injected = false;
  F.writeFileAtomic = (file, content, options) => {
    if (!injected && path.resolve(String(file)) === path.resolve(hooks)) {
      injected = true;
      fs.writeFileSync(hooks, external);
    }
    return realWrite(file, content, options);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { F.writeFileAtomic = realWrite; }
  t('uninstall CAS aborts when hooks.json changes after removal was computed', () => assert(error && /concurrent.*hooks\.json|hooks\.json.*concurrent/i.test(error.message)));
  t('uninstall CAS preserves the concurrent hooks tenant bytes', () => assert.strictEqual(fs.readFileSync(hooks, 'utf8'), external));
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  const target = path.join(dir, 'agentsmd');
  const foreign = path.join(target, 'concurrent-uninstall-tenant.txt');
  const F = require('../lib/fs-atomic');
  const realHash = F.sha256Tree;
  let targetHashes = 0;
  F.sha256Tree = (root) => {
    if (path.resolve(String(root)) === path.resolve(target) && ++targetHashes === 2) fs.writeFileSync(foreign, 'concurrent uninstall replacement\n');
    return realHash(root);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { F.sha256Tree = realHash; }
  t('uninstall revalidates deploy immediately before quarantine', () => assert(error && /ownership collision.*deploy/i.test(error.message)));
  t('uninstall preserves concurrently changed deploy and manifest', () => {
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'concurrent uninstall replacement\n');
    assert(fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
  });
});

for (const [name, relative, external] of [
  ['extended', 'AGENTS-extended.md', '# concurrent uninstall extended\n'],
  ['manifest', '.agentsmd-state/manifest.json', '{"concurrent":"uninstall-manifest"}\n'],
]) withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  const target = path.join(dir, relative);
  const F = require('../lib/fs-atomic');
  const realUnlink = F.unlinkFileIfUnchanged;
  let injected = false;
  F.unlinkFileIfUnchanged = (file, expected) => {
    if (!injected && path.resolve(String(file)) === path.resolve(target)) {
      injected = true;
      fs.writeFileSync(target, external);
    }
    return realUnlink(file, expected);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { F.unlinkFileIfUnchanged = realUnlink; }
  t(`uninstall refuses to unlink concurrently replaced ${name}`, () => assert(error && /concurrent change detected/i.test(error.message)));
  t(`uninstall preserves concurrently replaced ${name}`, () => assert.strictEqual(fs.readFileSync(target, 'utf8'), external));
});

withSandbox((dir) => {
  const artifactHash = require('../lib/fs-atomic');
  const legacyDeploy = path.join(dir, 'codexmd');
  const legacySkill = path.join(dir, 'skills', 'codexmd-audit');
  fs.mkdirSync(legacyDeploy, { recursive: true });
  fs.mkdirSync(legacySkill, { recursive: true });
  fs.writeFileSync(path.join(legacyDeploy, 'release'), 'original\n');
  fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), 'original\n');
  fs.mkdirSync(path.join(dir, '.codexmd-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codexmd-state', 'manifest.json'), JSON.stringify({
    name: 'codexmd',
    installDir: legacyDeploy,
    ownedArtifacts: {
      deploy: { path: legacyDeploy, sha256: artifactHash.sha256Tree(legacyDeploy) },
      skills: [{ name: 'codexmd-audit', path: legacySkill, sha256: artifactHash.sha256Tree(legacySkill) }],
    },
  }));
  fs.writeFileSync(path.join(legacyDeploy, 'release'), 'user modified\n');
  fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), 'user modified\n');
  const { install } = loadModules();
  const result = install('2026-07-03T00:00:00.000Z');
  t('migrate: modified legacy deploy and skill are preserved fail-closed', () => {
    assert.strictEqual(fs.readFileSync(path.join(legacyDeploy, 'release'), 'utf8'), 'user modified\n');
    assert.strictEqual(fs.readFileSync(path.join(legacySkill, 'SKILL.md'), 'utf8'), 'user modified\n');
    assert(result.migratedFromCodexmd.ownershipConflicts.length === 2);
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

// 9d. A name collision without legacy provenance is foreign and must survive.
withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  fs.mkdirSync(path.join(dir, 'codexmd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codexmd', 'x'), '1');
  const res = uninstall();
  t('migrate: uninstall preserves an unowned codexmd directory', () => {
    assert(res.legacyCodexmdRemoved && res.legacyCodexmdRemoved.installDirRemoved === false);
    assert(fs.existsSync(path.join(dir, 'codexmd', 'x')));
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

withSandbox((dir) => {
  const legacyLog = path.join(dir, 'logs', 'codexmd.jsonl');
  const currentLog = path.join(dir, 'logs', 'agentsmd.jsonl');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, '{"legacy":"once"}\n');
  fs.writeFileSync(currentLog, '{"current":"seed"}\n');
  const beforeCurrent = fs.readFileSync(currentLog);
  const { M } = loadModules();
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(legacyLog)) {
      const error = new Error('injected legacy unlink failure'); error.code = 'EACCES'; throw error;
    }
    return realUnlink(file);
  };
  let error;
  try { M.migrateLegacyTelemetry(); } catch (e) { error = e; } finally { fs.unlinkSync = realUnlink; }
  t('migrate telemetry: legacy unlink failure is surfaced', () => assert(error && /legacy.*unlink|unlink.*legacy|EACCES/i.test(error.message)));
  t('migrate telemetry: unlink failure restores exact pre-append current bytes and retains legacy', () => {
    assert(fs.readFileSync(currentLog).equals(beforeCurrent));
    assert.strictEqual(fs.readFileSync(legacyLog, 'utf8'), '{"legacy":"once"}\n');
  });
  const retry = M.migrateLegacyTelemetry();
  t('migrate telemetry: retry after unlink failure appends the legacy row exactly once', () => {
    assert.strictEqual(retry.migrated, 1);
    assert.deepStrictEqual(fs.readFileSync(currentLog, 'utf8').trim().split('\n'), ['{"current":"seed"}', '{"legacy":"once"}']);
    assert(!fs.existsSync(legacyLog));
  });
});

withSandbox((dir) => {
  const legacyLog = path.join(dir, 'logs', 'codexmd.jsonl');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, '');
  const { M } = loadModules();
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(legacyLog)) throw new Error('injected empty legacy unlink failure');
    return realUnlink(file);
  };
  let error;
  try { M.migrateLegacyTelemetry(); } catch (e) { error = e; } finally { fs.unlinkSync = realUnlink; }
  t('migrate telemetry: empty legacy unlink failure is not reported as success', () => {
    assert(error && /empty legacy unlink failure/.test(error.message));
    assert(fs.existsSync(legacyLog));
  });
});

withSandbox((dir) => {
  const legacyLog = path.join(dir, 'logs', 'codexmd.jsonl');
  const currentLog = path.join(dir, 'logs', 'agentsmd.jsonl');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, '{"legacy":"conflict"}\n');
  fs.writeFileSync(currentLog, '{"current":"seed"}\n');
  const concurrent = '{"current":"concurrent-tenant"}\n';
  const { M } = loadModules();
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(legacyLog)) {
      fs.writeFileSync(currentLog, concurrent);
      throw new Error('injected unlink plus rollback conflict');
    }
    return realUnlink(file);
  };
  let error;
  try { M.migrateLegacyTelemetry(); } catch (e) { error = e; } finally { fs.unlinkSync = realUnlink; }
  t('migrate telemetry: unsafe rollback conflict is surfaced and concurrent current bytes survive', () => {
    assert(error && /rollback|concurrent/i.test(error.message));
    assert.strictEqual(fs.readFileSync(currentLog, 'utf8'), concurrent);
    assert(fs.existsSync(legacyLog));
  });
});

// Uninstall is a multi-artifact transaction too. A failure after shared files
// changed must restore the complete installed state, not leave half an uninstall.
withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  const hooks = path.join(dir, 'hooks.json');
  const agents = path.join(dir, 'AGENTS.md');
  const extended = path.join(dir, 'AGENTS-extended.md');
  const manifest = path.join(dir, '.agentsmd-state', 'manifest.json');
  const before = Object.fromEntries([hooks, agents, extended, manifest].map((file) => [file, fs.readFileSync(file)]));
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(extended)) throw new Error('simulated uninstall failure after shared edits');
    return realUnlink(file);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { fs.unlinkSync = realUnlink; }
  t('uninstall failure after shared edits is reported', () => assert(error && /simulated uninstall failure/.test(error.message)));
  t('failed uninstall rolls every owned artifact back exactly', () => {
    for (const [file, content] of Object.entries(before)) assert(fs.readFileSync(file).equals(content), file);
    assert(fs.existsSync(path.join(dir, 'agentsmd', 'scripts', 'install.js')));
    assert(fs.existsSync(path.join(dir, 'skills', 'agentsmd-audit', 'SKILL.md')));
  });
});

withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  install('2026-07-03T00:00:00.000Z');
  const hooks = path.join(dir, 'hooks.json');
  const agents = path.join(dir, 'AGENTS.md');
  const agentsBefore = fs.readFileSync(agents);
  const extended = path.join(dir, 'AGENTS-extended.md');
  const external = '{"external":"concurrent-uninstall"}\n';
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(String(file)) === path.resolve(extended)) {
      fs.writeFileSync(hooks, external);
      throw new Error('simulated concurrent uninstall failure');
    }
    return realUnlink(file);
  };
  let error;
  try { uninstall(); } catch (e) { error = e; } finally { fs.unlinkSync = realUnlink; }
  t('uninstall rollback preserves concurrent external bytes', () => {
    assert(error && /rollback conflict.*hooks\.json/i.test(error.message));
    assert.strictEqual(fs.readFileSync(hooks, 'utf8'), external);
    assert(fs.readFileSync(agents).equals(agentsBefore));
    assert(fs.existsSync(path.join(dir, '.agentsmd-state', 'manifest.json')));
  });
});

// 9f. A later commit failure rolls the legacy migration back too; otherwise an
// update could fail while still deleting the only runnable old installation.
withSandbox((dir) => {
  const hooksPath = path.join(dir, 'hooks.json');
  const agentsPath = path.join(dir, 'AGENTS.md');
  const legacySkill = path.join(dir, 'skills', 'codexmd-audit');
  const legacyInstall = path.join(dir, 'codexmd');
  const legacyState = path.join(dir, '.codexmd-state');
  const legacyLog = path.join(dir, 'logs', 'codexmd.jsonl');
  const hooksBefore = codexmdSeed(dir);
  const agentsBefore = '# User\n\n# >>> codexmd >>>\nold spec\n# <<< codexmd <<<\n';
  fs.writeFileSync(hooksPath, hooksBefore);
  fs.writeFileSync(agentsPath, agentsBefore);
  for (const target of [legacySkill, legacyInstall, legacyState]) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), 'legacy skill\n');
  fs.writeFileSync(path.join(legacyInstall, 'release'), 'legacy release\n');
  fs.writeFileSync(path.join(legacyState, 'manifest.json'), '{}\n');
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, '{"legacy":true}\n');

  const { install } = loadModules();
  const realRename = fs.renameSync;
  let hooksCommits = 0;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(hooksPath) && ++hooksCommits === 2) throw new Error('simulated post-migration failure');
    return realRename(from, to);
  };
  let error;
  try { install('2026-07-03T00:00:00.000Z'); } catch (e) { error = e; } finally { fs.renameSync = realRename; }
  t('failed update restores every legacy migration artifact', () => {
    assert(error && /post-migration failure/.test(error.message));
    assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), hooksBefore);
    assert.strictEqual(fs.readFileSync(agentsPath, 'utf8'), agentsBefore);
    assert.strictEqual(fs.readFileSync(path.join(legacySkill, 'SKILL.md'), 'utf8'), 'legacy skill\n');
    assert.strictEqual(fs.readFileSync(path.join(legacyInstall, 'release'), 'utf8'), 'legacy release\n');
    assert(fs.existsSync(path.join(legacyState, 'manifest.json')));
    assert.strictEqual(fs.readFileSync(legacyLog, 'utf8'), '{"legacy":true}\n');
    assert(!fs.existsSync(path.join(dir, 'logs', 'agentsmd.jsonl')));
    assert(!fs.existsSync(path.join(dir, 'agentsmd')));
  });
});

// ── 10. Atomicity: a torn shared-file write during uninstall must leave the
//    original intact (never truncated) and drop no tmp turd. uninstall/migrate
//    now route shared-file writes through backup.writeFileAtomic (tmp+rename), so
//    an ENOSPC/crash at the rename step aborts without corrupting a co-tenant's
//    hooks.json. Simulate the crash by making renameSync throw for hooks.json only.
withSandbox((dir) => {
  const { install, uninstall } = loadModules();
  fs.writeFileSync(path.join(dir, 'hooks.json'), omxSeed());
  install('2026-07-02T00:00:00.000Z');
  const hooksPath = path.join(dir, 'hooks.json');
  const before = fs.readFileSync(hooksPath, 'utf8');   // post-install: OMX + agentsmd
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(hooksPath)) throw new Error('simulated ENOSPC/crash at rename');
    return realRename(from, to);
  };
  let threw = false;
  try { uninstall(); } catch { threw = true; } finally { fs.renameSync = realRename; }
  t('atomicity: torn hooks.json write during uninstall throws (crash simulated)', () => assert(threw));
  t('atomicity: torn write leaves the shared hooks.json byte-intact (not truncated)', () => assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), before));
  t('atomicity: torn write leaves no .agentsmd-tmp-* turd behind', () => {
    const turds = fs.readdirSync(dir).filter((f) => f.includes('.agentsmd-tmp-'));
    assert.strictEqual(turds.length, 0, 'tmp turds: ' + turds.join(','));
  });
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
