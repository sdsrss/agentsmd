'use strict';
// argv.js — shared strict argv parsing for agentsmd's L2 CLIs. Ported from
// claudemd/scripts/lib/argv.js (ESM→CommonJS). It exists to kill the
// "silent-fallback argv" bug class:
//   • a value flag accepts ONLY --key=value — a bare --key never silently
//     swallows the following token (the classic `args[args.indexOf('--x')+1]` trap);
//   • unknown flags/args throw loudly instead of being ignored;
//   • numeric flags validate as strict positive ints (no Number()/parseInt
//     over-coercion: '1e2' / '0x1e' / '1.5' / '' are rejected, not silently 100).
// scripts/lint-argv.js gates the repo against the antipatterns this replaces;
// new CLIs should parse through parseStrict + parsePositiveInt + printHelpAndExit.
// (This file is on lint-argv's allowlist — it is the sanctioned home of the
// argv primitives, so its own --help scan below is intentional.)

class ArgvError extends Error {
  constructor(message) { super(message); this.name = 'ArgvError'; }
}

// If argv asks for help (--help / -h anywhere), print usage to stdout and exit 0.
// Call BEFORE parseStrict so unknown-arg rejection never shadows --help.
function printHelpAndExit(argv, usage) {
  if (argv.includes('--help') || argv.includes('-h')) { // argv-lint:allow
    console.log(usage);
    process.exit(0);
  }
}

// Strict positive integer: returns the int, or null if not a clean positive int.
// Accepts '30', '30.0', ' 30 ', numeric 30; rejects '1.5', '0x1e', '1e2', '0',
// '-5', 'abc', '', null, undefined. Callers turn null into an ArgvError / exit 1.
function parsePositiveInt(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null; // shape gate: no hex / exp / sign
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Strict flag parser. bools = flags taking no value; values = flags requiring
// --key=value. Returns { bools:Set, values:{} }. Throws ArgvError on any shape
// violation: a bare value-flag, a valued bool-flag, an unknown flag, or a bare
// positional. Keys are constrained to the caller's allowlists, so no unexpected
// (or prototype-polluting) key can land in `values`.
function parseStrict(argv, { bools = [], values = [] } = {}) {
  const boolSet = new Set(bools);
  const valueSet = new Set(values);
  const outBools = new Set();
  const outValues = {};
  for (const tok of argv) {
    if (!tok.startsWith('--')) throw new ArgvError(`Unknown argument '${tok}'`);
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      const key = tok.slice(2, eq);
      if (boolSet.has(key)) throw new ArgvError(`Boolean flag '--${key}' does not take a value`);
      if (!valueSet.has(key)) throw new ArgvError(`Unknown flag '--${key}'`);
      outValues[key] = tok.slice(eq + 1); // repeated flag → last wins
    } else {
      const key = tok.slice(2);
      if (valueSet.has(key)) throw new ArgvError(`Value flag '--${key}' requires '=value' form`);
      if (!boolSet.has(key)) throw new ArgvError(`Unknown flag '--${key}'`);
      outBools.add(key);
    }
  }
  return { bools: outBools, values: outValues };
}

module.exports = { ArgvError, printHelpAndExit, parsePositiveInt, parseStrict };
