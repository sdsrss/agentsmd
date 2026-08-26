'use strict';
// doctor.js — health checks for an agentsmd install + spec integrity.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const P = require('./lib/paths');
const CT = require('./lib/config-toml');
const H = require('./lib/codex-hooks');
const REG = require('./lib/hook-registry');
const F = require('./lib/fs-atomic');
const SA = require('./lib/surface-arbitration');
const LOCK = require('./lib/lifecycle-lock');
const J = require('./lib/lifecycle-journal');
const { inspectSelectedPluginSurface } = require('./lib/doctor-plugin');
const { manualInstallCommand } = require('./lib/tool-guidance');
const { parseNoArgs, status: readStatus } = require('./status');

const REQUIRED_HOOK_SUPPORT = [
  'hooks.json',
  'banned-vocab.patterns',
  'secrets.patterns',
  'lib/hook-common.sh',
  'lib/memory-links.js',
  'lib/platform.sh',
  'lib/platform-timeout.js',
  'lib/rule-hits.sh',
  'lib/command-parse.js',
  'lib/orchestrator-source.js',
];

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const has = (bin) => { try { cp.execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; } };

function classifySpecFreshness(srcVer, depVer, manifestInstalled) {
  const srcSemver = SA.parseSemver(srcVer);
  const depSemver = SA.parseSemver(depVer);
  if (!depVer || !depSemver) {
    return {
      ok: false,
      state: 'deployed-invalid',
      detail: `no valid CODEX-CODING-SPEC block in ~/.codex/AGENTS.md — run agentsmd ${manifestInstalled ? 'repair --plan' : 'install'}`,
    };
  }
  if (!srcSemver) return { ok: false, state: 'source-invalid', detail: `doctor source carries invalid semantic version ${srcVer}` };
  const precedence = SA.compareSemver(depVer, srcVer);
  if (precedence < 0) {
    return {
      ok: false,
      state: 'deployed-older',
      detail: `deployed v${depVer} is older than source v${srcVer} — run agentsmd update when owned artifacts are intact; otherwise run agentsmd repair --plan`,
    };
  }
  if (precedence > 0) {
    return {
      ok: true,
      state: 'deployed-newer',
      detail: `deployed v${depVer} is newer than doctor source v${srcVer}; run doctor from the deployed/newer artifact`,
    };
  }
  if (depVer !== srcVer) {
    return {
      ok: true,
      state: 'equal-precedence-metadata-differs',
      detail: `deployed v${depVer} and source v${srcVer} have equal SemVer precedence but different metadata; no update direction inferred`,
    };
  }
  return { ok: true, state: 'same-version', detail: `v${depVer}` };
}

// Cadence classification over hard-rules.json governance stamps — re-exported
// from the shared classifier so doctor and `agentsmd rules` cannot drift apart.
const { classifyGovernanceReview } = require('./lib/governance-review');

// The demote-review cadence is a MAINTAINER obligation (OPERATOR §O2): review the
// telemetry-vs-rules loop, stamp last_demote_review, append spec/governance-log.json.
// An installed copy carries whatever stamps its release froze, and its user cannot
// act on them — editing the deployed hard-rules.json would trip the deploy
// tree-hash ownership check on the next update. Gating on a `.git` at the source
// root keeps the forcing function exactly where it works (ship rounds run doctor
// from the checkout) and keeps an end user's doctor from going red on a calendar
// date for a task that is not theirs. npm-installed and deployed trees have no
// `.git`; the maintainer's working copy does.
function isSourceCheckout() {
  try {
    return fs.existsSync(path.join(P.repoRoot(), '.git'));
  } catch {
    return false;
  }
}

