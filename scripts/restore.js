'use strict';
// restore.js — roll the 3 shared multi-tenant files (hooks.json / config.toml /
// AGENTS.md) back to a pre-install snapshot taken by scripts/lib/backup.js. DRY-RUN
// by default (prints what WOULD change); --confirm writes. --list shows the available
// backups. Overwrites only files PRESENT at backup time; a file absent then is left
// alone — to remove agentsmd's OWN entries use `uninstall` (marker-scoped, tenant-safe).

const B = require('./lib/backup');

function parseArgs(argv) {
  let list = false, confirm = false, id = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--list') { list = true; continue; }
    if (arg === '--confirm') { confirm = true; continue; }
    let m;
    if ((m = arg.match(/^--id=(.+)$/))) { if (id !== null) return { error: 'duplicate option: --id' }; id = m[1]; continue; }
    return { error: `unknown option: ${arg}` };
  }
  return { list, confirm, id };
}

const USAGE = [
  'Usage: agentsmd restore [--list] [--id=<backup-id>] [--confirm]',
  '',
  'Roll the 3 shared files (hooks.json / config.toml / AGENTS.md) back to a snapshot',
  'taken before an agentsmd install. Dry-run by default — pass --confirm to write.',
  '',
  '  --list          List available backups (newest first) and exit.',
  '  --id=<id>       Restore this backup id (default: the newest).',
  '  --confirm       Actually overwrite the live files (otherwise dry-run).',
  '',
  'Only files that existed at backup time are restored; files absent then are left',
  "alone. To remove agentsmd's own entries, use `agentsmd uninstall` (multi-tenant-safe).",
].join('\n');

function main(argv) {
  const p = parseArgs(argv);
  if (p.help) { console.log(USAGE); return 0; }
  if (p.error) { console.error(`agentsmd restore: ${p.error}`); console.error(USAGE); return 2; }

  const backups = B.listBackups();
  if (p.list) {
    if (!backups.length) { console.log('No agentsmd backups found.'); return 0; }
    console.log(`agentsmd backups (${backups.length}, newest first):`);
    for (const b of backups) console.log(`  ${b.id}`);
    return 0;
  }
  if (!backups.length) { console.error('agentsmd restore: no backups found (none taken yet).'); return 1; }

  let plan;
  try { plan = B.planRestore(p.id); }
  catch (e) { console.error(`agentsmd restore: ${e.message}`); return 1; }

  if (!p.confirm) {
    console.log(`DRY-RUN — would restore backup '${plan.id}':`);
    console.log(`  overwrite: ${plan.willRestore.join(', ') || '(none)'}`);
    if (plan.willLeave.length) console.log(`  leave (absent at backup): ${plan.willLeave.join(', ')}`);
    console.log('\nRe-run with --confirm to apply. This overwrites the live files with the snapshot,');
    console.log('discarding any changes made since the backup (all tenants). To remove only agentsmd,');
    console.log('use `agentsmd uninstall`.');
    return 0;
  }
  const res = B.restoreBackup(p.id);
  console.log(`Restored backup '${res.id}': overwrote ${res.restored.join(', ') || '(none)'}${res.left.length ? `; left ${res.left.join(', ')}` : ''}.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseArgs, main };
