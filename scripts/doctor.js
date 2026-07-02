'use strict';
// doctor.js — health checks for a codexmd install + spec integrity.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const P = require('./lib/paths');
const CT = require('./lib/config-toml');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const has = (bin) => { try { cp.execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; } };

function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

  add('jq present', has('jq'), 'hooks require jq');
  add('node present', has('node'), 'transcript scan + scripts require node');

  const cfg = read(P.configTomlPath()) || '';
  add('config.toml features.codex_hooks=true', CT.isCodexHooksEnabled(cfg), 'Codex native hooks enabled (must be under [features])');

  const hooksDir = P.installHooksDir();
  if (fs.existsSync(hooksDir)) {
    let execOk = true, bad = '';
    for (const f of fs.readdirSync(hooksDir)) if (f.endsWith('.sh')) {
      try { fs.accessSync(path.join(hooksDir, f), fs.constants.X_OK); } catch { execOk = false; bad = f; }
    }
    add('installed hooks executable', execOk, execOk ? 'ok' : `not executable: ${bad}`);
  } else {
    add('installed hooks executable', true, 'not installed (skipped)');
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
  } catch (e) { add('hard-rules anchors resolve', false, e.message); }

  return { ok: checks.every((c) => c.ok), checks };
}

if (require.main === module) {
  const r = doctor();
  for (const c of r.checks) console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(r.ok ? '\ncodexmd doctor: all checks passed' : '\ncodexmd doctor: some checks failed');
  process.exit(r.ok ? 0 : 1);
}
module.exports = { doctor };