function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

  const jqPresent = has('jq');
  add(
    'jq present',
    jqPresent,
    jqPresent
      ? 'jq on PATH'
      : `hooks require jq; manual install command: ${manualInstallCommand('jq')}`
  );
  let nodeVersion = '';
  try {
    nodeVersion = cp.execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
  } catch {}
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  const nodePresent = Number.isInteger(nodeMajor) && nodeMajor >= 18;
  add(
    'node present',
    nodePresent,
    nodePresent
      ? `${nodeVersion} on PATH`
      : `transcript scan + scripts require Node.js >=18${nodeVersion ? ` (found ${nodeVersion})` : ''}; manual install command: ${manualInstallCommand('node')}`
  );
  add('codex present', has('codex'), 'standalone config health uses the Codex CLI parser');

  const surfaceStatus = readStatus();
  // R1-03: a --degraded install persists enforcement:false in the manifest;
  // this check keeps failing (and doctor exits 1) until a healthy update heals it.
  if (surfaceStatus.installed) {
    add(
      'install enforcement active',
      surfaceStatus.enforcement !== false,
      surfaceStatus.enforcement !== false
        ? 'manifest enforcement:true'
        : `degraded install (missing: ${(surfaceStatus.missingPrerequisites || []).join(', ') || 'unknown'}) — install prerequisites, then run \`agentsmd update\``
    );
  }
  // R2-01: a LIVE lock is a concurrent lifecycle operation (fine — report it);
  // a STALE one is the residue of a crashed operation. It self-clears on the next
  // lifecycle run, but the crash it evidences may have left an interrupted
  // transaction — surface it instead of letting it look healthy.
  const lifecycleLock = LOCK.currentLock();
  if (lifecycleLock) {
    const o = lifecycleLock.owner || {};
    const who = `${o.action || 'unknown-action'} pid ${o.pid || '?'} started ${o.startedAt || 'unknown'}`;
    add(
      'no stale lifecycle lock',
      lifecycleLock.state === 'live',
      lifecycleLock.state === 'live'
        ? `lifecycle operation in progress (${who})`
        : `stale lock from a crashed run (${who}) — it self-clears on the next \`agentsmd install|update|uninstall\`; verify that run's outcome with \`agentsmd status\``
    );
  }

  // R2-02/R2-03: a pending journal under a LIVE lock is a commit in flight
  // (fine); without one it is a crashed transaction. Adjudicate + plan recovery
  // from disk and print the EXACT command that executes it — every lifecycle
  // entry (install/update/uninstall/restore --confirm/repair --confirm) runs
  // the recovery first; conflicts stay fail-closed with bytes preserved.
  const pendingJournal = J.readJournal();
  if (pendingJournal) {
    const inFlight = lifecycleLock && lifecycleLock.state === 'live';
    let detail = 'transaction journal present for the operation in progress';
    if (!inFlight) {
      const plan = J.planRecovery(pendingJournal);
      const recoveryCommand = pendingJournal.action === 'uninstall' ? 'agentsmd uninstall' : 'agentsmd update';
      detail = `crashed lifecycle transaction (${pendingJournal.action || 'unknown'}, started ${pendingJournal.startedAt || 'unknown'}) — recovery plan from disk: ${plan.mode}; ${
        plan.mode === 'conflict'
          ? `NOT auto-recoverable (${plan.reason || 'foreign concurrent change'}); bytes preserved — review the journal at ${J.journalPath()} before any lifecycle command`
          : `run \`${recoveryCommand}\` — it executes the ${plan.mode} first, then proceeds`
      }`;
    }
    add('no pending lifecycle transaction', !!inFlight, detail);
  }

  const arbitration = surfaceStatus.surfaceArbitration;
  const pluginBundle = arbitration.candidates.plugin;
  const pluginDiagnosis = inspectSelectedPluginSurface(surfaceStatus);
  if (pluginDiagnosis) {
    checks.push(...pluginDiagnosis.checks);
    return {
      ok: checks.every((check) => check.ok),
      surface: pluginDiagnosis.surface,
      selectedSurface: pluginDiagnosis.selectedSurface,
      dualSurface: pluginDiagnosis.dualSurface,
      pluginActivation: pluginDiagnosis.pluginActivation,
      surfaceArbitration: pluginDiagnosis.surfaceArbitration,
      checks,
    };
  }

  add(
    'surface arbitration selected a healthy candidate',
    arbitration.selection.selected === 'standalone' && arbitration.candidates.standalone.healthy,
    arbitration.selection.selected
      ? `selected=${arbitration.selection.selected}; reason=${arbitration.selection.reasonCode}`
      : `selected=none; reason=${arbitration.selection.reasonCode}`
  );
  if (pluginBundle.detected) {
    add(
      'dual surface absent',
      !surfaceStatus.dualSurface,
      surfaceStatus.dualSurface
        ? `dualSurface=true — standalone wins (${arbitration.selection.reasonCode}); plugin hooks must yield, but remove one delivery surface to eliminate configuration ambiguity`
        : 'dualSurface=false'
    );
  }

  const cfg = read(P.configTomlPath()) || '';
  const standaloneConfig = arbitration.candidates.standalone.config;
  add(
    'config.toml accepted by Codex parser',
    standaloneConfig.parseable,
    standaloneConfig.parseable
      ? standaloneConfig.validator
      : (standaloneConfig.errorCode === 'codex-cli-unavailable'
        ? 'surface health unverifiable (codex CLI not found — install codex or set AGENTSMD_CODEX_BIN)'
        : standaloneConfig.errorCode)
  );
  add(
    'config.toml features.hooks=true',
    standaloneConfig.hooksEnabled,
    'Codex native hooks enabled ([features] hooks; legacy codex_hooks also recognized)'
  );
  const statusLine = CT.getTuiStatusLine(cfg);
  const statusLineOk = statusLine.exists && statusLine.items !== null;
  add(
    'config.toml tui.status_line configured',
    statusLineOk,
    CT.isAgentsmdStatusLineEnabled(cfg) ? 'agentsmd preset' : (statusLine.exists ? (statusLineOk ? 'custom' : 'unparseable') : 'missing')
  );

  // Expected hook count comes from the hook-registry (single source of truth);
  // hook-registry.test.js asserts the registry never drifts from either hooks.json
  // wiring, so this stays equivalent to the old template-parse without re-reading it.
  const expectedHooks = REG.HOOK_REGISTRY.length;
  const rawHooks = read(P.hooksJsonPath());
  // hooks.json parseable? countAgentsmdHooks returns 0 on an UNPARSEABLE file exactly
  // as it does for "no agentsmd hooks" — but an unparseable SHARED hooks.json is a
  // distinct, worse state: install AND uninstall both abort on it (they refuse to
  // clobber a file that may hold other tenants' hooks), so every management command
  // is wedged until it's fixed. Surface it instead of hiding it behind a bare 0/15.
  const hooksParseable = rawHooks === null || rawHooks.trim() === '' || H.parseHooksConfig(rawHooks) !== null;
  add('hooks.json parseable', hooksParseable, hooksParseable ? 'ok' : 'UNPARSEABLE — install/uninstall abort on this; fix or remove ~/.codex/hooks.json');
  const registeredHooks = H.countAgentsmdHooks(rawHooks || '');
  const manifestRaw = read(P.manifestPath());
  const manifestInstalled = manifestRaw !== null;
  let manifest = null;
  try { manifest = manifestRaw === null ? null : JSON.parse(manifestRaw); } catch {}
  add(
    'agentsmd hooks registered',
    hooksParseable && registeredHooks === expectedHooks,
    hooksParseable ? `${registeredHooks}/${expectedHooks}` : `unknown — hooks.json unparseable`
  );
  // Install-state consistency: install writes the manifest LAST, so hooks live in the
  // shared hooks.json with NO manifest means a crash between the hooks-merge and the
  // manifest-write (or a manually-removed state dir). status.installed reads false off
  // the manifest while the hooks actually run — a contradiction doctor must name, not
  // report as two unrelated lines ("15/15 ok" + "not installed").
  add(
    'install state consistent (manifest vs live hooks)',
    !(!manifestInstalled && registeredHooks > 0),
    (!manifestInstalled && registeredHooks > 0)
      ? `partial install — ${registeredHooks} hooks live in hooks.json but no manifest (crash mid-install or state dir removed) — run agentsmd repair --plan; automatic apply requires valid ownership evidence`
      : 'ok'
  );

  const hooksDir = P.installHooksDir();
  if (!manifestInstalled) {
    add('installed hooks executable', false, 'not installed');
  } else {
    const bad = [];
    for (const hook of REG.HOOK_REGISTRY) {
      const file = path.join(hooksDir, hook.basename);
      try { fs.accessSync(file, fs.constants.X_OK); } catch { bad.push(hook.basename); }
    }
    add('installed hooks executable', bad.length === 0, bad.length ? `missing/not executable: ${bad.join(', ')}` : `${REG.HOOK_REGISTRY.length}/${REG.HOOK_REGISTRY.length}`);
  }

  // The manifest inventories the complete deployed release, including support
  // libraries and pattern files that a top-level executable scan cannot see.
  const integrityFailures = [];
  if (!manifestInstalled) {
    integrityFailures.push('not installed');
  } else if (!manifest || !Array.isArray(manifest.deployedFiles)) {
    integrityFailures.push('manifest has no deployed file inventory — run agentsmd repair --plan');
  } else {
    const root = path.resolve(P.installDir());
    if (manifest.name !== 'agentsmd' || typeof manifest.version !== 'string' || !manifest.version) {
      integrityFailures.push('manifest identity/version invalid');
    }
    if (manifest.deployedFiles.length === 0) integrityFailures.push('manifest deploy inventory is empty');
    for (const relative of REQUIRED_HOOK_SUPPORT) {
      if (!fs.existsSync(path.join(hooksDir, relative))) integrityFailures.push(`hooks/${relative}`);
    }
    const expected = new Map();
    for (const record of manifest.deployedFiles) {
      const file = path.resolve(root, record.path || '');
      const validType = record.type === 'file' || record.type === 'symlink';
      const validHash = record.type !== 'file' || /^[a-f0-9]{64}$/.test(record.sha256 || '');
      const validTarget = record.type !== 'symlink' || typeof record.target === 'string';
      if (!record.path || expected.has(record.path) || !validType || !validHash || !validTarget) {
        integrityFailures.push(`invalid inventory record: ${record.path || '(empty)'}`);
        continue;
      }
      if (file === root || !file.startsWith(root + path.sep)) {
        integrityFailures.push(`invalid manifest path: ${record.path}`);
        continue;
      }
      expected.set(record.path, record);
    }
    let actual = [];
    try { actual = F.treeEntries(root).filter((entry) => entry.type !== 'dir'); }
    catch (error) { integrityFailures.push(`cannot inventory deploy: ${error.message}`); }
    const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
    for (const [relative, record] of expected) {
      const entry = actualMap.get(relative);
      if (!entry || entry.type !== record.type
          || (record.type === 'file' && entry.sha256 !== record.sha256)
          || (record.type === 'symlink' && entry.target !== record.target)) integrityFailures.push(relative);
    }
    for (const relative of actualMap.keys()) {
      if (!expected.has(relative)) integrityFailures.push(`unexpected: ${relative}`);
    }
  }
  add(
    'installed hook and support files intact',
    integrityFailures.length === 0,
    integrityFailures.length
      ? `${[...new Set(integrityFailures)].slice(0, 5).join(', ')} — ${!manifestInstalled && registeredHooks === 0 ? 'run agentsmd install' : 'run agentsmd repair --plan'}`
      : `${manifest.deployedFiles.length}/${manifest.deployedFiles.length}`
  );
  if (manifest && manifest.manifestSchemaVersion === 2) {
    add(
      'standalone profile bundle complete',
      surfaceStatus.bundleProfilesComplete === true,
      surfaceStatus.bundleProfilesComplete === true
        ? 'full + extended + source layout verified from manifest digests'
        : 'one or more declared profile artifacts are missing, stale, or unreadable — run agentsmd repair --plan'
    );
    add(
      'standalone profile selection observable',
      true,
      surfaceStatus.profileState === 'drift'
        ? `configured=${surfaceStatus.configuredProfile}; desired=${surfaceStatus.desiredProfile}; mode=${surfaceStatus.profileSelectionMode}; enforcement remains active — run agentsmd update to migrate to the full profile`
        : `configured=${surfaceStatus.configuredProfile}; desired=${surfaceStatus.desiredProfile}; mode=${surfaceStatus.profileSelectionMode}; state=${surfaceStatus.profileState}`
    );
  }

  // hard-rules anchors resolve against the spec (drift guard).
  try {
    const hr = JSON.parse(read(path.join(P.repoRoot(), 'spec', 'hard-rules.json')));
    const files = {
      core: read(path.join(P.repoRoot(), 'spec', 'AGENTS.md')) || '',
      extended: read(path.join(P.repoRoot(), 'spec', 'AGENTS-extended.md')) || '',
    };
    const miss = hr.rules.filter((r) => !files[r.scope].includes(r.section_anchor));
    add('hard-rules anchors resolve', miss.length === 0, miss.length ? `${miss.length} missing` : `${hr.rules.length}/${hr.rules.length}`);

    // Governance demote-review cadence (R5-02 / OPERATOR §O2): a rule past its
    // review window means the telemetry-vs-rules loop has stopped being audited.
    // Same fresh/pending/due semantics as `agentsmd rules`, minus telemetry —
    // doctor only needs past-due-or-not plus the next due date.
    if (isSourceCheckout()) {
      const review = classifyGovernanceReview(hr, Date.now());
      add(
        'governance demote-review current',
        review.ok,
        review.ok
          ? `${review.total}/${review.total} within ${review.cadenceDays}d cadence — next review due ${review.nextDueIso}`
          : `${review.overdue.length}/${review.total} rule(s) past the ${review.cadenceDays}d demote-review cadence — run \`agentsmd rules\`, review, stamp last_demote_review + append spec/governance-log.json (OPERATOR §O2)`
      );
    }
  } catch (e) { add('hard-rules anchors resolve', false, e.message); }

  // Extended spec must exist at the top-level path core §2/§5 order the agent to
  // `cat` (~/.codex/AGENTS-extended.md) AND match the copy in the install dir — a
  // missing/stale target silently strips every L3/ship/override/three-strike rule.
  const extTop = read(P.agentsExtendedMdPath());
  const extSrc = read(path.join(P.installSpecDir(), 'AGENTS-extended.md'));
  add(
    'AGENTS-extended.md installed at ~/.codex/',
    extTop !== null && extSrc !== null && extTop === extSrc,
    extTop === null
      ? `missing — run agentsmd ${manifestInstalled ? 'repair --plan' : 'install'}`
      : (extSrc === null ? 'not installed' : (extTop === extSrc ? 'ok' : 'stale — run agentsmd repair --plan'))
  );

  // Installed-spec freshness: the spec version deployed into ~/.codex/AGENTS.md vs
  // the version this doctor's spec source carries. A lagging deploy (package bumped
  // but `install` never re-run) means new hooks/rules aren't live and the telemetry
  // loop starves (OPERATOR §O4). Only meaningful when doctor runs from a source
  // newer than the deploy (repo / freshly-updated package); run from the installed
  // copy the two match by construction, so this never false-fails there.
  const srcVer = SA.specVersion(read(path.join(P.repoRoot(), 'spec', 'AGENTS.md')) || '');
  const depVer = SA.specVersion(read(P.agentsMdPath()) || '');
  if (srcVer) {
    const freshness = classifySpecFreshness(srcVer, depVer, manifestInstalled);
    add(
      'installed spec is not older than doctor source',
      freshness.ok,
      freshness.detail
    );
  }

  // Discovery-chain budget: the global ~/.codex/AGENTS.md shares
  // project_doc_max_bytes (default 32 KiB) with every project's AGENTS.md chain,
  // and truncation past the cap is SILENT. Report the global spec's byte footprint
  // and the headroom left for project docs. Only fails if the global ALONE exceeds
  // the cap (thin-but-positive headroom is informational, never a false fail).
  const globalBytes = Buffer.byteLength(read(P.agentsMdPath()) || '', 'utf8');
  const budget = CT.chainBudget(cfg, globalBytes, 0);
  add(
    'discovery-chain headroom for project docs',
    budget.headroom >= 0,
    budget.headroom >= 0
      ? `global AGENTS.md ${globalBytes}B / cap ${budget.cap}B — ${budget.headroom}B left for project chains`
      : `global AGENTS.md ${globalBytes}B EXCEEDS cap ${budget.cap}B by ${-budget.headroom}B — raise project_doc_max_bytes in config.toml`
  );

  // Telemetry rows and state refs carry project path slugs — they must stay
  // private to the user (M-02). Hooks create new files under umask 077;
  // install/update tightens older artifacts; this check surfaces whatever is
  // still group/other-accessible. POSIX modes only (Windows support is WSL).
  if (process.platform !== 'win32') {
    const wide = [];
    const modeOf = (target) => { try { return fs.lstatSync(target); } catch { return null; } };
    const checkFile = (file) => {
      const stat = modeOf(file);
      if (stat && stat.isFile() && (stat.mode & 0o077) !== 0) wide.push(path.basename(file));
    };
    const stateStat = modeOf(P.stateDir());
    if (stateStat && stateStat.isDirectory() && (stateStat.mode & 0o077) !== 0) wide.push('.agentsmd-state/');
    const walkState = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walkState(full);
        else if (entry.isFile()) checkFile(full);
      }
    };
    if (stateStat && stateStat.isDirectory()) walkState(P.stateDir());
    for (const suffix of ['', '.1', '.2']) checkFile(`${P.logPath()}${suffix}`);
    add(
      'telemetry/state artifacts are private (0700/0600)',
      wide.length === 0,
      wide.length
        ? `group/other-accessible: ${[...new Set(wide)].slice(0, 6).join(', ')}${wide.length > 6 ? ', …' : ''} — run agentsmd update to tighten`
        : 'state dir + telemetry log private'
    );
  }

  // Structured §8 exceptions (R1-01): when the CURRENT directory's repo carries
  // .agentsmd/exceptions.json, it must be parseable, within the hooks' size cap,
  // and free of expired entries (hooks fail-closed on all three, so a broken or
  // stale file silently reverts the registered fixtures to blocking). Absent
  // file → no check row: most repos have no exceptions.
  try {
    const EXC = require('./exception');
    const excRoot = EXC.repoRoot(process.cwd());
    const excFile = excRoot ? EXC.exceptionsPath(excRoot) : null;
    if (excFile && fs.existsSync(excFile)) {
      let excOk = true;
      let excDetail = '';
      const excSize = fs.statSync(excFile).size;
      if (excSize > EXC.MAX_FILE_BYTES) {
        excOk = false;
        excDetail = `${excSize}B exceeds the ${EXC.MAX_FILE_BYTES}B hook cap — hooks ignore the whole file; run agentsmd exception prune`;
      } else {
        try {
          const store = EXC.readStore(excFile);
          const nowIso = new Date().toISOString();
          const expired = store.exceptions.filter((e) => !(typeof e.expires_at === 'string' && e.expires_at > nowIso));
          // An entry whose created_at → expires_at window exceeds the cap is dead
          // on arrival at the hooks (they enforce the same bound) but would read
          // as "active" here — surface it by name, since a hand-edited far-future
          // expiry is exactly what the cap exists to catch.
          const maxWindowMs = EXC.MAX_DAYS * 86400000;
          const overlong = store.exceptions.filter((e) => {
            if (expired.includes(e)) return false;
            const created = Date.parse(String(e.created_at || ''));
            const expires = Date.parse(String(e.expires_at || ''));
            return !Number.isFinite(created) || !Number.isFinite(expires)
              || expires - created > maxWindowMs;
          });
          excOk = expired.length === 0 && overlong.length === 0;
          const problems = [];
          if (expired.length > 0) {
            problems.push(`${expired.length} expired entr${expired.length === 1 ? 'y' : 'ies'} (${expired.map((e) => e.id).slice(0, 4).join(', ')})`);
          }
          if (overlong.length > 0) {
            problems.push(`${overlong.length} entr${overlong.length === 1 ? 'y' : 'ies'} past the ${EXC.MAX_DAYS}d window cap or missing created_at (${overlong.map((e) => e.id).slice(0, 4).join(', ')}) — hooks treat these as expired`);
          }
          excDetail = excOk
            ? `${store.exceptions.length} active exception(s) in ${path.relative(process.cwd(), excFile) || excFile}`
            : `${problems.join('; ')} — run agentsmd exception prune`;
        } catch (err) {
          excOk = false;
          excDetail = `unparseable — hooks treat this as no-exceptions (blocks stand): ${err.message}`;
        }
      }
      add('project §8 exceptions file is healthy', excOk, excDetail);
    }
  } catch { /* exception module unavailable → skip (older install) */ }

  return {
    ok: checks.every((c) => c.ok),
    surface: pluginBundle.detected ? 'plugin' : 'standalone',
    selectedSurface: arbitration.selection.selected,
    dualSurface: surfaceStatus.dualSurface,
    surfaceArbitration: arbitration,
    checks,
  };
}

if (require.main === module) {
  const parsed = parseNoArgs(
    process.argv.slice(2),
    'agentsmd doctor',
    'Run agentsmd install health checks: dependencies, native hooks, spec freshness, and discovery-chain headroom.'
  );
  if (parsed.help) {
    console.log(parsed.usage);
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd doctor: ${parsed.error}`);
    console.error(parsed.usage);
    process.exit(2);
  }
  const r = doctor();
  for (const c of r.checks) console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(r.ok ? '\nagentsmd doctor: all checks passed' : '\nagentsmd doctor: some checks failed');
  process.exit(r.ok ? 0 : 1);
}
module.exports = { classifySpecFreshness, classifyGovernanceReview, doctor };
