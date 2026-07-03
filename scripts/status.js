'use strict';
// status.js — report agentsmd's install state, and explicitly how many OTHER
// tenants' hook entries are present + preserved (the independence guarantee is
// observable, not just asserted).

const fs = require('fs');
const P = require('./lib/paths');
const H = require('./lib/codex-hooks');
const AM = require('./lib/agents-md');
const CT = require('./lib/config-toml');
const { readRows } = require('./audit');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function status() {
  let manifest = null;
  try { manifest = JSON.parse(read(P.manifestPath())); } catch {}
  const hooksContent = read(P.hooksJsonPath());
  const cfg = read(P.configTomlPath()) || '';

  let total = 0, other = 0;
  if (hooksContent) {
    try {
      const p = JSON.parse(hooksContent);
      for (const groups of Object.values(p.hooks || {})) for (const g of groups || []) for (const h of (g.hooks || [])) {
        if (h && h.type === 'command') { total++; if (!H.isAgentsmdCommand(h.command)) other++; }
      }
    } catch {}
  }
  return {
    installed: !!manifest,
    installedAt: manifest && manifest.installedAt,
    agentsmdHooksRegistered: hooksContent ? H.countAgentsmdHooks(hooksContent) : 0,
    otherTenantHooksPreserved: other,
    totalHookEntries: total,
    codexHooksFlag: CT.isCodexHooksEnabled(cfg),
    tuiStatusLineConfigured: CT.getTuiStatusLine(cfg).exists,
    agentsmdStatusLinePreset: CT.isAgentsmdStatusLineEnabled(cfg),
    specBlockInAgentsMd: AM.hasSpecBlock(read(P.agentsMdPath())),
    extendedMdInstalled: fs.existsSync(P.agentsExtendedMdPath()),
    telemetryRows: readRows(P.logPath()).length,
  };
}

function parseNoArgs(argv, commandName) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    return { error: `unknown option: ${arg}` };
  }
  return { usage: `Usage: ${commandName}` };
}

if (require.main === module) {
  const parsed = parseNoArgs(process.argv.slice(2), 'agentsmd-status');
  if (parsed.help) {
    console.log('Usage: agentsmd-status');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd status: ${parsed.error}`);
    console.error('Usage: agentsmd-status');
    process.exit(1);
  }
  console.log(JSON.stringify(status(), null, 2));
}
module.exports = { status, parseNoArgs };
