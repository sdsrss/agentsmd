'use strict';
// drift.test.js — CI gate keeping the spec, its machine-readable manifest, the
// two hook wirings, and the version in sync. A silent edit to any one side that
// isn't mirrored on the others fails here (claudemd's hard-rules-drift pattern).

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseSkillFrontmatter } = require('../lib/skill-frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const hr = JSON.parse(read('spec/hard-rules.json'));
const specFiles = { core: read('spec/AGENTS.md'), extended: read('spec/AGENTS-extended.md') };

// 1. every rule anchor still resolves verbatim in its spec file.
t('hard-rules: all section_anchors resolve in the spec', () => {
  const miss = hr.rules.filter((r) => !specFiles[r.scope].includes(r.section_anchor));
  assert.strictEqual(miss.length, 0, 'unresolved: ' + miss.map((r) => r.id).join(', '));
});

// Reverse direction: every explicit HARD/MUST line and every immutable Never
// clause must be represented by at least one same-scope manifest anchor. This
// prevents a new hard rule from landing in prose while the one-way anchor check
// remains green.
t('hard-rules: explicit HARD/MUST prose is represented in the manifest', () => {
  const missing = [];
  for (const [scope, text] of Object.entries(specFiles)) {
    for (const line of text.split('\n').filter((l) => /\b(?:HARD|MUST)\b/.test(l))) {
      const represented = hr.rules.some((r) => r.scope === scope && line.includes(r.section_anchor));
      if (!represented) missing.push(`${scope}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'ungoverned HARD/MUST lines:\n' + missing.join('\n'));
});

t('hard-rules: every immutable Never clause has a manifest anchor', () => {
  const line = specFiles.core.split('\n').find((l) => l.startsWith('**Never**:')) || '';
  const clauses = line.replace(/^\*\*Never\*\*:\s*/, '').replace(/\.$/, '').split(' · ').filter(Boolean);
  const missing = clauses.filter((clause) => !hr.rules.some((r) => r.scope === 'core'
    && (clause.includes(r.section_anchor) || r.section_anchor.includes(clause))));
  assert.deepStrictEqual(missing, [], 'ungoverned Never clauses: ' + missing.join(' | '));
});

t('ship contract: explicit release intent pre-authorizes closure without a repeat prompt', () => {
  assert.match(specFiles.core, /\*\*Explicit ship pre-authorization\*\*/,
    'core must define explicit ship pre-authorization');
  assert.match(specFiles.extended, /Release closure.*default branch.*delete.*branch/is,
    'extended checklist must require default-branch integration and release-branch cleanup');
  assert.doesNotMatch(specFiles.extended, /NO unattended path through this gate/,
    'legacy always-reprompt wording must be removed');
});

// 2. live_sections must reference sections that actually exist in the manifest.
t('hard-rules: live_sections ⊆ manifest rule_hits_sections', () => {
  const known = new Set(hr.rules.map((r) => r.rule_hits_section).filter(Boolean));
  const orphan = (hr.live_sections || []).filter((s) => !known.has(s));
  assert.strictEqual(orphan.length, 0, 'live_sections not in any rule: ' + orphan.join(', '));
});

// 2b. governance-review ledger (R5-02): the review log and the manifest stamps
//     must describe the same review — otherwise "reviewed" becomes unfalsifiable.
t('governance-log: latest review covers the manifest and matches its stamps', () => {
  const gl = JSON.parse(read('spec/governance-log.json'));
  assert(Array.isArray(gl.reviews) && gl.reviews.length > 0, 'governance log has no reviews');
  const latest = gl.reviews[gl.reviews.length - 1];
  assert(Number.isFinite(new Date(latest.date).getTime()), 'unparseable review date: ' + latest.date);
  const ruleIds = new Set(hr.rules.map((r) => r.id));
  const entryIds = new Set((latest.entries || []).map((e) => e.id));
  const unknown = [...entryIds].filter((id) => !ruleIds.has(id));
  assert.strictEqual(unknown.length, 0, 'review entries for unknown rules: ' + unknown.join(', '));
  for (const r of hr.rules) {
    if (!r.last_demote_review) continue; // never-reviewed rules owe no log entry yet
    assert(Number.isFinite(new Date(r.last_demote_review).getTime()), `${r.id}: unparseable last_demote_review`);
    if (r.last_demote_review === latest.date) {
      assert(entryIds.has(r.id), `${r.id} stamped ${latest.date} but absent from that review's log entries`);
    }
  }
  for (const e of latest.entries || []) {
    assert(e.verdict && e.evidence, `log entry ${e.id} lacks verdict/evidence`);
  }
});

t('hard-rules: governance parents resolve and cannot form chains or cycles', () => {
  const byId = new Map(hr.rules.map((rule) => [rule.id, rule]));
  for (const rule of hr.rules.filter((item) => item.governance_parent)) {
    assert.notStrictEqual(rule.governance_parent, rule.id, `${rule.id} governs itself`);
    const parent = byId.get(rule.governance_parent);
    assert(parent, `${rule.id} has missing governance parent ${rule.governance_parent}`);
    assert(!parent.governance_parent, `${rule.id} creates a governance chain through ${parent.id}`);
    assert.strictEqual(parent.rule_hits_section, rule.rule_hits_section,
      `${rule.id} and ${parent.id} do not share the telemetry bucket they deduplicate`);
  }
});

// 3. every live_section is actually EMITTED by a hook script, not merely named in
//    a comment. Full-line shell comments are stripped first: a section mentioned
//    only in a `# …` line but never in a hook_record call would otherwise green
//    while telemetry silently never accrues (rules.js would then read it as a live
//    0-hit demote-candidate). The real emission (`hook_record … '§x'`) survives.
t('hard-rules: every live_section is emitted by some hook (comments stripped)', () => {
  const hooksDir = path.join(ROOT, 'hooks');
  const stripLineComments = (src) => src.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
  const allHookSrc = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.sh'))
    .map((f) => stripLineComments(fs.readFileSync(path.join(hooksDir, f), 'utf8'))).join('\n');
  const missing = (hr.live_sections || []).filter((s) => !allHookSrc.includes(s));
  assert.strictEqual(missing.length, 0, 'live_sections no hook emits (in code, not comments): ' + missing.join(', '));
});

// 4. the two hook wirings (install template + plugin manifest) register the
//    same set of hook scripts per event — neither drifts silently.
t('hooks: install-template and plugin-manifest wirings match', () => {
  const basenames = (content) => {
    const cfg = JSON.parse(content);
    const out = {};
    for (const [ev, groups] of Object.entries(cfg.hooks)) {
      out[ev] = (groups || []).flatMap((g) => (g.hooks || []).map((h) => (h.command.match(/([a-z0-9-]+\.sh)/) || [])[1])).filter(Boolean).sort();
    }
    return out;
  };
  const a = basenames(read('hooks/hooks.json'));
  const b = basenames(read('hooks.json'));
  assert.deepStrictEqual(a, b, 'install-template vs plugin-manifest wiring differ');
  assert.deepStrictEqual(Object.keys(a).sort(), [...hr.registered_hook_events].sort(), 'manifest registered_hook_events differ from wiring');
  const supported = new Set(hr.supported_hook_events || []);
  assert(hr.registered_hook_events.every((event) => supported.has(event)), 'registered hook event missing from supported_hook_events');
});

t('plugin: manifest explicitly selects its root hook wiring', () => {
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.strictEqual(plugin.hooks, './hooks.json', 'plugin.json must explicitly select ./hooks.json');
  assert(plugin.hooks.startsWith('./'), 'plugin hook-manifest path must be plugin-root relative');
});

t('plugin: hook commands resolve scripts from Codex CLAUDE_PLUGIN_ROOT', () => {
  const wiring = JSON.parse(read('hooks.json'));
  for (const [event, groups] of Object.entries(wiring.hooks)) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        assert.match(
          hook.command,
          /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z0-9-]+\.sh"$/,
          `${event} command is not anchored to CLAUDE_PLUGIN_ROOT: ${hook.command}`
        );
      }
    }
  }
});

