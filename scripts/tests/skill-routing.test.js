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
  'agentsmd-safety-coverage-audit': 'safety-coverage-audit.js',
  'agentsmd-sampling-audit': 'sampling-audit.js',
  'agentsmd-sparkline': 'sparkline.js',
  'agentsmd-status': 'status.js',
  'agentsmd-version-cascade': 'version-cascade-check.js',
};

assert.deepStrictEqual(Object.keys(SCRIPT_BY_SKILL).sort(), names, 'script routing inventory must cover every agentsmd skill');

const skillDocs = {};
for (const name of names) {
  const raw = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
  skillDocs[name] = raw;
  const script = SCRIPT_BY_SKILL[name];
  assert(raw.includes('selected SKILL.md absolute path from the live skills list'), `${name}: selected absolute SKILL.md source missing`);
  assert(raw.includes('$(dirname "$SKILL_MD")/../..'), `${name}: candidate root must come from the selected skill path, not cwd`);
  assert(raw.includes(`$CANDIDATE_ROOT/scripts/${script}`), `${name}: candidate script probe missing`);
  assert(raw.includes('${CODEX_HOME:-$HOME/.codex}/agentsmd'), `${name}: standalone fallback missing`);
  assert(raw.includes(`node "$AGENTSMD_ROOT/scripts/${script}"`), `${name}: commands must execute through the resolved root`);
  assert(!raw.includes('node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/'), `${name}: direct standalone-only command remains`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function resolveDocumentedRoot(name, skillFile, codexHome, cwd) {
  const block = skillDocs[name].match(/```bash\n(SKILL_MD=.*?\nCANDIDATE_ROOT=.*?\nif .*? fi)\n```/s);
  assert(block, `${name}: resolver block missing`);
  const script = block[1]
    .replace(/^SKILL_MD=.*$/m, `SKILL_MD=${shellQuote(skillFile)}`)
    + '\nprintf "%s" "$AGENTSMD_ROOT"\n';
  return cp.execFileSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
}

const layoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-skill-routing.'));
try {
  for (const layout of ['plugin-cache', 'repo-checkout']) {
    const root = path.join(layoutRoot, layout);
    for (const [name, script] of Object.entries(SCRIPT_BY_SKILL)) {
      const skillFile = path.join(root, 'skills', name, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.writeFileSync(skillFile, 'fixture\n');
      fs.writeFileSync(path.join(root, 'scripts', script), 'fixture\n');
      assert.strictEqual(resolveDocumentedRoot(name, skillFile, path.join(layoutRoot, 'codex'), layoutRoot), root, `${name}: ${layout} root`);
    }
  }

  const codexHome = path.join(layoutRoot, 'standalone-home');
  for (const [name, script] of Object.entries(SCRIPT_BY_SKILL)) {
    const skillFile = path.join(codexHome, 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, 'fixture\n');
    fs.mkdirSync(path.join(codexHome, 'agentsmd', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'agentsmd', 'scripts', script), 'fixture\n');
    assert.strictEqual(resolveDocumentedRoot(name, skillFile, codexHome, layoutRoot), path.join(codexHome, 'agentsmd'), `${name}: standalone fallback`);
  }
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
];

for (const [prompt, expected] of CASES) {
  const top = rank(prompt, descriptions);
  assert.strictEqual(top[0].name, expected, `${prompt}: expected ${expected}, got ${top[0].name} (${top[0].score})`);
  assert(top[0].score > top[1].score, `${prompt}: routing tie ${top[0].name}/${top[1].name} at ${top[0].score}`);
}

console.log(`RESULT: ${names.length} descriptions + ${CASES.length} routing cases passed`);
