'use strict';
// Metadata proxy for implicit skill routing. Codex's router is not available to
// unit tests, so this gate checks compactness, explicit negative scope, and that
// distinctive positive prompts rank above their nearest neighboring skill.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');
const cp = require('child_process');
const { parseSkillFrontmatter } = require('../lib/skill-frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS = path.join(ROOT, 'skills');
const CANONICAL_RUNNER = path.join(ROOT, 'scripts', 'lib', 'skill-runner.js');
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;
const STOP = new Set(['agentsmd', 'the', 'and', 'for', 'from', 'into', 'not', 'use', 'when', 'with', 'read', 'only']);

function description(name) {
  const raw = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
  return parseSkillFrontmatter(raw, `${name}/SKILL.md`).description;
}

function tokens(s) {
  const source = String(s).toLowerCase();
  const out = source.match(/[a-z][a-z0-9-]{2,}/g)?.filter((x) => !STOP.has(x)) || [];
  for (const run of source.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return new Set(out);
}

function rank(prompt, descriptions) {
  const p = tokens(prompt);
  return Object.entries(descriptions)
    .map(([name, desc]) => {
      const [positive, negative = ''] = desc.split(/\bNot for\b/i);
      const positiveHits = [...tokens(positive)].filter((x) => p.has(x)).length;
      const negativeHits = [...tokens(negative)].filter((x) => p.has(x)).length;
      return { name, score: positiveHits - negativeHits };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

const names = fs.readdirSync(SKILLS).filter((n) => n.startsWith('agentsmd-')).sort();
const descriptions = Object.fromEntries(names.map((n) => [n, description(n)]));
const totalSkillBytes = names.reduce((total, name) => (
  total + fs.statSync(path.join(SKILLS, name, 'SKILL.md')).size
), 0);
assert(
  totalSkillBytes <= 46832,
  `model-visible skill entrypoints total ${totalSkillBytes} bytes; expected at least 50% below the 93665-byte baseline`,
);

const SCRIPT_BY_SKILL = {
  'agentsmd-analyze': 'analyze.js',
  'agentsmd-audit': 'audit.js',
  'agentsmd-design': 'design.js',
  'agentsmd-doctor': 'doctor.js',
  'agentsmd-init': 'init.js',
  'agentsmd-lesson-bypass-audit': 'lesson-bypass-audit.js',
  'agentsmd-lint-argv': 'lint-argv.js',
  'agentsmd-perf-baseline': 'perf-baseline.js',
  'agentsmd-restore': 'restore.js',
  'agentsmd-rules': 'rules.js',
  'agentsmd-scorecard': 'scorecard.js',
  'agentsmd-safety-coverage-audit': 'safety-coverage-audit.js',
  'agentsmd-sampling-audit': 'sampling-audit.js',
  'agentsmd-sparkline': 'sparkline.js',
  'agentsmd-status': 'status.js',
  'agentsmd-version-cascade': 'version-cascade-check.js',
  'agentsmd-verify': 'verify.js',
};

assert.deepStrictEqual(Object.keys(SCRIPT_BY_SKILL).sort(), names, 'script routing inventory must cover every agentsmd skill');

const skillDocs = {};
const canonicalRunner = fs.readFileSync(CANONICAL_RUNNER);
const generatedLauncher = require('../generate-skill-runners').renderLauncher(canonicalRunner);
for (const name of names) {
  const raw = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
  skillDocs[name] = raw;
  const runner = path.join(SKILLS, name, 'scripts', 'agentsmd-run.js');
  assert(raw.includes('selected `SKILL.md` absolute path from the live skills list'), `${name}: selected absolute SKILL.md source missing`);
  assert(raw.includes('Define and call the adjacent launcher in the same shell'), `${name}: launcher shell-lifetime warning missing`);
  assert(raw.includes('$(dirname "$SKILL_MD")/scripts/agentsmd-run.js'), `${name}: adjacent launcher path missing`);
  assert(raw.includes('"$SKILL_MD" "$@"'), `${name}: selected skill identity/argv forwarding missing`);
  assert(raw.includes('agentsmd_skill_run'), `${name}: documented commands do not use the compact launcher`);
  assert(!raw.includes('AGENTSMD_ROOT'), `${name}: model-visible resolved-root state remains`);
  assert(!raw.includes('pkg.name!=="@sdsrs/agentsmd"'), `${name}: package verifier leaked back into model-visible instructions`);
  assert(!raw.includes('command -v agentsmd'), `${name}: CLI locator leaked back into model-visible instructions`);
  assert.deepStrictEqual(fs.readFileSync(runner), generatedLauncher, `${name}: generated launcher drift; run node scripts/generate-skill-runners.js`);
}

const runtimeInventory = require('../lib/skill-runner').SCRIPT_BY_SKILL;
assert.deepStrictEqual(runtimeInventory, SCRIPT_BY_SKILL, 'generated runner inventory must match every skill script');

function installLauncher(skillFile) {
  const runner = path.join(path.dirname(skillFile), 'scripts', 'agentsmd-run.js');
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.writeFileSync(runner, generatedLauncher);
  return runner;
}

function writeProbe(root, script) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', script), [
    "'use strict';",
    "const path = require('path');",
    'process.stdout.write(JSON.stringify({',
    "  root: path.resolve(__dirname, '..'),",
    '  argv: process.argv.slice(2),',
    '  plugin: process.env.AGENTSMD_PLUGIN_ROOT || null,',
    '}));',
    '',
  ].join('\n'));
}

function runLauncher(skillFile, codexHome, cwd, extraEnv = {}, args = []) {
  return cp.spawnSync(process.execPath, [
    path.join(path.dirname(skillFile), 'scripts', 'agentsmd-run.js'),
    skillFile,
    ...args,
  ], {
    cwd,
    env: { ...process.env, ...extraEnv, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
}

function probe(result) {
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function writePackageIdentity(root, { plugin = false, bin = false } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(CANONICAL_RUNNER, path.join(root, 'scripts', 'lib', 'skill-runner.js'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: '@sdsrs/agentsmd',
    version: PACKAGE_VERSION,
    ...(bin ? { bin: { agentsmd: 'bin/agentsmd.js' } } : {}),
  })}\n`);
  if (plugin) {
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), `${JSON.stringify({
      name: 'agentsmd',
      version: PACKAGE_VERSION,
    })}\n`);
  }
}

const layoutRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-skill-routing.')));
try {
  for (const layout of ['plugin-cache', 'repo-checkout']) {
    const root = path.join(layoutRoot, layout);
    writePackageIdentity(root, { plugin: layout === 'plugin-cache' });
    for (const [name, script] of Object.entries(SCRIPT_BY_SKILL)) {
      const skillFile = path.join(root, 'skills', name, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, 'fixture\n');
      installLauncher(skillFile);
      writeProbe(root, script);
      const result = probe(runLauncher(skillFile, path.join(layoutRoot, 'codex'), layoutRoot));
      assert.strictEqual(result.root, root, `${name}: ${layout} root`);
      assert.strictEqual(result.plugin, layout === 'plugin-cache' ? root : null, `${name}: ${layout} plugin context`);
    }
  }

  const codexHome = path.join(layoutRoot, 'standalone-home');
  const standaloneRoot = path.join(codexHome, 'agentsmd');
  writePackageIdentity(standaloneRoot);
  fs.mkdirSync(path.join(codexHome, '.agentsmd-state'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, '.agentsmd-state', 'manifest.json'), `${JSON.stringify({
    name: 'agentsmd',
    version: PACKAGE_VERSION,
    ownedArtifacts: { deploy: { path: standaloneRoot, sha256: 'a'.repeat(64) } },
  })}\n`);
  for (const [name, script] of Object.entries(SCRIPT_BY_SKILL)) {
    const skillFile = path.join(codexHome, 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, 'fixture\n');
    installLauncher(skillFile);
    writeProbe(standaloneRoot, script);
    const result = probe(runLauncher(skillFile, codexHome, layoutRoot));
    assert.strictEqual(result.root, standaloneRoot, `${name}: standalone fallback`);
    assert.strictEqual(result.plugin, null, `${name}: standalone fallback must not impersonate a plugin`);
  }

  const cliHome = path.join(layoutRoot, 'cli-home');
  const cliBin = path.join(layoutRoot, 'cli-bin');
  const cliPackage = path.join(layoutRoot, 'global', 'lib', 'node_modules', '@sdsrs', 'agentsmd');
  writePackageIdentity(cliPackage, { plugin: true, bin: true });
  fs.mkdirSync(path.join(cliPackage, 'bin'), { recursive: true });
  fs.mkdirSync(cliBin, { recursive: true });
  fs.writeFileSync(path.join(cliPackage, 'bin', 'agentsmd.js'), 'fixture\n');
  fs.chmodSync(path.join(cliPackage, 'bin', 'agentsmd.js'), 0o755);
  fs.symlinkSync(path.join(cliPackage, 'bin', 'agentsmd.js'), path.join(cliBin, 'agentsmd'));
  for (const [name, script] of Object.entries(SCRIPT_BY_SKILL)) {
    const skillFile = path.join(cliHome, 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, 'fixture\n');
    installLauncher(skillFile);
    writeProbe(cliPackage, script);
    const result = probe(runLauncher(skillFile, cliHome, layoutRoot, { PATH: `${cliBin}:${process.env.PATH || ''}` }));
    assert.strictEqual(result.root, cliPackage, `${name}: global CLI package fallback`);
    assert.strictEqual(result.plugin, null, `${name}: CLI fallback must not impersonate a selected plugin`);
  }

  fs.writeFileSync(
    path.join(cliPackage, 'scripts', 'doctor.js'),
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), plugin: process.env.AGENTSMD_PLUGIN_ROOT || null }))\n',
  );
  const cliDoctorSkill = path.join(cliHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  const executed = runLauncher(
    cliDoctorSkill,
    cliHome,
    layoutRoot,
    { PATH: `${cliBin}:${process.env.PATH || ''}` },
    ['--probe'],
  );
  assert.strictEqual(executed.status, 0, executed.stderr);
  assert.deepStrictEqual(JSON.parse(executed.stdout), { argv: ['--probe'], plugin: null });

  const missingHome = path.join(layoutRoot, 'missing-home');
  const missingSkill = path.join(missingHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  fs.mkdirSync(path.dirname(missingSkill), { recursive: true });
  fs.writeFileSync(missingSkill, 'fixture\n');
  installLauncher(missingSkill);
  const missing = runLauncher(missingSkill, missingHome, layoutRoot, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^agentsmd skill runner unavailable:/);
  assert.match(missing.stderr, /unblock:/);
  assert(missing.stderr.length < 3000, `locator diagnosis is ${missing.stderr.length} characters`);
  assert.doesNotMatch(missing.stderr, /MODULE_NOT_FOUND/);
  assert.strictEqual(missing.stdout, '');

  const foreignHome = path.join(layoutRoot, 'foreign-home');
  const foreignSkill = path.join(foreignHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
  fs.mkdirSync(path.join(foreignHome, 'agentsmd', 'scripts'), { recursive: true });
  fs.writeFileSync(foreignSkill, 'fixture\n');
  installLauncher(foreignSkill);
  fs.writeFileSync(path.join(foreignHome, 'agentsmd', 'scripts', 'doctor.js'), 'foreign fixture\n');
  const foreign = runLauncher(foreignSkill, foreignHome, layoutRoot, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(foreign.status, 1, 'an unowned script at the conventional standalone path must not become executable trust');

  const invalidVersionRoot = path.join(layoutRoot, 'invalid-version-root');
  const invalidVersionSkill = path.join(invalidVersionRoot, 'skills', 'agentsmd-doctor', 'SKILL.md');
  fs.mkdirSync(path.dirname(invalidVersionSkill), { recursive: true });
  fs.mkdirSync(path.join(invalidVersionRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(invalidVersionSkill, 'fixture\n');
  installLauncher(invalidVersionSkill);
  fs.writeFileSync(path.join(invalidVersionRoot, 'scripts', 'doctor.js'), 'fixture\n');
  fs.writeFileSync(path.join(invalidVersionRoot, 'package.json'), JSON.stringify({
    name: '@sdsrs/agentsmd',
    version: '5.2.0-01',
  }));
  const invalidVersion = runLauncher(invalidVersionSkill, missingHome, layoutRoot, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(invalidVersion.status, 1, 'a non-SemVer package version must not satisfy runner identity');

  const mismatchedPluginRoot = path.join(layoutRoot, 'mismatched-plugin');
  const mismatchedPluginSkill = path.join(mismatchedPluginRoot, 'skills', 'agentsmd-doctor', 'SKILL.md');
  writePackageIdentity(mismatchedPluginRoot, { plugin: true });
  fs.writeFileSync(path.join(mismatchedPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'agentsmd', version: '0.0.0',
  }));
  fs.mkdirSync(path.dirname(mismatchedPluginSkill), { recursive: true });
  fs.writeFileSync(mismatchedPluginSkill, 'fixture\n');
  installLauncher(mismatchedPluginSkill);
  writeProbe(mismatchedPluginRoot, 'doctor.js');
  const mismatchedPlugin = runLauncher(mismatchedPluginSkill, missingHome, layoutRoot, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(mismatchedPlugin.status, 1, 'a plugin/package version mismatch must not execute the selected bundle');

  const mismatchedStandaloneHome = path.join(layoutRoot, 'mismatched-standalone-home');
  const mismatchedStandaloneRoot = path.join(mismatchedStandaloneHome, 'agentsmd');
  const mismatchedStandaloneSkill = path.join(mismatchedStandaloneHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  writePackageIdentity(mismatchedStandaloneRoot);
  writeProbe(mismatchedStandaloneRoot, 'doctor.js');
  fs.mkdirSync(path.dirname(mismatchedStandaloneSkill), { recursive: true });
  fs.writeFileSync(mismatchedStandaloneSkill, 'fixture\n');
  installLauncher(mismatchedStandaloneSkill);
  fs.mkdirSync(path.join(mismatchedStandaloneHome, '.agentsmd-state'), { recursive: true });
  fs.writeFileSync(path.join(mismatchedStandaloneHome, '.agentsmd-state', 'manifest.json'), JSON.stringify({
    name: 'agentsmd',
    version: PACKAGE_VERSION,
    ownedArtifacts: { deploy: { path: path.join(layoutRoot, 'other-deploy'), sha256: 'a'.repeat(64) } },
  }));
  const mismatchedStandalone = runLauncher(
    mismatchedStandaloneSkill,
    mismatchedStandaloneHome,
    layoutRoot,
    { PATH: '/usr/bin:/bin' },
  );
  assert.strictEqual(mismatchedStandalone.status, 1, 'a mismatched standalone deploy manifest must not authorize execution');

  const mismatchedCliHome = path.join(layoutRoot, 'mismatched-cli-home');
  const mismatchedCliRoot = path.join(layoutRoot, 'mismatched-cli-package');
  const mismatchedCliBin = path.join(layoutRoot, 'mismatched-cli-bin');
  const mismatchedCliSkill = path.join(mismatchedCliHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  writePackageIdentity(mismatchedCliRoot, { bin: true });
  fs.mkdirSync(path.join(mismatchedCliRoot, 'bin'), { recursive: true });
  fs.mkdirSync(mismatchedCliBin, { recursive: true });
  fs.writeFileSync(path.join(mismatchedCliRoot, 'bin', 'agentsmd.js'), 'fixture\n', { mode: 0o755 });
  const foreignCliEntry = path.join(mismatchedCliRoot, 'bin', 'foreign.js');
  fs.writeFileSync(foreignCliEntry, 'fixture\n', { mode: 0o755 });
  fs.symlinkSync(foreignCliEntry, path.join(mismatchedCliBin, 'agentsmd'));
  fs.mkdirSync(path.dirname(mismatchedCliSkill), { recursive: true });
  fs.writeFileSync(mismatchedCliSkill, 'fixture\n');
  installLauncher(mismatchedCliSkill);
  writeProbe(mismatchedCliRoot, 'doctor.js');
  const mismatchedCli = runLauncher(
    mismatchedCliSkill,
    mismatchedCliHome,
    layoutRoot,
    { PATH: `${mismatchedCliBin}:/usr/bin:/bin` },
  );
  assert.strictEqual(mismatchedCli.status, 1, 'a CLI entrypoint realpath mismatch must not execute package scripts');

  const symlinkHome = path.join(layoutRoot, 'symlink-home');
  const symlinkSkill = path.join(symlinkHome, 'skills', 'agentsmd-doctor', 'SKILL.md');
  fs.mkdirSync(path.dirname(symlinkSkill), { recursive: true });
  const realSkill = path.join(layoutRoot, 'real-skill.md');
  fs.writeFileSync(realSkill, 'fixture\n');
  fs.symlinkSync(realSkill, symlinkSkill);
  const symlinkRunnerDirectory = path.join(path.dirname(symlinkSkill), 'scripts');
  fs.mkdirSync(symlinkRunnerDirectory, { recursive: true });
  fs.writeFileSync(path.join(symlinkRunnerDirectory, 'agentsmd-run.js'), generatedLauncher);
  const symlinkSelected = runLauncher(symlinkSkill, symlinkHome, layoutRoot, { PATH: '/usr/bin:/bin' });
  assert.strictEqual(symlinkSelected.status, 1, 'a symlinked selected SKILL.md must fail before root resolution');
} finally {
  fs.rmSync(layoutRoot, { recursive: true, force: true });
}

for (const [name, desc] of Object.entries(descriptions)) {
  assert(desc.length <= 300, `${name}: description is ${desc.length} chars (max 300)`);
  assert(/\bnot for\b/i.test(desc), `${name}: description needs an explicit Not for boundary`);
}

const CASES = [
  ['generate project AGENTS stack commands structure', 'agentsmd-init'],
  ['distill naming imports error-handling coding conventions', 'agentsmd-analyze'],
  ['extract CSS Tailwind design tokens', 'agentsmd-design'],
  ['aggregate raw rule-hit telemetry counts', 'agentsmd-audit'],
  ['review rule promotion demotion governance', 'agentsmd-rules'],
  ['retrospective transcript vocabulary violation rates', 'agentsmd-sampling-audit'],
  ['multi-window trends sections went silent', 'agentsmd-sparkline'],
  ['diagnose install hook registration executability', 'agentsmd-doctor'],
  ['show install state registered hooks inventory', 'agentsmd-status'],
  ['benchmark hook latency medians', 'agentsmd-perf-baseline'],
  ['measure memory hint bypass follow-through', 'agentsmd-lesson-bypass-audit'],
  ['restore pre-install snapshot after bad merge', 'agentsmd-restore'],
  ['scan README stale version tokens', 'agentsmd-version-cascade'],
  ['detect silent-fallback argv parser', 'agentsmd-lint-argv'],
  ['check static hook claims bypass tokens emitters', 'agentsmd-safety-coverage-audit'],
  ['select change-aware validation checks with deterministic reasons', 'agentsmd-verify'],
  ['aggregate unified quality scorecard measurement limits', 'agentsmd-scorecard'],
  // Neighbor pairs: the prompt names the excluded neighbor but must still rank
  // the intended positive scope first.
  ['aggregate rule-hit telemetry raw counts, not govern the spec', 'agentsmd-audit'],
  ['review rule promotion demotion signals for the always-on spec, not raw listings', 'agentsmd-rules'],
  ['show install state and registered hooks inventory, not diagnose failures', 'agentsmd-status'],
  ['diagnose prerequisites hook executability and config drift, not inventory', 'agentsmd-doctor'],
  ['scaffold project stack instructions before convention analysis', 'agentsmd-init'],
  ['infer source coding conventions after stack detection', 'agentsmd-analyze'],
  // Bilingual metadata proxy cases. These validate only the repository lexical
  // proxy; they are not a measured Codex-router accuracy claim.
  ['汇总遥测命中统计', 'agentsmd-audit'],
  ['审核规则升降级治理', 'agentsmd-rules'],
  ['诊断安装故障', 'agentsmd-doctor'],
  ['查看安装状态清单', 'agentsmd-status'],
  ['生成项目指令', 'agentsmd-init'],
  ['提炼代码约定', 'agentsmd-analyze'],
  ['选择变更感知验证检查', 'agentsmd-verify'],
  ['汇总统一质量记分卡', 'agentsmd-scorecard'],
];

for (const [prompt, expected] of CASES) {
  const top = rank(prompt, descriptions);
  assert.strictEqual(top[0].name, expected, `${prompt}: expected ${expected}, got ${top[0].name} (${top[0].score})`);
  assert(top[0].score > top[1].score, `${prompt}: routing tie ${top[0].name}/${top[1].name} at ${top[0].score}`);
}

console.log(`RESULT: ${names.length} descriptions + ${CASES.length} routing cases passed`);