t('plugin: architecture separates runtime entry root from self-derived support paths', () => {
  assert(read('ARCHITECTURE.md').includes('`${CLAUDE_PLUGIN_ROOT}` 仅用于定位入口脚本'));
});

// 5. version is consistent across package.json / plugin.json / marketplace pin /
//    manifest / BOTH spec headers. Core + extended carry ONE shared version and move together
//    (AGENTS-CHANGELOG.md, since v1.4.0) — the extended header must be asserted
//    too, or it drifts silently (it sat at v2.3.0 through six releases because
//    this gate only checked the core header).
t('version: package = plugin = marketplace = hard-rules = core + extended headers', () => {
  const norm = (v) => String(v).replace(/^v/, '');
  const pkg = norm(JSON.parse(read('package.json')).version);
  const plugin = norm(JSON.parse(read('.codex-plugin/plugin.json')).version);
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  const marketplaceVersion = norm(marketplace.plugins.find((entry) => entry.name === 'agentsmd').source.version);
  const manifest = norm(hr.spec_version);
  const specHeader = (specFiles.core.match(/CODEX-CODING-SPEC v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
  const extHeader = (specFiles.extended.match(/CODEX-CODING-SPEC v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
  assert.strictEqual(pkg, plugin, `package(${pkg}) != plugin(${plugin})`);
  assert.strictEqual(pkg, marketplaceVersion, `package(${pkg}) != marketplace(${marketplaceVersion})`);
  assert.strictEqual(pkg, manifest, `package(${pkg}) != manifest(${manifest})`);
  assert.strictEqual(pkg, specHeader, `package(${pkg}) != core spec header(${specHeader})`);
  assert.strictEqual(pkg, extHeader, `package(${pkg}) != extended spec header(${extHeader})`);
  // install.sh pins its own release tag as the default ref (R3-01) — a stale
  // INSTALLER_VERSION would silently install the previous release.
  const installer = (read('install.sh').match(/INSTALLER_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];
  assert.strictEqual(pkg, installer, `package(${pkg}) != install.sh INSTALLER_VERSION(${installer})`);
});

// 6. plugin.json declares the skills dir and it exists with SKILL.md files.
t('plugin: skills dir declared and populated', () => {
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.strictEqual(plugin.skills, './skills/', 'plugin.json skills path');
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter((d) => d.startsWith('agentsmd-'));
  assert(skills.length >= 4, 'expected ≥4 agentsmd-* skills, got ' + skills.length);
  for (const s of skills) assert(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), s + ' missing SKILL.md');
});

// 7. no shipped hook hardcodes a spec version string (it goes stale every release;
//    session-start-check.sh derives it from the installed spec, fallback neutral).
t('version: shipped hooks carry no hardcoded spec version fallback', () => {
  const ss = read('hooks/session-start-check.sh');
  const bad = ss.match(/VER="v?\d+\.\d+\.\d+"/);
  assert(!bad, `session-start-check.sh hardcodes ${bad && bad[0]} — the fallback must be version-neutral (e.g. VER="unknown")`);
});

// 8. the agentsmd-status skill's stated hook count matches the actual wiring —
//    a doc number that silently drifts misleads the agent reading it.
t('skill: agentsmd-status hook count matches the wiring', () => {
  const wiring = JSON.parse(read('hooks/hooks.json'));
  let n = 0;
  for (const groups of Object.values(wiring.hooks)) for (const g of groups || []) n += (g.hooks || []).length;
  const claim = (read('skills/agentsmd-status/SKILL.md').match(/agentsmdHooksRegistered`?\s*\(should be (\d+)\)/) || [])[1];
  assert.strictEqual(Number(claim), n, `SKILL.md claims ${claim} hooks, wiring registers ${n}`);
});

// 9. Reserve at least half of the default discovery-chain cap for project-level
//    instructions. The core is global context; closer project rules must not be
//    silently truncated merely because the universal layer consumed the budget.
t('spec: core AGENTS.md stays below the 15 KiB ceiling', () => {
  const CAP = 15 * 1024;
  const bytes = Buffer.byteLength(specFiles.core, 'utf8');
  assert(bytes <= CAP, `core spec is ${bytes} B; max ${CAP} B`);
});

// 9b. R5-05: the guarantee behind the ceiling, asserted on the DEPLOYED shape —
//     the exact sentinel-wrapped block install.js writes into ~/.codex/AGENTS.md
//     must leave at least half of the default 32 KiB project_doc_max_bytes for
//     project chains, so a long project AGENTS.md is never truncated by OUR layer.
t('spec: injected managed block leaves ≥ half the default discovery cap for project chains', () => {
  const AM = require('../lib/agents-md');
  const injected = AM.injectSpecBlock(null, specFiles.core).content;
  const bytes = Buffer.byteLength(injected, 'utf8');
  assert(bytes <= 16 * 1024, `deployed block is ${bytes} B; must leave ≥ 16384 B of the 32768 B default cap`);
});

// 9c. R5-05: rule additions need behavior data, not taste. Every manifest rule
//     added after v4.16.0 must carry `behavior_evidence` naming its before/after
//     measurement (a conformance capture or governance-log entry). Bytes join the
//     always-on layer only with a measured reason (the R5-07 loop is the template;
//     C-1/C-2 were rejected for exactly this lack of data).
t('hard-rules: rules added after v4.16.0 carry behavior_evidence', () => {
  const GATE_FROM = [4, 16, 0];
  const newer = (v) => {
    const p = String(v || '').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((p[i] || 0) !== GATE_FROM[i]) return (p[i] || 0) > GATE_FROM[i]; }
    return false;
  };
  for (const r of hr.rules.filter((x) => newer(x.added_version))) {
    assert(typeof r.behavior_evidence === 'string' && r.behavior_evidence.trim().length > 0,
      `${r.id} (added ${r.added_version}) lacks behavior_evidence — new always-on rules require a measured before/after delta`);
  }
});

// 10. LEVEL is risk-based and orthogonal to AUTH. Diff size and file count are
//     observations, not gates; reversible L3 work does not ask twice merely
//     because it is L3, while the concrete §5 high-risk operations remain gated.
t('spec: LEVEL is risk-based and AUTH is operation-based', () => {
  const level = (specFiles.core.match(/## §2 LEVEL[\s\S]*?(?=\n## §3 )/) || [''])[0];
  const hardAuth = (specFiles.core.match(/\*\*Hard \(ask, block\)\*\*[\s\S]*?(?=\n\n\*\*Soft)/) || [''])[0];
  assert(level.includes('**Level/Auth separation**'), '§2 missing explicit LEVEL/AUTH separation');
  for (const stale of ['LOC <', 'LOC =', '≤2 files']) assert(!level.includes(stale), `§2 still uses ${stale} as a level gate`);
  assert(level.includes('Scoped reversible LLM-visible metadata → L2'), 'scoped reversible LLM metadata is not classified L2');
  assert(level.includes('global/shared/security-sensitive LLM-visible metadata → L3'), 'high-risk LLM metadata is not classified L3');
  for (const stale of ['entering L3 implementation', 'cross-module refactor']) assert(!hardAuth.includes(stale), `§5 still blanket-gates ${stale}`);
  for (const kept of ['DB migration / schema change', 'CI config', 'prod-dependency', '.env', 'auth/payment/crypto', 'global/shared/security-sensitive LLM routing metadata', 'breaking public-API', 'git push']) {
    assert(hardAuth.includes(kept), `§5 lost hard AUTH boundary: ${kept}`);
  }
  assert(specFiles.core.includes('L3 alone is not an authorization gate'), '§5 missing L3/AUTH boundary');
  assert(specFiles.extended.includes('When the plan contains a §5-hard operation'), '§E2 does not condition AUTH on a hard operation');
  for (const parity of ['before AND after', 'exported surface unchanged', 'characterization before/after', '[PARTIAL]']) {
    assert(specFiles.core.includes(parity), `§6 lost L2 refactor evidence boundary: ${parity}`);
  }
});

// 11. Trimming prose must never move the foundational always-on floor into the
//     triggered layer merely to satisfy the byte gate.
t('spec: foundational hard rules remain in core', () => {
  const ids = [
    '§0-extended-load', '§8-rm-rf-var', '§8-unknown-script', '§8-secrets',
    '§8-disable-ssl', '§8-env-key-commit', '§8-git-internals', '§8-sql-no-where',
    '§8-home-traversal', '§8-verify-before-claim', '§8.V4-sandbox-disposal',
    '§6-iron-law-1', '§6-iron-law-2', '§6-iron-law-3', '§6-bugfix-anchor',
    '§6-destructive-smoke', '§5-hard-auth', '§2-hard-upgrades',
    '§9-preflight', '§9-end-of-task-sweep', '§9-parallel-path',
    '§10-four-section-order', '§10-honesty', '§10-specificity',
  ];
  for (const id of ids) {
    const rule = hr.rules.find((r) => r.id === id);
    assert(rule, `missing foundational rule ${id}`);
    assert.strictEqual(rule.scope, 'core', `${id} moved out of core`);
  }
});

// 12. L2/L3 reports keep every outcome visible. Empty states are explicit,
//     separate labels rather than a combined line that renderers can de-emphasize.
t('spec: L2/L3 render four independent report labels', () => {
  assert(specFiles.core.includes('L2/L3 always show four independent labels'), 'core does not require independent report labels');
  assert(!specFiles.core.includes('use only non-empty sections'), 'core still hides empty report sections');
  for (const label of ['**Done:**', '**Not done:**', '**Failed:**', '**Uncertain:**']) {
    assert(specFiles.extended.includes(label), `§E12 missing visible label ${label}`);
  }
  assert(!specFiles.extended.includes('one combined `Not done / Failed / Uncertain'), '§E12 still combines empty states');
});

// 13. both READMEs' hook tables must list exactly as many hooks as the wiring
//     registers — a hand-maintained table that lags the code (it drifted to 12/10
//     rows while the wiring had 15) misleads the first-time reader about what runs.
t('README: EN + zh hook-table row counts match the wiring', () => {
  const wiring = JSON.parse(read('hooks/hooks.json'));
  const expected = new Map();
  for (const [event, groups] of Object.entries(wiring.hooks)) for (const group of groups || []) {
    for (const hook of group.hooks || []) {
      const name = (hook.command.match(/([a-z0-9-]+)\.sh/) || [])[1];
      if (name) expected.set(name, event);
    }
  }
  const rowRe = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(SessionStart|PreToolUse(?::Bash)?|UserPromptSubmit|Stop)\b.*$/gm;
  for (const f of ['README.md', 'README.zh-CN.md']) {
    const src = read(f);
    const actual = new Map([...src.matchAll(rowRe)].map((m) => [m[1], m[2].replace(':Bash', '')]));
    assert.deepStrictEqual([...actual].sort(), [...expected].sort(), `${f} hook names/events differ from wiring`);
    const transcript = [...src.matchAll(rowRe)].find((m) => m[1] === 'transcript-structure-scan');
    assert(transcript && transcript[0].includes('§10') && transcript[0].includes('§6'), `${f} transcript observer omits §10/§6 scope`);
  }
});

// 14. The Chinese README must retain the same discoverable user-command surface
//     as the English README. These are intentionally semantic anchors rather than
//     translated heading equality so either document can use natural wording.
t('README zh: project init/analyze/adoption/design workflows remain discoverable', () => {
  const zh = read('README.zh-CN.md');
  for (const command of ['agentsmd init', 'analyze --gather', '--write --from', 'analyze --adoption', 'agentsmd design', 'design --write']) {
    assert(zh.includes(command), `README.zh-CN.md missing project workflow: ${command}`);
  }
  for (const boundary of ['--check', '--dry-run', '--local', '--no-frontend', '6 KiB', 'Tailwind v3']) {
    assert(zh.includes(boundary), `README.zh-CN.md missing project workflow boundary: ${boundary}`);
  }
});

t('README zh: plugin browser fallback remains actionable', () => {
  const zh = read('README.zh-CN.md');
  assert(zh.includes('**插件**'), 'README.zh-CN.md missing Codex app Plugins action');
  assert(zh.includes('`/plugins`'), 'README.zh-CN.md missing Codex CLI plugin browser action');
});

t('README zh: governance project lens remains documented', () => {
  const zh = read('README.zh-CN.md');
  assert(zh.includes('audit.js --project=X'), 'README.zh-CN.md missing audit project example');
  assert(zh.includes('仅作信息透镜'), 'README.zh-CN.md missing rules project-lens boundary');
  assert(zh.includes('降级信号仍跨项目'), 'README.zh-CN.md missing cross-project demotion boundary');
});

t('README: EN + zh document the shared CLI exit-code contract', () => {
  for (const f of ['README.md', 'README.zh-CN.md']) {
    const src = read(f);
    assert(src.includes('`0`') && src.includes('`1`') && src.includes('`2`'), `${f} missing exit-code values`);
    assert(/argv\/usage/.test(src), `${f} missing argv/usage classification`);
  }
});

// 16. Skill frontmatter is always loaded for routing. Keep it compact and force
//     a negative boundary so neighboring audit/init skills do not blur together.
t('skills: descriptions stay compact and declare a Not for boundary', () => {
  const skillsDir = path.join(ROOT, 'skills');
  for (const name of fs.readdirSync(skillsDir).filter((n) => n.startsWith('agentsmd-'))) {
    const src = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    const metadata = parseSkillFrontmatter(src, `${name}/SKILL.md`);
    assert.strictEqual(metadata.name, name, `${name}: frontmatter name mismatch`);
    const desc = metadata.description;
    assert(desc, `${name}: missing frontmatter description`);
    assert(desc.length <= 300, `${name}: description ${desc.length} chars exceeds 300`);
    assert(/\bnot for\b/i.test(desc), `${name}: missing explicit Not for boundary`);
  }
});

// 17. Supply chain: workflow action refs must be immutable commit SHAs, not
//     mutable tags/branches a compromised upstream repo could repoint (M-12).
t('workflows: every uses: ref is pinned to a full commit SHA', () => {
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  for (const name of fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const src = fs.readFileSync(path.join(wfDir, name), 'utf8');
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (!m) continue;
      const ref = m[1];
      if (ref.startsWith('./')) continue; // local composite actions have no ref
      if (!/@[0-9a-f]{40}$/.test(ref)) offenders.push(`${name}: ${ref}`);
    }
  }
  assert.strictEqual(offenders.length, 0, `mutable action refs: ${offenders.join(', ')}`);
});

// 18. bypassable governance (R1-01). A rule marked bypassable:false is immutable
//     at the enforcement layer: no hook may emit a "bypass" telemetry event for
//     its section (every inline-token acceptance branch records exactly that, so
//     this is the mechanical signature of a token path). Rules marked
//     bypassable:true must declare their token, and that token must appear in
//     some hook source. §8 rules may never flip to bypassable:true.
t('hard-rules: bypassable:false sections have no hook bypass path; true tokens exist', () => {
  const hooksDir = path.join(ROOT, 'hooks');
  const hookSrc = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.sh'))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(hooksDir, f), 'utf8') }));
  const frozen = new Set(hr.rules.filter((r) => r.bypassable === false)
    .map((r) => r.rule_hits_section).filter(Boolean));
  const offenders = [];
  for (const { name, src } of hookSrc) {
    for (const line of src.split('\n')) {
      const m = line.match(/hook_record\s+"\$HOOK"\s+"bypass"\s+\S+\s+'([^']+)'/);
      if (m && frozen.has(m[1])) offenders.push(`${name}: bypass emission for frozen ${m[1]}`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
  const allSrc = hookSrc.map((h) => h.src).join('\n');
  for (const r of hr.rules.filter((x) => x.bypassable === true)) {
    assert.ok(typeof r.bypass_token === 'string' && /^\[allow-[a-z0-9-]+\]$/.test(r.bypass_token),
      `${r.id}: bypassable:true requires a [allow-*] bypass_token`);
    assert.ok(allSrc.includes(r.bypass_token), `${r.id}: declared token ${r.bypass_token} not found in any hook`);
  }
  const softened = hr.rules.filter((r) => r.id.startsWith('§8') && r.bypassable !== false);
  assert.deepStrictEqual(softened.map((r) => r.id), [], '§8 rules must all be bypassable:false');
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
